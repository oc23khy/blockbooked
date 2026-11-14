-- Outreach send queue. Applying this file does not send mail or update existing prospects.
-- Sending stays off: the settings row is false, and a trigger rejects turning it on.
-- Safe to run again. Do not run this from the application.

create table if not exists public.outreach_send_settings (
  id boolean primary key default true,
  sending_enabled boolean not null default false,
  daily_limit integer not null default 50,
  per_minute_limit integer not null default 5,
  updated_at timestamptz not null default now(),
  constraint outreach_send_settings_singleton check (id),
  constraint outreach_send_settings_daily check (daily_limit between 1 and 500),
  constraint outreach_send_settings_minute check (per_minute_limit between 1 and 30)
);

insert into public.outreach_send_settings (id, sending_enabled)
values (true, false)
on conflict (id) do nothing;

create table if not exists public.outreach_send_jobs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.outreach_campaigns (id) on delete cascade,
  status text not null default 'review',
  recipient_count integer not null default 0,
  suppressed_count integer not null default 0,
  invalid_count integer not null default 0,
  duplicate_count integer not null default 0,
  allowed_count integer not null default 0,
  block_reason text not null default '',
  confirmed_by uuid references public.profiles (id) on delete set null,
  confirmed_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint outreach_send_jobs_status check (status in ('review', 'confirmed', 'blocked', 'cancelled')),
  constraint outreach_send_jobs_counts check (
    recipient_count >= 0 and suppressed_count >= 0 and invalid_count >= 0
    and duplicate_count >= 0 and allowed_count >= 0 and allowed_count <= recipient_count
  ),
  constraint outreach_send_jobs_reason_length check (char_length(block_reason) <= 80)
);

create table if not exists public.outreach_send_recipients (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.outreach_send_jobs (id) on delete cascade,
  campaign_id uuid not null references public.outreach_campaigns (id) on delete cascade,
  prospect_id uuid references public.outreach_prospects (id) on delete set null,
  normalized_email text not null,
  personalized_subject text not null,
  personalized_body text not null,
  status text not null default 'queued',
  attempt_count integer not null default 0,
  idempotency_key text not null,
  last_error text not null default '',
  queued_at timestamptz not null default now(),
  attempted_at timestamptz,
  finished_at timestamptz,
  constraint outreach_send_recipients_email_shape check (
    char_length(normalized_email) between 3 and 320
    and normalized_email = lower(normalized_email)
    and normalized_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  constraint outreach_send_recipients_subject_length check (char_length(personalized_subject) between 1 and 160),
  constraint outreach_send_recipients_body_length check (char_length(personalized_body) between 1 and 8000),
  constraint outreach_send_recipients_status check (status in ('queued', 'suppressed', 'blocked', 'failed')),
  constraint outreach_send_recipients_attempts check (attempt_count between 0 and 3),
  constraint outreach_send_recipients_error_length check (char_length(last_error) <= 80),
  constraint outreach_send_recipients_job_email unique (job_id, normalized_email),
  constraint outreach_send_recipients_idempotency unique (idempotency_key)
);

create table if not exists public.outreach_delivery_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.outreach_send_jobs (id) on delete cascade,
  recipient_id uuid references public.outreach_send_recipients (id) on delete cascade,
  event_type text not null,
  detail text not null default '',
  created_at timestamptz not null default now(),
  constraint outreach_delivery_events_type check (event_type in ('queued', 'suppressed', 'blocked', 'retry', 'failed')),
  constraint outreach_delivery_events_detail_length check (char_length(detail) <= 80)
);

create unique index if not exists outreach_send_jobs_one_campaign
  on public.outreach_send_jobs (campaign_id);
create index if not exists outreach_send_jobs_campaign_idx
  on public.outreach_send_jobs (campaign_id, created_at desc);
create index if not exists outreach_send_recipients_status_idx
  on public.outreach_send_recipients (status, queued_at);
create index if not exists outreach_delivery_events_job_idx
  on public.outreach_delivery_events (job_id, created_at);

create or replace function public.protect_outreach_send_settings()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.sending_enabled is true then
    raise exception 'Outreach sending is disabled';
  end if;
  new.id := true;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists outreach_send_settings_protect on public.outreach_send_settings;
create trigger outreach_send_settings_protect
  before insert or update on public.outreach_send_settings
  for each row execute function public.protect_outreach_send_settings();

create or replace function public.prepare_outreach_send_job()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.status is null or new.status not in ('review', 'confirmed', 'blocked', 'cancelled') then
    raise exception 'Outreach send job status is not valid';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.status := 'review';
    new.confirmed_at := null;
    new.confirmed_by := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists outreach_send_jobs_prepare on public.outreach_send_jobs;
create trigger outreach_send_jobs_prepare
  before insert or update on public.outreach_send_jobs
  for each row execute function public.prepare_outreach_send_job();

create or replace function public.prepare_outreach_send_recipient()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.normalized_email := public.outreach_normalized_email(new.normalized_email);
  if new.normalized_email = '' then
    raise exception 'Outreach recipient email is not valid';
  end if;
  if new.status = 'sent' then
    raise exception 'Outreach sending is disabled';
  end if;
  if tg_op = 'INSERT' then
    new.queued_at := now();
    new.attempt_count := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists outreach_send_recipients_prepare on public.outreach_send_recipients;
create trigger outreach_send_recipients_prepare
  before insert or update on public.outreach_send_recipients
  for each row execute function public.prepare_outreach_send_recipient();

alter table public.outreach_send_settings enable row level security;
alter table public.outreach_send_settings force row level security;
alter table public.outreach_send_jobs enable row level security;
alter table public.outreach_send_jobs force row level security;
alter table public.outreach_send_recipients enable row level security;
alter table public.outreach_send_recipients force row level security;
alter table public.outreach_delivery_events enable row level security;
alter table public.outreach_delivery_events force row level security;

drop policy if exists outreach_send_settings_select on public.outreach_send_settings;
drop policy if exists outreach_send_settings_update on public.outreach_send_settings;
drop policy if exists outreach_send_jobs_select on public.outreach_send_jobs;
drop policy if exists outreach_send_jobs_insert on public.outreach_send_jobs;
drop policy if exists outreach_send_jobs_update on public.outreach_send_jobs;
drop policy if exists outreach_send_recipients_select on public.outreach_send_recipients;
drop policy if exists outreach_send_recipients_insert on public.outreach_send_recipients;
drop policy if exists outreach_send_recipients_update on public.outreach_send_recipients;
drop policy if exists outreach_delivery_events_select on public.outreach_delivery_events;
drop policy if exists outreach_delivery_events_insert on public.outreach_delivery_events;

create policy outreach_send_settings_select
  on public.outreach_send_settings for select to authenticated
  using (public.is_admin());
create policy outreach_send_settings_update
  on public.outreach_send_settings for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());
create policy outreach_send_jobs_select
  on public.outreach_send_jobs for select to authenticated
  using (public.is_admin());
create policy outreach_send_jobs_insert
  on public.outreach_send_jobs for insert to authenticated
  with check (public.is_admin());
create policy outreach_send_jobs_update
  on public.outreach_send_jobs for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());
create policy outreach_send_recipients_select
  on public.outreach_send_recipients for select to authenticated
  using (public.is_admin());
create policy outreach_send_recipients_insert
  on public.outreach_send_recipients for insert to authenticated
  with check (public.is_admin());
create policy outreach_send_recipients_update
  on public.outreach_send_recipients for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());
create policy outreach_delivery_events_select
  on public.outreach_delivery_events for select to authenticated
  using (public.is_admin());
create policy outreach_delivery_events_insert
  on public.outreach_delivery_events for insert to authenticated
  with check (public.is_admin());

revoke all on table public.outreach_send_settings from public, anon, authenticated;
revoke all on table public.outreach_send_jobs from public, anon, authenticated;
revoke all on table public.outreach_send_recipients from public, anon, authenticated;
revoke all on table public.outreach_delivery_events from public, anon, authenticated;
grant select, update on table public.outreach_send_settings to authenticated;
grant select, insert, update on table public.outreach_send_jobs to authenticated;
grant select, insert, update on table public.outreach_send_recipients to authenticated;
grant select, insert on table public.outreach_delivery_events to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.outreach_send_settings from service_role;
    revoke all on table public.outreach_send_jobs from service_role;
    revoke all on table public.outreach_send_recipients from service_role;
    revoke all on table public.outreach_delivery_events from service_role;
    grant select on table public.outreach_send_settings to service_role;
    grant select, insert, update on table public.outreach_send_jobs to service_role;
    grant select, insert, update on table public.outreach_send_recipients to service_role;
    grant select, insert on table public.outreach_delivery_events to service_role;
    grant execute on function public.protect_outreach_send_settings() to service_role;
    grant execute on function public.prepare_outreach_send_job() to service_role;
    grant execute on function public.prepare_outreach_send_recipient() to service_role;
  end if;
end
$$;

create or replace function public.outreach_campaign_is_sendable(target_campaign uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.outreach_campaigns
    where id = target_campaign
      and campaign_status = 'draft'
      and char_length(sender_name) >= 2
      and public.outreach_normalized_email(sender_email) <> ''
      and char_length(physical_address) >= 12
      and physical_address ~ '\d'
      and unsubscribe_footer ~* 'unsubscribe'
  );
$$;

create or replace function public.outreach_email_is_blocked(target_email text)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select public.outreach_normalized_email(target_email) <> ''
    and (
      exists (
        select 1 from public.outreach_suppressions
        where normalized_email = public.outreach_normalized_email(target_email)
      )
      or exists (
        select 1 from public.outreach_prospects
        where lead_status = 'suppressed'
          and public.outreach_normalized_email(contact_email) = public.outreach_normalized_email(target_email)
      )
    );
$$;

create or replace function public.guard_outreach_send_job()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and not public.outreach_campaign_is_sendable(new.campaign_id) then
    raise exception 'Outreach campaign is not sendable';
  end if;
  return new;
end;
$$;

drop trigger if exists outreach_send_jobs_guard on public.outreach_send_jobs;
create trigger outreach_send_jobs_guard
  before insert or update on public.outreach_send_jobs
  for each row execute function public.guard_outreach_send_job();

create or replace function public.create_outreach_send_queue(
  target_campaign uuid,
  recipient_count integer,
  suppressed_count integer,
  invalid_count integer,
  duplicate_count integer,
  allowed_count integer,
  recipients jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  new_job uuid;
  recipient jsonb;
  normalized text;
  prospect uuid;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Outreach send queue requires an administrator';
  end if;
  if not public.outreach_campaign_is_sendable(target_campaign) then
    raise exception 'Outreach campaign is not sendable';
  end if;
  if jsonb_typeof(recipients) is distinct from 'array'
    or jsonb_array_length(recipients) = 0
    or jsonb_array_length(recipients) > 5000
    or recipient_count is distinct from jsonb_array_length(recipients)
    or suppressed_count < 0 or invalid_count < 0 or duplicate_count < 0 or allowed_count < 0
    or allowed_count > recipient_count then
    raise exception 'Outreach recipient list is not valid';
  end if;

  insert into public.outreach_send_jobs (
    campaign_id, status, recipient_count, suppressed_count, invalid_count, duplicate_count, allowed_count, block_reason
  ) values (
    target_campaign, 'review', recipient_count, suppressed_count, invalid_count, duplicate_count, allowed_count, ''
  ) returning id into new_job;

  for recipient in select value from jsonb_array_elements(recipients)
  loop
    normalized := public.outreach_normalized_email(recipient->>'normalized_email');
    if normalized = '' or recipient->>'idempotency_key' is distinct from ('outreach:' || target_campaign::text || ':' || normalized) then
      raise exception 'Outreach recipient is not eligible';
    end if;
    if public.outreach_email_is_blocked(normalized) then
      raise exception 'Outreach recipient is suppressed';
    end if;
    prospect := nullif(recipient->>'prospect_id', '')::uuid;
    if prospect is not null and not exists (
      select 1 from public.outreach_prospects
      where id = prospect
        and public.outreach_normalized_email(contact_email) = normalized
        and lead_status <> 'suppressed'
    ) then
      raise exception 'Outreach recipient is not eligible';
    end if;
    insert into public.outreach_send_recipients (
      job_id, campaign_id, prospect_id, normalized_email, personalized_subject, personalized_body, status, idempotency_key
    ) values (
      new_job, target_campaign, prospect, normalized,
      recipient->>'personalized_subject', recipient->>'personalized_body', 'queued', recipient->>'idempotency_key'
    );
  end loop;

  insert into public.outreach_delivery_events (job_id, event_type, detail)
  values (new_job, 'queued', 'queue saved');
  return new_job;
exception
  when unique_violation then
    if sqlerrm like '%outreach_send_jobs_one_campaign%' then
      raise exception 'Outreach send queue already exists' using errcode = '23505';
    end if;
    raise exception 'Outreach recipient is not eligible';
end;
$$;

create or replace function public.confirm_outreach_send_queue(
  target_campaign uuid,
  target_job uuid,
  confirmation text
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  campaign_name text;
  job_status text;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Outreach send queue requires an administrator';
  end if;
  select name into campaign_name
  from public.outreach_campaigns
  where id = target_campaign and campaign_status = 'draft';
  if campaign_name is null or btrim(campaign_name) = '' or confirmation is distinct from btrim(campaign_name) then
    raise exception 'Outreach confirmation does not match';
  end if;
  select status into job_status
  from public.outreach_send_jobs
  where id = target_job and campaign_id = target_campaign
  for update;
  if job_status is distinct from 'review' then
    raise exception 'Outreach send queue is not awaiting confirmation';
  end if;

  with held as (
    update public.outreach_send_recipients
    set status = 'suppressed', last_error = 'suppressed', finished_at = now()
    where job_id = target_job
      and status = 'queued'
      and public.outreach_email_is_blocked(normalized_email)
    returning id
  )
  insert into public.outreach_delivery_events (job_id, recipient_id, event_type, detail)
  select target_job, held.id, 'suppressed', 'suppressed' from held;

  update public.outreach_send_recipients
  set status = 'blocked', last_error = 'sending_disabled', finished_at = now()
  where job_id = target_job and status = 'queued';

  update public.outreach_send_jobs
  set status = 'blocked',
      confirmed_by = auth.uid(),
      confirmed_at = now(),
      block_reason = 'sending_disabled'
  where id = target_job and campaign_id = target_campaign and status = 'review';
  if not found then
    raise exception 'Outreach send queue is not awaiting confirmation';
  end if;

  insert into public.outreach_delivery_events (job_id, event_type, detail)
  values (target_job, 'blocked', 'blocked:sending_disabled');
  return 'blocked';
end;
$$;

create or replace function public.retry_outreach_send_queue(target_campaign uuid, target_job uuid)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  job_status text;
  updated_count integer;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Outreach send queue requires an administrator';
  end if;
  select status into job_status
  from public.outreach_send_jobs
  where id = target_job and campaign_id = target_campaign
  for update;
  if job_status is distinct from 'blocked' then
    raise exception 'Outreach send queue cannot be retried';
  end if;

  with held as (
    update public.outreach_send_recipients
    set status = 'suppressed', last_error = 'suppressed', finished_at = now()
    where job_id = target_job
      and status in ('queued', 'failed', 'blocked')
      and public.outreach_email_is_blocked(normalized_email)
    returning id
  )
  insert into public.outreach_delivery_events (job_id, recipient_id, event_type, detail)
  select target_job, held.id, 'suppressed', 'suppressed' from held;

  with held as (
    update public.outreach_send_recipients
    set status = 'blocked',
        attempt_count = attempt_count + 1,
        attempted_at = now(),
        last_error = 'sending_disabled'
    where job_id = target_job
      and status in ('queued', 'failed', 'blocked')
      and attempt_count < 3
    returning id
  )
  insert into public.outreach_delivery_events (job_id, recipient_id, event_type, detail)
  select target_job, held.id, 'retry', 'blocked:sending_disabled' from held;
  get diagnostics updated_count = row_count;
  if updated_count = 0 then
    return 'exhausted';
  end if;
  return 'blocked';
end;
$$;

revoke all on function public.protect_outreach_send_settings() from public, anon, authenticated;
revoke all on function public.prepare_outreach_send_job() from public, anon, authenticated;
revoke all on function public.prepare_outreach_send_recipient() from public, anon, authenticated;
revoke all on function public.outreach_campaign_is_sendable(uuid) from public, anon, authenticated;
revoke all on function public.outreach_email_is_blocked(text) from public, anon, authenticated;
revoke all on function public.guard_outreach_send_job() from public, anon, authenticated;
revoke all on function public.create_outreach_send_queue(uuid, integer, integer, integer, integer, integer, jsonb) from public, anon, authenticated;
revoke all on function public.confirm_outreach_send_queue(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.retry_outreach_send_queue(uuid, uuid) from public, anon, authenticated;
grant execute on function public.protect_outreach_send_settings() to authenticated;
grant execute on function public.prepare_outreach_send_job() to authenticated;
grant execute on function public.prepare_outreach_send_recipient() to authenticated;
grant execute on function public.outreach_campaign_is_sendable(uuid) to authenticated;
grant execute on function public.outreach_email_is_blocked(text) to authenticated;
grant execute on function public.guard_outreach_send_job() to authenticated;
grant execute on function public.create_outreach_send_queue(uuid, integer, integer, integer, integer, integer, jsonb) to authenticated;
grant execute on function public.confirm_outreach_send_queue(uuid, uuid, text) to authenticated;
grant execute on function public.retry_outreach_send_queue(uuid, uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.create_outreach_send_queue(uuid, integer, integer, integer, integer, integer, jsonb) from service_role;
    revoke all on function public.confirm_outreach_send_queue(uuid, uuid, text) from service_role;
    revoke all on function public.retry_outreach_send_queue(uuid, uuid) from service_role;
  end if;
end
$$;
