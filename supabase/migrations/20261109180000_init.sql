-- BlockBooked accounts, provider applications, and booking requests.
-- Apply this in the Supabase SQL editor, or with the Supabase CLI.

create extension if not exists pgcrypto;

create type public.user_role as enum ('customer', 'provider', 'admin');
create type public.listing_status as enum ('pending', 'approved', 'rejected');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role public.user_role not null default 'customer',
  full_name text not null default '',
  phone text not null default '',
  email text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.providers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references public.profiles (id) on delete cascade,
  business_name text not null,
  category_id text not null,
  specialty text not null default '',
  about text not null default '',
  service_areas text[] not null default '{}',
  price_from numeric(10, 2) not null default 0,
  price_unit text not null default 'visit',
  services jsonb not null default '[]'::jsonb,
  availability text not null default '',
  response_time text not null default '',
  years integer not null default 0,
  status public.listing_status not null default 'pending',
  is_demo boolean not null default false,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint providers_price_nonnegative check (price_from >= 0),
  constraint providers_years_nonnegative check (years >= 0),
  constraint providers_category_known check (
    category_id in ('cleaners', 'barbers', 'movers', 'detailing', 'handyman', 'lawn', 'pets', 'plumbing')
  ),
  constraint providers_areas_known check (
    service_areas <@ array['Roselle', 'Bloomingdale', 'Schaumburg', 'Itasca', 'Hanover Park']::text[]
    and cardinality(service_areas) > 0
  ),
  constraint providers_services_array check (jsonb_typeof(services) = 'array')
);

create table public.booking_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles (id) on delete cascade,
  provider_id uuid not null references public.providers (id) on delete cascade,
  preferred_date date not null,
  time_window text not null,
  notes text not null default '',
  contact_phone text not null default '',
  status text not null default 'requested',
  created_at timestamptz not null default now(),
  constraint booking_window_known check (time_window in ('Morning', 'Afternoon', 'Evening')),
  constraint booking_status_known check (status in ('requested', 'cancelled'))
);

create index providers_status_idx on public.providers (status);
create index booking_requests_customer_idx on public.booking_requests (customer_id);
create index booking_requests_provider_idx on public.booking_requests (provider_id);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.can_view_profile(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    target = auth.uid()
    or public.is_admin()
    or exists (
      select 1
      from public.booking_requests as request
      join public.providers as provider on provider.id = request.provider_id
      where request.customer_id = target
        and provider.owner_id = auth.uid()
    );
$$;

create or replace function public.provider_is_bookable(target uuid)
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
      and status = 'approved'
      and owner_id is distinct from auth.uid()
  );
$$;

create or replace function public.become_provider()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  perform set_config('blockbooked.role_change', 'provider', true);

  update public.profiles
  set role = 'provider', updated_at = now()
  where id = auth.uid() and role = 'customer';
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested text;
begin
  requested := coalesce(new.raw_user_meta_data->>'account_type', 'customer');

  insert into public.profiles (id, role, full_name, phone, email)
  values (
    new.id,
    case
      when requested = 'provider' then 'provider'::public.user_role
      else 'customer'::public.user_role
    end,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.raw_user_meta_data->>'phone', ''),
    coalesce(new.email, '')
  );

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.protect_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if current_setting('blockbooked.role_change', true) is distinct from 'provider' or old.role <> 'customer' then
      new.role := old.role;
    else
      new.role := 'provider';
    end if;
    new.id := old.id;
    new.email := old.email;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_protect_role
  before update on public.profiles
  for each row execute function public.protect_profile_role();

create or replace function public.protect_provider_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if not public.is_admin() then
      if new.owner_id is distinct from auth.uid() then
        raise exception 'You can only create your own business profile';
      end if;
      new.status := 'pending';
      new.is_demo := false;
      new.review_note := null;
    end if;
  elsif not public.is_admin() then
    if new.owner_id is distinct from old.owner_id then
      raise exception 'Owner cannot be changed';
    end if;
    new.is_demo := old.is_demo;
    new.review_note := old.review_note;
    if new.status is distinct from old.status then
      if old.status = 'rejected' and new.status = 'pending' then
        null;
      else
        new.status := old.status;
      end if;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger providers_protect_row
  before insert or update on public.providers
  for each row execute function public.protect_provider_row();

create or replace function public.protect_booking_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and not public.is_admin() then
    new.customer_id := old.customer_id;
    new.provider_id := old.provider_id;
    new.preferred_date := old.preferred_date;
    new.time_window := old.time_window;
    new.notes := old.notes;
    new.contact_phone := old.contact_phone;
    if new.status is distinct from 'cancelled' then
      new.status := old.status;
    end if;
  end if;
  return new;
end;
$$;

create trigger bookings_protect_row
  before update on public.booking_requests
  for each row execute function public.protect_booking_row();

alter table public.profiles enable row level security;
alter table public.providers enable row level security;
alter table public.booking_requests enable row level security;

create policy profiles_select
  on public.profiles
  for select
  to authenticated
  using (public.can_view_profile(id));

create policy profiles_update
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

create policy providers_select
  on public.providers
  for select
  to anon, authenticated
  using (status = 'approved' or owner_id = auth.uid() or public.is_admin());

create policy providers_insert
  on public.providers
  for insert
  to authenticated
  with check (owner_id = auth.uid() or public.is_admin());

create policy providers_update
  on public.providers
  for update
  to authenticated
  using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

create policy bookings_select
  on public.booking_requests
  for select
  to authenticated
  using (
    customer_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1
      from public.providers
      where providers.id = booking_requests.provider_id
        and providers.owner_id = auth.uid()
    )
  );

create policy bookings_insert
  on public.booking_requests
  for insert
  to authenticated
  with check (
    customer_id = auth.uid()
    and public.provider_is_bookable(provider_id)
  );

create policy bookings_update
  on public.booking_requests
  for update
  to authenticated
  using (customer_id = auth.uid() or public.is_admin())
  with check (customer_id = auth.uid() or public.is_admin());

grant usage on schema public to anon, authenticated;
grant select on public.providers to anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update on public.providers to authenticated;
grant select, insert, update on public.booking_requests to authenticated;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.can_view_profile(uuid) to authenticated;
grant execute on function public.provider_is_bookable(uuid) to authenticated;
grant execute on function public.become_provider() to authenticated;
