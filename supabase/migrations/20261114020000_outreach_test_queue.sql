-- Isolated outreach queue simulation. Applying this file does not send mail.
-- It does not read or write production send settings, live prospects, live suppressions, or live queues.

create table if not exists public.outreach_test_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subject text not null,
  body text not null,
  created_at timestamptz not null default now(),
  constraint outreach_test_campaigns_name_length check (char_length(btrim(name)) between 2 and 80),
  constraint outreach_test_campaigns_subject_length check (char_length(subject) between 1 and 160),
  constraint outreach_test_campaigns_body_length check (char_length(body) between 1 and 8000)
);

create table if not exists public.outreach_test_recipients_fixture (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  city text not null,
  contact_email text not null,
  created_at timestamptz not null default now(),
  constraint outreach_test_fixture_name_length check (char_length(business_name) between 2 and 120),
  constraint outreach_test_fixture_city_length check (char_length(city) between 2 and 80),
  constraint outreach_test_fixture_email check (
    contact_email = lower(contact_email)
    and contact_email ~ '^[^[:space:]@]+@example\.com$'
  )
);

create table if not exists public.outreach_test_suppressions (
  normalized_email text primary key,
  reason text not null,
  created_at timestamptz not null default now(),
  constraint outreach_test_suppressions_email check (
    normalized_email = lower(normalized_email)
    and normalized_email ~ '^[^[:space:]@]+@example\.com$'
  ),
  constraint outreach_test_suppressions_reason check (reason in ('fixture', 'test'))
);

create table if not exists public.outreach_test_jobs (
  id uuid primary key default gen_random_uuid(),
  test_campaign_id uuid not null references public.outreach_test_campaigns (id) on delete cascade,
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
  constraint outreach_test_jobs_status check (status in ('review', 'blocked', 'cancelled')),
  constraint outreach_test_jobs_counts check (
    recipient_count >= 0 and suppressed_count >= 0 and invalid_count >= 0
    and duplicate_count >= 0 and allowed_count >= 0 and allowed_count <= recipient_count
  ),
  constraint outreach_test_jobs_reason check (block_reason = '' or block_reason ~ '^test:')
);

create table if not exists public.outreach_test_queue_recipients (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.outreach_test_jobs (id) on delete cascade,
  test_campaign_id uuid not null references public.outreach_test_campaigns (id) on delete cascade,
  fixture_id uuid references public.outreach_test_recipients_fixture (id) on delete set null,
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
  constraint outreach_test_recipients_email check (
    normalized_email = lower(normalized_email)
    and normalized_email ~ '^[^[:space:]@]+@example\.com$'
  ),
  constraint outreach_test_recipients_subject_length check (char_length(personalized_subject) between 1 and 160),
  constraint outreach_test_recipients_body_length check (char_length(personalized_body) between 1 and 8000),
  constraint outreach_test_recipients_status check (status in ('queued', 'suppressed', 'blocked', 'failed')),
  constraint outreach_test_recipients_attempts check (attempt_count between 0 and 3),
  constraint outreach_test_recipients_error check (last_error = '' or last_error ~ '^test:'),
  constraint outreach_test_recipients_key check (
    idempotency_key = 'outreach-test:' || test_campaign_id::text || ':' || normalized_email
  ),
  constraint outreach_test_recipients_job_email unique (job_id, normalized_email),
  constraint outreach_test_recipients_idempotency unique (idempotency_key)
);

create table if not exists public.outreach_test_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.outreach_test_jobs (id) on delete cascade,
  recipient_id uuid references public.outreach_test_queue_recipients (id) on delete cascade,
  event_type text not null,
  detail text not null,
  created_at timestamptz not null default now(),
  constraint outreach_test_events_type check (event_type in ('queued', 'suppressed', 'blocked', 'retry', 'failed')),
  constraint outreach_test_events_detail check (detail ~ '^test:' and char_length(detail) <= 80)
);

create unique index if not exists outreach_test_jobs_one_campaign
  on public.outreach_test_jobs (test_campaign_id);
create index if not exists outreach_test_events_job_idx
  on public.outreach_test_events (job_id, created_at);

create or replace function public.outreach_test_normalized_email(value text)
returns text
language sql
immutable
security invoker
set search_path = public
as $$
  select case
    when public.outreach_normalized_email(value) ~ '^[^[:space:]@]+@example\.com$'
      then public.outreach_normalized_email(value)
    else ''
  end;
$$;

create or replace function public.prepare_outreach_test_suppression()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.normalized_email := public.outreach_test_normalized_email(new.normalized_email);
  if new.normalized_email = '' then
    raise exception 'Outreach test recipient is not synthetic';
  end if;
  if new.reason is null or new.reason not in ('fixture', 'test') then
    raise exception 'Outreach test suppression is not valid';
  end if;
  if not exists (
    select 1 from public.outreach_test_recipients_fixture where contact_email = new.normalized_email
  ) then
    raise exception 'Outreach test recipient is not synthetic';
  end if;
  return new;
end;
$$;

drop trigger if exists outreach_test_suppressions_prepare on public.outreach_test_suppressions;
create trigger outreach_test_suppressions_prepare
  before insert or update on public.outreach_test_suppressions
  for each row execute function public.prepare_outreach_test_suppression();

create or replace function public.prepare_outreach_test_job()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.status is null or new.status not in ('review', 'blocked', 'cancelled') then
    raise exception 'Outreach test job status is not valid';
  end if;
  if new.status = 'sent' then
    raise exception 'Outreach sending is disabled';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.status := 'review';
    new.confirmed_at := null;
    new.confirmed_by := null;
    new.block_reason := '';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists outreach_test_jobs_prepare on public.outreach_test_jobs;
create trigger outreach_test_jobs_prepare
  before insert or update on public.outreach_test_jobs
  for each row execute function public.prepare_outreach_test_job();

create or replace function public.prepare_outreach_test_recipient()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.normalized_email := public.outreach_test_normalized_email(new.normalized_email);
  if new.normalized_email = '' then
    raise exception 'Outreach test recipient is not synthetic';
  end if;
  if tg_op = 'UPDATE' and new.normalized_email is distinct from old.normalized_email then
    raise exception 'Outreach test recipient is not synthetic';
  end if;
  if not exists (
    select 1 from public.outreach_test_recipients_fixture where contact_email = new.normalized_email
  ) then
    raise exception 'Outreach test recipient is not synthetic';
  end if;
  if new.status = 'sent' then
    raise exception 'Outreach sending is disabled';
  end if;
  new.idempotency_key := 'outreach-test:' || new.test_campaign_id::text || ':' || new.normalized_email;
  if tg_op = 'INSERT' then
    new.queued_at := now();
    new.attempt_count := 0;
  elsif new.attempt_count < old.attempt_count or new.attempt_count > old.attempt_count + 1 then
    raise exception 'Outreach test retry is not valid';
  elsif old.status = 'suppressed' and new.status is distinct from 'suppressed' then
    raise exception 'Outreach test recipient is suppressed';
  end if;
  return new;
end;
$$;

drop trigger if exists outreach_test_recipients_prepare on public.outreach_test_queue_recipients;
create trigger outreach_test_recipients_prepare
  before insert or update on public.outreach_test_queue_recipients
  for each row execute function public.prepare_outreach_test_recipient();

create or replace function public.prepare_outreach_test_event()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.event_type is null or new.event_type not in ('queued', 'suppressed', 'blocked', 'retry', 'failed') then
    raise exception 'Outreach test event is not a simulation';
  end if;
  if new.detail is null or new.detail !~ '^test:' then
    raise exception 'Outreach test event must be a simulation';
  end if;
  return new;
end;
$$;

drop trigger if exists outreach_test_events_prepare on public.outreach_test_events;
create trigger outreach_test_events_prepare
  before insert or update on public.outreach_test_events
  for each row execute function public.prepare_outreach_test_event();

insert into public.outreach_test_campaigns (id, name, subject, body)
values (
  '00000000-0000-4000-8000-0000000000a1',
  'Queue test',
  'Hello {{business_name}}',
  'This simulation mentions {{city}}.'
)
on conflict (id) do nothing;

insert into public.outreach_test_recipients_fixture (id, business_name, city, contact_email)
values
  ('00000000-0000-4000-8000-0000000000b1', 'North Test', 'Rockford', 'queue-test-a@example.com'),
  ('00000000-0000-4000-8000-0000000000b2', 'North Test Copy', 'Rockford', 'queue-test-a@example.com'),
  ('00000000-0000-4000-8000-0000000000b3', 'South Test', 'Rockford', 'queue-test-b@example.com'),
  ('00000000-0000-4000-8000-0000000000b4', 'Opted Test', 'Rockford', 'queue-test-c@example.com'),
  ('00000000-0000-4000-8000-0000000000b5', 'Later Test', 'Rockford', 'queue-test-d@example.com')
on conflict (id) do nothing;

insert into public.outreach_test_suppressions (normalized_email, reason)
values ('queue-test-c@example.com', 'fixture')
on conflict (normalized_email) do nothing;

create or replace function public.create_outreach_test_queue(
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
  fixture_row record;
  chosen_id uuid;
  chosen_name text;
  chosen_city text;
  campaign_subject text;
  campaign_body text;
  normalized text;
  seen text[] := '{}';
  queued_count integer := 0;
  found_suppressed integer := 0;
  found_invalid integer := 0;
  found_duplicates integer := 0;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Outreach test queue requires an administrator';
  end if;
  select subject, body into campaign_subject, campaign_body
  from public.outreach_test_campaigns
  where id = target_campaign;
  if campaign_subject is null then
    raise exception 'Outreach test campaign was not found';
  end if;
  if jsonb_typeof(recipients) is distinct from 'array'
    or jsonb_array_length(recipients) > 20 then
    raise exception 'Outreach test recipient list is not valid';
  end if;
  for recipient in select value from jsonb_array_elements(recipients)
  loop
    if public.outreach_test_normalized_email(recipient->>'normalized_email') = '' then
      raise exception 'Outreach test recipient is not synthetic';
    end if;
  end loop;

  for fixture_row in
    select id, business_name, city, contact_email
    from public.outreach_test_recipients_fixture
    order by id
  loop
    normalized := public.outreach_test_normalized_email(fixture_row.contact_email);
    if normalized = '' then
      found_invalid := found_invalid + 1;
    elsif exists (
      select 1 from public.outreach_test_suppressions where normalized_email = normalized
    ) then
      found_suppressed := found_suppressed + 1;
    elsif normalized = any (seen) then
      found_duplicates := found_duplicates + 1;
    else
      seen := array_append(seen, normalized);
      queued_count := queued_count + 1;
    end if;
  end loop;
  if queued_count = 0
    or recipient_count is distinct from queued_count
    or suppressed_count is distinct from found_suppressed
    or invalid_count is distinct from found_invalid
    or duplicate_count is distinct from found_duplicates
    or allowed_count is distinct from queued_count then
    raise exception 'Outreach test recipient list is not valid';
  end if;

  insert into public.outreach_test_jobs (
    test_campaign_id, status, recipient_count, suppressed_count, invalid_count, duplicate_count, allowed_count, block_reason
  ) values (
    target_campaign, 'review', queued_count, found_suppressed, found_invalid, found_duplicates, queued_count, ''
  ) returning id into new_job;

  foreach normalized in array seen
  loop
    select id, business_name, city into chosen_id, chosen_name, chosen_city
    from public.outreach_test_recipients_fixture
    where public.outreach_test_normalized_email(contact_email) = normalized
    order by id
    limit 1;
    insert into public.outreach_test_queue_recipients (
      job_id, test_campaign_id, fixture_id, normalized_email, personalized_subject, personalized_body, status, idempotency_key
    ) values (
      new_job,
      target_campaign,
      chosen_id,
      normalized,
      left(replace(replace(campaign_subject, '{{business_name}}', chosen_name), '{{city}}', chosen_city), 160),
      left(replace(replace(campaign_body, '{{business_name}}', chosen_name), '{{city}}', chosen_city), 8000),
      'queued',
      'outreach-test:' || target_campaign::text || ':' || normalized
    );
  end loop;

  insert into public.outreach_test_events (job_id, event_type, detail)
  values (new_job, 'queued', 'test:queue saved');
  return new_job;
exception
  when unique_violation then
    if sqlerrm like '%outreach_test_jobs_one_campaign%' then
      raise exception 'Outreach test queue already exists' using errcode = '23505';
    end if;
    raise exception 'Outreach test recipient is not synthetic';
end;
$$;

create or replace function public.confirm_outreach_test_queue(
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
    raise exception 'Outreach test queue requires an administrator';
  end if;
  select name into campaign_name
  from public.outreach_test_campaigns
  where id = target_campaign;
  if campaign_name is null or btrim(campaign_name) = '' or confirmation is distinct from btrim(campaign_name) then
    raise exception 'Outreach confirmation does not match';
  end if;
  select status into job_status
  from public.outreach_test_jobs
  where id = target_job and test_campaign_id = target_campaign
  for update;
  if job_status is distinct from 'review' then
    raise exception 'Outreach test queue is not awaiting confirmation';
  end if;

  with held as (
    update public.outreach_test_queue_recipients
    set status = 'suppressed', last_error = 'test:suppressed', finished_at = now()
    where job_id = target_job
      and status = 'queued'
      and exists (
        select 1 from public.outreach_test_suppressions
        where normalized_email = outreach_test_queue_recipients.normalized_email
      )
    returning id
  )
  insert into public.outreach_test_events (job_id, recipient_id, event_type, detail)
  select target_job, held.id, 'suppressed', 'test:suppressed' from held;

  update public.outreach_test_queue_recipients
  set status = 'blocked', last_error = 'test:sending_disabled', finished_at = now()
  where job_id = target_job and status = 'queued';

  update public.outreach_test_jobs
  set status = 'blocked',
      confirmed_by = auth.uid(),
      confirmed_at = now(),
      block_reason = 'test:sending_disabled'
  where id = target_job and test_campaign_id = target_campaign and status = 'review';
  if not found then
    raise exception 'Outreach test queue is not awaiting confirmation';
  end if;

  insert into public.outreach_test_events (job_id, event_type, detail)
  values (target_job, 'blocked', 'test:blocked:sending_disabled');
  return 'blocked';
end;
$$;

create or replace function public.retry_outreach_test_queue(target_campaign uuid, target_job uuid)
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
    raise exception 'Outreach test queue requires an administrator';
  end if;
  select status into job_status
  from public.outreach_test_jobs
  where id = target_job and test_campaign_id = target_campaign
  for update;
  if job_status is distinct from 'blocked' then
    raise exception 'Outreach test queue cannot be retried';
  end if;

  with held as (
    update public.outreach_test_queue_recipients
    set status = 'suppressed', last_error = 'test:suppressed', finished_at = now()
    where job_id = target_job
      and status in ('queued', 'failed', 'blocked')
      and exists (
        select 1 from public.outreach_test_suppressions
        where normalized_email = outreach_test_queue_recipients.normalized_email
      )
    returning id
  )
  insert into public.outreach_test_events (job_id, recipient_id, event_type, detail)
  select target_job, held.id, 'suppressed', 'test:suppressed' from held;

  with held as (
    update public.outreach_test_queue_recipients
    set status = 'blocked',
        attempt_count = attempt_count + 1,
        attempted_at = now(),
        last_error = 'test:sending_disabled'
    where job_id = target_job
      and status in ('queued', 'failed', 'blocked')
      and attempt_count < 3
    returning id
  )
  insert into public.outreach_test_events (job_id, recipient_id, event_type, detail)
  select target_job, held.id, 'retry', 'test:blocked:sending_disabled' from held;
  get diagnostics updated_count = row_count;
  if updated_count = 0 then
    return 'exhausted';
  end if;
  return 'blocked';
end;
$$;

create or replace function public.suppress_outreach_test_recipient(raw_email text)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  normalized text;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Outreach test queue requires an administrator';
  end if;
  normalized := public.outreach_test_normalized_email(raw_email);
  if normalized = '' or not exists (
    select 1 from public.outreach_test_recipients_fixture where contact_email = normalized
  ) then
    raise exception 'Outreach test recipient is not synthetic';
  end if;
  insert into public.outreach_test_suppressions (normalized_email, reason)
  values (normalized, 'test')
  on conflict (normalized_email) do nothing;
  return 'suppressed';
end;
$$;

alter table public.outreach_test_campaigns enable row level security;
alter table public.outreach_test_campaigns force row level security;
alter table public.outreach_test_recipients_fixture enable row level security;
alter table public.outreach_test_recipients_fixture force row level security;
alter table public.outreach_test_suppressions enable row level security;
alter table public.outreach_test_suppressions force row level security;
alter table public.outreach_test_jobs enable row level security;
alter table public.outreach_test_jobs force row level security;
alter table public.outreach_test_queue_recipients enable row level security;
alter table public.outreach_test_queue_recipients force row level security;
alter table public.outreach_test_events enable row level security;
alter table public.outreach_test_events force row level security;

drop policy if exists outreach_test_campaigns_select on public.outreach_test_campaigns;
drop policy if exists outreach_test_fixture_select on public.outreach_test_recipients_fixture;
drop policy if exists outreach_test_suppressions_select on public.outreach_test_suppressions;
drop policy if exists outreach_test_suppressions_insert on public.outreach_test_suppressions;
drop policy if exists outreach_test_jobs_select on public.outreach_test_jobs;
drop policy if exists outreach_test_jobs_insert on public.outreach_test_jobs;
drop policy if exists outreach_test_jobs_update on public.outreach_test_jobs;
drop policy if exists outreach_test_recipients_select on public.outreach_test_queue_recipients;
drop policy if exists outreach_test_recipients_insert on public.outreach_test_queue_recipients;
drop policy if exists outreach_test_recipients_update on public.outreach_test_queue_recipients;
drop policy if exists outreach_test_events_select on public.outreach_test_events;
drop policy if exists outreach_test_events_insert on public.outreach_test_events;

create policy outreach_test_campaigns_select
  on public.outreach_test_campaigns for select to authenticated
  using (public.is_admin());
create policy outreach_test_fixture_select
  on public.outreach_test_recipients_fixture for select to authenticated
  using (public.is_admin());
create policy outreach_test_suppressions_select
  on public.outreach_test_suppressions for select to authenticated
  using (public.is_admin());
create policy outreach_test_suppressions_insert
  on public.outreach_test_suppressions for insert to authenticated
  with check (public.is_admin());
create policy outreach_test_jobs_select
  on public.outreach_test_jobs for select to authenticated
  using (public.is_admin());
create policy outreach_test_jobs_insert
  on public.outreach_test_jobs for insert to authenticated
  with check (public.is_admin());
create policy outreach_test_jobs_update
  on public.outreach_test_jobs for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());
create policy outreach_test_recipients_select
  on public.outreach_test_queue_recipients for select to authenticated
  using (public.is_admin());
create policy outreach_test_recipients_insert
  on public.outreach_test_queue_recipients for insert to authenticated
  with check (public.is_admin());
create policy outreach_test_recipients_update
  on public.outreach_test_queue_recipients for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());
create policy outreach_test_events_select
  on public.outreach_test_events for select to authenticated
  using (public.is_admin());
create policy outreach_test_events_insert
  on public.outreach_test_events for insert to authenticated
  with check (public.is_admin());

revoke all on table public.outreach_test_campaigns from public, anon, authenticated;
revoke all on table public.outreach_test_recipients_fixture from public, anon, authenticated;
revoke all on table public.outreach_test_suppressions from public, anon, authenticated;
revoke all on table public.outreach_test_jobs from public, anon, authenticated;
revoke all on table public.outreach_test_queue_recipients from public, anon, authenticated;
revoke all on table public.outreach_test_events from public, anon, authenticated;
grant select on table public.outreach_test_campaigns to authenticated;
grant select on table public.outreach_test_recipients_fixture to authenticated;
grant select, insert on table public.outreach_test_suppressions to authenticated;
grant select, insert, update on table public.outreach_test_jobs to authenticated;
grant select, insert, update on table public.outreach_test_queue_recipients to authenticated;
grant select, insert on table public.outreach_test_events to authenticated;

revoke all on function public.outreach_test_normalized_email(text) from public, anon, authenticated;
revoke all on function public.prepare_outreach_test_suppression() from public, anon, authenticated;
revoke all on function public.prepare_outreach_test_job() from public, anon, authenticated;
revoke all on function public.prepare_outreach_test_recipient() from public, anon, authenticated;
revoke all on function public.prepare_outreach_test_event() from public, anon, authenticated;
revoke all on function public.create_outreach_test_queue(uuid, integer, integer, integer, integer, integer, jsonb) from public, anon, authenticated;
revoke all on function public.confirm_outreach_test_queue(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.retry_outreach_test_queue(uuid, uuid) from public, anon, authenticated;
revoke all on function public.suppress_outreach_test_recipient(text) from public, anon, authenticated;
grant execute on function public.outreach_test_normalized_email(text) to authenticated;
grant execute on function public.prepare_outreach_test_suppression() to authenticated;
grant execute on function public.prepare_outreach_test_job() to authenticated;
grant execute on function public.prepare_outreach_test_recipient() to authenticated;
grant execute on function public.prepare_outreach_test_event() to authenticated;
grant execute on function public.create_outreach_test_queue(uuid, integer, integer, integer, integer, integer, jsonb) to authenticated;
grant execute on function public.confirm_outreach_test_queue(uuid, uuid, text) to authenticated;
grant execute on function public.retry_outreach_test_queue(uuid, uuid) to authenticated;
grant execute on function public.suppress_outreach_test_recipient(text) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.outreach_test_campaigns from service_role;
    revoke all on table public.outreach_test_recipients_fixture from service_role;
    revoke all on table public.outreach_test_suppressions from service_role;
    revoke all on table public.outreach_test_jobs from service_role;
    revoke all on table public.outreach_test_queue_recipients from service_role;
    revoke all on table public.outreach_test_events from service_role;
    grant select on table public.outreach_test_campaigns to service_role;
    grant select on table public.outreach_test_recipients_fixture to service_role;
    grant select on table public.outreach_test_suppressions to service_role;
    grant select on table public.outreach_test_jobs to service_role;
    grant select on table public.outreach_test_queue_recipients to service_role;
    grant select on table public.outreach_test_events to service_role;
    revoke all on function public.create_outreach_test_queue(uuid, integer, integer, integer, integer, integer, jsonb) from service_role;
    revoke all on function public.confirm_outreach_test_queue(uuid, uuid, text) from service_role;
    revoke all on function public.retry_outreach_test_queue(uuid, uuid) from service_role;
    revoke all on function public.suppress_outreach_test_recipient(text) from service_role;
  end if;
end
$$;
