-- Persist completion-PIN lockouts. Run after 20261110190000_completion_pins.sql.
-- Does not delete accounts, providers, bookings, or completion rows.
--
-- The previous check updated failed_attempts in the same transaction as PIN
-- verification. An error from crypt() or from the booking trigger aborted that
-- transaction and discarded the counter, so the lockout never started.

do $$
begin
  if to_regclass('public.booking_completion_pins') is null then
    raise exception 'Apply 20261110190000_completion_pins.sql before this file';
  end if;
end $$;

alter table public.booking_completion_pins
  add column if not exists failed_attempts integer not null default 0;

alter table public.booking_completion_pins
  add column if not exists locked_until timestamptz;

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
        consumed_at = coalesce(consumed_at, now()),
        failed_attempts = 0,
        locked_until = null
    where booking_id = new.id;
  end if;

  return new;
end;
$$;

create or replace function public.complete_booking_with_pin(target_booking uuid, submitted_pin text)
returns text
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  booking public.booking_requests%rowtype;
  secret public.booking_completion_pins%rowtype;
  matched boolean := false;
  next_attempts integer;
  next_lock timestamptz;
  updated_status text;
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

  begin
    perform set_config('row_security', 'off', true);
  exception
    when others then
      null;
  end;

  select * into secret
  from public.booking_completion_pins
  where booking_id = target_booking
  for update;

  if not found or secret.consumed_at is not null or secret.pin_hash is null then
    return 'unavailable';
  end if;

  -- Reject the submitted PIN, correct or not, until the stored lock expires.
  if secret.locked_until is not null and secret.locked_until > transaction_timestamp() then
    return 'locked:' || to_char(secret.locked_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  end if;

  if secret.locked_until is not null and secret.locked_until <= transaction_timestamp() then
    update public.booking_completion_pins
    set failed_attempts = 0,
        locked_until = null
    where booking_id = target_booking;
    secret.failed_attempts := 0;
    secret.locked_until := null;
  end if;

  begin
    matched := secret.pin_hash = crypt(submitted_pin, secret.pin_hash);
  exception
    when others then
      matched := false;
  end;

  if matched is not true then
    update public.booking_completion_pins as pins
    set failed_attempts = coalesce(pins.failed_attempts, 0) + 1,
        locked_until = case
          when coalesce(pins.failed_attempts, 0) + 1 >= 5
            then clock_timestamp() + interval '15 minutes'
          else null
        end
    where pins.booking_id = target_booking
      and pins.consumed_at is null
    returning pins.failed_attempts, pins.locked_until
    into next_attempts, next_lock;

    if not found then
      return 'unavailable';
    end if;

    if next_lock is not null then
      return 'locked:' || to_char(next_lock at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
    end if;

    return 'incorrect:' || next_attempts::text;
  end if;

  begin
    perform set_config('blockbooked.pin_verified', '1', true);

    update public.booking_requests
    set status = 'completed',
        completed_at = clock_timestamp()
    where id = target_booking
      and status = 'accepted'
    returning status into updated_status;

    if updated_status is distinct from 'completed' then
      return 'error';
    end if;
  exception
    when others then
      return 'error';
  end;

  update public.booking_completion_pins
  set failed_attempts = 0,
      locked_until = null
  where booking_id = target_booking;

  return 'completed';
end;
$$;

revoke all on function public.complete_booking_with_pin(uuid, text) from public, anon;
grant execute on function public.complete_booking_with_pin(uuid, text) to authenticated;
