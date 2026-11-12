-- Remove the recoverable completion PIN when a booking can no longer be completed.
-- The bcrypt hash, lockout counter, and verification function stay in place.
-- Accepted bookings keep pin_code so the customer can still read it.
-- Safe to run again. Does not change payments, refunds, or transfers.

create or replace function public.consume_completion_pin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and old.status is distinct from new.status
     and new.status in ('completed', 'expired', 'cancelled', 'declined') then
    update public.booking_completion_pins
    set pin_code = null,
        consumed_at = coalesce(consumed_at, now()),
        failed_attempts = case when new.status = 'completed' then 0 else failed_attempts end,
        locked_until = case when new.status = 'completed' then null else locked_until end
    where booking_id = new.id
      and (pin_code is not null or consumed_at is null);
  end if;

  return new;
end;
$$;

-- Clear plaintext already stored for bookings that are no longer completable.
-- Accepted bookings are not updated, so an active customer PIN stays readable.
update public.booking_completion_pins as pin
set pin_code = null,
    consumed_at = coalesce(pin.consumed_at, now())
from public.booking_requests as booking
where booking.id = pin.booking_id
  and booking.status in ('completed', 'expired', 'cancelled', 'declined')
  and pin.pin_code is not null;
