-- Customer-verified completion. Run after the booking status migration.
-- Does not delete bookings, accounts, or listings. Safe to run again.

create extension if not exists pgcrypto;

alter table public.booking_requests
  add column if not exists completed_at timestamptz;

alter table public.booking_requests
  add column if not exists review_requested_at timestamptz;

alter table public.booking_requests
  add column if not exists review_note text;

create table if not exists public.booking_completion_pins (
  booking_id uuid primary key references public.booking_requests (id) on delete cascade,
  customer_id uuid not null references public.profiles (id) on delete cascade,
  pin_code text,
  pin_hash text not null,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint completion_pin_attempts_nonnegative check (failed_attempts >= 0),
  constraint completion_pin_code_format check (pin_code is null or pin_code ~ '^[0-9]{6}$')
);

create or replace function public.generate_completion_pin()
returns text
language plpgsql
set search_path = public, extensions
as $$
declare
  raw bytea;
  value bigint;
begin
  loop
    raw := gen_random_bytes(4);
    value := (get_byte(raw, 0)::bigint << 24)
      + (get_byte(raw, 1)::bigint << 16)
      + (get_byte(raw, 2)::bigint << 8)
      + get_byte(raw, 3)::bigint;
    exit when value < 4294000000;
  end loop;

  return lpad((value % 1000000)::text, 6, '0');
end;
$$;

create or replace function public.hash_completion_pin(pin text)
returns text
language sql
security definer
set search_path = public, extensions
as $$
  select crypt(pin, gen_salt('bf', 8));
$$;

create or replace function public.issue_completion_pin()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  generated text;
begin
  if new.status = 'accepted'
     and (tg_op = 'INSERT' or old.status is distinct from 'accepted')
     and not exists (
       select 1 from public.booking_completion_pins where booking_id = new.id
     ) then
    generated := public.generate_completion_pin();
    insert into public.booking_completion_pins (booking_id, customer_id, pin_code, pin_hash)
    values (new.id, new.customer_id, generated, public.hash_completion_pin(generated));
  end if;

  return new;
end;
$$;

create or replace function public.consume_completion_pin()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    update public.booking_completion_pins
    set pin_code = null,
        consumed_at = coalesce(consumed_at, now())
    where booking_id = new.id;
  end if;

  return new;
end;
$$;

create or replace function public.protect_booking_row()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  actor_owns_provider boolean;
  requested_status text;
  requested_completed_at timestamptz;
  requested_review_at timestamptz;
  requested_review_note text;
begin
  if tg_op = 'INSERT' and not public.is_admin() then
    new.status := 'pending';
    new.completed_at := null;
    new.review_requested_at := null;
    new.review_note := null;
  elsif tg_op = 'UPDATE' and not public.is_admin() then
    requested_status := new.status;
    requested_completed_at := new.completed_at;
    requested_review_at := new.review_requested_at;
    requested_review_note := new.review_note;

    new.id := old.id;
    new.customer_id := old.customer_id;
    new.provider_id := old.provider_id;
    new.preferred_date := old.preferred_date;
    new.time_window := old.time_window;
    new.notes := old.notes;
    new.contact_phone := old.contact_phone;
    new.service_name := old.service_name;
    new.created_at := old.created_at;
    new.completed_at := old.completed_at;
    new.review_requested_at := old.review_requested_at;
    new.review_note := old.review_note;
    new.status := old.status;

    if requested_status = 'completed'
       and old.status is distinct from 'completed'
       and current_setting('blockbooked.pin_verified', true) is distinct from '1' then
      raise exception 'Completion requires the customer PIN';
    end if;

    actor_owns_provider := public.owns_provider(old.provider_id);

    if current_setting('blockbooked.pin_verified', true) = '1'
       and actor_owns_provider
       and old.status = 'accepted'
       and requested_status = 'completed' then
      new.status := 'completed';
      new.completed_at := coalesce(requested_completed_at, now());
    elsif current_setting('blockbooked.review_request', true) = '1'
       and actor_owns_provider
       and old.status = 'accepted'
       and requested_status = 'accepted' then
      new.review_requested_at := coalesce(requested_review_at, now());
      new.review_note := requested_review_note;
    elsif old.customer_id = auth.uid() and not actor_owns_provider then
      if old.status in ('pending', 'requested') and requested_status = 'cancelled' then
        new.status := 'cancelled';
      end if;
    elsif actor_owns_provider then
      if old.status in ('pending', 'requested') and requested_status in ('accepted', 'declined') then
        new.status := requested_status;
      elsif old.status in ('pending', 'requested')
         and old.customer_id = auth.uid()
         and requested_status = 'cancelled' then
        new.status := 'cancelled';
      end if;
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.complete_booking_with_pin(target_booking uuid, submitted_pin text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  booking public.booking_requests%rowtype;
  secret public.booking_completion_pins%rowtype;
  attempts integer;
begin
  if auth.uid() is null then
    return 'forbidden';
  end if;

  if submitted_pin is null or submitted_pin !~ '^[0-9]{6}$' then
    return 'invalid_format';
  end if;

  select * into booking
  from public.booking_requests
  where id = target_booking;

  if not found then
    return 'not_found';
  end if;

  if not public.owns_provider(booking.provider_id) then
    return 'forbidden';
  end if;

  if booking.status is distinct from 'accepted' then
    return 'not_accepted';
  end if;

  select * into secret
  from public.booking_completion_pins
  where booking_id = target_booking
  for update;

  if not found or secret.consumed_at is not null or secret.pin_hash is null then
    return 'unavailable';
  end if;

  if secret.locked_until is not null and secret.locked_until > now() then
    return 'locked';
  end if;

  attempts := secret.failed_attempts;
  if secret.locked_until is not null and secret.locked_until <= now() then
    attempts := 0;
  end if;

  if secret.pin_hash is distinct from crypt(submitted_pin, secret.pin_hash) then
    update public.booking_completion_pins
    set failed_attempts = attempts + 1,
        locked_until = case
          when attempts + 1 >= 5 then now() + interval '15 minutes'
          else null
        end
    where booking_id = target_booking;
    return 'incorrect';
  end if;

  perform set_config('blockbooked.pin_verified', '1', true);

  update public.booking_requests
  set status = 'completed',
      completed_at = now()
  where id = target_booking
    and status = 'accepted';

  if not found then
    return 'not_accepted';
  end if;

  return 'completed';
end;
$$;

create or replace function public.request_completion_review(target_booking uuid, note text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  booking public.booking_requests%rowtype;
begin
  if auth.uid() is null then
    return 'forbidden';
  end if;

  select * into booking
  from public.booking_requests
  where id = target_booking;

  if not found then
    return 'not_found';
  end if;

  if not public.owns_provider(booking.provider_id) then
    return 'forbidden';
  end if;

  if booking.status is distinct from 'accepted' then
    return 'not_accepted';
  end if;

  if booking.review_requested_at is not null then
    return 'already_requested';
  end if;

  perform set_config('blockbooked.review_request', '1', true);

  update public.booking_requests
  set review_requested_at = now(),
      review_note = left(coalesce(note, ''), 500)
  where id = target_booking
    and status = 'accepted';

  return 'requested';
end;
$$;

drop trigger if exists bookings_issue_pin on public.booking_requests;
create trigger bookings_issue_pin
  after insert or update of status on public.booking_requests
  for each row execute function public.issue_completion_pin();

drop trigger if exists bookings_consume_pin on public.booking_requests;
create trigger bookings_consume_pin
  after update of status on public.booking_requests
  for each row execute function public.consume_completion_pin();

do $$
declare
  booking record;
  generated text;
begin
  for booking in
    select id, customer_id
    from public.booking_requests
    where status = 'accepted'
      and not exists (
        select 1
        from public.booking_completion_pins as existing
        where existing.booking_id = booking_requests.id
      )
  loop
    generated := public.generate_completion_pin();
    insert into public.booking_completion_pins (booking_id, customer_id, pin_code, pin_hash)
    values (booking.id, booking.customer_id, generated, public.hash_completion_pin(generated));
  end loop;
end $$;

create or replace view public.customer_completion_pins
with (security_invoker = false) as
select booking_id, pin_code
from public.booking_completion_pins
where customer_id = auth.uid()
  and consumed_at is null
  and pin_code is not null;

alter table public.booking_completion_pins enable row level security;

drop policy if exists completion_pins_customer_select on public.booking_completion_pins;
create policy completion_pins_customer_select
  on public.booking_completion_pins
  for select
  to authenticated
  using (customer_id = auth.uid());

revoke all on public.booking_completion_pins from public, anon, authenticated;
revoke all on public.customer_completion_pins from public, anon;
grant select on public.customer_completion_pins to authenticated;

revoke all on function public.generate_completion_pin() from public;
revoke all on function public.hash_completion_pin(text) from public;
revoke all on function public.complete_booking_with_pin(uuid, text) from public;
revoke all on function public.request_completion_review(uuid, text) from public;
grant execute on function public.complete_booking_with_pin(uuid, text) to authenticated;
grant execute on function public.request_completion_review(uuid, text) to authenticated;
