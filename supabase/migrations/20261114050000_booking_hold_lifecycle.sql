-- Unpaid holds expire sooner, a reservation and its booking commit together,
-- and an extra Stripe charge is stored without replacing the original payment.
-- This does not change commission, transfer rules, or existing booking rows.

create or replace function public.booking_hold_deadline(
  stored timestamptz,
  grace boolean,
  created_at timestamptz,
  appointment_start timestamptz,
  paid boolean
)
returns timestamptz
language sql
immutable
set search_path = public
as $$
  select case
    when grace then stored
    when paid or appointment_start is null then least(stored, coalesce(appointment_start, stored))
    else least(stored, appointment_start, created_at + interval '30 minutes')
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
  requested_refund_error text;
  issued_action text;
  effective_deadline timestamptz;
  appointment_start timestamptz;
  payment_confirmed boolean;
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

create or replace function public.claim_expired_bookings(batch_limit integer default 25)
returns table (expired_booking_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  target record;
  issued uuid;
  claimed integer := 0;
  limit_size integer := batch_limit;
begin
  if coalesce(auth.role(), '') is distinct from 'service_role' and not public.is_admin() then
    raise exception 'Not allowed to expire bookings';
  end if;
  if limit_size is null or limit_size < 1 or limit_size > 50 then
    limit_size := 25;
  end if;

  for target in
    select request.id
    from public.booking_requests as request
    where request.status = 'pending'
      and public.booking_hold_deadline(
        request.acceptance_deadline,
        request.expiration_grace,
        request.created_at,
        (
          select visit.starts_at
          from public.booking_appointments as visit
          where visit.booking_id = request.id
            and visit.status in ('held', 'confirmed')
        ),
        exists (
          select 1
          from public.payments as payment
          where payment.booking_id = request.id
            and payment.status in ('succeeded', 'partially_refunded')
            and payment.refunded_cents < payment.amount_cents
        )
      ) <= now()
    order by request.created_at
    limit (limit_size)
    for update of request skip locked
  loop
    issued := gen_random_uuid();
    insert into blockbooked_private.appointment_transition as transition (booking_id, action, nonce)
    values (target.id, 'expire', issued)
    on conflict on constraint appointment_transition_pkey do update
    set action = excluded.action,
        nonce = excluded.nonce;
    update public.booking_requests as request
    set status = 'expired'
    where request.id = target.id
      and request.status = 'pending';
    if exists (
      select 1
      from public.booking_requests as request
      where request.id = target.id
        and request.status = 'expired'
    ) then
      expired_booking_id := target.id;
      return next;
      claimed := claimed + 1;
    end if;
    update blockbooked_private.appointment_transition as transition
    set action = 'spent',
        nonce = gen_random_uuid()
    where transition.booking_id = target.id
      and transition.action = 'expire';
  end loop;
end;
$$;

create or replace function public.bookings_needing_expiration_refund(batch_limit integer default 25)
returns table (expired_booking_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  limit_size integer := batch_limit;
begin
  if coalesce(auth.role(), '') is distinct from 'service_role' and not public.is_admin() then
    raise exception 'Not allowed to read expiration refunds';
  end if;
  if limit_size is null or limit_size < 1 or limit_size > 50 then
    limit_size := 25;
  end if;
  return query
  select request.id
  from public.booking_requests as request
  where request.status in ('expired', 'cancelled', 'declined')
    and (
      request.expiration_refund_error is not null
      or exists (
        select 1
        from public.payments as succeeded_payment
        where succeeded_payment.booking_id = request.id
          and succeeded_payment.status in ('succeeded', 'partially_refunded')
          and succeeded_payment.refunded_cents < succeeded_payment.amount_cents
      )
    )
  order by request.expired_at desc nulls first
  limit (limit_size);
end;
$$;

create or replace function public.create_reserved_booking(
  target_provider uuid,
  preferred_day date,
  requested_window text,
  request_notes text,
  request_phone text,
  request_service text,
  request_receipt uuid,
  target_service uuid,
  visit_start timestamptz,
  visit_end timestamptz
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  created_id uuid;
  unpaid_holds integer;
begin
  if auth.uid() is null then
    raise exception 'Sign in required';
  end if;
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text), 440500);
  select count(*)
  into unpaid_holds
  from public.booking_requests as request
  join public.booking_appointments as visit on visit.booking_id = request.id
  where request.customer_id = auth.uid()
    and request.status = 'pending'
    and visit.status = 'held'
    and not exists (
      select 1
      from public.payments as payment
      where payment.booking_id = request.id
        and payment.status in ('succeeded', 'partially_refunded')
        and payment.refunded_cents < payment.amount_cents
    );
  if unpaid_holds >= 2 then
    raise exception 'Too many unpaid appointments are already held';
  end if;

  insert into public.booking_requests (
    customer_id,
    provider_id,
    preferred_date,
    time_window,
    notes,
    contact_phone,
    service_name,
    status,
    rate_limit_receipt
  )
  values (
    auth.uid(),
    target_provider,
    preferred_day,
    requested_window,
    request_notes,
    request_phone,
    request_service,
    'pending',
    request_receipt
  )
  returning id into created_id;

  insert into public.booking_appointments (
    booking_id,
    provider_id,
    service_id,
    starts_at,
    ends_at
  )
  values (
    created_id,
    target_provider,
    target_service,
    visit_start,
    visit_end
  );

  return created_id;
end;
$$;

create or replace function public.attach_booking_appointment(
  target_booking uuid,
  target_service uuid,
  visit_start timestamptz,
  visit_end timestamptz
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  owner uuid;
  provider uuid;
  unpaid_holds integer;
  created_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in required';
  end if;
  select request.customer_id, request.provider_id
  into owner, provider
  from public.booking_requests as request
  where request.id = target_booking
    and request.status = 'pending'
  for update;
  if owner is distinct from auth.uid() then
    raise exception 'Only a pending quote can reserve an appointment';
  end if;
  if exists (
    select 1
    from public.booking_appointments as visit
    where visit.booking_id = target_booking
      and visit.status in ('held', 'confirmed')
  ) then
    raise exception 'This request already holds an appointment';
  end if;
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text), 440500);
  select count(*)
  into unpaid_holds
  from public.booking_requests as request
  join public.booking_appointments as visit on visit.booking_id = request.id
  where request.customer_id = auth.uid()
    and request.status = 'pending'
    and visit.status = 'held'
    and not exists (
      select 1
      from public.payments as payment
      where payment.booking_id = request.id
        and payment.status in ('succeeded', 'partially_refunded')
        and payment.refunded_cents < payment.amount_cents
    );
  if unpaid_holds >= 2 then
    raise exception 'Too many unpaid appointments are already held';
  end if;
  insert into public.booking_appointments (
    booking_id,
    provider_id,
    service_id,
    starts_at,
    ends_at
  )
  values (
    target_booking,
    provider,
    target_service,
    visit_start,
    visit_end
  )
  returning id into created_id;
  return created_id;
end;
$$;

create or replace function public.enforce_unpaid_hold_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  customer uuid;
  unpaid_holds integer;
begin
  if tg_op is distinct from 'INSERT' or new.status is distinct from 'held' then
    return new;
  end if;
  select request.customer_id
  into customer
  from public.booking_requests as request
  where request.id = new.booking_id;
  if customer is null then
    raise exception 'Booking does not exist';
  end if;
  -- The appointment guard locks the booking first. This lock is second,
  -- matching attach_booking_appointment, so the two paths cannot deadlock.
  perform pg_advisory_xact_lock(hashtext(customer::text), 440500);
  select count(*)
  into unpaid_holds
  from public.booking_requests as request
  join public.booking_appointments as visit
    on visit.booking_id = request.id
  where request.customer_id = customer
    and request.status = 'pending'
    and visit.status = 'held'
    and not exists (
      select 1
      from public.payments as payment
      where payment.booking_id = request.id
        and payment.status in ('succeeded', 'partially_refunded')
        and payment.refunded_cents < payment.amount_cents
    );
  if unpaid_holds >= 2 then
    raise exception 'Too many unpaid appointments are already held';
  end if;
  return new;
end;
$$;

drop trigger if exists booking_appointments_unpaid_hold_limit on public.booking_appointments;

create trigger booking_appointments_unpaid_hold_limit
  before insert on public.booking_appointments
  for each row
  execute function public.enforce_unpaid_hold_limit();

revoke all on function public.enforce_unpaid_hold_limit() from public, anon, authenticated;

alter table public.refunds
  add column if not exists attempt_count integer not null default 0,
  add column if not exists next_retry_at timestamptz;

alter table public.refunds
  drop constraint if exists refunds_attempt_count_bounds;

alter table public.refunds
  add constraint refunds_attempt_count_bounds check (attempt_count between 0 and 8);

create table if not exists public.payment_extra_charges (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id),
  booking_id uuid not null references public.booking_requests (id),
  checkout_session_id text,
  payment_intent_id text not null,
  charge_id text,
  amount_cents integer not null check (amount_cents > 0),
  status text not null default 'refund_pending' check (status in ('refund_pending', 'refunded', 'needs_review')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 8),
  next_retry_at timestamptz,
  failure_reason text,
  stripe_refund_id text,
  created_at timestamptz not null default now(),
  constraint payment_extra_charges_intent_key unique (payment_intent_id)
);

create unique index if not exists payment_extra_charges_session_key
  on public.payment_extra_charges (checkout_session_id)
  where checkout_session_id is not null;

alter table public.payment_extra_charges enable row level security;
alter table public.payment_extra_charges force row level security;
revoke all on public.payment_extra_charges from public, anon, authenticated;

drop policy if exists payment_extra_charges_admin_select on public.payment_extra_charges;
create policy payment_extra_charges_admin_select
  on public.payment_extra_charges
  for select
  to authenticated
  using (public.is_admin());

grant select on public.payment_extra_charges to authenticated;

revoke all on function public.booking_hold_deadline(timestamptz, boolean, timestamptz, timestamptz, boolean) from public, anon;
grant execute on function public.booking_hold_deadline(timestamptz, boolean, timestamptz, timestamptz, boolean) to authenticated;

revoke all on function public.create_reserved_booking(uuid, date, text, text, text, text, uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.create_reserved_booking(uuid, date, text, text, text, text, uuid, uuid, timestamptz, timestamptz) to authenticated;

revoke all on function public.attach_booking_appointment(uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.attach_booking_appointment(uuid, uuid, timestamptz, timestamptz) to authenticated;

revoke all on function public.claim_expired_bookings(integer) from public, anon, authenticated;
revoke all on function public.bookings_needing_expiration_refund(integer) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.create_reserved_booking(uuid, date, text, text, text, text, uuid, uuid, timestamptz, timestamptz) from service_role;
    revoke all on function public.attach_booking_appointment(uuid, uuid, timestamptz, timestamptz) from service_role;
    grant select, insert, update on table public.payment_extra_charges to service_role;
    grant execute on function public.claim_expired_bookings(integer) to service_role;
    grant execute on function public.bookings_needing_expiration_refund(integer) to service_role;
  end if;
end
$$;
