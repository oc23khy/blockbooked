-- Temporary pause for new bookings, appointment holds, and payment rows.
-- Existing rows can still be updated, cancelled, expired, and refunded.
-- The setting starts off. Turning it on does not require an application redeploy.

insert into public.platform_settings (key, value)
values ('booking_maintenance', 'false'::jsonb)
on conflict (key) do nothing;

create or replace function public.enforce_booking_maintenance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  paused boolean;
begin
  select value = 'true'::jsonb
  into paused
  from public.platform_settings
  where key = 'booking_maintenance';

  if coalesce(paused, false) then
    raise exception 'Booking is temporarily paused for maintenance. You can still view, cancel, or manage an existing booking.';
  end if;
  return new;
end;
$$;

drop trigger if exists booking_requests_maintenance on public.booking_requests;
create trigger booking_requests_maintenance
  before insert on public.booking_requests
  for each row
  execute function public.enforce_booking_maintenance();

drop trigger if exists booking_appointments_maintenance on public.booking_appointments;
create trigger booking_appointments_maintenance
  before insert on public.booking_appointments
  for each row
  execute function public.enforce_booking_maintenance();

drop trigger if exists payments_maintenance on public.payments;
create trigger payments_maintenance
  before insert on public.payments
  for each row
  execute function public.enforce_booking_maintenance();

revoke all on function public.enforce_booking_maintenance() from public, anon, authenticated;
