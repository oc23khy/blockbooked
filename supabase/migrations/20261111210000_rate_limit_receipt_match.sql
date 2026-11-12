-- The applied booking trigger compared PL/pgSQL variables named actor and operation
-- with columns of the same names. PostgreSQL rejects that comparison, so a valid
-- receipt could not be consumed. This replaces only that function.

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
