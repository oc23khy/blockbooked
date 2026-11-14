-- Public outreach unsubscribe tokens. The raw token is never stored.
-- Applying this file does not insert tokens, send mail, or update existing rows.
-- A later call to redeem_outreach_unsubscribe is what suppresses one address.
-- Safe to run again. Do not run this from the application.

create table if not exists public.outreach_unsubscribe_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null,
  normalized_email text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint outreach_unsubscribe_tokens_hash_unique unique (token_hash),
  constraint outreach_unsubscribe_tokens_hash_shape check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint outreach_unsubscribe_tokens_email_shape check (
    char_length(normalized_email) between 3 and 320
    and normalized_email = lower(normalized_email)
    and normalized_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  constraint outreach_unsubscribe_tokens_expiry check (expires_at > created_at)
);

create index if not exists outreach_unsubscribe_tokens_email_idx
  on public.outreach_unsubscribe_tokens (normalized_email);

create or replace function public.prepare_outreach_unsubscribe_token()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    new.token_hash := old.token_hash;
    new.normalized_email := old.normalized_email;
    new.expires_at := old.expires_at;
    new.created_at := old.created_at;
    if old.used_at is not null then
      new.used_at := old.used_at;
    end if;
    return new;
  end if;
  new.token_hash := lower(btrim(coalesce(new.token_hash, '')));
  new.normalized_email := public.outreach_normalized_email(new.normalized_email);
  if new.token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Unsubscribe token hash is not valid';
  end if;
  if new.normalized_email = '' then
    raise exception 'Unsubscribe token requires a valid email';
  end if;
  if new.expires_at is null or new.expires_at <= now() then
    raise exception 'Unsubscribe token expiry is not valid';
  end if;
  return new;
end;
$$;

drop trigger if exists outreach_unsubscribe_tokens_prepare on public.outreach_unsubscribe_tokens;
create trigger outreach_unsubscribe_tokens_prepare
  before insert or update on public.outreach_unsubscribe_tokens
  for each row execute function public.prepare_outreach_unsubscribe_token();

create or replace function public.issue_outreach_unsubscribe_token(
  raw_email text,
  raw_hash text,
  token_expires_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  email text;
begin
  email := public.outreach_normalized_email(raw_email);
  if email = '' or raw_hash is null or lower(btrim(raw_hash)) !~ '^[0-9a-f]{64}$' then
    return 'invalid';
  end if;
  if token_expires_at is null
    or token_expires_at <= now()
    or token_expires_at > now() + interval '366 days' then
    return 'invalid';
  end if;
  insert into public.outreach_unsubscribe_tokens (token_hash, normalized_email, expires_at)
  values (lower(btrim(raw_hash)), email, token_expires_at);
  return 'issued';
exception
  when unique_violation then
    return 'invalid';
end;
$$;

create or replace function public.redeem_outreach_unsubscribe(raw_hash text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  target text;
  expiry timestamptz;
  used timestamptz;
  marked text;
begin
  if raw_hash is null or lower(btrim(raw_hash)) !~ '^[0-9a-f]{64}$' then
    return 'invalid';
  end if;
  select token.normalized_email, token.expires_at, token.used_at
    into target, expiry, used
  from public.outreach_unsubscribe_tokens as token
  where token.token_hash = lower(btrim(raw_hash))
  for update;
  if target is null then
    return 'invalid';
  end if;
  if expiry <= now() then
    return 'expired';
  end if;
  insert into public.outreach_suppressions (normalized_email, reason)
  values (target, 'unsubscribe')
  on conflict (normalized_email) do nothing;
  update public.outreach_prospects
  set lead_status = 'suppressed'
  where normalized_email = target
    and lead_status is distinct from 'suppressed';
  if used is null then
    update public.outreach_unsubscribe_tokens
    set used_at = now()
    where token_hash = lower(btrim(raw_hash))
      and used_at is null
    returning token_hash into marked;
    if marked is null then
      return 'repeated';
    end if;
    return 'unsubscribed';
  end if;
  return 'repeated';
end;
$$;

alter table public.outreach_unsubscribe_tokens enable row level security;
alter table public.outreach_unsubscribe_tokens force row level security;

revoke all on table public.outreach_unsubscribe_tokens from public, anon, authenticated;
revoke all on function public.prepare_outreach_unsubscribe_token() from public, anon, authenticated;
revoke all on function public.issue_outreach_unsubscribe_token(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.redeem_outreach_unsubscribe(text) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.outreach_unsubscribe_tokens from service_role;
    revoke all on function public.prepare_outreach_unsubscribe_token() from service_role;
    revoke all on function public.issue_outreach_unsubscribe_token(text, text, timestamptz) from service_role;
    revoke all on function public.redeem_outreach_unsubscribe(text) from service_role;
    grant execute on function public.issue_outreach_unsubscribe_token(text, text, timestamptz) to service_role;
    grant execute on function public.redeem_outreach_unsubscribe(text) to service_role;
  end if;
end
$$;
