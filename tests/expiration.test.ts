import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { accountPaymentNotice } from "../src/lib/payments/account-notice.ts";
import { recordedRefundCoverage } from "../src/lib/payments/guards.ts";
import { releaseVisit } from "../src/lib/scheduling/rules.ts";
import {
  ACCEPTANCE_WINDOW_MS,
  acceptanceDeadline,
  claimExpired,
  displayedDeadline,
  earlierDeadline,
  expirationRefundPlan,
  expirationRpcBookingId,
  resolvePendingRace,
} from "../src/lib/scheduling/expiration.ts";
import { priceAdjustmentRequired, rescheduleDecision, withoutOwnHold } from "../src/lib/scheduling/reschedule.ts";

const migration = readFileSync(
  new URL("../supabase/migrations/20261110270000_expiration_reschedule.sql", import.meta.url),
  "utf8",
);
const rescheduleFix = readFileSync(
  new URL("../supabase/migrations/20261110280000_reschedule_booking_id.sql", import.meta.url),
  "utf8",
);
const expirationFix = readFileSync(
  new URL("../supabase/migrations/20261110290000_expiration_booking_id.sql", import.meta.url),
  "utf8",
);

describe("acceptance deadline", () => {
  it("expires 24 hours after the request or when the appointment starts, whichever is sooner", () => {
    const created = new Date("2026-11-10T15:00:00Z");
    const soon = new Date("2026-11-10T20:00:00Z");
    const later = new Date("2026-11-12T15:00:00Z");
    assert.equal(acceptanceDeadline(created, soon).toISOString(), soon.toISOString());
    assert.equal(acceptanceDeadline(created, later).toISOString(), new Date(created.getTime() + ACCEPTANCE_WINDOW_MS).toISOString());
    assert.equal(acceptanceDeadline(created, null).toISOString(), new Date(created.getTime() + ACCEPTANCE_WINDOW_MS).toISOString());
    assert.equal(earlierDeadline(new Date(created.getTime() + ACCEPTANCE_WINDOW_MS).toISOString(), soon.toISOString()), soon.toISOString());
  });
});

describe("expiration concurrency", () => {
  it("claims a due pending booking once and leaves accepted bookings alone", () => {
    const rows = [
      { id: "due", status: "pending", deadline: Date.parse("2026-11-10T12:00:00Z") },
      { id: "waiting", status: "pending", deadline: Date.parse("2026-11-11T12:00:00Z") },
      { id: "kept", status: "accepted", deadline: Date.parse("2026-11-10T12:00:00Z") },
      { id: "done", status: "completed", deadline: Date.parse("2026-11-10T12:00:00Z") },
      { id: "cancelled", status: "cancelled", deadline: Date.parse("2026-11-10T12:00:00Z") },
    ];
    const now = Date.parse("2026-11-10T18:00:00Z");
    assert.deepEqual(claimExpired(rows, now), ["due"]);
    assert.deepEqual(claimExpired(rows, now), []);
    assert.equal(rows.find((row) => row.id === "kept")?.status, "accepted");
    assert.equal(rows.find((row) => row.id === "done")?.status, "completed");
  });

  it("does not expire existing pending bookings during their rollout grace", () => {
    const now = Date.parse("2026-11-10T18:00:00Z");
    const rows = [
      {
        id: "existing",
        status: "pending",
        deadline: Date.parse("2026-11-11T18:00:00Z"),
        appointmentStart: Date.parse("2026-11-10T12:00:00Z"),
        grace: true,
      },
      {
        id: "new-past-start",
        status: "pending",
        deadline: Date.parse("2026-11-11T18:00:00Z"),
        appointmentStart: Date.parse("2026-11-10T12:00:00Z"),
        grace: false,
      },
      {
        id: "being-accepted",
        status: "pending",
        deadline: Date.parse("2026-11-10T12:00:00Z"),
        locked: true,
      },
    ];
    assert.deepEqual(claimExpired(rows, now), ["new-past-start"]);
    assert.equal(rows.find((row) => row.id === "existing")?.status, "pending");
    assert.equal(rows.find((row) => row.id === "being-accepted")?.status, "pending");
    assert.equal(
      displayedDeadline(new Date(rows[0].deadline).toISOString(), new Date(rows[0].appointmentStart).toISOString(), true),
      new Date(rows[0].deadline).toISOString(),
    );
  });

  it("lets acceptance and expiration settle on one winner", () => {
    const acceptedFirst = resolvePendingRace("accept", "expire");
    const expiredFirst = resolvePendingRace("expire", "accept");
    assert.deepEqual(acceptedFirst, { status: "accepted", firstApplied: true, secondApplied: false });
    assert.deepEqual(expiredFirst, { status: "expired", firstApplied: true, secondApplied: false });
  });

  it("releases an expired hold and keeps the original time until a replacement is approved", () => {
    const visits = [
      { id: "booking", start: 10, end: 20, bufferMinutes: 0 },
      { id: "other", start: 30, end: 40, bufferMinutes: 0 },
    ];
    assert.equal(releaseVisit(visits, "booking", "expired").some((visit) => visit.id === "booking"), false);
    assert.equal(releaseVisit(visits, "booking", "accepted").some((visit) => visit.id === "booking"), true);
  });
});

describe("reschedule price and availability", () => {
  it("preserves the payment when the price is unchanged and flags a difference without charging it", () => {
    assert.equal(priceAdjustmentRequired(5000, 5000), false);
    assert.equal(priceAdjustmentRequired(5000, 8000), true);
    assert.equal(priceAdjustmentRequired(null, null), false);
  });

  it("approves only a move to the requested time and keeps the original when the slot conflicts", () => {
    assert.deepEqual(
      rescheduleDecision({
        ownsProvider: true,
        bookingStatus: "accepted",
        requestStatus: "pending",
        conflict: false,
        movedToRequest: true,
      }),
      { result: "approved", requestStatus: "approved", appointmentMoved: true },
    );
    assert.deepEqual(
      rescheduleDecision({
        ownsProvider: true,
        bookingStatus: "accepted",
        requestStatus: "pending",
        conflict: true,
        movedToRequest: false,
      }),
      { result: "conflict", requestStatus: "pending", appointmentMoved: false },
    );
    assert.equal(
      rescheduleDecision({
        ownsProvider: false,
        bookingStatus: "accepted",
        requestStatus: "pending",
        conflict: false,
        movedToRequest: true,
      }).result,
      "forbidden",
    );
    assert.equal(
      rescheduleDecision({
        ownsProvider: true,
        bookingStatus: "pending",
        requestStatus: "pending",
        conflict: false,
        movedToRequest: true,
      }).result,
      "not_accepted",
    );
  });

  it("keeps the customer's own hold from blocking the replacement choices", () => {
    const own = { start: 10, end: 20 };
    const open = withoutOwnHold([{ start: 10, end: 20 }, { start: 30, end: 40 }], own);
    assert.deepEqual(open, [{ start: 30, end: 40 }]);
  });
});

describe("payment notice", () => {
  it("replaces the stale checkout sentence with the real payment and booking status", () => {
    const stale = "Payment submitted. Stripe still has to confirm it before the provider can accept.";
    assert.equal(
      accountPaymentNotice({
        notice: stale,
        bookings: [{ status: "accepted", paymentStatus: "succeeded" }],
      }),
      "Payment confirmed. The provider accepted this appointment.",
    );
    assert.equal(
      accountPaymentNotice({
        checkout: "submitted",
        bookings: [{ status: "completed", paymentStatus: "succeeded" }],
      }),
      "Payment confirmed. This appointment is complete.",
    );
    assert.match(
      accountPaymentNotice({
        checkout: "submitted",
        bookings: [{ status: "pending", paymentStatus: "requires_payment" }],
      }) ?? "",
      /Stripe still has to confirm/,
    );
    assert.equal(accountPaymentNotice({ notice: "Request sent", bookings: [] }), "Request sent");
  });
});

describe("expiration refunds", () => {
  it("refunds a successful payment once and replays a failed refund without a second charge", () => {
    const base = { bookingStatus: "expired", paymentStatus: "succeeded", amountCents: 5000, refundedCents: 0, openRefundId: null };
    assert.equal(expirationRefundPlan(base), "create");
    assert.equal(expirationRefundPlan({ ...base, openRefundId: "refund-1" }), "replay");
    assert.equal(expirationRefundPlan({ ...base, refundedCents: 5000 }), "skip");
    assert.equal(expirationRefundPlan({ ...base, bookingStatus: "accepted" }), "skip");
    assert.equal(expirationRefundPlan({ ...base, paymentStatus: "requires_payment" }), "skip");
    assert.equal(expirationRefundPlan({ ...base, paymentStatus: "partially_refunded", refundedCents: 1000 }), "create");
    assert.equal(
      recordedRefundCoverage({ amountCents: 5000, refundedCents: 0, succeededRefundCents: 0, openRefundId: "refund-1" }).action,
      "replay",
    );
    assert.deepEqual(
      recordedRefundCoverage({ amountCents: 5000, refundedCents: 0, succeededRefundCents: 5000, openRefundId: null }),
      { action: "settled", refundedCents: 5000, needsRepair: true },
    );
    assert.equal(
      recordedRefundCoverage({ amountCents: 5000, refundedCents: 5000, succeededRefundCents: 5000, openRefundId: null }).action,
      "settled",
    );
  });
});

describe("expiration migration contract", () => {
  it("expires only through the locked claim and releases the slot", () => {
    assert.match(migration, /for update of booking skip locked/);
    assert.match(migration, /limit \(limit_size\)/);
    assert.equal(migration.includes("when others"), false);
    assert.match(migration, /status in \('pending', 'accepted', 'declined', 'completed', 'cancelled', 'expired'\)/);
    assert.match(migration, /new.status in \('declined', 'cancelled', 'expired'\)/);
    assert.match(migration, /issued_action = 'expire'/);
    assert.match(migration, /booking.status = 'expired'/);
    assert.match(migration, /expiration_grace = true/);
    assert.match(migration, /effective_acceptance_deadline/);
    assert.match(migration, /refunded_cents < payment.amount_cents/);
    assert.match(migration, /bookings_needing_expiration_refund/);
    assert.match(migration, /revoke all on function public.claim_expired_bookings\(integer\) from public, anon, authenticated/);
    assert.equal(migration.includes("delete from public.booking_requests"), false);
    assert.equal(migration.includes("update public.payments"), false);
  });

  it("moves an appointment only with the reschedule nonce and still rejects other time edits", () => {
    assert.match(migration, /issued_action = 'reschedule'/);
    assert.match(migration, /Appointment times cannot be changed/);
    assert.match(migration, /Appointment overlaps another booking/);
    assert.match(migration, /when exclusion_violation then/);
    assert.match(migration, /when raise_exception then/);
    assert.match(migration, /That time overlaps another appointment/);
    assert.match(migration, /The original appointment is unchanged/);
    assert.match(migration, /status = 'approved'/);
    assert.match(migration, /Reschedule did not reserve the requested time/);
    assert.match(migration, /Reschedule does not match a pending request/);
    assert.match(migration, /public.owns_provider\(booking.provider_id\)/);
    assert.match(migration, /price_adjustment_required := service.price_cents is distinct from paid_cents/);
    assert.match(migration, /Only an accepted appointment can be rescheduled/);
  });

  it("does not reuse row-variable names as the approval query's booking_id aliases", () => {
    const approval = rescheduleFix.slice(rescheduleFix.indexOf("new.status = 'approved'"));
    assert.match(approval, /confirmed_visit\.booking_id = old\.booking_id/);
    assert.match(approval, /booked_request\.id = confirmed_visit\.booking_id/);
    assert.match(approval, /public\.owns_provider\(booked_request\.provider_id\)/);
    assert.equal(approval.includes("as appointment"), false);
    assert.equal(approval.includes("as booking"), false);
    assert.equal(rescheduleFix.includes("update public.payments"), false);
    assert.match(rescheduleFix, /confirmed_visit\.status = 'confirmed'/);
  });

  it("keeps the expiration output variable from colliding with the booking_id column", () => {
    assert.match(expirationFix, /returns table \(expired_booking_id uuid\)/);
    assert.match(expirationFix, /visit\.booking_id = request\.id/);
    assert.match(expirationFix, /succeeded_payment\.booking_id = request\.id/);
    assert.match(expirationFix, /on conflict on constraint appointment_transition_pkey/);
    assert.match(expirationFix, /for update of request skip locked/);
    assert.match(expirationFix, /security definer/);
    assert.match(expirationFix, /set search_path = public/);
    assert.match(expirationFix, /revoke all on function public.claim_expired_bookings\(integer\) from public, anon, authenticated/);
    assert.match(expirationFix, /grant execute on function public.bookings_needing_expiration_refund\(integer\) to service_role/);
    assert.equal(expirationFix.includes("returns table (booking_id uuid)"), false);
    assert.equal(expirationFix.includes("on conflict (booking_id)"), false);
    assert.equal(expirationFix.includes("#variable_conflict"), false);
    assert.equal(expirationFix.includes("update public.payments"), false);
    assert.equal(expirationRpcBookingId({ expired_booking_id: "new-id", booking_id: "old-id" }), "new-id");
    assert.equal(expirationRpcBookingId({ booking_id: "old-id" }), "old-id");
    assert.equal(expirationRpcBookingId({}), null);
  });
});
