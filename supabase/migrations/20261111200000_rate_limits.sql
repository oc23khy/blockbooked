-- Shared request limits for the application servers.
-- One row lock per bucket makes the counter atomic across Vercel instances.
-- A booking receipt is single-use and belongs to one user and one operation.
-- Safe to run again. Does not change payments, refunds, or the PIN lockout rules.

create table if not exists public.rate_limit_counters (
  bucket text primary key,
  window_start timestamptz not null,
  hits integer not null,
  updated_at timestamptz not null default now(),
  constraint rate_limit_hits_nonnegative check (hits >= 0)
);

create index if not exists rate_limit_counters_updated_idx
  on public.rate_limit_counters (updated_at);

alter table public.rate_limit_counters enable row level security;

revoke all on public.rate_limit_counters from public, anon, authenticated;

create table if not exists public.rate_limit_receipts (
  receipt uuid primary key,
  bucket text not null,
  actor uuid not null,
  operation text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint rate_limit_receipt_operation_known check (operation in ('createBooking', 'bookingStatus'))
);

alter table public.rate_limit_receipts enable row level security;

revoke all on public.rate_limit_receipts from public, anon, authenticated;

alter table public.booking_requests
  add column if not exists rate_limit_receipt uuid;

comment on column public.booking_requests.rate_limit_receipt is
  'Single-use request token. The booking limit trigger clears it before the row is stored.';

create or replace function public.consume_rate_limit(
  target_bucket text,
  max_hits integer,
  window_seconds integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  observed integer;
begin
  if target_bucket is null
     or length(target_bucket) < 3
     or length(target_bucket) > 200
     or target_bucket !~ '^[a-zA-Z0-9:._-]+$' then
    raise exception 'Invalid rate limit bucket';
  end if;
  if max_hits is null or max_hits < 1 or max_hits > 1000
     or window_seconds is null or window_seconds < 1 or window_seconds > 86400 then
    raise exception 'Invalid rate limit window';
  end if;

  insert into public.rate_limit_counters (bucket, window_start, hits)
  values (target_bucket, clock_timestamp(), 1)
  on conflict (bucket) do update
  set
    hits = case
      when public.rate_limit_counters.window_start + make_interval(secs => window_seconds) <= clock_timestamp()
        then 1
      else public.rate_limit_counters.hits + 1
    end,
    window_start = case
      when public.rate_limit_counters.window_start + make_interval(secs => window_seconds) <= clock_timestamp()
        then clock_timestamp()
      else public.rate_limit_counters.window_start
    end,
    updated_at = clock_timestamp()
  returning hits into observed;

  return observed;
end;
$$;

-- Execute permission is the access control. auth.role() still shows the
-- caller's JWT inside a security definer function, so a role check here would
-- also block the booking trigger and the PIN wrapper.
revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;

create or replace function public.issue_booking_rate_receipt(actor uuid, operation text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  observed integer;
  limit_hits integer;
  window_seconds integer;
  issued uuid;
  bucket text;
begin
  if coalesce(auth.role(), '') is distinct from 'service_role' then
    raise exception 'Not allowed to issue a rate limit receipt';
  end if;
  if actor is null then
    raise exception 'Invalid rate limit actor';
  end if;
  if operation = 'createBooking' then
    limit_hits := 10;
    window_seconds := 3600;
  elsif operation = 'bookingStatus' then
    limit_hits := 30;
    window_seconds := 600;
  else
    raise exception 'Invalid rate limit operation';
  end if;

  bucket := operation || ':user:' || actor::text;
  observed := public.consume_rate_limit(bucket, limit_hits, window_seconds);
  if observed > limit_hits then
    return null;
  end if;

  issued := gen_random_uuid();
  insert into public.rate_limit_receipts (receipt, bucket, actor, operation)
  values (issued, bucket, actor, operation);
  return issued;
end;
$$;

revoke all on function public.issue_booking_rate_receipt(uuid, text) from public, anon, authenticated;

create or replace function public.purge_stale_rate_limits()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') is distinct from 'service_role' then
    raise exception 'Not allowed to purge rate limits';
  end if;

  delete from public.rate_limit_counters
  where updated_at < clock_timestamp() - interval '2 days';

  delete from public.rate_limit_receipts
  where created_at < clock_timestamp() - interval '10 minutes';
end;
$$;

revoke all on function public.purge_stale_rate_limits() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;
    grant execute on function public.issue_booking_rate_receipt(uuid, text) to service_role;
    grant execute on function public.purge_stale_rate_limits() to service_role;
  end if;
end
$$;

-- Direct booking writes use the same counter as the server actions.
-- Service-role workers, including expiration, refunds, and Stripe webhooks, are not counted.
-- A verified PIN completion changes status without using the status-change allowance.
create or replace function public.limit_booking_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  observed integer;
  booking_actor uuid;
  claimed uuid;
  booking_operation text;
begin
  if coalesce(auth.role(), '') is distinct from 'authenticated' or auth.uid() is null then
    new.rate_limit_receipt := null;
    return new;
  end if;
  booking_actor := auth.uid();

  if current_setting('blockbooked.pin_verified', true) = '1' then
    new.rate_limit_receipt := null;
    return new;
  end if;

  booking_operation := case when tg_op = 'INSERT' then 'createBooking' else 'bookingStatus' end;

  if new.rate_limit_receipt is not null then
    delete from public.rate_limit_receipts as receipt_row
    where receipt_row.receipt = new.rate_limit_receipt
      and receipt_row.actor = booking_actor
      and receipt_row.operation = booking_operation
      and receipt_row.created_at >= clock_timestamp() - interval '10 minutes'
    returning receipt_row.receipt into claimed;
  end if;
  new.rate_limit_receipt := null;

  if claimed is not null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    observed := public.consume_rate_limit('createBooking:user:' || booking_actor::text, 10, 3600);
    if observed > 10 then
      raise exception 'Too many attempts. Wait a few minutes and try again.';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' and old.status is distinct from new.status then
    observed := public.consume_rate_limit('bookingStatus:user:' || booking_actor::text, 30, 600);
    if observed > 30 then
      raise exception 'Too many attempts. Wait a few minutes and try again.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.limit_booking_write() from public, anon, authenticated;

drop trigger if exists bookings_limit_insert on public.booking_requests;
create trigger bookings_limit_insert
  before insert on public.booking_requests
  for each row
  execute function public.limit_booking_write();

drop trigger if exists bookings_limit_status on public.booking_requests;
create trigger bookings_limit_status
  before update of status on public.booking_requests
  for each row
  when (old.status is distinct from new.status)
  execute function public.limit_booking_write();

-- Keep the original PIN function under a private name and preserve its grants
-- only long enough to revoke them. Callers continue to use complete_booking_with_pin.
-- No trigger or policy calls that function; the only application caller is the RPC.
do $$
begin
  if to_regprocedure('public.complete_booking_with_pin_locked(uuid, text)') is null
     and to_regprocedure('public.complete_booking_with_pin(uuid, text)') is not null then
    alter function public.complete_booking_with_pin(uuid, text)
      rename to complete_booking_with_pin_locked;
  end if;
  if to_regprocedure('public.complete_booking_with_pin_locked(uuid, text)') is null then
    raise exception 'complete_booking_with_pin_locked is missing';
  end if;
end
$$;

create or replace function public.complete_booking_with_pin(target_booking uuid, submitted_pin text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  observed integer;
begin
  if auth.uid() is null then
    return 'forbidden';
  end if;

  -- An ordinary invalid PIN returns text, so Supabase commits this request and
  -- the counter remains. If the whole transaction rolls back, this increment
  -- rolls back with it. Unexpected database errors are not caught here.
  observed := public.consume_rate_limit('completionPin:user:' || auth.uid()::text, 12, 900);
  if observed > 12 then
    return 'rate_limited';
  end if;

  return public.complete_booking_with_pin_locked(target_booking, submitted_pin);
end;
$$;

revoke all on function public.complete_booking_with_pin(uuid, text) from public, anon;
grant execute on function public.complete_booking_with_pin(uuid, text) to authenticated;
revoke all on function public.complete_booking_with_pin_locked(uuid, text) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.complete_booking_with_pin(uuid, text) from service_role;
    revoke all on function public.complete_booking_with_pin_locked(uuid, text) from service_role;
    revoke all on function public.limit_booking_write() from service_role;
  end if;
end
$$;
