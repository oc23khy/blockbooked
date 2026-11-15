import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  APPOINTMENT_GUARD,
  APPOINTMENT_REQUIRED_TRIGGER,
  FIXTURE,
  FIXTURE_HOURS,
  assertLocalCleanupHost,
  fixtureCleanupStatements,
  fixtureRateLimitBuckets,
  runFixtureCleanup,
} from "./booking-db-cleanup.ts";

const integration = readFileSync(new URL("./booking-db.integration.test.ts", import.meta.url), "utf8");

describe("booking fixture cleanup", () => {
  it("keeps every scenario on its own appointment hour", () => {
    const hours = Object.values(FIXTURE_HOURS);
    assert.equal(new Set(hours).size, hours.length);
    assert.equal(hours.every((hour) => hour >= 0 && hour <= 23), true);
    assert.notEqual(FIXTURE_HOURS.overlap, FIXTURE_HOURS.firstHold);
    assert.notEqual(FIXTURE_HOURS.expiration, FIXTURE_HOURS.paidA);
  });

  it("deletes only the synthetic fixture ids and re-enables the guard before commit", async () => {
    const statements = fixtureCleanupStatements();
    const deletes = statements.filter((statement) => statement.text.startsWith("delete "));
    assert.equal(deletes.length > 0, true);
    for (const statement of deletes) {
      assert.match(statement.text, /\$\d/);
      assert.equal(statement.values?.some((value) => String(value).includes(FIXTURE.provider) || String(value).includes(FIXTURE.customer) || String(value).includes(FIXTURE.owner) || String(value).includes(FIXTURE.admin) || String(value).includes("@example.com")), true);
    }
    assert.equal(statements.some((statement) => statement.text.includes("disable trigger providers_protect_row")), false);
    const queries: string[] = [];
    await runFixtureCleanup({
      async query(text: string) {
        queries.push(text);
        if (text.includes("from pg_trigger")) {
          return {
            rows: [
              { name: APPOINTMENT_GUARD, enabled: "O" },
              { name: APPOINTMENT_REQUIRED_TRIGGER, enabled: "O" },
            ],
            rowCount: 2,
          };
        }
        if (text.includes("count(*)")) {
          return { rows: [{ bookings: 0, visits: 0, payments: 0, providers: 0, profiles: 0, users: 0, counters: 0, receipts: 0 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    }, "127.0.0.1");
    const disableAt = queries.findIndex((query) => query.includes(`disable trigger ${APPOINTMENT_GUARD}`));
    const enableAt = queries.findIndex((query) => query.includes(`enable trigger ${APPOINTMENT_GUARD}`));
    const commitAt = queries.findIndex((query) => query === "commit");
    assert.equal(disableAt >= 0 && enableAt > disableAt && commitAt > enableAt, true);
    assert.equal(queries.includes("rollback"), false);
    assert.equal(queries.filter((query) => query.includes(`disable trigger ${APPOINTMENT_REQUIRED_TRIGGER}`)).length, 0);
  });

  it("rolls back and reports a cleanup failure", async () => {
    const queries: string[] = [];
    await assert.rejects(
      () => runFixtureCleanup({
        async query(text: string) {
          queries.push(text);
          if (text.includes("delete from public.booking_appointments")) throw new Error("appointment delete failed");
          return { rows: [], rowCount: 0 };
        },
      }, "localhost"),
      /appointment delete failed/,
    );
    assert.equal(queries.includes("begin"), true);
    assert.equal(queries.includes("rollback"), true);
    assert.equal(queries.includes("commit"), false);
  });

  it("refuses cleanup for a hosted or private-network database", async () => {
    const client = {
      async query() {
        throw new Error("cleanup queried a non-local database");
      },
    };
    assert.throws(() => assertLocalCleanupHost("db.example.supabase.co"), /not local/);
    await assert.rejects(() => runFixtureCleanup(client, "172.19.0.2"), /not local/);
    await assert.rejects(() => runFixtureCleanup(client, "db.abcd1234.supabase.co"), /not local/);
  });

  it("deletes only the synthetic booking rate-limit buckets", () => {
    const buckets = fixtureRateLimitBuckets();
    const otherUser = "b2000001-0000-4000-8000-0000000000b1";
    const statement = fixtureCleanupStatements().find((entry) => entry.text.startsWith("delete from public.rate_limit_counters"));
    const receipts = fixtureCleanupStatements().find((entry) => entry.text.startsWith("delete from public.rate_limit_receipts"));
    assert.ok(statement);
    assert.ok(receipts);
    assert.equal(statement.text.includes("like"), false);
    assert.equal(receipts.text.includes("like"), false);
    assert.deepEqual(statement.values, buckets);
    assert.deepEqual(receipts.values, [FIXTURE.customer, FIXTURE.owner, FIXTURE.admin]);
    assert.match(receipts.text, /operation in \('createBooking', 'bookingStatus'\)/);
    assert.equal(buckets.includes(`createBooking:user:${FIXTURE.customer}`), true);
    assert.equal(buckets.includes(`createBooking:user:${otherUser}`), false);
    assert.equal(buckets.includes(`completionPin:user:${FIXTURE.customer}`), false);
    assert.equal(buckets.includes(`createBooking:user:${FIXTURE.customer.slice(0, 12)}`), false);
  });

  it("accepts a legacy booking only as the authenticated provider owner", () => {
    const start = integration.indexOf("disable trigger bookings_protect_appointment_required");
    const legacy = integration.slice(start, integration.indexOf("rollback", start));
    assert.match(legacy, /appointment_required[\s\S]*false/);
    assert.equal(legacy.includes("disable trigger bookings_protect_row"), false);
    assert.ok(legacy.indexOf("[customer]") < legacy.indexOf("[owner]"));
    assert.ok(legacy.indexOf('"pending"') < legacy.indexOf('"accepted"'));
    assert.equal(legacy.split("set local role authenticated").length, 3);
  });

  it("does not hide a cleanup error in the booking integration test", () => {
    assert.match(integration, /runFixtureCleanup\(client, target\.host\)/);
    assert.match(integration, /status = 'cancelled'/);
    assert.doesNotMatch(integration, /cleanup\(client\)\.catch/);
    assert.doesNotMatch(integration, /delete from public\.booking_appointments/);
    assert.doesNotMatch(integration, /disable trigger providers_protect_row/);
  });
});
