-- Administrators previously skipped protect_booking_row, so an admin session
-- could mark a booking completed without the customer PIN. This trigger runs
-- for every role. The PIN function still sets blockbooked.pin_verified in the
-- same transaction before it updates the booking.

create or replace function public.reject_unverified_completion()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.status = 'completed'
     and (tg_op = 'INSERT' or old.status is distinct from 'completed')
     and current_setting('blockbooked.pin_verified', true) is distinct from '1' then
    raise exception 'Completion requires the customer PIN';
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_reject_unverified_completion on public.booking_requests;

create trigger bookings_reject_unverified_completion
  before insert or update on public.booking_requests
  for each row
  execute function public.reject_unverified_completion();

revoke all on function public.reject_unverified_completion() from public, anon, authenticated;

grant execute on function public.reject_unverified_completion() to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.reject_unverified_completion() to service_role;
  end if;
end
$$;
