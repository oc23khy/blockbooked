-- Paste and run this whole script once in the Supabase SQL editor.
-- It checks one booking, attempts completion without a PIN, and rolls the attempt back.
-- It does not disable triggers, change roles, call the PIN function, or commit.

begin;

do $check$
declare
  target constant uuid := '0e6cd109-84a8-4e04-b58e-4ea4d0777246';
  observed text;
  verification text;
begin
  select status
    into observed
  from public.booking_requests
  where id = target
  for update;

  if not found then
    raise exception 'Refusing to run: booking % does not exist.', target;
  end if;

  if observed is distinct from 'accepted' then
    raise exception 'Refusing to run: booking % status is %, not accepted.', target, observed;
  end if;

  perform set_config('blockbooked.pin_verified', '0', true);
  verification := current_setting('blockbooked.pin_verified', true);
  if verification is not distinct from '1' then
    raise exception 'Refusing to run: the PIN verification flag is set.';
  end if;

  begin
    update public.booking_requests
    set status = 'completed'
    where id = target
      and status = 'accepted';

    if found then
      raise exception 'Test failed: completion was accepted without a customer PIN.';
    end if;

    raise exception 'Test failed: the completion update did not run.';
  exception
    when others then
      if sqlerrm is distinct from 'Completion requires the customer PIN' then
        raise;
      end if;
  end;

  select status
    into observed
  from public.booking_requests
  where id = target;

  if observed is distinct from 'accepted' then
    raise exception 'Test failed: booking % status is %, not accepted.', target, observed;
  end if;

  raise notice 'The database rejected completion without a customer PIN.';
  raise notice 'Booking % remained accepted.', target;
end
$check$;

rollback;

do $confirm$
declare
  target constant uuid := '0e6cd109-84a8-4e04-b58e-4ea4d0777246';
  observed text;
begin
  select status
    into observed
  from public.booking_requests
  where id = target;

  if observed is distinct from 'accepted' then
    raise exception 'After rollback, booking % status is %, not accepted.', target, coalesce(observed, 'missing');
  end if;

  raise notice 'The transaction was rolled back.';
  raise notice 'After rollback, booking % is still accepted.', target;
end
$confirm$;
