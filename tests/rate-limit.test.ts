import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  RATE_LIMITS,
  RATE_LIMIT_MESSAGE,
  advanceRateLimit,
  openRateLimit,
  rateLimitBucket,
  claimRateReceipt,
  rejectedAttemptKeepsStoredHits,
  trustedClientAddress,
} from "../src/lib/rate-limit-decision.ts";

const migration = readFileSync(new URL("../supabase/migrations/20261111200000_rate_limits.sql", import.meta.url), "utf8");
const limiter = readFileSync(new URL("../src/lib/rate-limit.ts", import.meta.url), "utf8");
const webhook = readFileSync(new URL("../src/app/api/stripe/webhook/route.ts", import.meta.url), "utf8");
const cron = readFileSync(new URL("../src/app/api/cron/expire-bookings/route.ts", import.meta.url), "utf8");
const bookings = readFileSync(new URL("../src/app/actions/bookings.ts", import.meta.url), "utf8");
const payments = readFileSync(new URL("../src/app/actions/payments.ts", import.meta.url), "utf8");
const auth = readFileSync(new URL("../src/app/actions/auth.ts", import.meta.url), "utf8");
const pinMigration = readFileSync(new URL("../supabase/migrations/20261110200000_pin_lockout.sql", import.meta.url), "utf8");
const checkout = readFileSync(new URL("../src/lib/payments/service.ts", import.meta.url), "utf8");

function lockedAttempts(count: number, nowMs: number, limit: number, windowMs: number) {
  let state: { hits: number; windowStartMs: number } | null = null;
  const allowed: boolean[] = [];
  for (let index = 0; index < count; index += 1) {
    const next = state
      ? advanceRateLimit({ hits: state.hits, windowStartMs: state.windowStartMs, nowMs, limit, windowMs })
      : openRateLimit(nowMs, limit);
    state = next;
    allowed.push(next.allowed);
  }
  return allowed;
}

describe("rate limit decisions", () => {
  it("allows a checkout retry and then stops at the shared limit", () => {
    const spec = RATE_LIMITS.checkout;
    const windowMs = spec.windowSeconds * 1000;
    const results = lockedAttempts(spec.max + 2, 1_000, spec.max, windowMs);
    assert.equal(results.filter(Boolean).length, spec.max);
    assert.equal(results.at(-1), false);
    assert.equal(spec.max >= 5, true);
    assert.equal(RATE_LIMIT_MESSAGE.includes("Too many attempts"), true);
  });

  it("resets the counter when the window has elapsed", () => {
    const first = openRateLimit(0, 2);
    const second = advanceRateLimit({ hits: first.hits, windowStartMs: first.windowStartMs, nowMs: 1_000, limit: 2, windowMs: 10_000 });
    const blocked = advanceRateLimit({ hits: second.hits, windowStartMs: second.windowStartMs, nowMs: 2_000, limit: 2, windowMs: 10_000 });
    const reset = advanceRateLimit({ hits: blocked.hits, windowStartMs: blocked.windowStartMs, nowMs: 12_000, limit: 2, windowMs: 10_000 });
    assert.equal(blocked.allowed, false);
    assert.deepEqual(reset, { hits: 1, windowStartMs: 12_000, allowed: true });
  });

  it("keeps concurrent requests on one counter instead of giving each request a fresh count", () => {
    const limit = RATE_LIMITS.checkout.max;
    const locked = lockedAttempts(20, 5_000, limit, 10 * 60 * 1000);
    const raced = Array.from({ length: 20 }, () => openRateLimit(5_000, limit).allowed);
    assert.equal(locked.filter(Boolean).length, limit);
    assert.equal(raced.filter(Boolean).length, 20);
  });

  it("separates users and ignores a spoofed forwarding header", () => {
    const customer = rateLimitBucket("checkout", "user:11111111-1111-1111-1111-111111111111");
    const other = rateLimitBucket("checkout", "user:22222222-2222-2222-2222-222222222222");
    assert.notEqual(customer, other);
    assert.equal(customer.startsWith("checkout:"), true);
    assert.equal(rateLimitBucket("checkout", "user:abc/../sign-in"), "checkout:user:abc..sign-in");
    const headers = {
      get(name: string) {
        if (name === "x-forwarded-for") return "198.51.100.4, 203.0.113.9";
        if (name === "x-vercel-forwarded-for") return "203.0.113.9";
        if (name === "x-real-ip") return "203.0.113.8";
        return null;
      },
    };
    assert.equal(trustedClientAddress(headers, true), "203.0.113.9");
    assert.equal(trustedClientAddress(headers, false), null);
    assert.equal(
      trustedClientAddress({ get: (name) => (name === "x-real-ip" ? "203.0.113.8" : null) }, true),
      "203.0.113.8",
    );
    assert.equal(
      trustedClientAddress({ get: (name) => (name === "x-forwarded-for" ? "198.51.100.4" : null) }, true),
      null,
    );
  });

  it("claims only the matching single-use receipt when two requests run together", () => {
    const receipts = [
      { id: "receipt-a", actor: "user-a", operation: "createBooking" },
      { id: "receipt-b", actor: "user-b", operation: "createBooking" },
    ];
    const first = claimRateReceipt(receipts, "receipt-a", "user-a", "createBooking");
    const second = claimRateReceipt(first.receipts, "receipt-b", "user-b", "createBooking");
    const stolen = claimRateReceipt(receipts, "receipt-a", "user-b", "createBooking");
    const replay = claimRateReceipt(first.receipts, "receipt-a", "user-a", "createBooking");
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, true);
    assert.equal(second.receipts.length, 0);
    assert.equal(stolen.claimed, false);
    assert.equal(stolen.receipts.length, 2);
    assert.equal(replay.claimed, false);
  });

  it("keeps a rejected database attempt at the stored limit instead of erasing it", () => {
    const denied = rejectedAttemptKeepsStoredHits(10, 10);
    assert.deepEqual(denied, { storedHits: 10, allowed: false });
    assert.equal(rejectedAttemptKeepsStoredHits(denied.storedHits, 10).allowed, false);
    assert.equal(rejectedAttemptKeepsStoredHits(9, 10).allowed, true);
  });
});

describe("rate limit enforcement", () => {
  it("stores the counter in Postgres and fails closed when the store cannot be checked", () => {
    assert.match(migration, /on conflict \(bucket\) do update/i);
    assert.match(migration, /counter\.hits \+ 1|rate_limit_counters\.hits \+ 1/);
    assert.match(migration, /auth\.role\(\), ''\) is distinct from 'authenticated'/);
    assert.match(migration, /revoke all on function public\.consume_rate_limit/);
    assert.match(migration, /complete_booking_with_pin_locked/);
    assert.match(migration, /return 'rate_limited'/);
    assert.match(migration, /blockbooked\.pin_verified/);
    assert.match(migration, /issue_booking_rate_receipt/);
    assert.match(migration, /receipt_row\.actor = actor/);
    assert.match(migration, /interval '2 days'/);
    assert.match(migration, /purge_stale_rate_limits/);
    assert.match(migration, /update of status/);
    assert.doesNotMatch(migration, /prepaid_until|mark_prepaid/);
    assert.doesNotMatch(migration, /drop function public\.complete_booking_with_pin/i);
    assert.match(migration, /revoke all on function public\.complete_booking_with_pin_locked\(uuid, text\) from public, anon, authenticated/);
    assert.match(migration, /revoke all on function public\.complete_booking_with_pin_locked\(uuid, text\) from service_role/);
    assert.match(migration, /revoke all on function public\.complete_booking_with_pin\(uuid, text\) from service_role/);
    const pinCount = migration.indexOf("completionPin:user:");
    const pinCall = migration.indexOf("return public.complete_booking_with_pin_locked(target_booking, submitted_pin)");
    assert.equal(pinCount >= 0 && pinCount < pinCall, true);
    assert.doesNotMatch(migration, /when others/i);
    assert.match(migration, /rolls back with it/);
    assert.match(pinMigration, /return 'invalid_format'/);
    assert.match(pinMigration, /return 'incorrect:/);
    const migrationLines = migration.split(/\r?\n/).map((line) => line.trim());
    assert.equal(migrationLines.filter((line) => line === "security definer").length, 5);
    assert.equal(migrationLines.filter((line) => line.startsWith("set search_path = public")).length, 5);
    const authenticatedGrants = migration.match(/grant execute on function[^\n]+/gi) ?? [];
    assert.deepEqual(
      authenticatedGrants.filter((grant) => /authenticated/i.test(grant)),
      ["grant execute on function public.complete_booking_with_pin(uuid, text) to authenticated;"],
    );
    assert.equal(authenticatedGrants.some((grant) => / to public| to anon/i.test(grant)), false);
    assert.doesNotMatch(migration, /```/);
    assert.doesNotMatch(migration, /crypt\(/);
    assert.match(pinMigration, />= 5/);
    assert.match(pinMigration, /15 minutes/);
    assert.match(limiter, /RATE_LIMIT_UNAVAILABLE/);
    assert.doesNotMatch(limiter, /new Map/);
    assert.match(limiter, /process\.env\.VERCEL === "1"/);
    assert.doesNotMatch(limiter, /x-forwarded-for/);
  });

  it("protects booking, payment, quote, and login actions without limiting Stripe or cron", () => {
    const createLimit = bookings.indexOf('reserveBookingRateLimit("createBooking"');
    const createInsert = bookings.indexOf('.from("booking_requests")\n    .insert(');
    const statusLimit = bookings.indexOf('reserveBookingRateLimit("bookingStatus"');
    const statusUpdate = bookings.indexOf(".update({ status: nextStatus, rate_limit_receipt: statusReceipt })");
    const checkoutLimit = bookings.indexOf('redirectIfRateLimited("checkout"');
    const checkoutStart = bookings.indexOf("startCheckout(");
    assert.equal(createLimit >= 0 && createLimit < createInsert, true);
    assert.equal(statusLimit >= 0 && statusLimit < statusUpdate, true);
    assert.equal(checkoutLimit >= 0 && checkoutLimit < checkoutStart, true);
    assert.match(bookings, /redirectIfRateLimited\("checkout"/);
    assert.match(checkout, /idempotencyKey: `checkout_\$\{paymentId\}`/);
    assert.match(checkout, /idempotencyKey: `checkout_retry_\$\{payment\.id\}_\$\{payment\.checkout_session_id \?\? "new"\}`/);
    assert.match(migration, /createBooking:user:/);
    assert.match(migration, /bookingStatus:user:/);
    assert.match(migration, /completionPin:user:/);
    assert.match(payments, /redirectIfRateLimited\("checkout"/);
    assert.match(payments, /redirectIfRateLimited\("sendQuote"/);
    assert.match(payments, /redirectIfRateLimited\("milestones"/);
    assert.match(auth, /redirectIfIpRateLimited\("sign-in"/);
    assert.match(auth, /redirectIfIpRateLimited\("sign-up"/);
    assert.doesNotMatch(webhook, /rate-limit|consume_rate_limit/);
    assert.doesNotMatch(cron, /rate-limit|consume_rate_limit/);
    assert.match(webhook, /stripe-signature/);
    assert.match(cron, /CRON_SECRET/);
    assert.match(cron, /purge_stale_rate_limits/);
    assert.match(bookings, /rate_limit_receipt: bookingReceipt/);
    assert.match(bookings, /rpc\("complete_booking_with_pin"/);
  });
});
