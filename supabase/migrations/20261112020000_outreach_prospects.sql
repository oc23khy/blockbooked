-- Admin outreach prospects and opt-out suppressions.
-- Authenticated administrators can read and write these rows.
-- Everyone else is denied. This does not alter booking, payment, or mail tables.
-- Safe to run again. Do not run this from the application.

create or replace function public.outreach_normalized_email(value text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when value is null then ''
    when char_length(btrim(value)) between 3 and 320
      and lower(btrim(value)) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      then lower(btrim(value))
    else ''
  end;
$$;

create or replace function public.outreach_normalized_website(value text)
returns text
language plpgsql
immutable
as $$
declare
  raw text := btrim(coalesce(value, ''));
  scheme text;
  rest text;
  host text;
  path text;
  slash integer;
begin
  if raw = '' then return ''; end if;
  if char_length(raw) > 200 or raw ~ '[[:space:]]' then return null; end if;
  if raw !~* '^https?://' then raw := 'https://' || raw; end if;
  raw := regexp_replace(lower(raw), '[?#].*$', '');
  scheme := substring(raw from '^(https?)://');
  rest := regexp_replace(raw, '^https?://', '');
  if scheme is null or rest = '' or position('@' in rest) > 0 then return null; end if;
  slash := position('/' in rest);
  if slash = 0 then
    host := rest;
    path := '';
  else
    host := substring(rest from 1 for slash - 1);
    path := rtrim(substring(rest from slash), '/');
  end if;
  host := regexp_replace(host, ':[0-9]+$', '');
  host := regexp_replace(host, '^www\.', '');
  if host = '' or host !~ '^[a-z0-9.-]+$' or path !~ '^/?[a-z0-9._~%!$&''()*+,;=:@/-]*$' then return null; end if;
  return scheme || '://' || host || path;
end;
$$;

create table if not exists public.outreach_suppressions (
  id uuid primary key default gen_random_uuid(),
  normalized_email text not null,
  reason text not null default 'opt_out',
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  constraint outreach_suppressions_email_unique unique (normalized_email),
  constraint outreach_suppressions_email_shape check (
    char_length(normalized_email) between 3 and 320
    and normalized_email = lower(normalized_email)
    and normalized_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  constraint outreach_suppressions_reason_length check (char_length(reason) between 1 and 160)
);

create table if not exists public.outreach_prospects (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  category text not null default '',
  location text not null default '',
  website text not null default '',
  contact_email text not null default '',
  source text not null default '',
  lead_status text not null default 'new',
  normalized_email text not null default '',
  normalized_website text not null default '',
  normalized_name text not null default '',
  normalized_location text not null default '',
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint outreach_prospects_name_length check (char_length(business_name) between 1 and 120),
  constraint outreach_prospects_category_length check (char_length(category) <= 80),
  constraint outreach_prospects_location_length check (char_length(location) <= 120),
  constraint outreach_prospects_website_length check (char_length(website) <= 200),
  constraint outreach_prospects_email_length check (char_length(contact_email) <= 320),
  constraint outreach_prospects_source_length check (char_length(source) <= 80),
  constraint outreach_prospects_status check (
    lead_status in ('new', 'contacted', 'interested', 'not_interested', 'suppressed')
  )
);

create unique index if not exists outreach_prospects_email_unique
  on public.outreach_prospects (normalized_email)
  where normalized_email <> '';

create unique index if not exists outreach_prospects_website_name_unique
  on public.outreach_prospects (normalized_website, normalized_name)
  where normalized_website <> '';

create unique index if not exists outreach_prospects_place_unique
  on public.outreach_prospects (normalized_name, normalized_location)
  where normalized_email = '' and normalized_website = '' and normalized_location <> '';

create unique index if not exists outreach_prospects_name_unique
  on public.outreach_prospects (normalized_name)
  where normalized_email = '' and normalized_website = '' and normalized_location = '';

create index if not exists outreach_prospects_status_idx
  on public.outreach_prospects (lead_status, created_at desc);

create or replace function public.prepare_outreach_prospect()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  website text;
begin
  new.business_name := left(regexp_replace(btrim(coalesce(new.business_name, '')), '\s+', ' ', 'g'), 120);
  new.category := left(regexp_replace(btrim(coalesce(new.category, '')), '\s+', ' ', 'g'), 80);
  new.location := left(regexp_replace(btrim(coalesce(new.location, '')), '\s+', ' ', 'g'), 120);
  new.source := left(regexp_replace(btrim(coalesce(new.source, '')), '\s+', ' ', 'g'), 80);
  new.contact_email := left(btrim(coalesce(new.contact_email, '')), 320);
  new.normalized_name := lower(new.business_name);
  new.normalized_location := lower(new.location);
  new.normalized_email := public.outreach_normalized_email(new.contact_email);
  website := public.outreach_normalized_website(new.website);
  if new.normalized_name = '' then
    raise exception 'A prospect needs a business name';
  end if;
  if new.contact_email <> '' and new.normalized_email = '' then
    raise exception 'Contact email is not valid';
  end if;
  if btrim(coalesce(new.website, '')) <> '' and website is null then
    raise exception 'Website must be an http or https address';
  end if;
  new.website := coalesce(website, '');
  new.normalized_website := coalesce(website, '');
  new.contact_email := new.normalized_email;
  if new.normalized_email <> '' and exists (
    select 1 from public.outreach_suppressions as suppression
    where suppression.normalized_email = new.normalized_email
  ) then
    new.lead_status := 'suppressed';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists outreach_prospects_prepare on public.outreach_prospects;
create trigger outreach_prospects_prepare
  before insert or update on public.outreach_prospects
  for each row execute function public.prepare_outreach_prospect();

create or replace function public.prepare_outreach_suppression()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.normalized_email := public.outreach_normalized_email(new.normalized_email);
  new.reason := left(regexp_replace(btrim(coalesce(new.reason, 'opt_out')), '\s+', ' ', 'g'), 160);
  if new.normalized_email = '' then
    raise exception 'Suppression requires a valid email';
  end if;
  if new.reason = '' then new.reason := 'opt_out'; end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists outreach_suppressions_prepare on public.outreach_suppressions;
create trigger outreach_suppressions_prepare
  before insert or update on public.outreach_suppressions
  for each row execute function public.prepare_outreach_suppression();

create or replace function public.apply_outreach_suppression()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.outreach_prospects
  set lead_status = 'suppressed'
  where normalized_email = new.normalized_email
    and lead_status is distinct from 'suppressed';
  return new;
end;
$$;

drop trigger if exists outreach_suppressions_apply on public.outreach_suppressions;
create trigger outreach_suppressions_apply
  after insert or update of normalized_email on public.outreach_suppressions
  for each row execute function public.apply_outreach_suppression();

alter table public.outreach_prospects enable row level security;
alter table public.outreach_prospects force row level security;
alter table public.outreach_suppressions enable row level security;
alter table public.outreach_suppressions force row level security;

drop policy if exists outreach_prospects_select on public.outreach_prospects;
drop policy if exists outreach_prospects_insert on public.outreach_prospects;
drop policy if exists outreach_prospects_update on public.outreach_prospects;
drop policy if exists outreach_prospects_delete on public.outreach_prospects;
drop policy if exists outreach_suppressions_select on public.outreach_suppressions;
drop policy if exists outreach_suppressions_insert on public.outreach_suppressions;
drop policy if exists outreach_suppressions_delete on public.outreach_suppressions;

create policy outreach_prospects_select
  on public.outreach_prospects for select to authenticated
  using (public.is_admin());
create policy outreach_prospects_insert
  on public.outreach_prospects for insert to authenticated
  with check (public.is_admin());
create policy outreach_prospects_update
  on public.outreach_prospects for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());
create policy outreach_prospects_delete
  on public.outreach_prospects for delete to authenticated
  using (public.is_admin());

create policy outreach_suppressions_select
  on public.outreach_suppressions for select to authenticated
  using (public.is_admin());
create policy outreach_suppressions_insert
  on public.outreach_suppressions for insert to authenticated
  with check (public.is_admin());
create policy outreach_suppressions_delete
  on public.outreach_suppressions for delete to authenticated
  using (public.is_admin());

-- Replace any default privileges, including truncate. Truncate ignores row policies.
revoke all on table public.outreach_prospects from public, anon, authenticated;
revoke all on table public.outreach_suppressions from public, anon, authenticated;
grant select, insert, update, delete on table public.outreach_prospects to authenticated;
grant select, insert, delete on table public.outreach_suppressions to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.outreach_prospects from service_role;
    revoke all on table public.outreach_suppressions from service_role;
    grant select, insert, update, delete on table public.outreach_prospects to service_role;
    grant select, insert, delete on table public.outreach_suppressions to service_role;
  end if;
end
$$;

revoke all on function public.outreach_normalized_email(text) from public, anon;
revoke all on function public.outreach_normalized_website(text) from public, anon;
revoke all on function public.prepare_outreach_prospect() from public, anon;
revoke all on function public.prepare_outreach_suppression() from public, anon;
revoke all on function public.apply_outreach_suppression() from public, anon;
grant execute on function public.outreach_normalized_email(text) to authenticated;
grant execute on function public.outreach_normalized_website(text) to authenticated;
grant execute on function public.prepare_outreach_prospect() to authenticated;
grant execute on function public.prepare_outreach_suppression() to authenticated;
grant execute on function public.apply_outreach_suppression() to authenticated;
