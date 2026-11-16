import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import http from "node:http";
import https from "node:https";
import { describe, it } from "node:test";
import { assertConnectedLocalDatabase, assertDisposableDatabaseUrl } from "./integration-guard.ts";

process.env.BLOCKBOOKED_BOOKING_TEST_CONFIRM = "local-disposable";
const databaseUrl = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const target = assertDisposableDatabaseUrl(databaseUrl, "https://example.supabase.co");
const customer = "d3000001-0000-4000-8000-0000000000d1";
const owner = "d3000002-0000-4000-8000-0000000000d2";
const admin = "d3000003-0000-4000-8000-0000000000d3";
const provider = "d3000004-0000-4000-8000-0000000000d4";
const service = "d3000005-0000-4000-8000-0000000000d5";
const eventId = "evt_local_webhook_idempotency";
const sessionId = "cs_local_webhook_idempotency";
const intentId = "pi_local_webhook_idempotency";
const webhookSecret = "whsec_local_only_webhook_idempotency";
const outbound = [];

function localStatus() {
  const result = spawnSync("npx.cmd", ["supabase", "status", "-o", "env"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    shell: true,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error("Local Supabase status could not be read.");
  const values = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
    if (match) values[match[1]] = match[2];
  }
  const api = new URL(values.API_URL ?? "http://invalid");
  if (api.hostname !== "127.0.0.1" || api.port !== "54321") {
    throw new Error("Refusing a Supabase API URL that is not the local stack.");
  }
  if (!values.SERVICE_ROLE_KEY || !values.ANON_KEY) throw new Error("Local Supabase keys are missing.");
  return { apiUrl: api.origin, serviceRoleKey: values.SERVICE_ROLE_KEY, anonKey: values.ANON_KEY };
}

function hostOf(input, options) {
  if (typeof input === "string") return new URL(input).hostname;
  if (input instanceof URL) return input.hostname;
  const value = input?.hostname || input?.host || options?.hostname || options?.host || "";
  return String(value).replace(/:\d+$/, "");
}

function pathOf(input, options) {
  if (typeof input === "string") return new URL(input).pathname;
  if (input instanceof URL) return input.pathname;
  return String(input?.path || options?.path || "/").split("?")[0];
}

function installOutboundGuard() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const raw = typeof input === "string" || input instanceof URL ? input : input.url;
    const url = new URL(raw);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      const method = (init?.method || (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET")).toUpperCase();
      outbound.push({ host: url.hostname, method, path: url.pathname });
      throw new Error(`Refusing outbound ${method} ${url.hostname}${url.pathname}`);
    }
    return originalFetch(input, init);
  };
  for (const mod of [http, https]) {
    const original = mod.request;
    mod.request = function guarded(input, options, callback) {
      const host = hostOf(input, typeof input === "object" ? input : options);
      if (host && host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
        const method = String((typeof input === "object" ? input.method : options?.method) || "GET").toUpperCase();
        const requestPath = pathOf(input, typeof input === "object" ? input : options);
        outbound.push({ host, method, path: requestPath });
        throw new Error(`Refusing outbound ${method} ${host}${requestPath}`);
      }
      return original.call(this, input, options, callback);
    };
  }
}

function clientFor() {
  const require = createRequire(import.meta.url);
  const { Client } = require("pg");
  return new Client({ connectionString: databaseUrl });
}

async function asDatabaseOwner(client) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claim.sub', '', false)");
  await client.query("select set_config('request.jwt.claim.role', '', false)");
  await client.query("select set_config('request.jwt.claims', '', false)");
}

async function asAuthenticated(client, userId) {
  await asDatabaseOwner(client);
  await client.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await client.query("select set_config('request.jwt.claim.role', 'authenticated', false)");
  await client.query(
    "select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, false)",
    [userId],
  );
  await client.query("set role authenticated");
}

async function snapshot(client, bookingId) {
  const result = await client.query(
    `select
       (select status::text from public.booking_requests where id = $1) as booking_status,
       (select status::text from public.payments where booking_id = $1) as payment_status,
       (select count(*)::int from public.payments where booking_id = $1) as payments,
       (select count(*)::int from public.booking_appointments where booking_id = $1) as appointments,
       (select count(*)::int from public.booking_appointments where booking_id = $1 and status = 'held') as held,
       (select count(*)::int from public.booking_appointments where booking_id = $1 and status = 'released') as released,
       (select count(*)::int from public.refunds where booking_id = $1) as refunds,
       (select count(*)::int from public.refunds where booking_id = $1 and status = 'succeeded') as succeeded_refunds,
       (select coalesce(sum(amount_cents), 0)::int from public.refunds where booking_id = $1 and status = 'succeeded') as refunded_amount,
       (select count(*)::int from public.stripe_events where event_id = $2) as events,
       (select status::text from public.stripe_events where event_id = $2) as event_status,
       (select count(*)::int from public.ledger_entries where booking_id = $1 and entry_type = 'payment_succeeded') as payment_ledgers`,
    [bookingId, eventId],
  );
  return result.rows[0];
}

async function cleanup(client) {
  await asDatabaseOwner(client);
  await client.query("begin");
  try {
    await client.query("alter table public.booking_appointments disable trigger booking_appointments_guard");
    await client.query("delete from public.payment_extra_charges where booking_id in (select id from public.booking_requests where customer_id = $1)", [customer]);
    await client.query("delete from public.ledger_entries where booking_id in (select id from public.booking_requests where customer_id = $1)", [customer]);
    await client.query("delete from public.refunds where booking_id in (select id from public.booking_requests where customer_id = $1)", [customer]);
    await client.query("delete from public.payments where customer_id = $1 and provider_id = $2", [customer, provider]);
    await client.query("delete from public.booking_appointments where provider_id = $1", [provider]);
    await client.query("delete from public.booking_requests where customer_id = $1", [customer]);
    await client.query("delete from public.stripe_events where event_id = $1", [eventId]);
    await client.query("delete from public.provider_services where id = $1", [service]);
    await client.query("delete from public.provider_business_hours where provider_id = $1", [provider]);
    await client.query("delete from public.provider_schedule_settings where provider_id = $1", [provider]);
    await client.query("delete from public.providers where id = $1", [provider]);
    await client.query("delete from auth.users where id in ($1, $2, $3)", [customer, owner, admin]);
    await client.query(
      "delete from public.rate_limit_counters where bucket in ($1, $2, $3, $4)",
      [`createBooking:user:${customer}`, `bookingStatus:user:${customer}`, `createBooking:user:${owner}`, `bookingStatus:user:${owner}`],
    );
    await client.query(
      "delete from public.rate_limit_receipts where actor in ($1, $2, $3) and operation in ('createBooking', 'bookingStatus')",
      [customer, owner, admin],
    );
    await client.query("alter table public.booking_appointments enable trigger booking_appointments_guard");
    const trigger = await client.query(
      "select tgenabled::text as enabled from pg_trigger where tgname = 'booking_appointments_guard' and not tgisinternal",
    );
    const left = await client.query(
      `select
         (select count(*)::int from auth.users where id in ($1, $2, $3)) as users,
         (select count(*)::int from public.booking_requests where customer_id = $1) as bookings,
         (select count(*)::int from public.payments where customer_id = $1) as payments,
         (select count(*)::int from public.stripe_events where event_id = $4) as events`,
      [customer, owner, admin, eventId],
    );
    if (trigger.rows[0]?.enabled !== "O" || left.rows[0].users !== 0 || left.rows[0].bookings !== 0 || left.rows[0].payments !== 0 || left.rows[0].events !== 0) {
      throw new Error("Webhook fixture cleanup did not restore the local database.");
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

describe("local webhook idempotency", () => {
  it("processes one signed checkout event once and ignores the same delivery after refund", async () => {
    const local = localStatus();
    process.env.NEXT_PUBLIC_SUPABASE_URL = local.apiUrl;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = local.anonKey;
    process.env.SUPABASE_SERVICE_ROLE_KEY = local.serviceRoleKey;
    process.env.STRIPE_SECRET_KEY = "sk_test_local_webhook_idempotency_not_a_real_key";
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
    process.env.NOTIFICATIONS_ENABLED = "false";
    delete process.env.RESEND_API_KEY;
    installOutboundGuard();

    const client = clientFor();
    await client.connect();
    let bookingId = "";
    let paymentId = "";
    try {
      const identity = await client.query("select current_database() as name, inet_server_addr()::text as addr");
      const history = await client.query("select version from supabase_migrations.schema_migrations order by version");
      assertConnectedLocalDatabase({
        expectedDatabase: target.database,
        currentDatabase: String(identity.rows[0].name),
        serverAddress: identity.rows[0].addr == null ? null : String(identity.rows[0].addr),
        migrations: history.rows.map((row) => String(row.version)),
      });
      const settings = await client.query(
        "select key, value::text as value from public.platform_settings where key like 'booking_maintenance%' order by key",
      );
      const setting = Object.fromEntries(settings.rows.map((row) => [row.key, row.value]));
      assert.equal(setting.booking_maintenance, "false");
      assert.equal(setting.booking_maintenance_allowlist, "[]");
      const before = await client.query(
        "select (select count(*)::int from auth.users) as users, (select count(*)::int from public.booking_requests) as bookings, (select count(*)::int from public.payments) as payments",
      );
      assert.deepEqual(before.rows[0], { users: 0, bookings: 0, payments: 0 });

      const route = await import("../src/app/api/stripe/webhook/route.ts");
      const require = createRequire(import.meta.url);
      const Stripe = require("stripe");

      for (const [id, email] of [
        [customer, "webhook-customer@example.com"],
        [owner, "webhook-owner@example.com"],
        [admin, "webhook-admin@example.com"],
      ]) {
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
        "insert into public.providers (id, owner_id, business_name, category_id, service_areas) values ($1, $2, 'Webhook Check', 'cleaners', array['Roselle'])",
        [provider, owner],
      );
      await asAuthenticated(client, admin);
      await client.query("update public.providers set status = 'approved', review_note = null where id = $1", [provider]);
      await asAuthenticated(client, owner);
      await client.query(
        "insert into public.provider_services (id, provider_id, name, pricing_type, price_cents, duration_minutes) values ($1, $2, 'Visit', 'fixed', 5000, 60)",
        [service, provider],
      );
      await client.query(
        "insert into public.provider_schedule_settings (provider_id, min_notice_minutes, max_advance_days, buffer_minutes) values ($1, 0, 60, 0)",
        [provider],
      );
      for (let weekday = 0; weekday < 7; weekday += 1) {
        await client.query(
          "insert into public.provider_business_hours (provider_id, weekday, opens_minute, closes_minute) values ($1, $2, 0, 1440)",
          [provider, weekday],
        );
      }
      await asAuthenticated(client, customer);
      const booking = await client.query(
        `insert into public.booking_requests (customer_id, provider_id, preferred_date, time_window, contact_phone, service_name, status)
         values ($1, $2, current_date, 'Afternoon', '5555550100', 'Visit', 'pending') returning id`,
        [customer, provider],
      );
      bookingId = booking.rows[0].id;
      await client.query(
        `insert into public.booking_appointments (booking_id, provider_id, service_id, starts_at, ends_at)
         values (
           $1, $2, $3,
           ((date_trunc('day', now() at time zone 'America/Chicago') + interval '2 days' + make_interval(hours => 8)) at time zone 'America/Chicago'),
           ((date_trunc('day', now() at time zone 'America/Chicago') + interval '2 days' + make_interval(hours => 9)) at time zone 'America/Chicago')
         )`,
        [bookingId, provider, service],
      );
      await asDatabaseOwner(client);
      const payment = await client.query(
        `insert into public.payments (
           booking_id, customer_id, provider_id, amount_cents, commission_bps, commission_cents, provider_share_cents, fee_bearer, status, checkout_session_id
         ) values ($1, $2, $3, 5000, 800, 400, 4600, 'platform', 'requires_payment', $4) returning id`,
        [bookingId, customer, provider, sessionId],
      );
      paymentId = payment.rows[0].id;

      const payload = JSON.stringify({
        id: eventId,
        object: "event",
        api_version: "2026-10-28.endive",
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId,
            object: "checkout.session",
            amount_total: 5000,
            currency: "usd",
            payment_status: "paid",
            payment_intent: intentId,
            livemode: false,
            metadata: { payment_id: paymentId, booking_id: bookingId, provider_id: provider },
          },
        },
      });
      const signer = new Stripe("sk_test_local_webhook_idempotency_not_a_real_key");
      const signature = signer.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
      const deliver = () => route.POST(new Request("http://127.0.0.1/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": signature, "content-type": "application/json" },
        body: payload,
      }));

      const first = await deliver();
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), { received: true });
      const paid = await snapshot(client, bookingId);
      assert.equal(paid.payment_status, "succeeded");
      assert.equal(paid.booking_status, "pending");
      assert.deepEqual(
        [paid.payments, paid.appointments, paid.held, paid.released, paid.refunds, paid.events, paid.event_status, paid.payment_ledgers],
        [1, 1, 1, 0, 0, 1, "processed", 1],
      );

      const second = await deliver();
      assert.equal(second.status, 200);
      const replayed = await snapshot(client, bookingId);
      assert.deepEqual(replayed, paid);

      await asAuthenticated(client, customer);
      await client.query("update public.booking_requests set status = 'cancelled' where id = $1 and status = 'pending'", [bookingId]);
      await asDatabaseOwner(client);
      await client.query(
        `insert into public.refunds (
           payment_id, booking_id, amount_cents, commission_reversal_cents, provider_reversal_cents, status, reason, stripe_refund_id, requested_by, confirmed_at
         ) values ($1, $2, 5000, 400, 4600, 'succeeded', 'customer_cancelled', 're_local_webhook_idempotency', $3, now())`,
        [paymentId, bookingId, customer],
      );
      await client.query(
        "update public.payments set status = 'refunded', refunded_cents = amount_cents where id = $1 and status = 'succeeded'",
        [paymentId],
      );
      const settled = await snapshot(client, bookingId);
      assert.equal(settled.booking_status, "cancelled");
      assert.equal(settled.payment_status, "refunded");
      assert.equal(settled.held, 0);
      assert.equal(settled.released, 1);
      assert.equal(settled.succeeded_refunds, 1);
      assert.equal(settled.refunded_amount, 5000);

      const third = await deliver();
      assert.equal(third.status, 200);
      const afterRefund = await snapshot(client, bookingId);
      assert.deepEqual(afterRefund, settled);
      assert.equal(outbound.some((call) => call.path.includes("/refunds") || call.method === "POST"), false);

      const restored = await client.query(
        "select key, value::text as value from public.platform_settings where key like 'booking_maintenance%' order by key",
      );
      const restoredMap = Object.fromEntries(restored.rows.map((row) => [row.key, row.value]));
      assert.deepEqual(restoredMap, setting);
    } finally {
      await asDatabaseOwner(client);
      await cleanup(client);
      await client.end();
    }
  });
});
