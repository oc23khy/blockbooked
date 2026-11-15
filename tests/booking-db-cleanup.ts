export const FIXTURE = {
  customer: "a1000001-0000-4000-8000-0000000000a1",
  owner: "a1000002-0000-4000-8000-0000000000a2",
  provider: "a1000003-0000-4000-8000-0000000000a3",
  service: "a1000004-0000-4000-8000-0000000000a4",
  admin: "a1000005-0000-4000-8000-0000000000a5",
  customerEmail: "booking-customer@example.com",
  ownerEmail: "booking-owner@example.com",
  adminEmail: "booking-admin@example.com",
} as const;

export const FIXTURE_HOURS = {
  firstHold: 8,
  secondHold: 9,
  rejectedHold: 10,
  concurrentA: 11,
  concurrentB: 12,
  overlap: 13,
  paidA: 14,
  paidB: 15,
  paidC: 16,
  expiration: 17,
} as const;

export const APPOINTMENT_GUARD = "booking_appointments_guard";
export const APPOINTMENT_REQUIRED_TRIGGER = "bookings_protect_appointment_required";
export const FIXTURE_RATE_ACTORS = [FIXTURE.customer, FIXTURE.owner, FIXTURE.admin] as const;
export const FIXTURE_RATE_OPERATIONS = ["createBooking", "bookingStatus"] as const;

type QueryClient = {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
};

type CleanupStatement = { text: string; values?: unknown[] };

export function assertLocalCleanupHost(host: string) {
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("Refusing fixture cleanup because the database host is not local.");
  }
}

export function fixtureRateLimitBuckets() {
  return FIXTURE_RATE_ACTORS.flatMap((actor) =>
    FIXTURE_RATE_OPERATIONS.map((operation) => `${operation}:user:${actor}`),
  );
}

export function fixtureRateLimitStatements(): CleanupStatement[] {
  const buckets = fixtureRateLimitBuckets();
  const bucketPlaceholders = buckets.map((_, index) => `$${index + 1}`).join(", ");
  const actorPlaceholders = FIXTURE_RATE_ACTORS.map((_, index) => `$${index + 1}`).join(", ");
  return [
    {
      text: `delete from public.rate_limit_counters where bucket in (${bucketPlaceholders})`,
      values: [...buckets],
    },
    {
      text: `delete from public.rate_limit_receipts where actor in (${actorPlaceholders}) and operation in ('createBooking', 'bookingStatus')`,
      values: [...FIXTURE_RATE_ACTORS],
    },
  ];
}

export function fixtureCleanupStatements(): CleanupStatement[] {
  const ids = [FIXTURE.customer, FIXTURE.provider];
  const bookingMatch = "customer_id = $1 and provider_id = $2";
  return [
    {
      text: `alter table public.booking_appointments disable trigger ${APPOINTMENT_GUARD}`,
    },
    {
      text: `delete from public.payment_extra_charges where booking_id in (select id from public.booking_requests where ${bookingMatch})`,
      values: ids,
    },
    {
      text: `delete from public.refunds where booking_id in (select id from public.booking_requests where ${bookingMatch})`,
      values: ids,
    },
    {
      text: `delete from public.payments where customer_id = $1 and provider_id = $2`,
      values: ids,
    },
    {
      text: `delete from public.booking_appointments where provider_id = $2 and booking_id in (select id from public.booking_requests where ${bookingMatch})`,
      values: ids,
    },
    {
      text: `delete from public.booking_requests where ${bookingMatch}`,
      values: ids,
    },
    {
      text: "delete from public.provider_business_hours where provider_id = $1",
      values: [FIXTURE.provider],
    },
    {
      text: "delete from public.provider_schedule_settings where provider_id = $1",
      values: [FIXTURE.provider],
    },
    {
      text: "delete from public.provider_services where provider_id = $1",
      values: [FIXTURE.provider],
    },
    {
      text: "delete from public.providers where id = $1 and owner_id = $2",
      values: [FIXTURE.provider, FIXTURE.owner],
    },
    {
      text: "delete from public.profiles where id in ($1, $2, $3)",
      values: [FIXTURE.customer, FIXTURE.owner, FIXTURE.admin],
    },
    ...fixtureRateLimitStatements(),
    {
      text: "delete from auth.users where (id, email) in (($1, $2), ($3, $4), ($5, $6))",
      values: [
        FIXTURE.customer,
        FIXTURE.customerEmail,
        FIXTURE.owner,
        FIXTURE.ownerEmail,
        FIXTURE.admin,
        FIXTURE.adminEmail,
      ],
    },
    {
      text: `alter table public.booking_appointments enable trigger ${APPOINTMENT_GUARD}`,
    },
  ];
}

async function assertTriggersEnabled(client: QueryClient) {
  const triggers = await client.query(
    `select tgname::text as name, tgenabled::text as enabled
     from pg_trigger
     where not tgisinternal
       and tgname in ($1, $2)
     order by tgname`,
    [APPOINTMENT_GUARD, APPOINTMENT_REQUIRED_TRIGGER],
  );
  const enabled = new Map(triggers.rows.map((row) => [String(row.name), String(row.enabled)]));
  for (const name of [APPOINTMENT_GUARD, APPOINTMENT_REQUIRED_TRIGGER]) {
    if (enabled.get(name) !== "O") {
      throw new Error(`Fixture cleanup left ${name} disabled.`);
    }
  }
}

async function assertFixturesGone(client: QueryClient) {
  const counts = await client.query(
    `select
       (select count(*)::int from public.booking_requests where customer_id = $1 or provider_id = $2) as bookings,
       (select count(*)::int from public.booking_appointments where provider_id = $2) as visits,
       (select count(*)::int from public.payments where customer_id = $1 or provider_id = $2) as payments,
       (select count(*)::int from public.providers where id = $2) as providers,
       (select count(*)::int from public.profiles where id in ($1, $3, $4)) as profiles,
       (select count(*)::int from auth.users where id in ($1, $3, $4)) as users,
       (select count(*)::int from public.rate_limit_counters where bucket in (${fixtureRateLimitBuckets().map((_, index) => `$${index + 5}`).join(", ")})) as counters,
       (select count(*)::int from public.rate_limit_receipts where actor in ($1, $3, $4) and operation in ('createBooking', 'bookingStatus')) as receipts`,
    [FIXTURE.customer, FIXTURE.provider, FIXTURE.owner, FIXTURE.admin, ...fixtureRateLimitBuckets()],
  );
  const row = counts.rows[0] ?? {};
  const leftover = Object.entries(row).filter(([, count]) => Number(count) !== 0);
  if (leftover.length > 0) {
    throw new Error(`Fixture cleanup left rows: ${leftover.map(([name, count]) => `${name}=${count}`).join(", ")}.`);
  }
}

export async function clearFixtureRateLimits(client: QueryClient, host: string) {
  assertLocalCleanupHost(host);
  await client.query("reset role");
  await client.query("begin");
  let committed = false;
  try {
    for (const statement of fixtureRateLimitStatements()) {
      await client.query(statement.text, statement.values);
    }
    const counts = await client.query(
      `select
         (select count(*)::int from public.rate_limit_counters where bucket in (${fixtureRateLimitBuckets().map((_, index) => `$${index + 1}`).join(", ")})) as counters,
         (select count(*)::int from public.rate_limit_receipts where actor in ($${fixtureRateLimitBuckets().length + 1}, $${fixtureRateLimitBuckets().length + 2}, $${fixtureRateLimitBuckets().length + 3}) and operation in ('createBooking', 'bookingStatus')) as receipts`,
      [...fixtureRateLimitBuckets(), ...FIXTURE_RATE_ACTORS],
    );
    const row = counts.rows[0] ?? {};
    const leftover = Object.entries(row).filter(([, count]) => Number(count) !== 0);
    if (leftover.length > 0) {
      throw new Error(`Fixture rate-limit cleanup left rows: ${leftover.map(([name, count]) => `${name}=${count}`).join(", ")}.`);
    }
    await client.query("commit");
    committed = true;
  } catch (error) {
    if (!committed) {
      try {
        await client.query("rollback");
      } catch (rollbackError) {
        const reason = error instanceof Error ? error.message : String(error);
        const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`Fixture rate-limit cleanup failed and rollback failed: ${reason}; ${rollback}`);
      }
    }
    throw error;
  }
}

export async function runFixtureCleanup(client: QueryClient, host: string) {
  assertLocalCleanupHost(host);
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claim.sub', '', false)");
  await client.query("select set_config('request.jwt.claim.role', '', false)");
  await client.query("select set_config('request.jwt.claims', '', false)");
  await client.query("begin");
  let committed = false;
  try {
    for (const statement of fixtureCleanupStatements()) {
      await client.query(statement.text, statement.values);
    }
    await assertTriggersEnabled(client);
    await assertFixturesGone(client);
    await client.query("commit");
    committed = true;
  } catch (error) {
    if (!committed) {
      try {
        await client.query("rollback");
      } catch (rollbackError) {
        const reason = error instanceof Error ? error.message : String(error);
        const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`Fixture cleanup failed and rollback failed: ${reason}; ${rollback}`);
      }
    }
    throw error;
  }
  await assertTriggersEnabled(client);
  await assertFixturesGone(client);
}
