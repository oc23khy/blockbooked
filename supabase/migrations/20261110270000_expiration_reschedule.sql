-- Pending-request expiration and provider-approved rescheduling.
-- Run after 20261110260000_provider_schedules.sql.
-- Additive. Does not change payments, refunds, transfers, quotes, milestones,
-- completion PINs, or the 8% commission. Does not delete bookings or payments.
-- Replacing booking_status_known and appointment_transition_action_known only
-- adds allowed values. It does not rewrite or delete rows.
-- Safe to run again. Do not run this from the application.

alter table public.booking_requests
  add column if not exists acceptance_deadline timestamptz,
  add column if not exists expired_at timestamptz,
  add column if not exists expiration_refund_error text,
  add column if not exists expiration_grace boolean not null default false;

-- Existing pending requests get 24 hours from this migration, not from their
-- original request time. The first worker run therefore does not expire or
-- refund them immediately. New requests do not receive this grace: their
-- deadline is 24 hours after creation, or the appointment start if sooner.
update public.booking_requests
set acceptance_deadline = now() + interval '24 hours',
    expiration_grace = true
where status = 'pending'
  and acceptance_deadline is null;

update public.booking_requests
set acceptance_deadline = created_at + interval '24 hours',
    expiration_grace = false
where acceptance_deadline is null;

create or replace function public.effective_acceptance_deadline(
  stored timestamptz,
  grace boolean,
  appointment_start timestamptz
)
returns timestamptz
language sql
immutable
set search_path = public
as $$
  select case
    when grace then stored
    else least(stored, coalesce(appointment_start, stored))
  end;
$$;

alter table public.booking_requests
  alter column acceptance_deadline set not null;

alter table public.booking_requests
  drop constraint if exists booking_status_known;

alter table public.booking_requests
  add constraint booking_status_known
  check (status in ('pending', 'accepted', 'declined', 'completed', 'cancelled', 'expired'));

alter table blockbooked_private.appointment_transition
  drop constraint if exists appointment_transition_action_known;

alter table blockbooked_private.appointment_transition
  add constraint appointment_transition_action_known
  check (action in ('confirm', 'release', 'spent', 'expire', 'reschedule'));

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
      select public.effective_acceptance_deadline(
        old.acceptance_deadline,
        old.expiration_grace,
        (
          select appointment.starts_at
          from public.booking_appointments as appointment
          where appointment.booking_id = old.id
            and appointment.status in ('held', 'confirmed')
        )
      )
      into effective_deadline;
      if issued_action = 'expire' and effective_deadline <= now() then
        new.status := 'expired';
        new.expired_at := now();
      end if;
    elsif old.status = 'expired' and requested_status = 'expired' and auth.uid() is null then
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

create or replace function public.sync_booking_appointment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  issued_nonce uuid := gen_random_uuid();
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    insert into blockbooked_private.appointment_transition as transition (booking_id, action, nonce)
    values (new.id, 'confirm', issued_nonce)
    on conflict (booking_id) do update
    set action = excluded.action,
        nonce = excluded.nonce;
    update public.booking_appointments
    set status = 'confirmed', transition_nonce = issued_nonce
    where booking_id = new.id
      and status = 'held';
    update blockbooked_private.appointment_transition as transition
    set action = 'spent',
        nonce = gen_random_uuid()
    where transition.booking_id = new.id
      and transition.nonce = issued_nonce;
  elsif new.status in ('declined', 'cancelled', 'expired') and old.status is distinct from new.status then
    issued_nonce := gen_random_uuid();
    insert into blockbooked_private.appointment_transition as transition (booking_id, action, nonce)
    values (new.id, 'release', issued_nonce)
    on conflict (booking_id) do update
    set action = excluded.action,
        nonce = excluded.nonce;
    update public.booking_appointments
    set status = 'released', transition_nonce = issued_nonce
    where booking_id = new.id
      and status in ('held', 'confirmed');
    update blockbooked_private.appointment_transition as transition
    set action = 'spent',
        nonce = gen_random_uuid()
    where transition.booking_id = new.id
      and transition.nonce = issued_nonce;
  end if;
  return new;
end;
$$;

create or replace function public.claim_expired_bookings(batch_limit integer default 25)
returns table (booking_id uuid)
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
    select booking.id
    from public.booking_requests as booking
    where booking.status = 'pending'
      and public.effective_acceptance_deadline(
        booking.acceptance_deadline,
        booking.expiration_grace,
        (
          select appointment.starts_at
          from public.booking_appointments as appointment
          where appointment.booking_id = booking.id
            and appointment.status in ('held', 'confirmed')
        )
      ) <= now()
    order by booking.created_at
    limit (limit_size)
    for update of booking skip locked
  loop
    issued := gen_random_uuid();
    insert into blockbooked_private.appointment_transition as transition (booking_id, action, nonce)
    values (target.id, 'expire', issued)
    on conflict (booking_id) do update
    set action = excluded.action,
        nonce = excluded.nonce;
    update public.booking_requests
    set status = 'expired'
    where id = target.id
      and status = 'pending';
    -- The protect trigger can keep the row pending. FOUND only means a row
    -- was matched, so read the status back before reporting it as expired.
    -- A provider acceptance that committed first stays accepted.
    if exists (
      select 1
      from public.booking_requests as booking
      where booking.id = target.id
        and booking.status = 'expired'
    ) then
      booking_id := target.id;
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

revoke all on function public.claim_expired_bookings(integer) from public, anon, authenticated;

create or replace function public.bookings_needing_expiration_refund(batch_limit integer default 25)
returns table (booking_id uuid)
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
  select booking.id
  from public.booking_requests as booking
  where booking.status = 'expired'
    and (
      booking.expiration_refund_error is not null
      or exists (
        select 1
        from public.payments as payment
        where payment.booking_id = booking.id
          and payment.status in ('succeeded', 'partially_refunded')
          and payment.refunded_cents < payment.amount_cents
      )
    )
  order by booking.expired_at desc nulls first
  limit (limit_size);
end;
$$;

revoke all on function public.claim_expired_bookings(integer) from public, anon, authenticated;
revoke all on function public.bookings_needing_expiration_refund(integer) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.claim_expired_bookings(integer) to service_role;
    grant execute on function public.bookings_needing_expiration_refund(integer) to service_role;
  end if;
end $$;

-- A requested replacement is not reserved. The confirmed row stays in place
-- until decide_reschedule moves it under the reschedule nonce.
create table if not exists public.booking_reschedule_requests (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.booking_requests (id) on delete cascade,
  customer_id uuid not null references public.profiles (id),
  service_id uuid not null references public.provider_services (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  original_starts_at timestamptz not null,
  original_price_cents integer,
  requested_price_cents integer,
  price_adjustment_required boolean not null default false,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint booking_reschedule_status_known check (status in ('pending', 'approved', 'declined', 'cancelled')),
  constraint booking_reschedule_range check (ends_at > starts_at)
);

create unique index if not exists booking_reschedule_one_pending
  on public.booking_reschedule_requests (booking_id)
  where status = 'pending';

create index if not exists booking_reschedule_booking_idx
  on public.booking_reschedule_requests (booking_id, created_at desc);

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
    from public.booking_appointments
    where booking_id = new.booking_id
      and status = 'confirmed';
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
    new.original_price_cents := paid_cents;
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
    from public.booking_appointments as appointment
    join public.booking_requests as booking on booking.id = appointment.booking_id
    where appointment.booking_id = old.booking_id
      and appointment.status = 'confirmed'
      and appointment.service_id = old.service_id
      and appointment.starts_at = old.starts_at
      and appointment.ends_at = old.ends_at
      and public.owns_provider(booking.provider_id)
  ) then
    new.decided_at := now();
    return new;
  end if;

  new.status := old.status;
  new.decided_at := old.decided_at;
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'booking_reschedule_guard'
      and tgrelid = 'public.booking_reschedule_requests'::regclass
      and not tgisinternal
  ) then
    create trigger booking_reschedule_guard
      before insert or update on public.booking_reschedule_requests
      for each row execute function public.guard_reschedule_request();
  end if;
end $$;

create or replace function public.decide_reschedule(request_id uuid, approve boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  request public.booking_reschedule_requests%rowtype;
  booking public.booking_requests%rowtype;
  original public.booking_appointments%rowtype;
  issued uuid;
  failure text;
begin
  if auth.uid() is null then
    return 'forbidden';
  end if;

  select * into request
  from public.booking_reschedule_requests
  where id = request_id
  for update;

  if not found then
    return 'not_found';
  end if;
  if request.status is distinct from 'pending' then
    return 'not_pending';
  end if;

  select * into booking
  from public.booking_requests
  where id = request.booking_id
  for update;

  if not found or not public.owns_provider(booking.provider_id) then
    return 'forbidden';
  end if;
  if booking.status is distinct from 'accepted' then
    return 'not_accepted';
  end if;

  if not approve then
    update public.booking_reschedule_requests
    set status = 'declined'
    where id = request_id
      and status = 'pending';
    if not exists (
      select 1
      from public.booking_reschedule_requests
      where id = request_id
        and status = 'declined'
    ) then
      return 'forbidden';
    end if;
    return 'declined';
  end if;

  -- Payments, refunds, and transfers are not updated here. A different price
  -- stays on the request as price_adjustment_required and needs a separate
  -- approved adjustment. Approval only moves the confirmed appointment.
  issued := gen_random_uuid();
  insert into blockbooked_private.appointment_transition as transition (booking_id, action, nonce)
  values (request.booking_id, 'reschedule', issued)
  on conflict (booking_id) do update
  set action = excluded.action,
      nonce = excluded.nonce;

  select * into original
  from public.booking_appointments
  where booking_id = request.booking_id
    and status = 'confirmed'
  for update;

  if not found then
    update blockbooked_private.appointment_transition
    set action = 'spent',
        nonce = gen_random_uuid()
    where booking_id = request.booking_id
      and nonce = issued;
    return 'unavailable';
  end if;

  begin
    update public.booking_appointments
    set service_id = request.service_id,
        starts_at = request.starts_at,
        ends_at = request.ends_at,
        status = 'confirmed',
        transition_nonce = issued
    where booking_id = request.booking_id
      and status = 'confirmed';
  exception
    when exclusion_violation then
      failure := 'That time overlaps another appointment.';
    when raise_exception then
      get stacked diagnostics failure = message_text;
      failure := coalesce(nullif(failure, ''), 'The appointment could not be moved.');
  end;

  if not exists (
    select 1
    from public.booking_appointments as appointment
    where appointment.booking_id = request.booking_id
      and appointment.status = 'confirmed'
      and appointment.service_id = request.service_id
      and appointment.starts_at = request.starts_at
      and appointment.ends_at = request.ends_at
  ) then
    if not exists (
      select 1
      from public.booking_appointments as appointment
      where appointment.booking_id = request.booking_id
        and appointment.status = 'confirmed'
        and appointment.service_id = original.service_id
        and appointment.starts_at = original.starts_at
        and appointment.ends_at = original.ends_at
    ) then
      raise exception 'Reschedule did not reserve the requested time. %', coalesce(failure, 'The appointment row changed.');
    end if;
    raise exception '% The original appointment is unchanged.',
      coalesce(failure, 'The appointment could not be moved.')
      using errcode = 'P0001';
  end if;

  update public.booking_reschedule_requests
  set status = 'approved'
  where id = request_id
    and status = 'pending';

  if not exists (
    select 1
    from public.booking_reschedule_requests
    where id = request_id
      and status = 'approved'
  ) then
    raise exception 'Reschedule did not reserve the requested time';
  end if;

  update blockbooked_private.appointment_transition
  set action = 'spent',
      nonce = gen_random_uuid()
  where booking_id = request.booking_id
    and nonce = issued;

  return 'approved';
end;
$$;

revoke all on function public.decide_reschedule(uuid, boolean) from public, anon;
grant execute on function public.decide_reschedule(uuid, boolean) to authenticated;

-- Reschedule is allowed only through the private nonce. Every other time edit
-- still fails. The new range is checked against other held and confirmed rows,
-- so the exclusion constraint still prevents a double booking.
create or replace function public.guard_booking_appointment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  booking public.booking_requests%rowtype;
  provider public.providers%rowtype;
  service public.provider_services%rowtype;
  settings public.provider_schedule_settings%rowtype;
  issued_action text;
  issued_nonce uuid;
  start_local timestamp;
  end_local timestamp;
  start_minute integer;
  end_minute integer;
  local_weekday integer;
begin
  if tg_op = 'DELETE' then
    raise exception 'Appointments cannot be removed. Decline or cancel the booking to release the time.';
  end if;

  if tg_op = 'UPDATE' then
    if new.booking_id is distinct from old.booking_id
      or new.provider_id is distinct from old.provider_id
      or new.created_at is distinct from old.created_at then
      raise exception 'Appointment times cannot be changed. Rescheduling is not available yet.';
    end if;

    select transition.action, transition.nonce
    into issued_action, issued_nonce
    from blockbooked_private.appointment_transition as transition
    where transition.booking_id = old.booking_id
    for update;

    if old.status = 'confirmed'
      and new.status = 'confirmed'
      and issued_action = 'reschedule'
      and issued_nonce is not null
      and new.transition_nonce = issued_nonce then
      select * into booking
      from public.booking_requests
      where id = new.booking_id
      for update;
      if not found or booking.status is distinct from 'accepted' then
        raise exception 'Only an accepted booking can be rescheduled';
      end if;
      if not exists (
        select 1
        from public.booking_reschedule_requests as pending_request
        where pending_request.booking_id = new.booking_id
          and pending_request.status = 'pending'
          and pending_request.service_id = new.service_id
          and pending_request.starts_at = new.starts_at
          and pending_request.ends_at = new.ends_at
      ) then
        raise exception 'Reschedule does not match a pending request';
      end if;
      select * into provider
      from public.providers
      where id = new.provider_id
      for update;
      if not found or provider.status <> 'approved' then
        raise exception 'Provider is not available for booking';
      end if;
      select * into service
      from public.provider_services
      where id = new.service_id
        and provider_id = new.provider_id
        and active = true;
      if not found or service.duration_minutes is null then
        raise exception 'Choose an active service that has a duration';
      end if;
      if new.starts_at <> date_trunc('minute', new.starts_at)
        or new.ends_at <> date_trunc('minute', new.ends_at)
        or new.ends_at <> new.starts_at + make_interval(mins => service.duration_minutes) then
        raise exception 'Appointment length must match the service duration';
      end if;
      select * into settings
      from public.provider_schedule_settings
      where provider_id = new.provider_id;
      if not found then
        raise exception 'Provider has not published a schedule';
      end if;
      if new.starts_at < now() + make_interval(mins => settings.min_notice_minutes) then
        raise exception 'Appointment is inside the minimum notice period';
      end if;
      if new.starts_at > now() + make_interval(days => settings.max_advance_days) then
        raise exception 'Appointment is outside the booking window';
      end if;
      start_local := new.starts_at at time zone provider.timezone;
      end_local := new.ends_at at time zone provider.timezone;
      if start_local::date <> end_local::date then
        raise exception 'Appointment must start and end on the same local day';
      end if;
      start_minute := extract(hour from start_local)::integer * 60 + extract(minute from start_local)::integer;
      end_minute := extract(hour from end_local)::integer * 60 + extract(minute from end_local)::integer;
      local_weekday := extract(dow from start_local)::integer;
      if not exists (
        select 1
        from public.provider_business_hours as hours
        where hours.provider_id = new.provider_id
          and hours.weekday = local_weekday
          and hours.opens_minute <= start_minute
          and hours.closes_minute >= end_minute
      ) then
        raise exception 'Appointment is outside published business hours';
      end if;
      new.buffer_minutes := settings.buffer_minutes;
      new.blocked_until := new.ends_at + (new.buffer_minutes * interval '1 minute');
      if exists (
        select 1
        from public.provider_time_off as blocked
        where blocked.provider_id = new.provider_id
          and blocked.starts_at < new.blocked_until
          and blocked.ends_at > new.starts_at
      ) then
        raise exception 'Appointment overlaps provider time off';
      end if;
      if exists (
        select 1
        from public.booking_appointments as existing
        where existing.provider_id = new.provider_id
          and existing.booking_id <> new.booking_id
          and existing.status in ('held', 'confirmed')
          and existing.starts_at < new.blocked_until
          and new.starts_at < existing.blocked_until
      ) then
        raise exception 'Appointment overlaps another booking';
      end if;
      new.transition_nonce := null;
      return new;
    end if;

    if new.service_id is distinct from old.service_id
      or new.starts_at is distinct from old.starts_at
      or new.ends_at is distinct from old.ends_at
      or new.buffer_minutes is distinct from old.buffer_minutes
      or new.blocked_until is distinct from old.blocked_until then
      raise exception 'Appointment times cannot be changed. Rescheduling is not available yet.';
    end if;

    if old.status = 'held'
      and new.status = 'confirmed'
      and issued_action = 'confirm'
      and issued_nonce is not null
      and new.transition_nonce = issued_nonce then
      new.transition_nonce := null;
      return new;
    end if;

    if old.status in ('held', 'confirmed')
      and new.status = 'released'
      and issued_action = 'release'
      and issued_nonce is not null
      and new.transition_nonce = issued_nonce then
      new.transition_nonce := null;
      return new;
    end if;

    raise exception 'Appointments can only be confirmed when the booking is accepted';
  end if;

  select * into booking
  from public.booking_requests
  where id = new.booking_id
  for update;

  if not found then
    raise exception 'Booking does not exist';
  end if;
  if booking.provider_id is distinct from new.provider_id then
    raise exception 'Appointment provider does not match the booking';
  end if;
  if booking.status <> 'pending' then
    raise exception 'This booking cannot hold an appointment';
  end if;
  if booking.customer_id is distinct from auth.uid() then
    raise exception 'Not allowed to schedule this booking';
  end if;

  new.status := 'held';
  new.transition_nonce := null;

  select * into provider
  from public.providers
  where id = new.provider_id
  for update;
  if not found or provider.status <> 'approved' then
    raise exception 'Provider is not available for booking';
  end if;
  select * into service
  from public.provider_services
  where id = new.service_id
    and provider_id = new.provider_id
    and active = true;
  if not found or service.duration_minutes is null then
    raise exception 'Choose an active service that has a duration';
  end if;
  if new.starts_at <> date_trunc('minute', new.starts_at)
    or new.ends_at <> date_trunc('minute', new.ends_at) then
    raise exception 'Appointment times must use whole minutes';
  end if;
  if new.ends_at <> new.starts_at + make_interval(mins => service.duration_minutes) then
    raise exception 'Appointment length must match the service duration';
  end if;
  select * into settings
  from public.provider_schedule_settings
  where provider_id = new.provider_id;
  if not found then
    raise exception 'Provider has not published a schedule';
  end if;
  if new.starts_at < now() + make_interval(mins => settings.min_notice_minutes) then
    raise exception 'Appointment is inside the minimum notice period';
  end if;
  if new.starts_at > now() + make_interval(days => settings.max_advance_days) then
    raise exception 'Appointment is outside the booking window';
  end if;
  start_local := new.starts_at at time zone provider.timezone;
  end_local := new.ends_at at time zone provider.timezone;
  if start_local::date <> end_local::date then
    raise exception 'Appointment must start and end on the same local day';
  end if;
  start_minute := extract(hour from start_local)::integer * 60 + extract(minute from start_local)::integer;
  end_minute := extract(hour from end_local)::integer * 60 + extract(minute from end_local)::integer;
  local_weekday := extract(dow from start_local)::integer;
  if not exists (
    select 1
    from public.provider_business_hours as hours
    where hours.provider_id = new.provider_id
      and hours.weekday = local_weekday
      and hours.opens_minute <= start_minute
      and hours.closes_minute >= end_minute
  ) then
    raise exception 'Appointment is outside published business hours';
  end if;
  new.buffer_minutes := settings.buffer_minutes;
  new.blocked_until := new.ends_at + (new.buffer_minutes * interval '1 minute');
  if exists (
    select 1
    from public.provider_time_off as blocked
    where blocked.provider_id = new.provider_id
      and blocked.starts_at < new.blocked_until
      and blocked.ends_at > new.starts_at
  ) then
    raise exception 'Appointment overlaps provider time off';
  end if;
  if exists (
    select 1
    from public.booking_appointments as existing
    where existing.provider_id = new.provider_id
      and existing.booking_id <> new.booking_id
      and existing.status in ('held', 'confirmed')
      and existing.starts_at < new.blocked_until
      and new.starts_at < existing.blocked_until
  ) then
    raise exception 'Appointment overlaps another booking';
  end if;
  return new;
end;
$$;

alter table public.booking_reschedule_requests enable row level security;

do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'booking_reschedule_requests'
      and policyname = 'booking_reschedule_select'
  ) then
    execute $sql$
      create policy booking_reschedule_select
        on public.booking_reschedule_requests
        for select
        to authenticated
        using (
          public.is_admin()
          or customer_id = auth.uid()
          or exists (
            select 1
            from public.booking_requests as booking
            where booking.id = booking_reschedule_requests.booking_id
              and public.owns_provider(booking.provider_id)
          )
        );
    $sql$;
  end if;
end
$policy$;

do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'booking_reschedule_requests'
      and policyname = 'booking_reschedule_insert'
  ) then
    execute $sql$
      create policy booking_reschedule_insert
        on public.booking_reschedule_requests
        for insert
        to authenticated
        with check (customer_id = auth.uid() and status = 'pending');
    $sql$;
  end if;
end
$policy$;

do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'booking_reschedule_requests'
      and policyname = 'booking_reschedule_update'
  ) then
    execute $sql$
      create policy booking_reschedule_update
        on public.booking_reschedule_requests
        for update
        to authenticated
        using (
          customer_id = auth.uid()
          or public.is_admin()
          or exists (
            select 1
            from public.booking_requests as booking
            where booking.id = booking_reschedule_requests.booking_id
              and public.owns_provider(booking.provider_id)
          )
        )
        with check (
          customer_id = auth.uid()
          or public.is_admin()
          or exists (
            select 1
            from public.booking_requests as booking
            where booking.id = booking_reschedule_requests.booking_id
              and public.owns_provider(booking.provider_id)
          )
        );
    $sql$;
  end if;
end
$policy$;

grant select, insert, update on public.booking_reschedule_requests to authenticated;
revoke all on public.booking_reschedule_requests from anon;
revoke all on function public.guard_reschedule_request() from public, anon, authenticated, service_role;
revoke all on function public.guard_booking_appointment() from public, anon, authenticated, service_role;
revoke all on function public.sync_booking_appointment() from public, anon, authenticated, service_role;
