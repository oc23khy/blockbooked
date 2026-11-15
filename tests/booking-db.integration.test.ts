import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { FIXTURE, FIXTURE_HOURS, clearFixtureRateLimits, runFixtureCleanup } from "./booking-db-cleanup.ts";
import { assertConnectedLocalDatabase, assertDisposableDatabaseUrl } from "./integration-guard.ts";

const url = process.env.BLOCKBOOKED_BOOKING_TEST_URL;
const customer = FIXTURE.customer;
const owner = FIXTURE.owner;
const provider = FIXTURE.provider;
const service = FIXTURE.service;
const admin = FIXTURE.admin;

type QueryClient = {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  connect(): Promise<void>;
  end(): Promise<void>;
};

function clientFor(connectionString: string) {
  const require = createRequire(import.meta.url);
  const pg = require("pg") as { Client: new (config: { connectionString: string }) => QueryClient };
  return new pg.Client({ connectionString });
}

async function asDatabaseOwner(client: QueryClient) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claim.sub', '', false)");
  await client.query("select set_config('request.jwt.claim.role', '', false)");
  await client.query("select set_config('request.jwt.claims', '', false)");
}

async function asAuthenticated(client: QueryClient, userId: string) {
  await asDatabaseOwner(client);
  await client.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await client.query("select set_config('request.jwt.claim.role', 'authenticated', false)");
  await client.query("select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, false)", [userId]);
  await client.query("set role authenticated");
}

async function asService(client: QueryClient) {
  await asDatabaseOwner(client);
  await client.query("select set_config('request.jwt.claim.role', 'service_role', false)");
  await client.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', false)");
}

async function releaseFixtureHolds(client: QueryClient) {
  await asAuthenticated(client, customer);
  await client.query(
    `update public.booking_requests
     set status = 'cancelled'
     where customer_id = $1 and provider_id = $2 and status = 'pending'`,
    [customer, provider],
  );
  const held = await client.query(
    "select count(*)::int as count from public.booking_appointments where provider_id = $1 and status in ('held', 'confirmed')",
    [provider],
  );
  if (Number(held.rows[0]?.count) !== 0) {
    throw new Error("Fixture holds were not released by cancellation.");
  }
}

async function seed(client: QueryClient, host: string) {
  await runFixtureCleanup(client, host);
  for (const [id, email] of [
    [customer, "booking-customer@example.com"],
    [owner, "booking-owner@example.com"],
    [admin, "booking-admin@example.com"],
  ] as const) {
    await client.query(
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, extensions.crypt('local-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`,
      [id, email],
    );
  }
  await client.query("update public.profiles set role = 'admin' where id = $1 and role = 'customer'", [admin]);
  await asAuthenticated(client, owner);
  await client.query("select public.become_provider()");
  await client.query(
    `insert into public.providers (id, owner_id, business_name, category_id, service_areas)
     values ($1, $2, 'Integration Cleaning', 'cleaners', array['Roselle'])`,
    [provider, owner],
  );
  await asAuthenticated(client, admin);
  await client.query("update public.providers set status = 'approved', review_note = null where id = $1", [provider]);
  const approved = await client.query("select status::text as status, owner_id::text as owner_id from public.providers where id = $1", [provider]);
  if (approved.rows[0]?.status !== "approved" || approved.rows[0]?.owner_id !== owner) {
    throw new Error("Admin approval did not keep the provider owner.");
  }
  await asDatabaseOwner(client);
  const roles = await client.query("select id::text as id, role::text as role from public.profiles where id in ($1, $2, $3)", [customer, owner, admin]);
  const roleOf = (id: string) => roles.rows.find((row) => row.id === id)?.role;
  if (roleOf(customer) !== "customer" || roleOf(owner) !== "provider" || roleOf(admin) !== "admin") {
    throw new Error("Fixture roles were not customer, provider, and admin.");
  }
  await asAuthenticated(client, owner);
  await client.query(
    `insert into public.provider_services (id, provider_id, name, pricing_type, price_cents, duration_minutes)
     values ($1, $2, 'Visit', 'fixed', 5000, 60)`,
    [service, provider],
  );
  await client.query(
    `insert into public.provider_schedule_settings (provider_id, min_notice_minutes, max_advance_days, buffer_minutes)
     values ($1, 0, 60, 0)`,
    [provider],
  );
  for (let weekday = 0; weekday < 7; weekday += 1) {
    await client.query(
      `insert into public.provider_business_hours (provider_id, weekday, opens_minute, closes_minute)
       values ($1, $2, 0, 1440)`,
      [provider, weekday],
    );
  }
}

async function visit(client: QueryClient, hour: number, bookingId?: string) {
  const created = bookingId
    ? { rows: [{ id: bookingId }] }
    : await client.query(
        `insert into public.booking_requests (customer_id, provider_id, preferred_date, time_window, contact_phone, service_name, status)
         values ($1, $2, current_date, 'Afternoon', '5555550100', 'Visit', 'pending')
         returning id`,
        [customer, provider],
      );
  await client.query(
    `insert into public.booking_appointments (booking_id, provider_id, service_id, starts_at, ends_at)
     values (
       $1, $2, $3,
       ((date_trunc('day', now() at time zone 'America/Chicago') + interval '2 days' + make_interval(hours => $4)) at time zone 'America/Chicago'),
       ((date_trunc('day', now() at time zone 'America/Chicago') + interval '2 days' + make_interval(hours => $4 + 1)) at time zone 'America/Chicago')
     )`,
    [created.rows[0].id, provider, service, hour],
  );
  return created.rows[0].id as string;
}

if (!url) {
  describe("booking database integration", () => {
    it("does not connect until a disposable local database is configured", () => {
      assert.equal(process.env.BLOCKBOOKED_BOOKING_TEST_URL, undefined);
    });
  });
} else {
  const target = assertDisposableDatabaseUrl(url, process.env.NEXT_PUBLIC_SUPABASE_URL);
  describe("booking database integration", () => {
    it("checks the local database name, hold limits, rollback, expiration, and row security", async () => {
      assert.equal(target.host === "127.0.0.1" || target.host === "localhost", true);
      const client = clientFor(url);
      const other = clientFor(url);
      let failure: unknown;
      await client.connect();
      await other.connect();
      try {
        const identity = await client.query("select current_database() as name, inet_server_addr()::text as addr");
        const history = await client.query("select version from supabase_migrations.schema_migrations order by version");
        assertConnectedLocalDatabase({
          expectedDatabase: target.database,
          currentDatabase: String(identity.rows[0].name),
          serverAddress: identity.rows[0].addr == null ? null : String(identity.rows[0].addr),
          migrations: history.rows.map((row) => String(row.version)),
        });
        const ready = await client.query("select to_regprocedure('public.enforce_unpaid_hold_limit()') as fn");
        if (!ready.rows[0].fn) {
          throw new Error("Apply the local Supabase migrations, including 20261114050000, before this test.");
        }
        await seed(client, target.host);
        await asDatabaseOwner(client);
        await client.query("begin");
        try {
          await client.query("select set_config('request.jwt.claim.sub', $1, true)", [customer]);
          await client.query("select set_config('request.jwt.claim.role', 'authenticated', true)");
          await client.query("select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)", [customer]);
          await client.query("set local role authenticated");
          await assert.rejects(
            () => client.query(
              `insert into public.providers (owner_id, business_name, category_id, service_areas)
               values ($1, 'Stolen', 'cleaners', array['Roselle'])`,
              [owner],
            ),
            /You can only create your own business profile/,
          );
        } finally {
          await client.query("rollback");
        }
        await asAuthenticated(client, customer);
        await asAuthenticated(other, customer);
        await visit(client, FIXTURE_HOURS.firstHold);
        await visit(client, FIXTURE_HOURS.secondHold);
        await assert.rejects(() => visit(client, FIXTURE_HOURS.rejectedHold), /Too many unpaid appointments/);
        const before = await client.query(
          "select count(*)::int as count from public.booking_appointments where provider_id = $1 and status = 'held'",
          [provider],
        );
        const results = await Promise.allSettled([visit(client, FIXTURE_HOURS.concurrentA), visit(other, FIXTURE_HOURS.concurrentB)]);
        assert.equal(results.filter((result) => result.status === "fulfilled").length, 0);
        const after = await client.query(
          "select count(*)::int as count from public.booking_appointments where provider_id = $1 and status = 'held'",
          [provider],
        );
        assert.equal(after.rows[0].count, before.rows[0].count);

        await releaseFixtureHolds(client);
        await clearFixtureRateLimits(client, target.host);
        await asAuthenticated(client, customer);
        const first = await visit(client, FIXTURE_HOURS.overlap);
        const secondBooking = await client.query(
          `insert into public.booking_requests (customer_id, provider_id, preferred_date, time_window, contact_phone, service_name, status)
           values ($1, $2, current_date, 'Afternoon', '5555550100', 'Visit', 'pending') returning id`,
          [customer, provider],
        );
        await assert.rejects(
          () => visit(client, FIXTURE_HOURS.overlap, secondBooking.rows[0].id as string),
          /overlap/i,
        );
        const kept = await client.query("select id from public.booking_requests where id = $1", [first]);
        assert.equal(kept.rowCount, 1);

        await releaseFixtureHolds(client);
        await clearFixtureRateLimits(client, target.host);
        await asAuthenticated(client, customer);
        const beforeRollback = await client.query("select count(*)::int as count from public.booking_requests where provider_id = $1", [provider]);
        await assert.rejects(
          () =>
            client.query(
              `select public.create_reserved_booking($1, current_date, 'Afternoon', '', '5555550100', 'Visit', null, $2, now() + interval '2 days', now() + interval '2 days' + interval '5 minutes')`,
              [provider, service],
            ),
          /duration|Appointment/,
        );
        const afterRollback = await client.query("select count(*)::int as count from public.booking_requests where provider_id = $1", [provider]);
        assert.equal(afterRollback.rows[0].count, beforeRollback.rows[0].count);

        await client.query("reset role");
        await client.query("begin");
        try {
          await client.query("alter table public.booking_requests disable trigger bookings_protect_appointment_required");
          const legacy = await client.query(
            `insert into public.booking_requests (customer_id, provider_id, preferred_date, time_window, contact_phone, service_name, status, appointment_required)
             values ($1, $2, current_date, 'Morning', '5555550100', 'Legacy', 'pending', false) returning id`,
            [customer, provider],
          );
          await client.query(
            `insert into public.payments (booking_id, customer_id, provider_id, amount_cents, commission_bps, commission_cents, provider_share_cents, status)
             values ($1, $2, $3, 5000, 800, 400, 4600, 'succeeded')`,
            [legacy.rows[0].id, customer, provider],
          );
          await client.query("select set_config('request.jwt.claim.sub', $1, true)", [customer]);
          await client.query("select set_config('request.jwt.claim.role', 'authenticated', true)");
          await client.query("select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)", [customer]);
          await client.query("set local role authenticated");
          await client.query("update public.booking_requests set status = 'accepted' where id = $1", [legacy.rows[0].id]);
          const refused = await client.query("select status::text as status from public.booking_requests where id = $1", [legacy.rows[0].id]);
          assert.equal(refused.rows[0].status, "pending");
          await client.query("set local role none");
          await client.query("select set_config('request.jwt.claim.sub', $1, true)", [owner]);
          await client.query("select set_config('request.jwt.claim.role', 'authenticated', true)");
          await client.query("select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)", [owner]);
          await client.query("set local role authenticated");
          await client.query("update public.booking_requests set status = 'accepted' where id = $1", [legacy.rows[0].id]);
          const accepted = await client.query("select status::text as status, appointment_required from public.booking_requests where id = $1", [legacy.rows[0].id]);
          assert.equal(accepted.rows[0].status, "accepted");
          assert.equal(accepted.rows[0].appointment_required, false);
        } finally {
          await client.query("rollback");
        }
        await clearFixtureRateLimits(client, target.host);
        await asAuthenticated(client, customer);
        const paidOne = await visit(client, FIXTURE_HOURS.paidA);
        const paidTwo = await visit(client, FIXTURE_HOURS.paidB);
        await client.query("reset role");
        await client.query(
          `insert into public.payments (booking_id, customer_id, provider_id, amount_cents, commission_bps, commission_cents, provider_share_cents, status)
           values ($1, $2, $3, 5000, 800, 400, 4600, 'succeeded'), ($4, $2, $3, 5000, 800, 400, 4600, 'succeeded')`,
          [paidOne, customer, provider, paidTwo],
        );
        await asAuthenticated(client, customer);
        await visit(client, FIXTURE_HOURS.paidC);
        const paidCount = await client.query(
          "select count(*)::int as count from public.booking_appointments where provider_id = $1 and status = 'held'",
          [provider],
        );
        assert.equal(paidCount.rows[0].count, 3);

        await releaseFixtureHolds(client);
        await clearFixtureRateLimits(client, target.host);
        await asAuthenticated(client, customer);
        const expiring = await client.query(
          `insert into public.booking_requests (customer_id, provider_id, preferred_date, time_window, contact_phone, service_name, status, created_at)
           values ($1, $2, current_date, 'Afternoon', '5555550100', 'Visit', 'pending', now() - interval '31 minutes')
           returning id`,
          [customer, provider],
        );
        await client.query(
          `insert into public.booking_appointments (booking_id, provider_id, service_id, starts_at, ends_at)
           values (
             $1, $2, $3,
             ((date_trunc('day', now() at time zone 'America/Chicago') + interval '2 days' + make_interval(hours => $4)) at time zone 'America/Chicago'),
             ((date_trunc('day', now() at time zone 'America/Chicago') + interval '2 days' + make_interval(hours => $4 + 1)) at time zone 'America/Chicago')
           )`,
          [expiring.rows[0].id, provider, service, FIXTURE_HOURS.expiration],
        );
        await client.query("begin");
        try {
          await asService(client);
          const expired = await client.query("select expired_booking_id from public.claim_expired_bookings(25)");
          assert.equal(
            expired.rows.some((row) => row.expired_booking_id === expiring.rows[0].id),
            true,
          );
          const released = await client.query(
            "select request.status as booking_status, visit.status as visit_status from public.booking_requests request join public.booking_appointments visit on visit.booking_id = request.id where request.id = $1",
            [expiring.rows[0].id],
          );
          assert.equal(released.rows[0].booking_status, "expired");
          assert.equal(released.rows[0].visit_status, "released");
        } finally {
          await client.query("rollback");
        }

        await asAuthenticated(client, customer);
        await assert.rejects(
          () =>
            client.query(
              `insert into public.booking_requests (customer_id, provider_id, preferred_date, time_window, contact_phone, service_name, status)
               values ($1, $2, current_date, 'Morning', '5555550100', 'Other', 'pending')`,
              [owner, provider],
            ),
          /row-level security|permission|policy/i,
        );
      } catch (error) {
        failure = error;
      } finally {
        try {
          await runFixtureCleanup(client, target.host);
        } catch (cleanupError) {
          const reason = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          failure = failure instanceof Error
            ? new Error(`${failure.message}; fixture cleanup failed: ${reason}`)
            : cleanupError;
        }
        await client.end().catch(() => undefined);
        await other.end().catch(() => undefined);
      }
      if (failure) throw failure;
    });
  });
}
