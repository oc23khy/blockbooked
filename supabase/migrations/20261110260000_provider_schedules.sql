-- Provider schedules, service durations, and galleries.
-- Run after 20261110250000_transfer_refund_guards.sql.
-- Additive only. Does not change payments, refunds, transfers, quotes,
-- milestones, completion PINs, or booking status rules.
-- Safe to run again after the 42P17 failure. That error stopped the exclusion
-- constraint, so earlier statements may have been rolled back or kept. This
-- file only adds missing objects. It does not delete bookings or payment rows.
-- Existing jsonb services on providers stay in place. A provider has bookable
-- appointment times only after that provider saves business hours.
--
-- A booking_requests row may exist with no booking_appointments row. That is a
-- request for a time, including a custom quote, and it does not block the
-- calendar. An appointment is optional. When one exists it must reference an
-- active provider_services row with a duration, and the visit length must match.
-- Pending appointments are held. The only way to mark one confirmed is for the
-- booking to move to accepted. Decline and cancel mark it released, which frees
-- the time and keeps the row. Completion keeps the historical row.
-- Nothing in this file expires a booking or changes a payment.
-- Times cannot be edited in place; rescheduling is not
-- implemented and must be added later as its own reviewed function.

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

create or replace function public.valid_timezone(tz text)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from pg_timezone_names where name = tz
  );
$$;

alter table public.providers
  add column if not exists timezone text not null default 'America/Chicago';

alter table public.providers
  add column if not exists languages text[] not null default '{}';

alter table public.providers
  add column if not exists travel_radius_miles integer;

alter table public.providers
  add column if not exists cover_image_path text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'providers_timezone_known'
      and conrelid = 'public.providers'::regclass
  ) then
    alter table public.providers
      add constraint providers_timezone_known
      check (public.valid_timezone(timezone));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'providers_languages_limit'
      and conrelid = 'public.providers'::regclass
  ) then
    alter table public.providers
      add constraint providers_languages_limit
      check (cardinality(languages) <= 8);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'providers_travel_radius_bounds'
      and conrelid = 'public.providers'::regclass
  ) then
    alter table public.providers
      add constraint providers_travel_radius_bounds
      check (travel_radius_miles is null or travel_radius_miles between 0 and 150);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'providers_cover_path_safe'
      and conrelid = 'public.providers'::regclass
  ) then
    alter table public.providers
      add constraint providers_cover_path_safe
      check (
        cover_image_path is null
        or (
          cover_image_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,120}$'
          and split_part(cover_image_path, '/', 1) = id::text
        )
      );
  end if;
end $$;

create table if not exists public.provider_services (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers (id) on delete cascade,
  name text not null,
  description text not null default '',
  pricing_type text not null,
  price_cents integer,
  duration_minutes integer,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_services_name_length check (char_length(btrim(name)) between 1 and 80),
  constraint provider_services_description_length check (char_length(description) <= 1000),
  constraint provider_services_pricing_known check (pricing_type in ('fixed', 'starting', 'quote')),
  constraint provider_services_price_matches check (
    (pricing_type = 'quote' and price_cents is null)
    or (pricing_type in ('fixed', 'starting') and price_cents > 0)
  ),
  constraint provider_services_duration_bounds check (
    duration_minutes is null or duration_minutes between 15 and 480
  ),
  constraint provider_services_sort_nonnegative check (sort_order >= 0)
);

create index if not exists provider_services_provider_idx
  on public.provider_services (provider_id, sort_order);

-- Weekday uses PostgreSQL extract(dow): 0 = Sunday through 6 = Saturday.
-- Minutes are local wall-clock minutes in the provider timezone. 9:00 is 540.
create table if not exists public.provider_business_hours (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers (id) on delete cascade,
  weekday smallint not null,
  opens_minute smallint not null,
  closes_minute smallint not null,
  constraint provider_hours_weekday check (weekday between 0 and 6),
  constraint provider_hours_bounds check (
    opens_minute >= 0
    and closes_minute <= 1440
    and closes_minute > opens_minute
  )
);

create index if not exists provider_business_hours_provider_idx
  on public.provider_business_hours (provider_id, weekday);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'provider_hours_no_overlap'
  ) then
    alter table public.provider_business_hours
      add constraint provider_hours_no_overlap
      exclude using gist (
        provider_id with =,
        weekday with =,
        int4range(opens_minute, closes_minute, '[)') with &&
      );
  end if;
end $$;

create table if not exists public.provider_schedule_settings (
  provider_id uuid primary key references public.providers (id) on delete cascade,
  min_notice_minutes integer not null default 120,
  max_advance_days integer not null default 60,
  buffer_minutes integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint provider_schedule_notice_bounds check (min_notice_minutes between 0 and 10080),
  constraint provider_schedule_advance_bounds check (max_advance_days between 1 and 365),
  constraint provider_schedule_buffer_bounds check (buffer_minutes between 0 and 240)
);

create table if not exists public.provider_time_off (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  constraint provider_time_off_range check (ends_at > starts_at),
  constraint provider_time_off_note_length check (char_length(note) <= 80)
);

create index if not exists provider_time_off_provider_idx
  on public.provider_time_off (provider_id, starts_at);

create table if not exists public.provider_images (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers (id) on delete cascade,
  storage_path text not null,
  caption text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint provider_images_path_unique unique (provider_id, storage_path),
  constraint provider_images_path_safe check (
    storage_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,120}$'
    and split_part(storage_path, '/', 1) = provider_id::text
  ),
  constraint provider_images_caption_length check (char_length(caption) <= 120),
  constraint provider_images_sort_nonnegative check (sort_order >= 0)
);

create index if not exists provider_images_provider_idx
  on public.provider_images (provider_id, sort_order);

-- One concrete visit per booking. A booking with no row here is a request
-- without a scheduled time, including a custom quote, and does not block anyone.
-- transition_nonce is only present while the booking-acceptance trigger is
-- writing; the guard clears it before the row is stored.
create table if not exists public.booking_appointments (
  booking_id uuid primary key references public.booking_requests (id) on delete cascade,
  provider_id uuid not null references public.providers (id) on delete cascade,
  service_id uuid not null references public.provider_services (id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  buffer_minutes integer not null,
  blocked_until timestamptz not null,
  status text not null,
  transition_nonce uuid,
  created_at timestamptz not null default now(),
  constraint booking_appointments_status_known check (status in ('held', 'confirmed', 'released')),
  constraint booking_appointments_duration check (
    ends_at > starts_at
    and ends_at <= starts_at + interval '8 hours'
  ),
  constraint booking_appointments_buffer_bounds check (buffer_minutes between 0 and 240),
  constraint booking_appointments_blocked_until_matches check (
    blocked_until = ends_at + (buffer_minutes * interval '1 minute')
  ),
  constraint booking_appointments_nonce_clear check (transition_nonce is null),
  constraint booking_appointments_whole_minute check (
    starts_at = date_trunc('minute', starts_at)
    and ends_at = date_trunc('minute', ends_at)
  )
);

create index if not exists booking_appointments_provider_start_idx
  on public.booking_appointments (provider_id, starts_at);

-- timestamptz + interval is STABLE because calendar intervals depend on TimeZone.
-- A GiST exclusion index can only use IMMUTABLE expressions, which is why the
-- first attempt failed with 42P17. blocked_until is stored by the insert trigger
-- and checked against the buffer. The index compares the two timestamps only.
-- tstzrange(start, end) is immutable and uses the [) bound.
alter table public.booking_appointments
  add column if not exists blocked_until timestamptz;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'booking_appointments'
      and column_name = 'blocked_until'
      and is_nullable = 'YES'
  ) then
    update public.booking_appointments
    set blocked_until = ends_at + (buffer_minutes * interval '1 minute')
    where blocked_until is null;

    alter table public.booking_appointments
      alter column blocked_until set not null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'booking_appointments_blocked_until_matches'
      and conrelid = 'public.booking_appointments'::regclass
  ) then
    alter table public.booking_appointments
      add constraint booking_appointments_blocked_until_matches
      check (blocked_until = ends_at + (buffer_minutes * interval '1 minute'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'booking_appointments_no_overlap'
      and conrelid = 'public.booking_appointments'::regclass
  ) then
    alter table public.booking_appointments
      add constraint booking_appointments_no_overlap
      exclude using gist (
        provider_id with =,
        tstzrange(starts_at, blocked_until) with &&
      )
      where (status in ('held', 'confirmed'));
  end if;
end $$;

-- One nonce row per booking, so two bookings can change state at the same time
-- without overwriting each other. API roles have no privileges. RLS is forced
-- and the only policy denies anon and authenticated. The trigger functions are
-- security definer and run as the table owner.
create schema if not exists blockbooked_private;

revoke all on schema blockbooked_private from public;
revoke all on schema blockbooked_private from anon, authenticated;

create table if not exists blockbooked_private.appointment_transition (
  booking_id uuid primary key,
  action text not null,
  nonce uuid not null,
  constraint appointment_transition_action_known check (action in ('confirm', 'release', 'spent'))
);

alter table blockbooked_private.appointment_transition enable row level security;
alter table blockbooked_private.appointment_transition force row level security;

revoke all on table blockbooked_private.appointment_transition from public, anon, authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'blockbooked_private'
      and tablename = 'appointment_transition'
      and policyname = 'appointment_transition_no_api'
  ) then
    create policy appointment_transition_no_api
      on blockbooked_private.appointment_transition
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end $$;

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
      or new.service_id is distinct from old.service_id
      or new.starts_at is distinct from old.starts_at
      or new.ends_at is distinct from old.ends_at
      or new.buffer_minutes is distinct from old.buffer_minutes
      or new.blocked_until is distinct from old.blocked_until
      or new.created_at is distinct from old.created_at then
      raise exception 'Appointment times cannot be changed. Rescheduling is not available yet.';
    end if;

    select transition.action, transition.nonce
    into issued_action, issued_nonce
    from blockbooked_private.appointment_transition as transition
    where transition.booking_id = old.booking_id
    for update;

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

  -- INSERT. A provider, admin, or session setting cannot force confirmed.

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

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'booking_appointments_guard'
      and tgrelid = 'public.booking_appointments'::regclass
      and not tgisinternal
  ) then
    create trigger booking_appointments_guard
      before insert or update or delete on public.booking_appointments
      for each row execute function public.guard_booking_appointment();
  end if;
end $$;

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
  elsif new.status in ('declined', 'cancelled') and old.status is distinct from new.status then
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

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'booking_requests_sync_appointment'
      and tgrelid = 'public.booking_requests'::regclass
      and not tgisinternal
  ) then
    create trigger booking_requests_sync_appointment
      after update of status on public.booking_requests
      for each row execute function public.sync_booking_appointment();
  end if;
end $$;

-- Busy ranges only. The returned end includes that visit's buffer.
-- No customer, price, booking id, or service is returned.
create or replace function public.provider_busy_ranges(
  target uuid,
  range_start timestamptz,
  range_end timestamptz
)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select appointment.starts_at, appointment.blocked_until
  from public.booking_appointments as appointment
  join public.providers as provider on provider.id = appointment.provider_id
  where appointment.provider_id = target
    and provider.status = 'approved'
    and appointment.status in ('held', 'confirmed')
    and range_end > range_start
    and range_end <= range_start + interval '120 days'
    and appointment.starts_at < range_end
    and appointment.blocked_until > range_start
  order by appointment.starts_at;
$$;

-- Time-off ranges only. The private note stays on the table and is not returned.
create or replace function public.provider_time_off_ranges(
  target uuid,
  range_start timestamptz,
  range_end timestamptz
)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select blocked.starts_at, blocked.ends_at
  from public.provider_time_off as blocked
  join public.providers as provider on provider.id = blocked.provider_id
  where blocked.provider_id = target
    and provider.status = 'approved'
    and range_end > range_start
    and range_end <= range_start + interval '120 days'
    and blocked.starts_at < range_end
    and blocked.ends_at > range_start
  order by blocked.starts_at;
$$;

alter table public.provider_services enable row level security;
alter table public.provider_business_hours enable row level security;
alter table public.provider_schedule_settings enable row level security;
alter table public.provider_time_off enable row level security;
alter table public.provider_images enable row level security;
alter table public.booking_appointments enable row level security;

do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_services'
      and policyname = 'provider_services_select'
  ) then
    execute $sql$
create policy provider_services_select
  on public.provider_services
  for select
  to anon, authenticated
  using (
    public.is_admin()
    or public.owns_provider(provider_id)
    or exists (
      select 1 from public.providers
      where providers.id = provider_services.provider_id
        and providers.status = 'approved'
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
      and tablename = 'provider_services'
      and policyname = 'provider_services_write'
  ) then
    execute $sql$
create policy provider_services_write
  on public.provider_services
  for all
  to authenticated
  using (public.is_admin() or public.owns_provider(provider_id))
  with check (public.is_admin() or public.owns_provider(provider_id));
$sql$;
  end if;
end
$policy$;

do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_business_hours'
      and policyname = 'provider_hours_select'
  ) then
    execute $sql$
create policy provider_hours_select
  on public.provider_business_hours
  for select
  to anon, authenticated
  using (
    public.is_admin()
    or public.owns_provider(provider_id)
    or exists (
      select 1 from public.providers
      where providers.id = provider_business_hours.provider_id
        and providers.status = 'approved'
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
      and tablename = 'provider_business_hours'
      and policyname = 'provider_hours_write'
  ) then
    execute $sql$
create policy provider_hours_write
  on public.provider_business_hours
  for all
  to authenticated
  using (public.is_admin() or public.owns_provider(provider_id))
  with check (public.is_admin() or public.owns_provider(provider_id));
$sql$;
  end if;
end
$policy$;

do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_schedule_settings'
      and policyname = 'provider_schedule_select'
  ) then
    execute $sql$
create policy provider_schedule_select
  on public.provider_schedule_settings
  for select
  to anon, authenticated
  using (
    public.is_admin()
    or public.owns_provider(provider_id)
    or exists (
      select 1 from public.providers
      where providers.id = provider_schedule_settings.provider_id
        and providers.status = 'approved'
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
      and tablename = 'provider_schedule_settings'
      and policyname = 'provider_schedule_write'
  ) then
    execute $sql$
create policy provider_schedule_write
  on public.provider_schedule_settings
  for all
  to authenticated
  using (public.is_admin() or public.owns_provider(provider_id))
  with check (public.is_admin() or public.owns_provider(provider_id));
$sql$;
  end if;
end
$policy$;

do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_time_off'
      and policyname = 'provider_time_off_select'
  ) then
    execute $sql$
create policy provider_time_off_select
  on public.provider_time_off
  for select
  to authenticated
  using (public.is_admin() or public.owns_provider(provider_id));
$sql$;
  end if;
end
$policy$;

do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_time_off'
      and policyname = 'provider_time_off_write'
  ) then
    execute $sql$
create policy provider_time_off_write
  on public.provider_time_off
  for all
  to authenticated
  using (public.is_admin() or public.owns_provider(provider_id))
  with check (public.is_admin() or public.owns_provider(provider_id));
$sql$;
  end if;
end
$policy$;

do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_images'
      and policyname = 'provider_images_select'
  ) then
    execute $sql$
create policy provider_images_select
  on public.provider_images
  for select
  to anon, authenticated
  using (
    public.is_admin()
    or public.owns_provider(provider_id)
    or exists (
      select 1 from public.providers
      where providers.id = provider_images.provider_id
        and providers.status = 'approved'
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
      and tablename = 'provider_images'
      and policyname = 'provider_images_write'
  ) then
    execute $sql$
create policy provider_images_write
  on public.provider_images
  for all
  to authenticated
  using (public.is_admin() or public.owns_provider(provider_id))
  with check (
    (public.is_admin() or public.owns_provider(provider_id))
    and split_part(storage_path, '/', 1) = provider_id::text
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
      and tablename = 'booking_appointments'
      and policyname = 'booking_appointments_select'
  ) then
    execute $sql$
create policy booking_appointments_select
  on public.booking_appointments
  for select
  to authenticated
  using (
    public.is_admin()
    or public.owns_provider(provider_id)
    or exists (
      select 1 from public.booking_requests as request
      where request.id = booking_appointments.booking_id
        and request.customer_id = auth.uid()
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
      and tablename = 'booking_appointments'
      and policyname = 'booking_appointments_insert'
  ) then
    execute $sql$
create policy booking_appointments_insert
  on public.booking_appointments
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.booking_requests as request
      where request.id = booking_appointments.booking_id
        and request.provider_id = booking_appointments.provider_id
        and request.customer_id = auth.uid()
        and request.status = 'pending'
    )
  );
$sql$;
  end if;
end
$policy$;


grant select on public.provider_services to anon, authenticated;
grant select on public.provider_business_hours to anon, authenticated;
grant select on public.provider_schedule_settings to anon, authenticated;
grant select, insert, update, delete on public.provider_time_off to authenticated;
grant select on public.provider_images to anon, authenticated;
grant select, insert, update, delete on public.provider_services to authenticated;
grant select, insert, update, delete on public.provider_business_hours to authenticated;
grant select, insert, update, delete on public.provider_schedule_settings to authenticated;
grant select, insert, update, delete on public.provider_images to authenticated;
revoke all on public.booking_appointments from public, anon;
grant select, insert on public.booking_appointments to authenticated;
revoke all on function public.guard_booking_appointment() from public, anon, authenticated;
revoke all on function public.sync_booking_appointment() from public, anon, authenticated;
revoke all on function public.provider_busy_ranges(uuid, timestamptz, timestamptz) from public;
revoke all on function public.provider_time_off_ranges(uuid, timestamptz, timestamptz) from public;
grant execute on function public.provider_busy_ranges(uuid, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.provider_time_off_ranges(uuid, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.valid_timezone(text) to anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on schema blockbooked_private from service_role;
    revoke all on table blockbooked_private.appointment_transition from service_role;
    revoke insert, update, delete on table public.booking_appointments from service_role;
    revoke all on function public.guard_booking_appointment() from service_role;
    revoke all on function public.sync_booking_appointment() from service_role;
  end if;
end $$;

-- Public gallery and cover images only. Do not store customer addresses or job photos here.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'provider-media',
  'provider-media',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

create or replace function public.provider_media_owner(object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  folder text;
begin
  folder := split_part(object_name, '/', 1);
  if folder !~* '^[0-9a-f-]{36}$' then
    return false;
  end if;
  return public.owns_provider(folder::uuid) or public.is_admin();
end;
$$;

revoke all on function public.provider_media_owner(text) from public, anon;
grant execute on function public.provider_media_owner(text) to authenticated;

do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'provider_media_public_read'
  ) then
    execute $sql$
create policy provider_media_public_read
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'provider-media');
$sql$;
  end if;
end
$policy$;

do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'provider_media_owner_insert'
  ) then
    execute $sql$
create policy provider_media_owner_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'provider-media'
    and public.provider_media_owner(name)
  );
$sql$;
  end if;
end
$policy$;

do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'provider_media_owner_update'
  ) then
    execute $sql$
create policy provider_media_owner_update
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'provider-media' and public.provider_media_owner(name))
  with check (bucket_id = 'provider-media' and public.provider_media_owner(name));
$sql$;
  end if;
end
$policy$;

do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'provider_media_owner_delete'
  ) then
    execute $sql$
create policy provider_media_owner_delete
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'provider-media' and public.provider_media_owner(name));
$sql$;
  end if;
end
$policy$;
