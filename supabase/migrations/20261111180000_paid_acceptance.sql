-- A booking can become accepted only after Stripe has confirmed a payment.
-- The check reads public.payments. It does not trust a status sent by the client.
-- It does not change commission, PINs, expiration, refunds, or transfers.
-- Safe to run again. Do not run this from the application.
--
-- BEFORE triggers on booking_requests run in trigger-name order.
-- bookings_protect_row and bookings_reject_unverified_completion run first.
-- This check then sees the status those triggers left in place.

create or replace function public.require_paid_acceptance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  confirmed_payment uuid;
begin
  if new.status is distinct from 'accepted' then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.status is not distinct from 'accepted' then
    return new;
  end if;

  -- Administrators skip bookings_protect_row, so this check has to reject the
  -- transition for every role, including service_role. A qualifying payment
  -- does not reopen a booking that already left the pending state.
  if tg_op = 'UPDATE' and old.status in ('expired', 'declined', 'cancelled', 'completed') then
    raise exception 'An expired, declined, cancelled, or completed booking cannot be accepted';
  end if;

  if tg_op = 'UPDATE' and old.status not in ('pending', 'requested') then
    raise exception 'Only a pending booking can be accepted';
  end if;

  -- Lock the confirming payment in this same statement. A refund or webhook
  -- update of that row waits until this booking change commits or rolls back.
  select payment.id
  into confirmed_payment
  from public.payments as payment
  where payment.booking_id = new.id
    and payment.status in ('succeeded', 'partially_refunded')
    and payment.refunded_cents < payment.amount_cents
  order by payment.created_at
  limit 1
  for update of payment;

  if not found then
    raise exception 'Acceptance requires a confirmed Stripe payment';
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_require_paid_acceptance on public.booking_requests;
drop trigger if exists bookings_require_paid_acceptance_insert on public.booking_requests;

create trigger bookings_require_paid_acceptance
  before update of status on public.booking_requests
  for each row
  when (new.status = 'accepted' and old.status is distinct from 'accepted')
  execute function public.require_paid_acceptance();

create trigger bookings_require_paid_acceptance_insert
  before insert on public.booking_requests
  for each row
  when (new.status = 'accepted')
  execute function public.require_paid_acceptance();

revoke all on function public.require_paid_acceptance() from public, anon, authenticated;

grant execute on function public.require_paid_acceptance() to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.require_paid_acceptance() to service_role;
  end if;
end
$$;
