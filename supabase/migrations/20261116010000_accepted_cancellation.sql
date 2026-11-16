-- Customers can cancel an accepted booking for a full refund when its confirmed
-- appointment starts at least 24 hours from the database clock. Pending
-- cancellation, refunds, and appointment release stay on their existing paths.

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
  requested_refund_error text;
  issued_action text;
  effective_deadline timestamptz;
  appointment_start timestamptz;
  payment_confirmed boolean;
  confirmed_count integer;
begin
  if tg_op = 'INSERT' and not public.is_admin() then
    new.status := 'pending';
    new.completed_at := null;
    new.review_requested_at := null;
    new.review_note := null;
    new.acceptance_deadline := coalesce(new.created_at, now()) + interval '24 hours';
    new.expiration_grace := false;
    new.expired_at := null;
    new.expiration_refund_error := null;
  elsif tg_op = 'UPDATE' and not public.is_admin() then
    requested_status := new.status;
    requested_completed_at := new.completed_at;
    requested_review_at := new.review_requested_at;
    requested_review_note := new.review_note;
    requested_refund_error := new.expiration_refund_error;

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
    new.acceptance_deadline := old.acceptance_deadline;
    new.expiration_grace := old.expiration_grace;
    new.expired_at := old.expired_at;
    new.expiration_refund_error := old.expiration_refund_error;
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
    elsif old.status = 'pending' and requested_status = 'expired' then
      select transition.action
      into issued_action
      from blockbooked_private.appointment_transition as transition
      where transition.booking_id = old.id
      for update;
      select appointment.starts_at
      into appointment_start
      from public.booking_appointments as appointment
      where appointment.booking_id = old.id
        and appointment.status in ('held', 'confirmed');
      select exists (
        select 1
        from public.payments as payment
        where payment.booking_id = old.id
          and payment.status in ('succeeded', 'partially_refunded')
          and payment.refunded_cents < payment.amount_cents
      )
      into payment_confirmed;
      effective_deadline := public.booking_hold_deadline(
        old.acceptance_deadline,
        old.expiration_grace,
        old.created_at,
        appointment_start,
        payment_confirmed
      );
      if issued_action = 'expire' and effective_deadline <= now() then
        new.status := 'expired';
        new.expired_at := now();
      end if;
    elsif old.status in ('expired', 'cancelled', 'declined')
      and requested_status = old.status
      and auth.uid() is null then
      new.expiration_refund_error := nullif(left(coalesce(requested_refund_error, ''), 500), '');
    elsif old.customer_id = auth.uid()
      and old.status = 'accepted'
      and requested_status = 'cancelled' then
      -- Lock the booking's confirmed visits before reading the clock. The booking
      -- row is already locked by this update. A customer-supplied time is ignored.
      perform 1
      from public.booking_appointments as appointment
      where appointment.booking_id = old.id
        and appointment.status = 'confirmed'
      for update;
      select count(*)::integer, min(appointment.starts_at)
      into confirmed_count, appointment_start
      from public.booking_appointments as appointment
      where appointment.booking_id = old.id
        and appointment.status = 'confirmed';
      if confirmed_count > 0
         and appointment_start is not null
         and appointment_start >= now() + interval '24 hours' then
        new.status := 'cancelled';
      else
        raise exception 'An accepted booking can be cancelled for a full refund only when a confirmed appointment starts at least 24 hours from now.';
      end if;
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
