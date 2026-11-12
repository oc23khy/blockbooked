-- Disposable messaging RLS test. Do not run this against the deployed Supabase database.
-- The node test applies the rate-limit migration and
-- supabase/migrations/20261111220000_booking_messages.sql before the TESTS section.

-- SPLIT:schema

do $$
begin
  if current_database() is distinct from 'blockbooked_rate_limit_test' then
    raise exception 'Refusing to run outside database blockbooked_rate_limit_test';
  end if;
end
$$;

create table if not exists public.profiles (
  id uuid primary key,
  full_name text not null default '',
  role text not null default 'customer'
);

create table if not exists public.providers (
  id uuid primary key,
  owner_id uuid not null unique,
  business_name text not null
);

alter table public.booking_requests
  add column if not exists created_at timestamptz not null default now();

grant usage on schema public to authenticated;
grant authenticated to current_user;
grant select on public.booking_requests, public.providers, public.profiles to authenticated;

insert into public.profiles (id, full_name)
values ('c1000090-0000-4000-8000-000000000090', 'Unchanged Customer')
on conflict (id) do nothing;
insert into public.providers (id, owner_id, business_name)
values ('c1000091-0000-4000-8000-000000000091', 'c1000090-0000-4000-8000-000000000090', 'Unchanged Business')
on conflict (id) do nothing;
insert into public.booking_requests (
  id, customer_id, provider_id, preferred_date, time_window, notes, service_name, status
) values (
  'c1000092-0000-4000-8000-000000000092',
  'c1000090-0000-4000-8000-000000000090',
  'c1000091-0000-4000-8000-000000000091',
  date '2026-11-11',
  'Morning',
  'preserve-this-note',
  'Preserve',
  'pending'
)
on conflict (id) do update
set notes = 'preserve-this-note', status = 'pending', service_name = 'Preserve';

create table if not exists rate_lab.sentinel (
  id uuid primary key,
  notes text not null,
  status text not null,
  service_name text not null
);
insert into rate_lab.sentinel (id, notes, status, service_name)
values (
  'c1000092-0000-4000-8000-000000000092',
  'preserve-this-note',
  'pending',
  'Preserve'
)
on conflict (id) do update
set notes = excluded.notes, status = excluded.status, service_name = excluded.service_name;

-- SPLIT:tests

do $$
begin
  if current_database() is distinct from 'blockbooked_rate_limit_test' then
    raise exception 'Refusing to run outside database blockbooked_rate_limit_test';
  end if;
  if to_regprocedure('public.consume_rate_limit(text, integer, integer)') is null then
    raise exception 'Apply the rate-limit migration before the messaging tests';
  end if;
  if to_regclass('public.booking_messages') is null then
    raise exception 'Apply supabase/migrations/20261111220000_booking_messages.sql before these tests';
  end if;
end
$$;

create or replace function rate_lab.send_message(
  actor uuid,
  target_booking uuid,
  message_body text,
  claimed_sender uuid,
  message_client uuid default null
)
returns text
language plpgsql
as $$
declare
  chosen_client uuid;
begin
  chosen_client := coalesce(message_client, extensions.gen_random_uuid());
  perform set_config('request.jwt.claim.sub', actor::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', actor::text, 'role', 'authenticated')::text,
    true
  );
  set local role authenticated;
  insert into public.booking_messages (booking_id, sender_id, body, client_id)
  values (target_booking, claimed_sender, message_body, chosen_client);
  reset role;
  return 'ok';
exception
  when others then
    reset role;
    return sqlerrm;
end;
$$;

create or replace function rate_lab.visible_messages(actor uuid, target_booking uuid)
returns integer
language plpgsql
as $$
declare
  visible integer;
begin
  perform set_config('request.jwt.claim.sub', actor::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', actor::text, 'role', 'authenticated')::text,
    true
  );
  set local role authenticated;
  select count(*) into visible
  from public.booking_messages
  where booking_id = target_booking;
  reset role;
  return visible;
end;
$$;

create or replace function rate_lab.unread_for(actor uuid, target_booking uuid)
returns integer
language plpgsql
as $$
declare
  unread integer;
begin
  perform set_config('request.jwt.claim.sub', actor::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', actor::text, 'role', 'authenticated')::text,
    true
  );
  set local role authenticated;
  select summary.unread_count into unread
  from public.booking_conversation_summaries() as summary
  where summary.booking_id = target_booking;
  reset role;
  return coalesce(unread, -1);
end;
$$;

create or replace function rate_lab.mark_read(actor uuid, target_booking uuid)
returns text
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', actor::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', actor::text, 'role', 'authenticated')::text,
    true
  );
  set local role authenticated;
  insert into public.booking_message_reads (booking_id, reader_id)
  values (target_booking, actor)
  on conflict (booking_id, reader_id) do update
  set read_at = clock_timestamp();
  reset role;
  return 'ok';
exception
  when others then
    reset role;
    return sqlerrm;
end;
$$;

create or replace function rate_lab.rewrite_message(actor uuid, target_booking uuid)
returns text
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', actor::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', actor::text, 'role', 'authenticated')::text,
    true
  );
  set local role authenticated;
  update public.booking_messages
  set body = 'rewritten'
  where booking_id = target_booking;
  reset role;
  return 'ok';
exception
  when others then
    reset role;
    return sqlerrm;
end;
$$;

create or replace function rate_lab.summary_for(actor uuid, target_booking uuid)
returns table (found boolean, body text, counterpart text)
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', actor::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', actor::text, 'role', 'authenticated')::text,
    true
  );
  set local role authenticated;
  return query
  select true, summary.latest_body, summary.counterpart_name
  from public.booking_conversation_summaries() as summary
  where summary.booking_id = target_booking;
  reset role;
end;
$$;

create or replace function rate_lab.probe(actor uuid, actor_role text, reads boolean, statement text)
returns text
language plpgsql
as $$
declare
  observed integer;
begin
  perform set_config('request.jwt.claim.sub', coalesce(actor::text, ''), true);
  perform set_config('request.jwt.claim.role', actor_role, true);
  perform set_config(
    'request.jwt.claims',
    case
      when actor is null then '{}'::text
      else json_build_object('sub', actor::text, 'role', actor_role)::text
    end,
    true
  );
  execute format('set local role %I', actor_role);
  if reads then
    execute statement into observed;
    reset role;
    return 'rows:' || coalesce(observed, 0)::text;
  end if;
  execute statement;
  reset role;
  return 'ok';
exception
  when others then
    reset role;
    return sqlerrm;
end;
$$;

-- SCENARIO 1: the customer messages the booked provider
-- SCENARIO 2: the provider replies to that customer
-- SCENARIO 3: an unrelated user cannot read the messages
-- SCENARIO 4: an unrelated user cannot send a message
-- SCENARIO 5: another provider cannot read the conversation
-- SCENARIO 6: a participant cannot impersonate the other sender
-- SCENARIO 7: messaging works before provider acceptance
-- SCENARIO 8: completed and cancelled bookings keep history and reject new messages
-- SCENARIO 9: empty and oversized messages are rejected
-- SCENARIO 10: the 31st message in ten minutes is rejected
-- SCENARIO 11: read receipts clear the recipient unread count
-- SCENARIO 12: repeating a client id does not insert a second message

do $tests$
declare
  customer_id uuid := 'c1000001-0000-4000-8000-000000000001';
  owner_id uuid := 'c1000002-0000-4000-8000-000000000002';
  stranger_id uuid := 'c1000003-0000-4000-8000-000000000003';
  other_owner_id uuid := 'c1000004-0000-4000-8000-000000000004';
  rate_customer_id uuid := 'c1000005-0000-4000-8000-000000000005';
  rate_owner_id uuid := 'c1000006-0000-4000-8000-000000000006';
  provider_id uuid := 'c1000007-0000-4000-8000-000000000007';
  other_provider_id uuid := 'c1000008-0000-4000-8000-000000000008';
  rate_provider_id uuid := 'c1000009-0000-4000-8000-000000000009';
  open_booking uuid := 'c1000011-0000-4000-8000-000000000011';
  other_booking uuid := 'c1000012-0000-4000-8000-000000000012';
  completed_booking uuid := 'c1000013-0000-4000-8000-000000000013';
  cancelled_booking uuid := 'c1000014-0000-4000-8000-000000000014';
  rate_booking uuid := 'c1000015-0000-4000-8000-000000000015';
  result text;
  visible integer;
  stored integer;
  attempt integer;
  preserved_notes text;
  preserved_status text;
  summary_body text;
  summary_name text;
  summary_found boolean;
  backdated timestamptz;
begin
  select booking.notes, booking.status
    into preserved_notes, preserved_status
  from public.booking_requests as booking
  join rate_lab.sentinel as sentinel on sentinel.id = booking.id
  where booking.id = 'c1000092-0000-4000-8000-000000000092'
    and booking.notes = sentinel.notes
    and booking.status = sentinel.status
    and booking.service_name = sentinel.service_name;
  if preserved_notes is distinct from 'preserve-this-note' or preserved_status is distinct from 'pending' then
    raise exception 'Migration changed an existing booking row: % %', preserved_notes, preserved_status;
  end if;
  delete from public.booking_messages
  where booking_id in (open_booking, other_booking, completed_booking, cancelled_booking, rate_booking);
  delete from public.booking_message_reads
  where booking_id in (open_booking, other_booking, completed_booking, cancelled_booking, rate_booking);
  delete from public.booking_requests
  where id in (open_booking, other_booking, completed_booking, cancelled_booking, rate_booking);
  delete from public.providers
  where id in (provider_id, other_provider_id, rate_provider_id);
  delete from public.profiles
  where id in (customer_id, owner_id, stranger_id, other_owner_id, rate_customer_id, rate_owner_id);
  delete from public.rate_limit_counters
  where bucket in (
    'sendMessage:user:' || customer_id::text,
    'sendMessage:user:' || owner_id::text,
    'sendMessage:user:' || rate_customer_id::text
  );

  insert into public.profiles (id, full_name) values
    (customer_id, 'Casey Customer'),
    (owner_id, 'Owen Owner'),
    (stranger_id, 'Sam Stranger'),
    (other_owner_id, 'Olivia Other'),
    (rate_customer_id, 'Riley Rate'),
    (rate_owner_id, 'Rowan Rate');
  insert into public.providers (id, owner_id, business_name) values
    (provider_id, owner_id, 'North Lawn'),
    (other_provider_id, other_owner_id, 'Other Lawn'),
    (rate_provider_id, rate_owner_id, 'Rate Lawn');
  insert into public.booking_requests (
    id, customer_id, provider_id, preferred_date, time_window, service_name, status
  ) values
    (open_booking, customer_id, provider_id, current_date, 'Morning', 'Mow', 'pending'),
    (other_booking, customer_id, other_provider_id, current_date, 'Afternoon', 'Trim', 'pending'),
    (completed_booking, customer_id, provider_id, current_date, 'Evening', 'Mow', 'pending'),
    (cancelled_booking, customer_id, provider_id, current_date, 'Morning', 'Mow', 'pending'),
    (rate_booking, rate_customer_id, rate_provider_id, current_date, 'Morning', 'Mow', 'accepted');

  result := rate_lab.send_message(customer_id, open_booking, 'Can you arrive at 9?', customer_id);
  if result is distinct from 'ok' then
    raise exception 'SCENARIO 1 failed: %', result;
  end if;

  result := rate_lab.send_message(owner_id, open_booking, 'Yes, 9 works.', owner_id);
  if result is distinct from 'ok' then
    raise exception 'SCENARIO 2 failed: %', result;
  end if;
  if rate_lab.visible_messages(customer_id, open_booking) <> 2 then
    raise exception 'SCENARIO 2 failed: provider reply was not visible to the customer';
  end if;

  if rate_lab.visible_messages(stranger_id, open_booking) <> 0 then
    raise exception 'SCENARIO 3 failed: stranger can read messages';
  end if;

  result := rate_lab.send_message(stranger_id, open_booking, 'hello', stranger_id);
  if result = 'ok' then
    raise exception 'SCENARIO 4 failed: stranger sent a message';
  end if;

  if rate_lab.visible_messages(other_owner_id, open_booking) <> 0 then
    raise exception 'SCENARIO 5 failed: another provider can read the conversation';
  end if;
  result := rate_lab.send_message(other_owner_id, open_booking, 'wrong business', other_owner_id);
  if result = 'ok' then
    raise exception 'SCENARIO 5 failed: another provider sent a message';
  end if;

  result := rate_lab.send_message(customer_id, open_booking, 'pretending', owner_id);
  if result = 'ok' or result not like '%someone else%' then
    raise exception 'SCENARIO 6 failed: %', result;
  end if;

  if rate_lab.visible_messages(customer_id, open_booking) < 2 then
    raise exception 'SCENARIO 7 failed: pending booking rejected the customer';
  end if;

  result := rate_lab.send_message(customer_id, completed_booking, 'see you then', customer_id);
  if result is distinct from 'ok' then
    raise exception 'SCENARIO 8 setup failed: %', result;
  end if;
  result := rate_lab.send_message(owner_id, cancelled_booking, 'still scheduled', owner_id);
  if result is distinct from 'ok' then
    raise exception 'SCENARIO 8 setup failed: %', result;
  end if;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);
  update public.booking_requests set status = 'completed' where id = completed_booking;
  update public.booking_requests set status = 'cancelled' where id = cancelled_booking;
  if rate_lab.visible_messages(customer_id, completed_booking) <> 1 then
    raise exception 'SCENARIO 8 failed: completed history was not readable';
  end if;
  result := rate_lab.send_message(customer_id, completed_booking, 'after completion', customer_id);
  if result = 'ok' or result not like '%closed%' then
    raise exception 'SCENARIO 8 completed failed: %', result;
  end if;
  result := rate_lab.send_message(owner_id, cancelled_booking, 'after cancellation', owner_id);
  if result = 'ok' or result not like '%closed%' then
    raise exception 'SCENARIO 8 cancelled failed: %', result;
  end if;
  if rate_lab.visible_messages(customer_id, cancelled_booking) <> 1 then
    raise exception 'SCENARIO 8 failed: cancelled history was not readable';
  end if;

  result := rate_lab.send_message(customer_id, open_booking, '   ', customer_id);
  if result = 'ok' then
    raise exception 'SCENARIO 9 failed: empty message was stored';
  end if;
  result := rate_lab.send_message(customer_id, open_booking, repeat('a', 2001), customer_id);
  if result = 'ok' then
    raise exception 'SCENARIO 9 failed: oversized message was stored';
  end if;

  for attempt in 1..30 loop
    result := rate_lab.send_message(rate_customer_id, rate_booking, 'message ' || attempt::text, rate_customer_id);
    if result is distinct from 'ok' then
      raise exception 'SCENARIO 10 failed on message %: %', attempt, result;
    end if;
  end loop;
  result := rate_lab.send_message(rate_customer_id, rate_booking, 'one too many', rate_customer_id);
  if result = 'ok' or result not like '%Too many attempts%' then
    raise exception 'SCENARIO 10 failed: %', result;
  end if;
  select count(*) into stored from public.booking_messages where booking_id = rate_booking;
  if stored <> 30 then
    raise exception 'SCENARIO 10 stored % messages', stored;
  end if;

  if rate_lab.unread_for(owner_id, open_booking) <> 1 then
    raise exception 'SCENARIO 11 failed: provider unread was %', rate_lab.unread_for(owner_id, open_booking);
  end if;
  if rate_lab.unread_for(customer_id, open_booking) <> 1 then
    raise exception 'SCENARIO 11 failed: customer unread was %', rate_lab.unread_for(customer_id, open_booking);
  end if;
  result := rate_lab.mark_read(owner_id, open_booking);
  if result is distinct from 'ok' or rate_lab.unread_for(owner_id, open_booking) <> 0 then
    raise exception 'SCENARIO 11 mark failed: % unread %', result, rate_lab.unread_for(owner_id, open_booking);
  end if;
  result := rate_lab.mark_read(stranger_id, open_booking);
  if result = 'ok' then
    raise exception 'SCENARIO 11 failed: stranger marked the conversation read';
  end if;

  result := rate_lab.send_message(
    customer_id,
    open_booking,
    'same client',
    customer_id,
    'c1000016-0000-4000-8000-000000000016'
  );
  if result is distinct from 'ok' then
    raise exception 'SCENARIO 12 first insert failed: %', result;
  end if;
  result := rate_lab.send_message(
    customer_id,
    open_booking,
    'same client again',
    customer_id,
    'c1000016-0000-4000-8000-000000000016'
  );
  if result = 'ok' then
    raise exception 'SCENARIO 12 stored a duplicate client id';
  end if;
  select count(*) into stored
  from public.booking_messages
  where client_id = 'c1000016-0000-4000-8000-000000000016';
  if stored <> 1 then
    raise exception 'SCENARIO 12 stored % rows', stored;
  end if;

  result := rate_lab.rewrite_message(customer_id, open_booking);
  if result = 'ok' then
    raise exception 'Message rewrite was allowed';
  end if;

  alter table public.booking_requests enable row level security;
  drop policy if exists bookings_select_message_lab on public.booking_requests;
  create policy bookings_select_message_lab
    on public.booking_requests
    for select
    to authenticated
    using (
      customer_id = auth.uid()
      or exists (
        select 1
        from public.providers as provider
        where provider.id = booking_requests.provider_id
          and provider.owner_id = auth.uid()
      )
    );

  if rate_lab.visible_messages(customer_id, open_booking) < 2 then
    raise exception 'Booking RLS hid the conversation from its customer';
  end if;
  if rate_lab.visible_messages(stranger_id, open_booking) <> 0
     or rate_lab.visible_messages(other_owner_id, open_booking) <> 0 then
    raise exception 'Booking RLS allowed an unrelated user to read messages';
  end if;

  select summary.found, summary.body, summary.counterpart
    into summary_found, summary_body, summary_name
  from rate_lab.summary_for(customer_id, open_booking) as summary;
  if summary_found is not true or summary_body is null or summary_name is distinct from 'North Lawn' then
    raise exception 'Customer summary was incomplete: % %', summary_body, summary_name;
  end if;
  select summary.found, summary.counterpart
    into summary_found, summary_name
  from rate_lab.summary_for(customer_id, other_booking) as summary;
  if summary_found is not true or summary_name is distinct from 'Other Lawn' then
    raise exception 'Customer summary attached the wrong provider: %', summary_name;
  end if;
  summary_found := null;
  summary_body := null;
  select summary.found, summary.body
    into summary_found, summary_body
  from rate_lab.summary_for(stranger_id, open_booking) as summary;
  if summary_found is true or summary_body is not null then
    raise exception 'Direct summary call leaked a conversation to a stranger';
  end if;
  summary_found := null;
  summary_body := null;
  select summary.found, summary.body
    into summary_found, summary_body
  from rate_lab.summary_for(other_owner_id, open_booking) as summary;
  if summary_found is true or summary_body is not null then
    raise exception 'Direct summary call leaked a conversation to another provider';
  end if;
  summary_found := null;
  select summary.found
    into summary_found
  from rate_lab.summary_for(other_owner_id, other_booking) as summary;
  if summary_found is not true then
    raise exception 'Provider summary omitted that provider''s own booking';
  end if;

  result := rate_lab.probe(null, 'anon', true, 'select count(*) from public.booking_messages');
  if result like 'rows:%' then
    raise exception 'Anonymous role read messages: %', result;
  end if;
  result := rate_lab.probe(null, 'anon', true, 'select count(*) from public.booking_message_reads');
  if result like 'rows:%' then
    raise exception 'Anonymous role read cursors: %', result;
  end if;
  result := rate_lab.probe(null, 'anon', true, 'select count(*) from public.booking_conversation_summaries()');
  if result like 'rows:%' then
    raise exception 'Anonymous role called the inbox function: %', result;
  end if;
  result := rate_lab.probe(stranger_id, 'authenticated', false, format(
    'insert into public.booking_messages (booking_id, sender_id, body) values (%L, %L, %L)',
    open_booking, stranger_id, 'secret phrase should not leak'
  ));
  if result = 'ok' or result like '%secret phrase%' then
    raise exception 'Unrelated insert leaked or succeeded: %', result;
  end if;
  result := rate_lab.probe(customer_id, 'authenticated', false, format(
    'insert into public.booking_messages (booking_id, sender_id, body, created_at) values (%L, %L, %L, %L)',
    open_booking, customer_id, 'backdated', '2000-01-01T00:00:00Z'
  ));
  if result is distinct from 'ok' then
    raise exception 'Participant backdated insert failed: %', result;
  end if;
  select message.created_at into backdated
  from public.booking_messages as message
  where message.booking_id = open_booking and message.body = 'backdated';
  if backdated is null or backdated < clock_timestamp() - interval '5 minutes' then
    raise exception 'Client-supplied created_at was stored: %', backdated;
  end if;
  perform rate_lab.mark_read(owner_id, open_booking);
  result := rate_lab.probe(stranger_id, 'authenticated', false, format(
    'insert into public.booking_message_reads (booking_id, reader_id) values (%L, %L)',
    open_booking, stranger_id
  ));
  if result = 'ok' then
    raise exception 'Unrelated user created a read cursor';
  end if;
  if exists (
    select 1 from public.booking_message_reads
    where booking_id = open_booking and reader_id = stranger_id
  ) then
    raise exception 'Unrelated read cursor was stored';
  end if;
  result := rate_lab.probe(customer_id, 'authenticated', false, format(
    'delete from public.booking_messages where booking_id = %L',
    open_booking
  ));
  if result = 'ok' then
    raise exception 'Participant deleted message history';
  end if;

  alter table public.booking_requests disable row level security;
  drop policy if exists bookings_select_message_lab on public.booking_requests;
end;
$tests$;

-- SPLIT:cleanup

delete from public.booking_messages
where booking_id in (
  'c1000011-0000-4000-8000-000000000011',
  'c1000012-0000-4000-8000-000000000012',
  'c1000013-0000-4000-8000-000000000013',
  'c1000014-0000-4000-8000-000000000014',
  'c1000015-0000-4000-8000-000000000015'
);
delete from public.booking_message_reads
where booking_id in (
  'c1000011-0000-4000-8000-000000000011',
  'c1000012-0000-4000-8000-000000000012',
  'c1000013-0000-4000-8000-000000000013',
  'c1000014-0000-4000-8000-000000000014',
  'c1000015-0000-4000-8000-000000000015'
);
delete from public.booking_requests
where id in (
  'c1000011-0000-4000-8000-000000000011',
  'c1000012-0000-4000-8000-000000000012',
  'c1000013-0000-4000-8000-000000000013',
  'c1000014-0000-4000-8000-000000000014',
  'c1000015-0000-4000-8000-000000000015'
);
delete from public.providers
where id in (
  'c1000007-0000-4000-8000-000000000007',
  'c1000008-0000-4000-8000-000000000008',
  'c1000009-0000-4000-8000-000000000009'
);
delete from public.profiles
where id in (
  'c1000001-0000-4000-8000-000000000001',
  'c1000002-0000-4000-8000-000000000002',
  'c1000003-0000-4000-8000-000000000003',
  'c1000004-0000-4000-8000-000000000004',
  'c1000005-0000-4000-8000-000000000005',
  'c1000006-0000-4000-8000-000000000006'
);
delete from public.rate_limit_counters
where bucket in (
  'sendMessage:user:c1000001-0000-4000-8000-000000000001',
  'sendMessage:user:c1000002-0000-4000-8000-000000000002',
  'sendMessage:user:c1000005-0000-4000-8000-000000000005',
  'sendMessage:user:c1000093-0000-4000-8000-000000000093',
  'sendMessage:user:c1000097-0000-4000-8000-000000000097'
);
delete from public.booking_messages
where booking_id in (
  'c1000092-0000-4000-8000-000000000092',
  'c1000094-0000-4000-8000-000000000094',
  'c1000095-0000-4000-8000-000000000095'
);
delete from public.booking_message_reads
where booking_id in (
  'c1000092-0000-4000-8000-000000000092',
  'c1000094-0000-4000-8000-000000000094',
  'c1000095-0000-4000-8000-000000000095'
);
delete from public.booking_requests
where id in (
  'c1000092-0000-4000-8000-000000000092',
  'c1000094-0000-4000-8000-000000000094',
  'c1000095-0000-4000-8000-000000000095'
);
delete from public.providers
where id in (
  'c1000091-0000-4000-8000-000000000091',
  'c1000096-0000-4000-8000-000000000096'
);
delete from public.profiles
where id in (
  'c1000090-0000-4000-8000-000000000090',
  'c1000093-0000-4000-8000-000000000093',
  'c1000097-0000-4000-8000-000000000097'
);
alter table public.booking_requests disable row level security;
drop policy if exists bookings_select_message_lab on public.booking_requests;
delete from rate_lab.sentinel
where id = 'c1000092-0000-4000-8000-000000000092';
