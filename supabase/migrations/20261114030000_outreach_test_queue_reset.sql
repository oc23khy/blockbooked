-- Resets one seeded outreach simulation. Applying this file does not send mail.
-- It does not read or write production send settings, live prospects, live suppressions, or live queues.
-- Delete stays inside these functions. Authenticated users receive no delete or truncate grant.

create or replace function public.outreach_test_lock_seed(target uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Outreach test queue requires an administrator';
  end if;
  if target is distinct from '00000000-0000-4000-8000-0000000000a1'::uuid then
    raise exception 'Outreach test campaign was not found';
  end if;
  perform id
  from public.outreach_test_campaigns
  where id = target
  for update;
  if not found then
    raise exception 'Outreach test campaign was not found';
  end if;
end;
$$;

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
  perform public.outreach_test_lock_seed(target_campaign);
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
  perform public.outreach_test_lock_seed(target_campaign);
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
  perform public.outreach_test_lock_seed(target_campaign);
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
  perform public.outreach_test_lock_seed('00000000-0000-4000-8000-0000000000a1'::uuid);
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

do $$
begin
  if to_regprocedure('public.reset_outreach_test_queue()') is not null then
    revoke all on function public.reset_outreach_test_queue() from public, anon, authenticated;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      revoke all on function public.reset_outreach_test_queue() from service_role;
    end if;
    drop function public.reset_outreach_test_queue();
  end if;
end
$$;

create or replace function public.reset_outreach_test_queue(confirmation text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  seeded uuid := '00000000-0000-4000-8000-0000000000a1';
begin
  if confirmation is distinct from 'Reset test queue' then
    raise exception 'Outreach confirmation does not match';
  end if;
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Outreach test queue requires an administrator';
  end if;
  perform public.outreach_test_lock_seed(seeded);
  perform id
  from public.outreach_test_jobs
  where test_campaign_id = seeded
  for update;

  delete from public.outreach_test_events
  where job_id in (
    select id from public.outreach_test_jobs where test_campaign_id = seeded
  );
  delete from public.outreach_test_queue_recipients
  where test_campaign_id = seeded;
  delete from public.outreach_test_jobs
  where test_campaign_id = seeded;
  delete from public.outreach_test_suppressions
  where reason = 'test';
  return 'reset';
end;
$$;

revoke all on function public.outreach_test_lock_seed(uuid) from public, anon, authenticated;
revoke all on function public.reset_outreach_test_queue(text) from public, anon, authenticated;
grant execute on function public.outreach_test_lock_seed(uuid) to authenticated;
grant execute on function public.reset_outreach_test_queue(text) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.outreach_test_lock_seed(uuid) from service_role;
    revoke all on function public.reset_outreach_test_queue(text) from service_role;
  end if;
end
$$;
