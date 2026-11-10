-- Guards for provider transfers and refunds. Additive.
-- Run after 20261110230000_stripe_payments.sql and 20261110240000_quotes_milestones.sql.
-- Does not delete bookings, payments, or refunds.

alter table public.payments
  add column if not exists transfer_attempt integer not null default 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'payments_transfer_attempt_nonnegative'
      and conrelid = 'public.payments'::regclass
  ) then
    alter table public.payments
      add constraint payments_transfer_attempt_nonnegative check (transfer_attempt >= 0);
  end if;
end $$;

create or replace function public.guard_refund_balance()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  payment public.payments%rowtype;
  committed integer;
begin
  select * into payment
  from public.payments
  where id = new.payment_id
  for update;

  if not found then
    raise exception 'Payment not found';
  end if;

  select coalesce(sum(amount_cents), 0) into committed
  from public.refunds
  where payment_id = new.payment_id
    and status in ('pending', 'succeeded')
    and id is distinct from new.id;

  if committed + new.amount_cents > payment.amount_cents then
    raise exception 'Refund amount is outside the remaining balance';
  end if;

  return new;
end;
$$;

drop trigger if exists refunds_guard_balance on public.refunds;
create trigger refunds_guard_balance
  before insert on public.refunds
  for each row execute function public.guard_refund_balance();

create unique index if not exists refunds_one_open_payment_uidx
  on public.refunds (payment_id)
  where status = 'pending';
