-- New bookings need a held appointment before they can be accepted.
-- Rows that already exist keep appointment_required false, so a pending
-- paid time-of-day request can still be accepted, completed, or refunded.
-- Applying this file does not update booking status or payment amounts.

alter table public.booking_requests
  add column if not exists appointment_required boolean not null default false;

create or replace function public.protect_appointment_required()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.appointment_required := true;
  else
    new.appointment_required := old.appointment_required;
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_protect_appointment_required on public.booking_requests;

create trigger bookings_protect_appointment_required
  before insert or update on public.booking_requests
  for each row
  execute function public.protect_appointment_required();

create or replace function public.require_reserved_appointment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from 'accepted' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status is not distinct from 'accepted' then
    return new;
  end if;
  if coalesce(new.appointment_required, false) is not true then
    return new;
  end if;
  if not exists (
    select 1
    from public.booking_appointments
    where booking_id = new.id
      and status = 'held'
  ) then
    raise exception 'Acceptance requires a reserved appointment';
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_require_reserved_appointment on public.booking_requests;
drop trigger if exists bookings_require_reserved_appointment_insert on public.booking_requests;

create trigger bookings_require_reserved_appointment
  before update of status on public.booking_requests
  for each row
  when (new.status = 'accepted' and old.status is distinct from 'accepted')
  execute function public.require_reserved_appointment();

create trigger bookings_require_reserved_appointment_insert
  before insert on public.booking_requests
  for each row
  when (new.status = 'accepted')
  execute function public.require_reserved_appointment();

revoke all on function public.protect_appointment_required() from public, anon, authenticated;
revoke all on function public.require_reserved_appointment() from public, anon, authenticated;
grant execute on function public.require_reserved_appointment() to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.require_reserved_appointment() to service_role;
  end if;
end
$$;
