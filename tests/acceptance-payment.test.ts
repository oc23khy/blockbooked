import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { acceptanceTransitionAllowed, canChangeBookingStatus, paidAcceptanceAllowed } from "../src/lib/booking-status.ts";

const migration = readFileSync(
  new URL("../supabase/migrations/20261111180000_paid_acceptance.sql", import.meta.url),
  "utf8",
);
const acceptanceAction = readFileSync(new URL("../src/app/actions/bookings.ts", import.meta.url), "utf8");

function payment(status: string, amountCents = 5000, refundedCents = 0) {
  return { status, amountCents, refundedCents };
}

describe("paid acceptance", () => {
  it("rejects a missing, pending, failed, cancelled, refunded, or disputed payment", () => {
    assert.equal(paidAcceptanceAllowed([]), false);
    for (const status of ["requires_payment", "processing", "failed", "canceled", "refunded", "disputed"]) {
      assert.equal(paidAcceptanceAllowed([payment(status)]), false);
    }
    assert.equal(paidAcceptanceAllowed([payment("succeeded", 5000, 5000)]), false);
    assert.equal(paidAcceptanceAllowed([payment("partially_refunded", 5000, 5000)]), false);
  });

  it("allows a succeeded payment and a partial refund that still has a balance", () => {
    assert.equal(paidAcceptanceAllowed([payment("succeeded", 5000, 0)]), true);
    assert.equal(paidAcceptanceAllowed([payment("partially_refunded", 5000, 2000)]), true);
    assert.equal(
      paidAcceptanceAllowed([payment("failed", 5000, 0), payment("succeeded", 5000, 0)]),
      true,
    );
  });

  it("does not reopen an expired, declined, cancelled, or completed booking", () => {
    for (const status of ["expired", "declined", "cancelled", "completed"]) {
      assert.equal(acceptanceTransitionAllowed(status), false);
      assert.equal(
        canChangeBookingStatus({
          isCustomer: false,
          isProvider: true,
          currentStatus: status,
          nextStatus: "accepted",
        }),
        false,
      );
    }
    assert.equal(acceptanceTransitionAllowed("pending"), true);
    assert.equal(acceptanceTransitionAllowed("requested"), true);
    const guard = migration.slice(0, migration.indexOf("select payment.id"));
    assert.match(guard, /old\.status in \('expired', 'declined', 'cancelled', 'completed'\)/);
    assert.match(guard, /old\.status not in \('pending', 'requested'\)/);
    assert.match(guard, /cannot be accepted/);
    assert.equal(guard.includes("is_admin()"), false);
    assert.equal(guard.includes("auth.role()"), false);
  });

  it("does not let another provider or a customer accept a booking", () => {
    assert.equal(
      canChangeBookingStatus({
        isCustomer: false,
        isProvider: false,
        currentStatus: "pending",
        nextStatus: "accepted",
      }),
      false,
    );
    assert.equal(
      canChangeBookingStatus({
        isCustomer: true,
        isProvider: false,
        currentStatus: "pending",
        nextStatus: "accepted",
      }),
      false,
    );
    assert.equal(
      canChangeBookingStatus({
        isCustomer: false,
        isProvider: true,
        currentStatus: "pending",
        nextStatus: "accepted",
      }),
      true,
    );
  });

  it("keeps the server action from treating a missing payment as acceptable", () => {
    const action = acceptanceAction.slice(
      acceptanceAction.indexOf("export async function updateBookingStatus"),
      acceptanceAction.indexOf("export async function submitCompletionPin"),
    );
    assert.match(action, /paidAcceptanceAllowed\(/);
    assert.equal(action.includes("rows.length > 0"), false);
    assert.match(action, /amount_cents, refunded_cents/);
  });

  it("enforces the payment in the database for every role, including a direct update", () => {
    assert.match(migration, /raise exception 'Acceptance requires a confirmed Stripe payment'/);
    assert.match(migration, /payment\.status in \('succeeded', 'partially_refunded'\)/);
    assert.match(migration, /payment\.refunded_cents < payment\.amount_cents/);
    assert.match(migration, /for update of payment/);
    assert.match(migration, /when \(new\.status = 'accepted' and old\.status is distinct from 'accepted'\)/);
    assert.match(migration, /before update of status on public\.booking_requests/);
    assert.match(migration, /before insert on public\.booking_requests/);
    assert.match(migration, /when \(new\.status = 'accepted'\)/);
    assert.equal(migration.includes("is_admin()"), false);
    assert.equal(migration.includes("new.payment_status"), false);
    assert.match(migration, /from public\.payments as payment/);
    assert.equal(migration.includes("```"), false);
  });

  it("runs after the existing status guards and locks the confirming payment", () => {
    assert.equal("bookings_protect_row" < "bookings_require_paid_acceptance", true);
    assert.equal("bookings_reject_unverified_completion" < "bookings_require_paid_acceptance", true);
    assert.equal("bookings_protect_row" < "bookings_require_paid_acceptance_insert", true);
    assert.match(migration, /security definer/);
    assert.match(migration, /set search_path = public/);
    assert.match(migration, /revoke all on function public\.require_paid_acceptance\(\) from public, anon, authenticated/);
    assert.match(migration, /grant execute on function public\.require_paid_acceptance\(\) to authenticated/);
    assert.match(migration, /grant execute on function public\.require_paid_acceptance\(\) to service_role/);
    assert.equal(migration.includes("grant execute on function public.require_paid_acceptance() to anon"), false);
    const decision = migration.slice(
      migration.indexOf("select payment.id"),
      migration.indexOf("if not found"),
    );
    assert.match(decision, /for update of payment/);
    assert.equal(decision.includes("perform 1"), false);
  });
});
