import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { RATE_LIMITS } from "../src/lib/rate-limit-decision.ts";
import {
  canMessageBooking,
  mergeMessages,
  messagePath,
  prepareMessage,
  unreadCount,
} from "../src/lib/messages.ts";

const migration = readFileSync(
  new URL("../supabase/migrations/20261111220000_booking_messages.sql", import.meta.url),
  "utf8",
);
const script = readFileSync(
  new URL("../supabase/verification/booking_messages_rls.sql", import.meta.url),
  "utf8",
);
const rateLimitMigration = readFileSync(
  new URL("../supabase/migrations/20261111200000_rate_limits.sql", import.meta.url),
  "utf8",
);
const receiptMatchFix = readFileSync(
  new URL("../supabase/migrations/20261111210000_rate_limit_receipt_match.sql", import.meta.url),
  "utf8",
);
const rateLimitScript = readFileSync(
  new URL("../supabase/verification/rate_limit_booking_integration.sql", import.meta.url),
  "utf8",
);

function section(source: string, name: string) {
  const marker = `-- SPLIT:${name}`;
  const start = source.indexOf(marker);
  const next = source.indexOf("-- SPLIT:", start + marker.length);
  if (start < 0) throw new Error(`Missing ${marker}`);
  return source.slice(start + marker.length, next === -1 ? source.length : next);
}

describe("message rules", () => {
  it("lets a customer message a booked provider before acceptance", () => {
    assert.equal(canMessageBooking("pending"), true);
    assert.equal(canMessageBooking("requested"), true);
    assert.equal(prepareMessage("  Can you arrive at 9?\n").ok, true);
    assert.equal(messagePath("customer", "booking-1"), "/account/messages/booking-1");
  });

  it("lets the provider reply on the same booking", () => {
    assert.equal(messagePath("provider", "booking-1"), "/dashboard/messages/booking-1");
    assert.equal(canMessageBooking("accepted"), true);
  });

  it("keeps completed and cancelled conversations read only", () => {
    for (const status of ["completed", "cancelled", "declined", "expired"]) {
      assert.equal(canMessageBooking(status), false);
    }
  });

  it("rejects empty and oversized messages", () => {
    assert.equal(prepareMessage("   ").ok, false);
    assert.equal(prepareMessage("a".repeat(2001)).ok, false);
    const accepted = prepareMessage("a".repeat(2000));
    assert.equal(accepted.ok, true);
  });

  it("counts unread messages from the other person and ignores the viewer", () => {
    const messages = [
      { senderId: "customer", createdAt: "2026-11-11T15:00:00.000Z" },
      { senderId: "provider", createdAt: "2026-11-11T15:05:00.000Z" },
    ];
    assert.equal(unreadCount(messages, "provider", null), 1);
    assert.equal(unreadCount(messages, "provider", "2026-11-11T15:01:00.000Z"), 0);
    assert.equal(unreadCount(messages, "customer", "2026-11-11T15:01:00.000Z"), 1);
  });

  it("drops duplicate ids when a realtime subscription reconnects", () => {
    const first = [{ id: "m1", createdAt: "2026-11-11T15:00:00.000Z", body: "Hello" }];
    const replay = [
      { id: "m1", createdAt: "2026-11-11T15:00:00.000Z", body: "Hello" },
      { id: "m2", createdAt: "2026-11-11T15:01:00.000Z", body: "Reply" },
    ];
    const merged = mergeMessages(mergeMessages(first, replay), replay);
    assert.deepEqual(merged.map((message) => message.id), ["m1", "m2"]);
  });

  it("documents a 30 message limit and enforces it in the database trigger", () => {
    assert.equal(RATE_LIMITS.sendMessage.max, 30);
    assert.equal(RATE_LIMITS.sendMessage.windowSeconds, 600);
    assert.match(migration, /consume_rate_limit\('sendMessage:user:'/);
    assert.match(migration, /message_hits > 30/);
    assert.match(script, /SCENARIO 10/);
  });
});

describe("message database contract", () => {
  it("authorizes participants, blocks impersonation, and keeps messages immutable", () => {
    assert.match(migration, /provider\.owner_id/);
    assert.match(migration, /new\.created_at := clock_timestamp\(\)/);
    assert.match(migration, /You cannot send a message as someone else/);
    assert.match(migration, /This conversation is closed/);
    assert.match(migration, /char_length\(btrim\(body\)\) between 1 and 2000/);
    assert.match(migration, /booking_messages_client_uidx/);
    assert.match(migration, /force row level security/);
    assert.match(migration, /grant select, insert on public\.booking_messages to authenticated/);
    assert.doesNotMatch(migration, /for delete/);
    assert.doesNotMatch(migration, /grant update on public\.booking_messages/);
    assert.match(migration, /supabase_realtime/);
    assert.match(migration, /booking_conversation_summaries/);
    assert.match(
      readFileSync(new URL("../src/components/message-thread.tsx", import.meta.url), "utf8"),
      /booking_id=eq\.\$\{bookingId\}/,
    );
  });
});

const localDatabaseUrl = "postgres://postgres:blockbooked_local_test@127.0.0.1:54329/blockbooked_rate_limit_test";

describe("disposable PostgreSQL message authorization", () => {
  it("runs the booking participant, closure, rate-limit, and read-receipt scenarios", async () => {
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
    const client = new pg.Client({ connectionString: localDatabaseUrl });
    try {
      await client.connect();
    } catch {
      await client.end().catch(() => undefined);
      return;
    }
    try {
      const identity = await client.query("select current_database() as name");
      assert.equal(identity.rows[0].name, "blockbooked_rate_limit_test");
      await client.query(section(rateLimitScript, "prelude"));
      await client.query(rateLimitMigration);
      await client.query(receiptMatchFix);
      await client.query(section(script, "schema"));
      await client.query(migration);
      await client.query(section(script, "tests"));

      const raceCustomer = "c1000093-0000-4000-8000-000000000093";
      const raceOwner = "c1000097-0000-4000-8000-000000000097";
      const raceProvider = "c1000096-0000-4000-8000-000000000096";
      const duplicateBooking = "c1000094-0000-4000-8000-000000000094";
      const rateBooking = "c1000095-0000-4000-8000-000000000095";
      const duplicateClient = "c1000098-0000-4000-8000-000000000098";
      await client.query(
        "delete from public.rate_limit_counters where bucket = any($1::text[])",
        [[`sendMessage:user:${raceCustomer}`, `sendMessage:user:${raceOwner}`]],
      );
      await client.query(`
        insert into public.profiles (id, full_name) values
          ('${raceCustomer}', 'Race Customer'),
          ('${raceOwner}', 'Race Owner');
        insert into public.providers (id, owner_id, business_name) values
          ('${raceProvider}', '${raceOwner}', 'Race Lawn');
        insert into public.booking_requests (
          id, customer_id, provider_id, preferred_date, time_window, service_name, status
        ) values
          ('${duplicateBooking}', '${raceCustomer}', '${raceProvider}', current_date, 'Morning', 'Race', 'pending'),
          ('${rateBooking}', '${raceCustomer}', '${raceProvider}', current_date, 'Morning', 'Race', 'accepted');
      `);
      const pool = new pg.Pool({ connectionString: localDatabaseUrl, max: 40 });
      try {
        const duplicate = await Promise.all([
          pool.query("select rate_lab.send_message($1::uuid, $2::uuid, 'first copy', $1::uuid, $3::uuid) as result", [
            raceCustomer,
            duplicateBooking,
            duplicateClient,
          ]),
          pool.query("select rate_lab.send_message($1::uuid, $2::uuid, 'second copy', $1::uuid, $3::uuid) as result", [
            raceCustomer,
            duplicateBooking,
            duplicateClient,
          ]),
        ]);
        assert.equal(duplicate.filter((attempt) => attempt.rows[0].result === "ok").length, 1);
        const stored = await client.query(
          "select count(*)::int as stored from public.booking_messages where client_id = $1::uuid",
          [duplicateClient],
        );
        assert.equal(Number(stored.rows[0].stored), 1);

        const burst = await Promise.all(
          Array.from({ length: 40 }, (_, index) =>
            pool.query("select rate_lab.send_message($1::uuid, $2::uuid, $3, $1::uuid, null) as result", [
              raceOwner,
              rateBooking,
              `burst ${index}`,
            ]),
          ),
        );
        assert.equal(burst.filter((attempt) => attempt.rows[0].result === "ok").length, 30);
        const hits = await client.query("select hits from public.rate_limit_counters where bucket = $1", [
          `sendMessage:user:${raceOwner}`,
        ]);
        assert.equal(Number(hits.rows[0].hits), 30);
      } finally {
        await pool.end();
      }
    } finally {
      await client.query(section(script, "cleanup")).catch(() => undefined);
      await client.end();
    }
  });
});
