-- Remove the booking_id name collision in the expiration worker functions.
-- Run after 20261110280000_reschedule_booking_id.sql.
-- Drops and recreates only these two functions. Does not update bookings,
-- payments, refunds, or deadlines.
--
-- Both functions returned table (booking_id uuid). That output name is a
-- PL/pgSQL variable, so SQL references to the booking_id column were ambiguous.
-- The result column is now expired_booking_id. Table columns stay qualified,
-- and the transition upsert targets appointment_transition_pkey instead of
-- ON CONFLICT (booking_id).

drop function if exists public.claim_expired_bookings(integer);
drop function if exists public.bookings_needing_expiration_refund(integer);

create function public.claim_expired_bookings(batch_limit integer default 25)
returns table (expired_booking_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  target record;
  issued uuid;
  claimed integer := 0;
  limit_size integer := batch_limit;
begin
  if coalesce(auth.role(), '') is distinct from 'service_role' and not public.is_admin() then
    raise exception 'Not allowed to expire bookings';
  end if;
  if limit_size is null or limit_size < 1 or limit_size > 50 then
    limit_size := 25;
  end if;

  for target in
    select request.id
    from public.booking_requests as request
    where request.status = 'pending'
      and public.effective_acceptance_deadline(
        request.acceptance_deadline,
        request.expiration_grace,
        (
          select visit.starts_at
          from public.booking_appointments as visit
          where visit.booking_id = request.id
            and visit.status in ('held', 'confirmed')
        )
      ) <= now()
    order by request.created_at
    limit (limit_size)
    for update of request skip locked
  loop
    issued := gen_random_uuid();
    insert into blockbooked_private.appointment_transition as transition (booking_id, action, nonce)
    values (target.id, 'expire', issued)
    on conflict on constraint appointment_transition_pkey do update
    set action = excluded.action,
        nonce = excluded.nonce;
    update public.booking_requests as request
    set status = 'expired'
    where request.id = target.id
      and request.status = 'pending';
    -- The protect trigger can keep the row pending. Read the status back
    -- before reporting it. A provider acceptance that committed first stays
    -- accepted.
    if exists (
      select 1
      from public.booking_requests as request
      where request.id = target.id
        and request.status = 'expired'
    ) then
      expired_booking_id := target.id;
      return next;
      claimed := claimed + 1;
    end if;
    update blockbooked_private.appointment_transition as transition
    set action = 'spent',
        nonce = gen_random_uuid()
    where transition.booking_id = target.id
      and transition.action = 'expire';
  end loop;
end;
$$;

create function public.bookings_needing_expiration_refund(batch_limit integer default 25)
returns table (expired_booking_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  limit_size integer := batch_limit;
begin
  if coalesce(auth.role(), '') is distinct from 'service_role' and not public.is_admin() then
    raise exception 'Not allowed to read expiration refunds';
  end if;
  if limit_size is null or limit_size < 1 or limit_size > 50 then
    limit_size := 25;
  end if;
  return query
  select request.id
  from public.booking_requests as request
  where request.status = 'expired'
    and (
      request.expiration_refund_error is not null
      or exists (
        select 1
        from public.payments as succeeded_payment
        where succeeded_payment.booking_id = request.id
          and succeeded_payment.status in ('succeeded', 'partially_refunded')
          and succeeded_payment.refunded_cents < succeeded_payment.amount_cents
      )
    )
  order by request.expired_at desc nulls first
  limit (limit_size);
end;
$$;

revoke all on function public.claim_expired_bookings(integer) from public, anon, authenticated;
revoke all on function public.bookings_needing_expiration_refund(integer) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.claim_expired_bookings(integer) to service_role;
    grant execute on function public.bookings_needing_expiration_refund(integer) to service_role;
  end if;
end $$;
