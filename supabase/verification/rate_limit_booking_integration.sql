-- Disposable booking-limiter test. Do not run this against the deployed Supabase database.
-- It aborts unless the database name is blockbooked_rate_limit_test and the
-- limiter tables contain no unrelated rows.
--
-- Setup, from an empty local Postgres instance:
--   createdb blockbooked_rate_limit_test
--   psql "postgresql://postgres@127.0.0.1:5432/blockbooked_rate_limit_test" -v ON_ERROR_STOP=1 -f supabase/verification/rate_limit_booking_integration.sql
-- The file applies supabase/migrations/20261111200000_rate_limits.sql itself when
-- executed by tests/rate-limit-integration.test.ts. For psql, run that migration
-- after the PRELUDE section and before the TESTS section.
--
-- A rejected insert rolls its own counter change back. The stored total stays at
-- the last committed attempt. This script does not assume a rolled-back hit remains.

-- SPLIT:prelude

do $$
begin
  if current_database() is distinct from 'blockbooked_rate_limit_test' then
    raise exception 'Refusing to run outside database blockbooked_rate_limit_test';
  end if;
end
$$;

create schema if not exists auth;
create schema if not exists extensions;
create schema if not exists rate_lab;

create extension if not exists pgcrypto with schema extensions;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      case
        when coalesce(current_setting('request.jwt.claims', true), '') = '' then null
        else current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
      end
    ),
    ''
  )::uuid
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    case
      when coalesce(current_setting('request.jwt.claims', true), '') = '' then null
      else current_setting('request.jwt.claims', true)::jsonb ->> 'role'
    end
  )
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end
$$;

create table if not exists public.booking_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null,
  provider_id uuid not null,
  preferred_date date not null,
  time_window text not null,
  notes text not null default '',
  contact_phone text not null default '',
  service_name text not null default '',
  status text not null default 'pending'
);

do $$
begin
  if to_regprocedure('public.complete_booking_with_pin(uuid, text)') is null
     and to_regprocedure('public.complete_booking_with_pin_locked(uuid, text)') is null then
    execute $stub$
      create function public.complete_booking_with_pin(target_booking uuid, submitted_pin text)
      returns text
      language sql
      as $body$ select 'not_accepted'::text $body$
    $stub$;
  end if;
end
$$;

-- SPLIT:tests

do $$
begin
  if current_database() is distinct from 'blockbooked_rate_limit_test' then
    raise exception 'Refusing to run outside database blockbooked_rate_limit_test';
  end if;
  if to_regprocedure('public.consume_rate_limit(text, integer, integer)') is null then
    raise exception 'Apply supabase/migrations/20261111200000_rate_limits.sql before these tests';
  end if;
  if to_regclass('public.rate_limit_counters') is not null
     and exists (
       select 1
       from public.rate_limit_counters
       where bucket !~ '^createBooking:user:a000000[1-8]-0000-4000-8000-00000000000[1-8]$'
         and bucket !~ '^bookingStatus:user:a000000[1-8]-0000-4000-8000-00000000000[1-8]$'
     ) then
    raise exception 'Refusing to run because rate_limit_counters has unrelated rows';
  end if;
  if exists (
    select 1
    from public.booking_requests
    where customer_id not in (
      'a0000001-0000-4000-8000-000000000001'::uuid,
      'a0000002-0000-4000-8000-000000000002'::uuid,
      'a0000003-0000-4000-8000-000000000003'::uuid,
      'a0000004-0000-4000-8000-000000000004'::uuid,
      'a0000005-0000-4000-8000-000000000005'::uuid,
      'a0000006-0000-4000-8000-000000000006'::uuid,
      'a0000007-0000-4000-8000-000000000007'::uuid,
      'a0000008-0000-4000-8000-000000000008'::uuid
    )
  ) then
    raise exception 'Refusing to run because booking_requests has unrelated rows';
  end if;
end
$$;

create or replace function rate_lab.try_booking(actor uuid, actor_role text, test_receipt_id uuid default null)
returns text
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', actor::text, true);
  perform set_config('request.jwt.claim.role', actor_role, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', actor::text, 'role', actor_role)::text,
    true
  );
  perform set_config('blockbooked.pin_verified', '', true);
  insert into public.booking_requests (
    customer_id, provider_id, preferred_date, time_window, status, rate_limit_receipt
  ) values (
    actor,
    'a0000009-0000-4000-8000-000000000009',
    current_date,
    'Morning',
    'pending',
    test_receipt_id
  );
  return 'ok';
exception
  when others then
    return sqlerrm;
end;
$$;

create or replace function rate_lab.hits_for(actor uuid, operation text)
returns integer
language sql
stable
as $$
  select coalesce((
    select hits
    from public.rate_limit_counters
    where bucket = operation || ':user:' || actor::text
  ), 0)
$$;

-- SCENARIO 1: first 10 booking attempts are permitted
-- SCENARIO 2: the 11th booking attempt is rejected
-- SCENARIO 3: a second user has an independent limit
-- SCENARIO 4: the one-hour window resets
-- SCENARIO 5: a valid receipt is consumed only once
-- SCENARIO 6: another user's receipt cannot be used
-- SCENARIO 7: serial attempts stop at the limit; parallel attempts are in the node test
-- SCENARIO 8: direct inserts without a receipt enforce the limit
-- SCENARIO 9: service-role inserts bypass the booking limit
-- SCENARIO 10: a PIN-verified completion does not use the status limit

do $tests$
declare
  result text;
  allowed integer := 0;
  test_receipt_id uuid;
  index integer;
begin
  -- SCENARIO 1 and 8. Direct inserts have no receipt.
  for index in 1..10 loop
    result := rate_lab.try_booking('a0000001-0000-4000-8000-000000000001', 'authenticated', null);
    if result is distinct from 'ok' then
      raise exception 'Scenario 1 failed on attempt %: %', index, result;
    end if;
  end loop;
  if rate_lab.hits_for('a0000001-0000-4000-8000-000000000001', 'createBooking') <> 10 then
    raise exception 'Scenario 1 counter was %, expected 10', rate_lab.hits_for('a0000001-0000-4000-8000-000000000001', 'createBooking');
  end if;

  -- SCENARIO 2. The rejected statement rolls its increment back, leaving 10.
  result := rate_lab.try_booking('a0000001-0000-4000-8000-000000000001', 'authenticated', null);
  if result not like '%Too many attempts%' then
    raise exception 'Scenario 2 expected rejection, got %', result;
  end if;
  if rate_lab.hits_for('a0000001-0000-4000-8000-000000000001', 'createBooking') <> 10 then
    raise exception 'Scenario 2 counter changed to % after the rejected attempt', rate_lab.hits_for('a0000001-0000-4000-8000-000000000001', 'createBooking');
  end if;

  -- SCENARIO 3.
  result := rate_lab.try_booking('a0000002-0000-4000-8000-000000000002', 'authenticated', null);
  if result is distinct from 'ok' or rate_lab.hits_for('a0000002-0000-4000-8000-000000000002', 'createBooking') <> 1 then
    raise exception 'Scenario 3 second user was not independent: %', result;
  end if;
  if rate_lab.hits_for('a0000001-0000-4000-8000-000000000001', 'createBooking') <> 10 then
    raise exception 'Scenario 3 changed the first user counter';
  end if;

  -- SCENARIO 4.
  update public.rate_limit_counters
  set window_start = clock_timestamp() - interval '2 hours'
  where bucket = 'createBooking:user:a0000001-0000-4000-8000-000000000001';
  result := rate_lab.try_booking('a0000001-0000-4000-8000-000000000001', 'authenticated', null);
  if result is distinct from 'ok' or rate_lab.hits_for('a0000001-0000-4000-8000-000000000001', 'createBooking') <> 1 then
    raise exception 'Scenario 4 window did not reset: % hits %', result, rate_lab.hits_for('a0000001-0000-4000-8000-000000000001', 'createBooking');
  end if;

  -- SCENARIO 5.
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  test_receipt_id := public.issue_booking_rate_receipt('a0000003-0000-4000-8000-000000000003', 'createBooking');
  if test_receipt_id is null or rate_lab.hits_for('a0000003-0000-4000-8000-000000000003', 'createBooking') <> 1 then
    raise exception 'Scenario 5 did not issue a receipt';
  end if;
  result := rate_lab.try_booking('a0000003-0000-4000-8000-000000000003', 'authenticated', test_receipt_id);
  if result is distinct from 'ok'
     or rate_lab.hits_for('a0000003-0000-4000-8000-000000000003', 'createBooking') <> 1
     or exists (select 1 from public.rate_limit_receipts as saved where saved.receipt = test_receipt_id) then
    raise exception 'Scenario 5 did not consume the receipt once';
  end if;
  result := rate_lab.try_booking('a0000003-0000-4000-8000-000000000003', 'authenticated', test_receipt_id);
  if result is distinct from 'ok' or rate_lab.hits_for('a0000003-0000-4000-8000-000000000003', 'createBooking') <> 2 then
    raise exception 'Scenario 5 reused a consumed receipt: %', result;
  end if;

  -- SCENARIO 6.
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  test_receipt_id := public.issue_booking_rate_receipt('a0000004-0000-4000-8000-000000000004', 'createBooking');
  result := rate_lab.try_booking('a0000008-0000-4000-8000-000000000008', 'authenticated', test_receipt_id);
  if result is distinct from 'ok'
     or rate_lab.hits_for('a0000008-0000-4000-8000-000000000008', 'createBooking') <> 1
     or rate_lab.hits_for('a0000004-0000-4000-8000-000000000004', 'createBooking') <> 1
     or not exists (select 1 from public.rate_limit_receipts as saved where saved.receipt = test_receipt_id) then
    raise exception 'Scenario 6 allowed another user to consume the receipt';
  end if;

  -- SCENARIO 7 serial cap. The node test repeats this with parallel connections.
  for index in 1..12 loop
    result := rate_lab.try_booking('a0000005-0000-4000-8000-000000000005', 'authenticated', null);
    if result = 'ok' then
      allowed := allowed + 1;
    end if;
  end loop;
  if allowed <> 10 or rate_lab.hits_for('a0000005-0000-4000-8000-000000000005', 'createBooking') <> 10 then
    raise exception 'Scenario 7 allowed % inserts and stored % hits', allowed, rate_lab.hits_for('a0000005-0000-4000-8000-000000000005', 'createBooking');
  end if;

  -- SCENARIO 9.
  allowed := 0;
  for index in 1..12 loop
    result := rate_lab.try_booking('a0000006-0000-4000-8000-000000000006', 'service_role', null);
    if result = 'ok' then
      allowed := allowed + 1;
    end if;
  end loop;
  if allowed <> 12 or rate_lab.hits_for('a0000006-0000-4000-8000-000000000006', 'createBooking') <> 0 then
    raise exception 'Scenario 9 service role was limited: allowed %, hits %', allowed, rate_lab.hits_for('a0000006-0000-4000-8000-000000000006', 'createBooking');
  end if;

  -- SCENARIO 10.
  result := rate_lab.try_booking('a0000007-0000-4000-8000-000000000007', 'authenticated', null);
  if result is distinct from 'ok' then
    raise exception 'Scenario 10 setup failed: %', result;
  end if;
  perform set_config('request.jwt.claim.sub', 'a0000007-0000-4000-8000-000000000007', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"sub":"a0000007-0000-4000-8000-000000000007","role":"authenticated"}', true);
  perform set_config('blockbooked.pin_verified', '1', true);
  update public.booking_requests
  set status = 'completed'
  where customer_id = 'a0000007-0000-4000-8000-000000000007';
  if rate_lab.hits_for('a0000007-0000-4000-8000-000000000007', 'bookingStatus') <> 0
     or rate_lab.hits_for('a0000007-0000-4000-8000-000000000007', 'createBooking') <> 1
     or not exists (
       select 1 from public.booking_requests
       where customer_id = 'a0000007-0000-4000-8000-000000000007' and status = 'completed'
     ) then
    raise exception 'Scenario 10 PIN completion changed the booking limit';
  end if;
end
$tests$;

-- SPLIT:cleanup

delete from public.booking_requests
where customer_id in (
  'a0000001-0000-4000-8000-000000000001'::uuid,
  'a0000002-0000-4000-8000-000000000002'::uuid,
  'a0000003-0000-4000-8000-000000000003'::uuid,
  'a0000004-0000-4000-8000-000000000004'::uuid,
  'a0000005-0000-4000-8000-000000000005'::uuid,
  'a0000006-0000-4000-8000-000000000006'::uuid,
  'a0000007-0000-4000-8000-000000000007'::uuid,
  'a0000008-0000-4000-8000-000000000008'::uuid
);

delete from public.rate_limit_receipts
where actor in (
  'a0000001-0000-4000-8000-000000000001'::uuid,
  'a0000002-0000-4000-8000-000000000002'::uuid,
  'a0000003-0000-4000-8000-000000000003'::uuid,
  'a0000004-0000-4000-8000-000000000004'::uuid,
  'a0000005-0000-4000-8000-000000000005'::uuid,
  'a0000006-0000-4000-8000-000000000006'::uuid,
  'a0000007-0000-4000-8000-000000000007'::uuid,
  'a0000008-0000-4000-8000-000000000008'::uuid
);

delete from public.rate_limit_counters
where bucket ~ 'a000000[1-8]-0000-4000-8000-00000000000[1-8]';
