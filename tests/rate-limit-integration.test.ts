import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const script = readFileSync(
  new URL("../supabase/verification/rate_limit_booking_integration.sql", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL("../supabase/migrations/20261111200000_rate_limits.sql", import.meta.url),
  "utf8",
);
const receiptMatchFix = readFileSync(
  new URL("../supabase/migrations/20261111210000_rate_limit_receipt_match.sql", import.meta.url),
  "utf8",
);

function section(name: string) {
  const marker = `-- SPLIT:${name}`;
  const start = script.indexOf(marker);
  const next = script.indexOf("-- SPLIT:", start + marker.length);
  if (start < 0) throw new Error(`Missing ${marker}`);
  return script.slice(start + marker.length, next === -1 ? script.length : next);
}

const localDatabaseUrl = "postgres://postgres:blockbooked_local_test@127.0.0.1:54329/blockbooked_rate_limit_test";

function disposableDatabaseUrl() {
  const supplied = process.env.BLOCKBOOKED_RATE_LIMIT_TEST_URL;
  if (supplied && supplied !== localDatabaseUrl) {
    throw new Error("Refusing BLOCKBOOKED_RATE_LIMIT_TEST_URL because it is not the localhost disposable database.");
  }
  const parsed = new URL(localDatabaseUrl);
  if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/blockbooked_rate_limit_test") {
    throw new Error("The disposable database URL must use 127.0.0.1 and blockbooked_rate_limit_test.");
  }
  if (localDatabaseUrl.includes("supabase.co")) {
    throw new Error("Refusing a Supabase host.");
  }
  return localDatabaseUrl;
}

describe("prepared booking rate-limit integration script", () => {
  it("keeps every scenario on a named disposable database and cleans up only test rows", () => {
    for (const scenario of [
      "SCENARIO 1",
      "SCENARIO 2",
      "SCENARIO 3",
      "SCENARIO 4",
      "SCENARIO 5",
      "SCENARIO 6",
      "SCENARIO 7",
      "SCENARIO 8",
      "SCENARIO 9",
      "SCENARIO 10",
    ]) {
      assert.match(script, new RegExp(scenario));
    }
    assert.match(script, /create extension if not exists pgcrypto with schema extensions/);
    assert.match(script, /blockbooked_rate_limit_test/);
    assert.match(script, /unrelated rows/);
    assert.match(script, /Too many attempts/);
    assert.match(script, /service_role/);
    assert.match(script, /blockbooked\.pin_verified/);
    assert.match(section("cleanup"), /delete from public\.rate_limit_counters/);
    assert.doesNotMatch(script, /supabase\.co|stripe\.com/i);
    assert.match(migration, /bookings_limit_insert/);
    assert.doesNotMatch(migration, /on public\.payments|stripe\./i);
  });
});

describe("disposable PostgreSQL booking rate limiter", () => {
  it("runs the limiter, receipt, concurrency, service-role, and PIN scenarios", async () => {
    const url = disposableDatabaseUrl();
    const require = createRequire(import.meta.url);
    const pg = require("pg") as {
      Client: new (config: { connectionString: string }) => {
        connect(): Promise<void>;
        query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
        end(): Promise<void>;
      };
      Pool: new (config: { connectionString: string; max: number }) => {
        query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, string>> }>;
        end(): Promise<void>;
      };
    };
    const setup = new pg.Client({ connectionString: url });
    await setup.connect();
    try {
      const identity = await setup.query("select current_database() as name");
      assert.equal(identity.rows[0].name, "blockbooked_rate_limit_test");
      await setup.query(section("prelude"));
      await setup.query(migration);
      await setup.query(receiptMatchFix);
      await setup.query(section("tests"));

      await setup.query(
        "delete from public.booking_requests where customer_id = 'a0000005-0000-4000-8000-000000000005'",
      );
      await setup.query(
        "delete from public.rate_limit_counters where bucket = 'createBooking:user:a0000005-0000-4000-8000-000000000005'",
      );
      const pool = new pg.Pool({ connectionString: url, max: 12 });
      try {
        const attempts = await Promise.all(
          Array.from({ length: 12 }, () =>
            pool.query("select rate_lab.try_booking($1::uuid, 'authenticated', null) as result", [
              "a0000005-0000-4000-8000-000000000005",
            ]),
          ),
        );
        const allowed = attempts.filter((attempt) => attempt.rows[0].result === "ok").length;
        const hits = await pool.query("select rate_lab.hits_for($1::uuid, 'createBooking') as hits", [
          "a0000005-0000-4000-8000-000000000005",
        ]);
        assert.equal(allowed, 10);
        assert.equal(Number(hits.rows[0].hits), 10);
      } finally {
        await pool.end();
      }
    } finally {
      await setup.query(section("cleanup"));
      await setup.end();
    }
  });
});
