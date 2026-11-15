import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  BOOKING_MAINTENANCE_MESSAGE,
  BOOKING_MAINTENANCE_UNAVAILABLE,
  bookingCreationBlock,
  bookingCreationDecision,
} from "../src/lib/bookings/maintenance-decision.ts";
import { customerFacingError } from "../src/lib/public-error.ts";

const bookings = readFileSync(new URL("../src/app/actions/bookings.ts", import.meta.url), "utf8");
const payments = readFileSync(new URL("../src/app/actions/payments.ts", import.meta.url), "utf8");
const service = readFileSync(new URL("../src/lib/payments/service.ts", import.meta.url), "utf8");
const expire = readFileSync(new URL("../src/lib/bookings/expire.ts", import.meta.url), "utf8");
const webhook = readFileSync(new URL("../src/app/api/stripe/webhook/route.ts", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../supabase/migrations/20261114035000_booking_maintenance.sql", import.meta.url),
  "utf8",
);

function slice(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

describe("booking maintenance decision", () => {
  it("pauses only when the stored setting is true", () => {
    assert.equal(bookingCreationDecision({ readFailed: false, value: true }), "paused");
    assert.equal(bookingCreationDecision({ readFailed: false, value: false }), "open");
    assert.equal(bookingCreationDecision({ readFailed: false, value: null }), "open");
    assert.equal(bookingCreationDecision({ readFailed: false, value: "true" }), "open");
    assert.equal(bookingCreationDecision({ readFailed: true, value: false }), "unavailable");
    assert.equal(bookingCreationBlock("paused"), BOOKING_MAINTENANCE_MESSAGE);
    assert.equal(bookingCreationBlock("unavailable"), BOOKING_MAINTENANCE_UNAVAILABLE);
    assert.equal(bookingCreationBlock("open"), null);
    assert.equal(customerFacingError(BOOKING_MAINTENANCE_MESSAGE, "The booking could not be saved."), BOOKING_MAINTENANCE_MESSAGE);
  });
});

describe("booking maintenance enforcement", () => {
  it("blocks new bookings and checkout before any write or Stripe call", () => {
    const createBooking = slice(bookings, "export async function createBooking", "export async function reserveBookingAppointment");
    const reserve = slice(bookings, "export async function reserveBookingAppointment", "export async function updateBookingStatus");
    const pay = slice(payments, "export async function payForBooking", "export async function updateCommission");
    const start = slice(service, "export async function startCheckout", "export async function resumeCheckout");
    const resume = slice(service, "export async function resumeCheckout", "export async function ");
    for (const body of [createBooking, reserve, pay, start, resume]) {
      const guard = body.indexOf("readBookingCreationDecision");
      assert.ok(guard > 0);
    }
    assert.ok(createBooking.indexOf("readBookingCreationDecision") < createBooking.indexOf('rpc("create_reserved_booking"'));
    assert.ok(createBooking.indexOf("readBookingCreationDecision") < createBooking.indexOf('.from("booking_requests")'));
    assert.ok(reserve.indexOf("readBookingCreationDecision") < reserve.indexOf('rpc("attach_booking_appointment"'));
    assert.ok(pay.indexOf("readBookingCreationDecision") < pay.indexOf("payOutstanding("));
    assert.ok(start.indexOf("readBookingCreationDecision") < start.indexOf('.from("payments")'));
    assert.ok(start.indexOf("readBookingCreationDecision") < start.indexOf("checkout.sessions.create"));
    assert.ok(resume.indexOf("readBookingCreationDecision") < resume.indexOf("checkout.sessions.create"));
  });

  it("leaves cancellation, refunds, expiration, and webhooks available", () => {
    const status = slice(bookings, "export async function updateBookingStatus", "export async function submitCompletionPin");
    const refund = slice(service, "export async function requestRefund", "export async function ");
    assert.equal(status.includes("readBookingCreationDecision"), false);
    assert.equal(refund.includes("readBookingCreationDecision"), false);
    assert.equal(expire.includes("readBookingCreationDecision"), false);
    assert.equal(webhook.includes("readBookingCreationDecision"), false);
    assert.match(status, /status: nextStatus/);
    assert.match(migration, /before insert on public\.booking_requests/);
    assert.match(migration, /before insert on public\.booking_appointments/);
    assert.match(migration, /before insert on public\.payments/);
    assert.doesNotMatch(migration, /before update/i);
    assert.doesNotMatch(migration, /public\.refunds/);
    assert.match(migration, /values \('booking_maintenance', 'false'::jsonb\)/);
  });
});
