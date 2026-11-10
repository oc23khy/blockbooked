-- Booking status workflow. Run this after 20261109180000_init.sql.
-- Do not run this file again after 20261110190000_completion_pins.sql.
-- Existing rows are kept. "requested" becomes "pending".
-- Safe to run again: column, constraint, trigger, and policy steps are conditional.

alter table public.booking_requests
  add column if not exists service_name text not null default '';

-- The protect trigger rewrites status changes back to the old value when this
-- script runs in the SQL Editor. Drop it before migrating rows, then recreate it.
drop trigger if exists bookings_protect_row on public.booking_requests;

-- Remove the old check before any status is changed.
alter table public.booking_requests
  drop constraint if exists booking_status_known;

update public.booking_requests
set status = 'pending'
where status = 'requested';

alter table public.booking_requests
  alter column status set default 'pending';

-- Add the new check only after every legacy status has been rewritten.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'booking_status_known'
      and conrelid = 'public.booking_requests'::regclass
  ) then
    alter table public.booking_requests
      add constraint booking_status_known
      check (status in ('pending', 'accepted', 'declined', 'completed', 'cancelled'));
  end if;
end $$;

create or replace function public.owns_provider(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.providers
    where id = target
      and owner_id = auth.uid()
  );
$$;

create or replace function public.protect_booking_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_owns_provider boolean;
begin
  if tg_op = 'INSERT' and not public.is_admin() then
    new.status := 'pending';
  elsif tg_op = 'UPDATE' and not public.is_admin() then
    new.id := old.id;
    new.customer_id := old.customer_id;
    new.provider_id := old.provider_id;
    new.preferred_date := old.preferred_date;
    new.time_window := old.time_window;
    new.notes := old.notes;
    new.contact_phone := old.contact_phone;
    new.service_name := old.service_name;
    new.created_at := old.created_at;

    actor_owns_provider := public.owns_provider(old.provider_id);

    if old.customer_id = auth.uid() and not actor_owns_provider then
      if not (old.status in ('pending', 'requested') and new.status = 'cancelled') then
        new.status := old.status;
      else
        new.status := 'cancelled';
      end if;
    elsif actor_owns_provider and old.customer_id is distinct from auth.uid() then
      if old.status in ('pending', 'requested') and new.status in ('accepted', 'declined') then
        null;
      elsif old.status = 'accepted' and new.status = 'completed' then
        null;
      else
        new.status := old.status;
      end if;
    elsif actor_owns_provider and old.customer_id = auth.uid() then
      if old.status in ('pending', 'requested') and new.status in ('accepted', 'declined', 'cancelled') then
        null;
      elsif old.status = 'accepted' and new.status = 'completed' then
        null;
      else
        new.status := old.status;
      end if;
    else
      new.status := old.status;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_protect_row on public.booking_requests;

create trigger bookings_protect_row
  before insert or update on public.booking_requests
  for each row execute function public.protect_booking_row();

drop policy if exists bookings_update on public.booking_requests;

create policy bookings_update
  on public.booking_requests
  for update
  to authenticated
  using (
    customer_id = auth.uid()
    or public.is_admin()
    or public.owns_provider(provider_id)
  )
  with check (
    customer_id = auth.uid()
    or public.is_admin()
    or public.owns_provider(provider_id)
  );

grant execute on function public.owns_provider(uuid) to authenticated;
