-- Fix provider approval of a reschedule request.
-- Run after 20261110270000_expiration_reschedule.sql.
-- Does not change payments, refunds, transfers, or existing reschedule rows.
--
-- guard_reschedule_request() declares row variables named booking and
-- appointment. Its approval check used those same names as table aliases, so
-- appointment.booking_id matched both the variable and the column:
--   column reference "booking_id" is ambiguous
-- The appointment row is still moved by decide_reschedule before this check.
-- Approval only records that the confirmed row already has the requested time.

create or replace function public.guard_reschedule_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  booking public.booking_requests%rowtype;
  appointment public.booking_appointments%rowtype;
  service public.provider_services%rowtype;
  paid_cents integer;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is null then
      raise exception 'Sign in to request a new time';
    end if;
    select * into booking
    from public.booking_requests
    where id = new.booking_id
    for update;
    if not found or booking.customer_id is distinct from auth.uid() then
      raise exception 'You can only reschedule your own booking';
    end if;
    if booking.status is distinct from 'accepted' then
      raise exception 'Only an accepted appointment can be rescheduled';
    end if;
    select * into appointment
    from public.booking_appointments as confirmed_visit
    where confirmed_visit.booking_id = new.booking_id
      and confirmed_visit.status = 'confirmed';
    if not found then
      raise exception 'This booking has no confirmed appointment to reschedule';
    end if;
    select * into service
    from public.provider_services
    where id = new.service_id
      and provider_id = booking.provider_id
      and active = true
      and duration_minutes is not null;
    if not found then
      raise exception 'Choose an active service that has a duration';
    end if;
    if new.ends_at is distinct from new.starts_at + make_interval(mins => service.duration_minutes) then
      raise exception 'Appointment length must match the service duration';
    end if;
    select coalesce(sum(payment.amount_cents), null)
    into paid_cents
    from public.payments as payment
    where payment.booking_id = new.booking_id
      and payment.status in ('succeeded', 'partially_refunded');
    new.customer_id := auth.uid();
    new.status := 'pending';
    new.original_starts_at := appointment.starts_at;
    new.requested_price_cents := service.price_cents;
    new.price_adjustment_required := service.price_cents is distinct from paid_cents;
    new.decided_at := null;
    return new;
  end if;

  if new.booking_id is distinct from old.booking_id
    or new.customer_id is distinct from old.customer_id
    or new.service_id is distinct from old.service_id
    or new.starts_at is distinct from old.starts_at
    or new.ends_at is distinct from old.ends_at
    or new.original_starts_at is distinct from old.original_starts_at
    or new.original_price_cents is distinct from old.original_price_cents
    or new.requested_price_cents is distinct from old.requested_price_cents
    or new.price_adjustment_required is distinct from old.price_adjustment_required
    or new.created_at is distinct from old.created_at then
    raise exception 'Reschedule details cannot be edited';
  end if;

  if old.status is distinct from 'pending' then
    new.status := old.status;
    new.decided_at := old.decided_at;
    return new;
  end if;

  if new.status = 'cancelled' and old.customer_id = auth.uid() then
    new.decided_at := now();
    return new;
  end if;

  if new.status = 'declined' and public.owns_provider(
    (select provider_id from public.booking_requests where id = old.booking_id)
  ) then
    new.decided_at := now();
    return new;
  end if;

  if new.status = 'approved' and exists (
    select 1
    from public.booking_appointments as confirmed_visit
    join public.booking_requests as booked_request
      on booked_request.id = confirmed_visit.booking_id
    where confirmed_visit.booking_id = old.booking_id
      and confirmed_visit.status = 'confirmed'
      and confirmed_visit.service_id = old.service_id
      and confirmed_visit.starts_at = old.starts_at
      and confirmed_visit.ends_at = old.ends_at
      and public.owns_provider(booked_request.provider_id)
  ) then
    new.decided_at := now();
    return new;
  end if;

  new.status := old.status;
  new.decided_at := old.decided_at;
  return new;
end;
$$;

revoke all on function public.guard_reschedule_request() from public, anon, authenticated, service_role;
