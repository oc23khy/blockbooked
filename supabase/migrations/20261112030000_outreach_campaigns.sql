-- Draft outreach campaigns. Administrators can prepare a message and audience.
-- Nothing in this migration sends mail. It does not alter booking, payment, or mail tables.
-- Safe to run again. Do not run this from the application.

create table if not exists public.outreach_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subject text not null,
  body text not null,
  sender_name text not null default '',
  sender_email text not null default '',
  physical_address text not null default '',
  unsubscribe_footer text not null default '',
  filter_lead_status text not null default '',
  filter_category text not null default '',
  filter_location text not null default '',
  filter_source text not null default '',
  campaign_status text not null default 'draft',
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint outreach_campaigns_name_length check (char_length(name) between 1 and 120),
  constraint outreach_campaigns_subject_length check (char_length(subject) between 1 and 160),
  constraint outreach_campaigns_body_length check (char_length(body) between 1 and 8000),
  constraint outreach_campaigns_sender_name_length check (char_length(sender_name) <= 80),
  constraint outreach_campaigns_sender_email_length check (char_length(sender_email) <= 320),
  constraint outreach_campaigns_address_length check (char_length(physical_address) <= 300),
  constraint outreach_campaigns_footer_length check (char_length(unsubscribe_footer) <= 500),
  constraint outreach_campaigns_filter_status check (
    filter_lead_status in ('', 'new', 'contacted', 'interested', 'not_interested')
  ),
  constraint outreach_campaigns_filter_category_length check (char_length(filter_category) <= 80),
  constraint outreach_campaigns_filter_location_length check (char_length(filter_location) <= 120),
  constraint outreach_campaigns_filter_source_length check (char_length(filter_source) <= 80),
  constraint outreach_campaigns_draft_only check (campaign_status = 'draft')
);

create index if not exists outreach_campaigns_created_idx
  on public.outreach_campaigns (created_at desc);

create or replace function public.prepare_outreach_campaign()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  raw_sender text;
begin
  if new.campaign_status is distinct from 'draft' then
    raise exception 'Only a draft campaign can be saved';
  end if;
  new.name := left(regexp_replace(btrim(coalesce(new.name, '')), '\s+', ' ', 'g'), 120);
  new.subject := left(regexp_replace(btrim(coalesce(new.subject, '')), '\s+', ' ', 'g'), 160);
  new.sender_name := left(regexp_replace(btrim(coalesce(new.sender_name, '')), '\s+', ' ', 'g'), 80);
  raw_sender := btrim(coalesce(new.sender_email, ''));
  new.sender_email := public.outreach_normalized_email(raw_sender);
  new.physical_address := left(regexp_replace(btrim(coalesce(new.physical_address, '')), '\s+', ' ', 'g'), 300);
  new.filter_category := left(regexp_replace(btrim(coalesce(new.filter_category, '')), '\s+', ' ', 'g'), 80);
  new.filter_location := left(regexp_replace(btrim(coalesce(new.filter_location, '')), '\s+', ' ', 'g'), 120);
  new.filter_source := left(regexp_replace(btrim(coalesce(new.filter_source, '')), '\s+', ' ', 'g'), 80);
  if raw_sender <> '' and new.sender_email = '' then
    raise exception 'Sender email is not valid';
  end if;
  if new.name = '' or new.subject = '' or btrim(coalesce(new.body, '')) = '' then
    raise exception 'A campaign needs a name, subject, and body';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists outreach_campaigns_prepare on public.outreach_campaigns;
create trigger outreach_campaigns_prepare
  before insert or update on public.outreach_campaigns
  for each row execute function public.prepare_outreach_campaign();

alter table public.outreach_campaigns enable row level security;
alter table public.outreach_campaigns force row level security;

drop policy if exists outreach_campaigns_select on public.outreach_campaigns;
drop policy if exists outreach_campaigns_insert on public.outreach_campaigns;
drop policy if exists outreach_campaigns_update on public.outreach_campaigns;
drop policy if exists outreach_campaigns_delete on public.outreach_campaigns;

create policy outreach_campaigns_select
  on public.outreach_campaigns for select to authenticated
  using (public.is_admin());
create policy outreach_campaigns_insert
  on public.outreach_campaigns for insert to authenticated
  with check (public.is_admin());
create policy outreach_campaigns_update
  on public.outreach_campaigns for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());
create policy outreach_campaigns_delete
  on public.outreach_campaigns for delete to authenticated
  using (public.is_admin());

revoke all on table public.outreach_campaigns from public, anon, authenticated;
grant select, insert, update, delete on table public.outreach_campaigns to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.outreach_campaigns from service_role;
    grant select, insert, update, delete on table public.outreach_campaigns to service_role;
  end if;
end
$$;

revoke all on function public.prepare_outreach_campaign() from public, anon, authenticated;
grant execute on function public.prepare_outreach_campaign() to authenticated;
