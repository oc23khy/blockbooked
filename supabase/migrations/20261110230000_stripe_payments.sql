-- Stripe Connect payment records. Additive only.
-- Run after the completion PIN migrations. Does not change existing booking rows.

create table if not exists public.platform_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id)
);

insert into public.platform_settings (key, value)
values ('commission_bps', '800'::jsonb)
on conflict (key) do nothing;

insert into public.platform_settings (key, value)
values ('processing_fee_bearer', '"platform"'::jsonb)
on conflict (key) do nothing;

create table if not exists public.provider_stripe_accounts (
  provider_id uuid primary key references public.providers (id) on delete cascade,
  stripe_account_id text unique,
  details_submitted boolean not null default false,
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  transfers_enabled boolean not null default false,
  disabled_reason text,
  updated_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.booking_requests (id) on delete restrict,
  customer_id uuid not null references public.profiles (id),
  provider_id uuid not null references public.providers (id),
  currency text not null default 'usd',
  amount_cents integer not null,
  commission_bps integer not null,
  commission_cents integer not null,
  provider_share_cents integer not null,
  stripe_fee_cents integer,
  fee_bearer text not null default 'platform',
  status text not null default 'requires_payment',
  checkout_session_id text unique,
  payment_intent_id text unique,
  charge_id text unique,
  transfer_id text unique,
  transfer_status text not null default 'not_ready',
  refunded_cents integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_amount_positive check (amount_cents > 0),
  constraint payments_split_exact check (commission_cents + provider_share_cents = amount_cents),
  constraint payments_refund_bounds check (refunded_cents >= 0 and refunded_cents <= amount_cents),
  constraint payments_status_known check (
    status in (
      'requires_payment',
      'processing',
      'succeeded',
      'failed',
      'refunded',
      'partially_refunded',
      'disputed',
      'canceled'
    )
  ),
  constraint payments_transfer_status_known check (
    transfer_status in ('not_ready', 'pending', 'paid', 'failed', 'reversed', 'partially_reversed')
  ),
  constraint payments_fee_bearer_known check (fee_bearer = 'platform')
);

create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id) on delete restrict,
  booking_id uuid not null references public.booking_requests (id) on delete restrict,
  amount_cents integer not null,
  commission_reversal_cents integer not null,
  provider_reversal_cents integer not null,
  status text not null,
  reason text,
  stripe_refund_id text unique,
  stripe_reversal_id text,
  reversal_status text,
  failure_reason text,
  requested_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  constraint refunds_amount_positive check (amount_cents > 0),
  constraint refunds_split_exact check (commission_reversal_cents + provider_reversal_cents = amount_cents),
  constraint refunds_status_known check (status in ('pending', 'succeeded', 'failed', 'canceled'))
);

create table if not exists public.stripe_events (
  event_id text primary key,
  event_type text not null,
  livemode boolean not null,
  status text not null,
  error text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint stripe_events_status_known check (status in ('processing', 'processed', 'ignored', 'failed'))
);

create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid references public.payments (id) on delete restrict,
  booking_id uuid references public.booking_requests (id) on delete restrict,
  entry_type text not null,
  amount_cents integer not null,
  currency text not null default 'usd',
  stripe_object_id text,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists payments_provider_idx on public.payments (provider_id);
create index if not exists payments_customer_idx on public.payments (customer_id);
create index if not exists refunds_payment_idx on public.refunds (payment_id);
create index if not exists ledger_payment_idx on public.ledger_entries (payment_id);

alter table public.platform_settings enable row level security;
alter table public.provider_stripe_accounts enable row level security;
alter table public.payments enable row level security;
alter table public.refunds enable row level security;
alter table public.stripe_events enable row level security;
alter table public.ledger_entries enable row level security;

drop policy if exists platform_settings_admin_select on public.platform_settings;
create policy platform_settings_admin_select
  on public.platform_settings for select to authenticated
  using (public.is_admin());

drop policy if exists provider_stripe_select on public.provider_stripe_accounts;
create policy provider_stripe_select
  on public.provider_stripe_accounts for select to authenticated
  using (public.owns_provider(provider_id) or public.is_admin());

drop policy if exists payments_select on public.payments;
create policy payments_select
  on public.payments for select to authenticated
  using (customer_id = auth.uid() or public.owns_provider(provider_id) or public.is_admin());

drop policy if exists refunds_select on public.refunds;
create policy refunds_select
  on public.refunds for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.payments
      where payments.id = refunds.payment_id
        and (payments.customer_id = auth.uid() or public.owns_provider(payments.provider_id))
    )
  );

drop policy if exists stripe_events_admin_select on public.stripe_events;
create policy stripe_events_admin_select
  on public.stripe_events for select to authenticated
  using (public.is_admin());

drop policy if exists ledger_select on public.ledger_entries;
create policy ledger_select
  on public.ledger_entries for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.payments
      where payments.id = ledger_entries.payment_id
        and (payments.customer_id = auth.uid() or public.owns_provider(payments.provider_id))
    )
  );

revoke all on public.platform_settings from public, anon, authenticated;
revoke all on public.provider_stripe_accounts from public, anon, authenticated;
revoke all on public.payments from public, anon, authenticated;
revoke all on public.refunds from public, anon, authenticated;
revoke all on public.stripe_events from public, anon, authenticated;
revoke all on public.ledger_entries from public, anon, authenticated;

grant select on public.platform_settings to authenticated;
grant select on public.provider_stripe_accounts to authenticated;
grant select on public.payments to authenticated;
grant select on public.refunds to authenticated;
grant select on public.stripe_events to authenticated;
grant select on public.ledger_entries to authenticated;
