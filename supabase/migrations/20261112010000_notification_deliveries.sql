-- Delivery records for transactional email. The service role writes these
-- after a booking or payment change is saved. Authenticated clients cannot
-- read or insert them, so addresses and booking details stay out of this table.

create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null,
  event_type text not null,
  booking_id uuid references public.booking_requests (id) on delete cascade,
  recipient_role text not null,
  recipient_user_id uuid,
  status text not null default 'pending',
  attempt_count integer not null default 1,
  provider_message_id text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_deliveries_key_unique unique (idempotency_key),
  constraint notification_deliveries_key_length check (char_length(idempotency_key) between 1 and 160),
  constraint notification_deliveries_role check (recipient_role in ('customer', 'provider')),
  constraint notification_deliveries_status check (status in ('pending', 'sent', 'failed', 'skipped')),
  constraint notification_deliveries_event check (
    event_type in (
      'booking_requested',
      'booking_accepted',
      'payment_succeeded',
      'booking_cancelled',
      'refund_issued',
      'booking_completed'
    )
  ),
  constraint notification_deliveries_error_code_safe check (
    error_code is null or error_code ~ '^[a-z0-9_]{1,80}$'
  ),
  constraint notification_deliveries_provider_id_length check (
    provider_message_id is null or char_length(provider_message_id) between 1 and 80
  ),
  constraint notification_deliveries_attempts check (attempt_count between 1 and 50)
);

create index if not exists notification_deliveries_booking_idx
  on public.notification_deliveries (booking_id, created_at);

create index if not exists notification_deliveries_due_idx
  on public.notification_deliveries (status, updated_at)
  where status in ('pending', 'failed');

alter table public.notification_deliveries enable row level security;
alter table public.notification_deliveries force row level security;

-- No policies. Authenticated and anonymous roles stay denied even if a grant
-- is added later. The service role bypasses row level security and is the
-- only role allowed to write delivery records.
revoke all on table public.notification_deliveries from public, anon, authenticated, service_role;
grant select, insert, update on table public.notification_deliveries to service_role;
