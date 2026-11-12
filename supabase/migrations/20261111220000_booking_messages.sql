-- One conversation per booking. The provider participant is providers.owner_id,
-- which is the auth user, not the provider listing id.
-- Messages are insert-only. Read cursors are separate so a recipient cannot
-- rewrite message text. Closed bookings keep history and reject new inserts.

create table if not exists public.booking_messages (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.booking_requests (id) on delete cascade,
  sender_id uuid not null,
  body text not null,
  created_at timestamptz not null default now(),
  client_id uuid,
  constraint booking_messages_body_length check (char_length(btrim(body)) between 1 and 2000)
);

create unique index if not exists booking_messages_client_uidx
  on public.booking_messages (sender_id, client_id)
  where client_id is not null;

create index if not exists booking_messages_booking_created_idx
  on public.booking_messages (booking_id, created_at);

create index if not exists booking_messages_booking_sender_idx
  on public.booking_messages (booking_id, sender_id, created_at);

create table if not exists public.booking_message_reads (
  booking_id uuid not null references public.booking_requests (id) on delete cascade,
  reader_id uuid not null,
  read_at timestamptz not null default now(),
  primary key (booking_id, reader_id)
);

create index if not exists booking_message_reads_reader_idx
  on public.booking_message_reads (reader_id, booking_id);

alter table public.booking_messages enable row level security;
alter table public.booking_messages force row level security;
alter table public.booking_message_reads enable row level security;
alter table public.booking_message_reads force row level security;

create or replace function public.guard_booking_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  booking_customer uuid;
  booking_owner uuid;
  booking_status text;
  message_hits integer;
begin
  select booking.customer_id, provider.owner_id, booking.status
    into booking_customer, booking_owner, booking_status
  from public.booking_requests as booking
  join public.providers as provider on provider.id = booking.provider_id
  where booking.id = new.booking_id;

  if booking_customer is null then
    raise exception 'That booking could not be found.';
  end if;
  if auth.uid() is null
     or (auth.uid() is distinct from booking_customer and auth.uid() is distinct from booking_owner) then
    raise exception 'You cannot message this booking.';
  end if;
  if new.sender_id is distinct from auth.uid() then
    raise exception 'You cannot send a message as someone else.';
  end if;
  if booking_status not in ('pending', 'requested', 'accepted') then
    raise exception 'This conversation is closed.';
  end if;

  new.sender_id := auth.uid();
  new.created_at := clock_timestamp();
  new.body := btrim(new.body);
  if char_length(new.body) < 1 or char_length(new.body) > 2000 then
    raise exception 'Enter a message of up to 2,000 characters.';
  end if;
  message_hits := public.consume_rate_limit('sendMessage:user:' || auth.uid()::text, 30, 600);
  if message_hits > 30 then
    raise exception 'Too many attempts. Wait a few minutes and try again.';
  end if;
  return new;
end;
$$;

drop trigger if exists booking_messages_guard on public.booking_messages;
create trigger booking_messages_guard
  before insert on public.booking_messages
  for each row
  execute function public.guard_booking_message();

create or replace function public.guard_booking_message_read()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  booking_customer uuid;
  booking_owner uuid;
begin
  if tg_op = 'UPDATE' and (new.booking_id is distinct from old.booking_id or new.reader_id is distinct from old.reader_id) then
    raise exception 'Read receipts cannot be reassigned.';
  end if;

  select booking.customer_id, provider.owner_id
    into booking_customer, booking_owner
  from public.booking_requests as booking
  join public.providers as provider on provider.id = booking.provider_id
  where booking.id = new.booking_id;

  if auth.uid() is null
     or (auth.uid() is distinct from booking_customer and auth.uid() is distinct from booking_owner) then
    raise exception 'You cannot update this conversation.';
  end if;
  if new.reader_id is distinct from auth.uid() then
    raise exception 'You cannot mark messages read for someone else.';
  end if;
  new.reader_id := auth.uid();
  new.read_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists booking_message_reads_guard on public.booking_message_reads;
create trigger booking_message_reads_guard
  before insert or update on public.booking_message_reads
  for each row
  execute function public.guard_booking_message_read();

revoke all on function public.guard_booking_message() from public, anon, authenticated, service_role;
revoke all on function public.guard_booking_message_read() from public, anon, authenticated, service_role;

create or replace function public.booking_conversation_summaries()
returns table (
  booking_id uuid,
  counterpart_name text,
  service_name text,
  preferred_date date,
  time_window text,
  status text,
  latest_body text,
  latest_at timestamptz,
  unread_count integer,
  viewer_role text
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  return query
  select
    booking.id,
    case
      when booking.customer_id = auth.uid() then provider.business_name
      else customer.full_name
    end,
    booking.service_name,
    booking.preferred_date,
    booking.time_window,
    booking.status,
    latest.body,
    latest.created_at,
    coalesce((
      select count(*)::integer
      from public.booking_messages as message
      where message.booking_id = booking.id
        and message.sender_id is distinct from auth.uid()
        and message.created_at > coalesce(receipt.read_at, '-infinity'::timestamptz)
    ), 0),
    case
      when booking.customer_id = auth.uid() then 'customer'
      else 'provider'
    end
  from public.booking_requests as booking
  join public.providers as provider on provider.id = booking.provider_id
  join public.profiles as customer on customer.id = booking.customer_id
  left join lateral (
    select message.body, message.created_at
    from public.booking_messages as message
    where message.booking_id = booking.id
    order by message.created_at desc
    limit 1
  ) as latest on true
  left join public.booking_message_reads as receipt
    on receipt.booking_id = booking.id
   and receipt.reader_id = auth.uid()
  where auth.uid() is not null
    and (booking.customer_id = auth.uid() or provider.owner_id = auth.uid())
  order by coalesce(latest.created_at, booking.created_at) desc;
end;
$$;

revoke all on function public.booking_conversation_summaries() from public, anon;
grant execute on function public.booking_conversation_summaries() to authenticated;

drop policy if exists booking_messages_select on public.booking_messages;
create policy booking_messages_select
  on public.booking_messages
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.booking_requests as booking
      join public.providers as provider on provider.id = booking.provider_id
      where booking.id = booking_messages.booking_id
        and (booking.customer_id = auth.uid() or provider.owner_id = auth.uid())
    )
  );

drop policy if exists booking_messages_insert on public.booking_messages;
create policy booking_messages_insert
  on public.booking_messages
  for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and exists (
      select 1
      from public.booking_requests as booking
      join public.providers as provider on provider.id = booking.provider_id
      where booking.id = booking_messages.booking_id
        and (booking.customer_id = auth.uid() or provider.owner_id = auth.uid())
        and booking.status in ('pending', 'requested', 'accepted')
    )
  );

drop policy if exists booking_message_reads_select on public.booking_message_reads;
create policy booking_message_reads_select
  on public.booking_message_reads
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.booking_requests as booking
      join public.providers as provider on provider.id = booking.provider_id
      where booking.id = booking_message_reads.booking_id
        and (booking.customer_id = auth.uid() or provider.owner_id = auth.uid())
    )
  );

drop policy if exists booking_message_reads_write on public.booking_message_reads;
create policy booking_message_reads_write
  on public.booking_message_reads
  for insert
  to authenticated
  with check (
    reader_id = auth.uid()
    and exists (
      select 1
      from public.booking_requests as booking
      join public.providers as provider on provider.id = booking.provider_id
      where booking.id = booking_message_reads.booking_id
        and (booking.customer_id = auth.uid() or provider.owner_id = auth.uid())
    )
  );

drop policy if exists booking_message_reads_update on public.booking_message_reads;
create policy booking_message_reads_update
  on public.booking_message_reads
  for update
  to authenticated
  using (
    reader_id = auth.uid()
    and exists (
      select 1
      from public.booking_requests as booking
      join public.providers as provider on provider.id = booking.provider_id
      where booking.id = booking_message_reads.booking_id
        and (booking.customer_id = auth.uid() or provider.owner_id = auth.uid())
    )
  )
  with check (
    reader_id = auth.uid()
    and exists (
      select 1
      from public.booking_requests as booking
      join public.providers as provider on provider.id = booking.provider_id
      where booking.id = booking_message_reads.booking_id
        and (booking.customer_id = auth.uid() or provider.owner_id = auth.uid())
    )
  );

revoke all on public.booking_messages from public, anon, authenticated;
grant select, insert on public.booking_messages to authenticated;
revoke all on public.booking_message_reads from public, anon, authenticated;
grant select, insert, update on public.booking_message_reads to authenticated;

alter table public.booking_messages replica identity full;
alter table public.booking_message_reads replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'booking_messages'
    ) then
      alter publication supabase_realtime add table public.booking_messages;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'booking_message_reads'
    ) then
      alter publication supabase_realtime add table public.booking_message_reads;
    end if;
  end if;
end
$$;
