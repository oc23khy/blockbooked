import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ACCEPTED_CANCELLATION_BLOCKED,
  ACCEPTED_CANCELLATION_NOTICE_MS,
  acceptedCancellationDecision,
  customerCanCancel,
  refundableCancellationPayments,
} from "../src/lib/booking-status.ts";

const migration = readFileSync(
  new URL("../supabase/migrations/20261116010000_accepted_cancellation.sql", import.meta.url),
  "utf8",
);
const action = readFileSync(new URL("../src/app/actions/bookings.ts", import.meta.url), "utf8");
const card = readFileSync(new URL("../src/components/booking-card.tsx", import.meta.url), "utf8");
const now = Date.parse("2026-11-16T12:00:00.000Z");
const day = ACCEPTED_CANCELLATION_NOTICE_MS;

function decision(overrides: Partial<Parameters<typeof acceptedCancellationDecision>[0]> = {}) {
  return acceptedCancellationDecision({
    isBookingOwner: true,
    currentStatus: "accepted",
    appointmentStatus: "confirmed",
    startsAt: new Date(now + day).toISOString(),
    nowMs: now,
    ...overrides,
  });
}

describe("accepted cancellation window", () => {
  it("allows a confirmed appointment at or beyond 24 hours and blocks a closer one", () => {
    assert.equal(decision(), "full_refund");
    assert.equal(decision({ startsAt: new Date(now + day + 60_000).toISOString() }), "full_refund");
    assert.equal(decision({ startsAt: new Date(now + day - 1).toISOString() }), "too_soon");
    assert.equal(customerCanCancel("pending"), true);
    assert.equal(customerCanCancel("accepted"), false);
  });

  it("rejects a missing appointment, a held quote, and a different customer", () => {
    assert.equal(decision({ appointmentStatus: null, startsAt: null }), "unavailable");
    assert.equal(decision({ appointmentStatus: "held" }), "unavailable");
    assert.equal(decision({ appointmentStatus: "released" }), "unavailable");
    assert.equal(decision({ isBookingOwner: false }), "unavailable");
    assert.equal(decision({ currentStatus: "cancelled" }), "unavailable");
    assert.equal(decision({ currentStatus: "pending" }), "unavailable");
  });
});

describe("cancellation refunds", () => {
  it("refunds every remaining succeeded payment once", () => {
    const payments = refundableCancellationPayments([
      { id: "paid", status: "succeeded", amount_cents: 5000, refunded_cents: 0 },
      { id: "milestone", status: "succeeded", amount_cents: 2000, refunded_cents: 0 },
      { id: "partial", status: "partially_refunded", amount_cents: 5000, refunded_cents: 1000 },
      { id: "settled", status: "succeeded", amount_cents: 5000, refunded_cents: 5000 },
      { id: "done", status: "refunded", amount_cents: 5000, refunded_cents: 5000 },
    ]);
    assert.deepEqual(payments.map((payment) => payment.id), ["paid", "milestone", "partial"]);
  });

  it("keeps the existing refund failure and idempotent refund path", () => {
    const status = action.slice(action.indexOf("export async function updateBookingStatus"), action.indexOf("export async function submitCompletionPin"));
    assert.ok(status.indexOf("acceptedCancellationDecision") < status.indexOf(".update("));
    assert.equal(status.includes('formData.get("startsAt")'), false);
    assert.equal(status.includes('formData.get("refund")'), false);
    assert.match(status, /refundableCancellationPayments/);
    assert.match(status, /requestRefund\(/);
    assert.match(status, /The booking was updated, but the refund was not confirmed/);
    assert.match(status, /Stripe has not confirmed the refund yet/);
  });
});

describe("accepted cancellation enforcement", () => {
  it("uses the database clock, the booking owner, and a confirmed appointment", () => {
    assert.match(migration, /old\.customer_id = auth\.uid\(\)/);
    assert.match(migration, /appointment\.status = 'confirmed'/);
    assert.match(migration, /appointment_start >= now\(\) \+ interval '24 hours'/);
    assert.match(migration, /for update/);
    assert.match(migration, new RegExp(ACCEPTED_CANCELLATION_BLOCKED.replace(/[.]/g, "\\.")));
    assert.match(migration, /old\.status in \('pending', 'requested'\) and requested_status = 'cancelled'/);
    assert.doesNotMatch(migration, /formData|startsAt|refund amount/i);
    assert.match(card, /Cancel booking — full refund/);
    assert.match(card, /Cancel request/);
    assert.match(card, /acceptedCancellationDecision/);
  });
});
