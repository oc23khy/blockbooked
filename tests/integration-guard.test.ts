import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { assertConnectedLocalDatabase, assertDisposableDatabaseUrl, assertStripeTestKey, LOCAL_MIGRATION_VERSIONS } from "./integration-guard.ts";

const original = {
  database: process.env.BLOCKBOOKED_BOOKING_TEST_CONFIRM,
  stripe: process.env.BLOCKBOOKED_STRIPE_TEST_CONFIRM,
};

afterEach(() => {
  if (original.database == null) delete process.env.BLOCKBOOKED_BOOKING_TEST_CONFIRM;
  else process.env.BLOCKBOOKED_BOOKING_TEST_CONFIRM = original.database;
  if (original.stripe == null) delete process.env.BLOCKBOOKED_STRIPE_TEST_CONFIRM;
  else process.env.BLOCKBOOKED_STRIPE_TEST_CONFIRM = original.stripe;
});

describe("integration environment guards", () => {
  it("allows only the two local disposable databases after confirmation", () => {
    process.env.BLOCKBOOKED_BOOKING_TEST_CONFIRM = "local-disposable";
    assert.equal(
      assertDisposableDatabaseUrl("postgres://postgres@127.0.0.1:54322/postgres").database,
      "postgres",
    );
    assert.equal(
      assertDisposableDatabaseUrl("postgres://postgres@127.0.0.1:54329/blockbooked_booking_integration").database,
      "blockbooked_booking_integration",
    );
  });

  it("refuses a hosted database, the wrong local database, and a missing confirmation", () => {
    process.env.BLOCKBOOKED_BOOKING_TEST_CONFIRM = "local-disposable";
    assert.throws(
      () => assertDisposableDatabaseUrl("postgres://postgres:secret@db.example.supabase.co:5432/postgres"),
      /hosted Supabase/,
    );
    assert.throws(
      () => assertDisposableDatabaseUrl("postgres://postgres@127.0.0.1:5432/postgres"),
      /Refusing this database/,
    );
    delete process.env.BLOCKBOOKED_BOOKING_TEST_CONFIRM;
    assert.throws(
      () => assertDisposableDatabaseUrl("postgres://postgres@127.0.0.1:54322/postgres"),
      /BLOCKBOOKED_BOOKING_TEST_CONFIRM/,
    );
  });

  it("refuses production-like URLs, poolers, private-network hosts, and unexpected ports", () => {
    process.env.BLOCKBOOKED_BOOKING_TEST_CONFIRM = "local-disposable";
    const production = "https://abcd1234.supabase.co";
    assert.throws(
      () => assertDisposableDatabaseUrl("postgres://postgres:secret@db.abcd1234.supabase.co:5432/postgres", production),
      /hosted Supabase/,
    );
    assert.throws(
      () => assertDisposableDatabaseUrl("postgresql://postgres.abcd1234:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres", production),
      /hosted Supabase/,
    );
    assert.throws(
      () => assertDisposableDatabaseUrl("postgres://postgres:secret@10.0.0.5:54322/postgres", production),
      /not on this computer/,
    );
    assert.throws(
      () => assertDisposableDatabaseUrl("postgres://postgres@127.0.0.1:54321/postgres", production),
      /Refusing this database/,
    );
    assert.throws(
      () => assertDisposableDatabaseUrl("postgres://postgres@localhost:54322/production", production),
      /Refusing this database/,
    );
  });

  it("accepts the Docker-local server only when its name and migration history match", () => {
    const connected = assertConnectedLocalDatabase({
      expectedDatabase: "postgres",
      currentDatabase: "postgres",
      serverAddress: "172.19.0.2/32",
      migrations: LOCAL_MIGRATION_VERSIONS,
    });
    assert.equal(connected.addressClass, "private");
    assert.deepEqual(LOCAL_MIGRATION_VERSIONS.slice(-6), [
      "20261114030000",
      "20261114035000",
      "20261114040000",
      "20261114050000",
      "20261114060000",
      "20261116010000",
    ]);
    assert.equal(
      assertConnectedLocalDatabase({
        expectedDatabase: "postgres",
        currentDatabase: "postgres",
        serverAddress: null,
        migrations: LOCAL_MIGRATION_VERSIONS,
      }).addressClass,
      "absent",
    );
    assert.throws(
      () => assertConnectedLocalDatabase({
        expectedDatabase: "postgres",
        currentDatabase: "postgres",
        serverAddress: "172.19.0.2",
        migrations: LOCAL_MIGRATION_VERSIONS.filter((version) => version !== "20261114050000"),
      }),
      /migration history/,
    );
    assert.throws(
      () => assertConnectedLocalDatabase({
        expectedDatabase: "postgres",
        currentDatabase: "postgres",
        serverAddress: "34.1.2.3",
        migrations: LOCAL_MIGRATION_VERSIONS,
      }),
      /public address/,
    );
    assert.throws(
      () => assertConnectedLocalDatabase({
        expectedDatabase: "postgres",
        currentDatabase: "defaultdb",
        serverAddress: "10.0.0.5",
        migrations: LOCAL_MIGRATION_VERSIONS,
      }),
      /does not match/,
    );
  });

  it("accepts only a confirmed Stripe test key", () => {
    process.env.BLOCKBOOKED_STRIPE_TEST_CONFIRM = "test-mode-only";
    assert.doesNotThrow(() => assertStripeTestKey("sk_test_example"));
    assert.throws(() => assertStripeTestKey("sk_live_example"), /sk_test_/);
    delete process.env.BLOCKBOOKED_STRIPE_TEST_CONFIRM;
    assert.throws(() => assertStripeTestKey("sk_test_example"), /BLOCKBOOKED_STRIPE_TEST_CONFIRM/);
  });
});
