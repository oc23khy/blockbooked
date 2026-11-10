-- Custom quotes and milestone payments. Additive. Does not delete bookings or payments.

create table if not exists public.booking_payment_plans (
  booking_id uuid primary key references public.booking_requests (id) on delete cascade,
  plan text not null,
  agreed_amount_cents integer,
  created_at timestamptz not null default now(),
  constraint booking_payment_plan_known check (plan in ('single', 'quote', 'milestones')),
  constraint booking_payment_plan_amount check (agreed_amount_cents is null or agreed_amount_cents > 0)
);

create table if not exists public.booking_quotes (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.booking_requests (id) on delete cascade,
  amount_cents integer not null,
  note text,
  status text not null,
  created_at timestamptz not null default now(),
  constraint booking_quotes_amount_positive check (amount_cents > 0),
  constraint booking_quotes_status_known check (status in ('offered', 'accepted', 'declined', 'superseded'))
);

create table if not exists public.booking_milestones (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.booking_requests (id) on delete cascade,
  label text not null,
  amount_cents integer not null,
  position integer not null,
  created_at timestamptz not null default now(),
  constraint booking_milestones_amount_positive check (amount_cents > 0),
  constraint booking_milestones_position unique (booking_id, position)
);

alter table public.payments
  add column if not exists milestone_id uuid references public.booking_milestones (id) on delete restrict;

alter table public.payments drop constraint if exists payments_booking_id_key;

create unique index if not exists payments_primary_booking_uidx
  on public.payments (booking_id)
  where milestone_id is null;

create unique index if not exists payments_milestone_uidx
  on public.payments (milestone_id)
  where milestone_id is not null;

alter table public.booking_payment_plans enable row level security;
alter table public.booking_quotes enable row level security;
alter table public.booking_milestones enable row level security;

drop policy if exists booking_payment_plans_select on public.booking_payment_plans;
create policy booking_payment_plans_select
  on public.booking_payment_plans for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.booking_requests
      where booking_requests.id = booking_payment_plans.booking_id
        and (
          booking_requests.customer_id = auth.uid()
          or public.owns_provider(booking_requests.provider_id)
        )
    )
  );

drop policy if exists booking_quotes_select on public.booking_quotes;
create policy booking_quotes_select
  on public.booking_quotes for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.booking_requests
      where booking_requests.id = booking_quotes.booking_id
        and (
          booking_requests.customer_id = auth.uid()
          or public.owns_provider(booking_requests.provider_id)
        )
    )
  );

drop policy if exists booking_milestones_select on public.booking_milestones;
create policy booking_milestones_select
  on public.booking_milestones for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.booking_requests
      where booking_requests.id = booking_milestones.booking_id
        and (
          booking_requests.customer_id = auth.uid()
          or public.owns_provider(booking_requests.provider_id)
        )
    )
  );

revoke all on public.booking_payment_plans from public, anon, authenticated;
revoke all on public.booking_quotes from public, anon, authenticated;
revoke all on public.booking_milestones from public, anon, authenticated;
grant select on public.booking_payment_plans to authenticated;
grant select on public.booking_quotes to authenticated;
grant select on public.booking_milestones to authenticated;
