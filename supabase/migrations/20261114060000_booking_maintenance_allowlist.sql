-- Temporary one-user exception while booking_maintenance stays true.
-- The list starts empty, so applying this file does not allow any booking.
-- Remove the test user with select public.clear_booking_maintenance_allowlist();
-- That call leaves booking_maintenance unchanged.

insert into public.platform_settings (key, value)
values ('booking_maintenance_allowlist', '[]'::jsonb)
on conflict (key) do nothing;

-- Reads the session identity. It does not read JWT user metadata or a customer id
-- supplied by the application. SECURITY DEFINER lets the trigger read platform
-- settings and the booking row when the caller cannot. auth.uid() still returns
-- the session user because this function never changes request.jwt settings.
-- A security-definer insert elsewhere therefore cannot take the function owner's
-- identity. Clearing the session identity makes auth.uid() null, which cannot
-- create a booking or appointment. A payment insert with no session user is
-- accepted only from the service role, and only when its customer matches the
-- customer already stored on the booking.
create or replace function public.enforce_booking_maintenance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  paused boolean;
  actor uuid := auth.uid();
  booking_customer uuid;
  actor_listed boolean := false;
  booking_listed boolean := false;
begin
  select value = 'true'::jsonb
  into paused
  from public.platform_settings
  where key = 'booking_maintenance';

  if not coalesce(paused, false) then
    return new;
  end if;

  if actor is not null then
    select jsonb_typeof(value) = 'array'
      and jsonb_array_length(value) = 1
      and value @> to_jsonb(actor::text)
    into actor_listed
    from public.platform_settings
    where key = 'booking_maintenance_allowlist';
    actor_listed := coalesce(actor_listed, false);
  end if;

  if tg_table_name = 'booking_requests' then
    if actor_listed and new.customer_id is not distinct from actor then
      return new;
    end if;
  elsif tg_table_name = 'booking_appointments' then
    select request.customer_id
    into booking_customer
    from public.booking_requests as request
    where request.id = new.booking_id;
    if actor_listed and booking_customer is not distinct from actor then
      return new;
    end if;
  elsif tg_table_name = 'payments' then
    select request.customer_id
    into booking_customer
    from public.booking_requests as request
    where request.id = new.booking_id;
    if booking_customer is not null then
      select jsonb_typeof(value) = 'array'
        and jsonb_array_length(value) = 1
        and value @> to_jsonb(booking_customer::text)
      into booking_listed
      from public.platform_settings
      where key = 'booking_maintenance_allowlist';
      booking_listed := coalesce(booking_listed, false);
    end if;
    if booking_listed and new.customer_id is not distinct from booking_customer then
      if actor is not distinct from booking_customer then
        return new;
      end if;
      if actor is null and coalesce(auth.role(), '') = 'service_role' then
        return new;
      end if;
    end if;
  end if;

  raise exception 'Booking is temporarily paused for maintenance. You can still view, cancel, or manage an existing booking.';
end;
$$;

revoke all on function public.enforce_booking_maintenance() from public, anon, authenticated;

-- Security invoker so current_user is the caller. A security-definer check would
-- see the function owner and could treat a forged empty session as the database
-- owner. Signed-in users are rejected because auth.uid() is set. An application
-- admin profile or ownership of a provider is not an exception.
create or replace function public.protect_booking_maintenance_allowlist()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  guarded_key text;
  trusted boolean;
begin
  guarded_key := case when tg_op = 'DELETE' then old.key else new.key end;
  if tg_op = 'UPDATE' and old.key = 'booking_maintenance_allowlist' then
    guarded_key := old.key;
  end if;
  if guarded_key is distinct from 'booking_maintenance_allowlist' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  trusted :=
    auth.uid() is null
    and coalesce(auth.role(), '') not in ('anon', 'authenticated')
    and (
      coalesce(auth.role(), '') = 'service_role'
      or exists (
        select 1
        from pg_roles
        where rolname = current_user
          and rolbypassrls
      )
    );
  if not trusted then
    raise exception 'Only a database administrator can change the booking maintenance allowlist.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  if new.key is distinct from 'booking_maintenance_allowlist' then
    raise exception 'The booking maintenance allowlist cannot be renamed.';
  end if;
  if jsonb_typeof(new.value) is distinct from 'array'
     or jsonb_array_length(new.value) > 1 then
    raise exception 'The booking maintenance allowlist must be empty or one user id.';
  end if;
  if jsonb_array_length(new.value) = 1
     and (
       jsonb_typeof(new.value -> 0) is distinct from 'string'
       or (new.value ->> 0) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ) then
    raise exception 'The booking maintenance allowlist must contain one user id.';
  end if;
  return new;
end;
$$;

revoke all on function public.protect_booking_maintenance_allowlist() from public, anon, authenticated;

drop trigger if exists platform_settings_allowlist_guard on public.platform_settings;
create trigger platform_settings_allowlist_guard
  before insert or update or delete on public.platform_settings
  for each row
  execute function public.protect_booking_maintenance_allowlist();

-- Immediate removal. This does not turn booking maintenance off.
create or replace function public.clear_booking_maintenance_allowlist()
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  trusted boolean;
begin
  trusted :=
    auth.uid() is null
    and coalesce(auth.role(), '') not in ('anon', 'authenticated')
    and (
      coalesce(auth.role(), '') = 'service_role'
      or exists (
        select 1
        from pg_roles
        where rolname = current_user
          and rolbypassrls
      )
    );
  if not trusted then
    raise exception 'Only a database administrator can change the booking maintenance allowlist.';
  end if;
  update public.platform_settings
  set value = '[]'::jsonb,
      updated_at = now()
  where key = 'booking_maintenance_allowlist';
end;
$$;

revoke all on function public.clear_booking_maintenance_allowlist() from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.clear_booking_maintenance_allowlist() to service_role;
  end if;
end;
$$;
