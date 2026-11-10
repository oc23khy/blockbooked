-- Stores the cents Stripe actually transferred and reversed.
-- Existing rows stay null. Do not copy provider_share_cents into these columns.

alter table public.payments
  add column if not exists transfer_amount_cents integer,
  add column if not exists transfer_reversed_cents integer;

alter table public.payments
  drop constraint if exists payments_transfer_amounts_nonnegative;

alter table public.payments
  add constraint payments_transfer_amounts_nonnegative
  check (
    (transfer_amount_cents is null or transfer_amount_cents >= 0)
    and (transfer_reversed_cents is null or transfer_reversed_cents >= 0)
  );
