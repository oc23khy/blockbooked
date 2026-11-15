import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  BOOKING_MAINTENANCE_MESSAGE,
  BOOKING_MAINTENANCE_UNAVAILABLE,
  allowlistedActor,
  bookingCreationBlock,
  bookingCreationDecision,
  bookingMaintenanceWriteAllowed,
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
const allowlistMigration = readFileSync(
  new URL("../supabase/migrations/20261114060000_booking_maintenance_allowlist.sql", import.meta.url),
  "utf8",
);
const maintenanceReader = readFileSync(new URL("../src/lib/bookings/maintenance.ts", import.meta.url), "utf8");

const customer = "a1000001-0000-4000-8000-0000000000a1";
const other = "a1000002-0000-4000-8000-0000000000a2";
const providerOwner = "a1000003-0000-4000-8000-0000000000a3";

function slice(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

describe("booking maintenance decision", () => {
  it("pauses only when the stored setting is true", () => {
    const base = { allowlist: [], actorId: customer };
    assert.equal(bookingCreationDecision({ readFailed: false, maintenance: true, ...base }), "paused");
    assert.equal(bookingCreationDecision({ readFailed: false, maintenance: false, ...base }), "open");
    assert.equal(bookingCreationDecision({ readFailed: false, maintenance: null, ...base }), "open");
    assert.equal(bookingCreationDecision({ readFailed: false, maintenance: "true", ...base }), "open");
    assert.equal(bookingCreationDecision({ readFailed: true, maintenance: false, ...base }), "unavailable");
    assert.equal(bookingCreationBlock("paused"), BOOKING_MAINTENANCE_MESSAGE);
    assert.equal(bookingCreationBlock("unavailable"), BOOKING_MAINTENANCE_UNAVAILABLE);
    assert.equal(bookingCreationBlock("open"), null);
    assert.equal(customerFacingError(BOOKING_MAINTENANCE_MESSAGE, "The booking could not be saved."), BOOKING_MAINTENANCE_MESSAGE);
  });

  it("permits only the one allowlisted signed-in customer", () => {
    assert.equal(bookingCreationDecision({
      readFailed: false,
      maintenance: true,
      allowlist: [customer],
      actorId: customer,
    }), "open");
    assert.equal(bookingCreationDecision({
      readFailed: false,
      maintenance: true,
      allowlist: [],
      actorId: customer,
    }), "paused");
    assert.equal(bookingCreationDecision({
      readFailed: false,
      maintenance: true,
      allowlist: [customer],
      actorId: null,
    }), "paused");
    assert.equal(bookingCreationDecision({
      readFailed: false,
      maintenance: true,
      allowlist: [customer],
      actorId: other,
    }), "paused");
    assert.equal(allowlistedActor([customer.toUpperCase()], customer), false);
    assert.equal(allowlistedActor([{ id: customer }], customer), false);
    assert.equal(allowlistedActor([customer, other], customer), false);
    assert.equal(allowlistedActor(customer, customer), false);
    assert.equal(bookingCreationDecision({
      readFailed: false,
      maintenance: true,
      allowlist: [],
      actorId: providerOwner,
    }), "paused");
  });
});

describe("booking maintenance row authorization", () => {
  const paused = { paused: true, allowlist: [customer] as unknown };

  it("rejects another customer, a forged customer id, and a missing session", () => {
    assert.equal(bookingMaintenanceWriteAllowed({
      ...paused,
      actorId: other,
      actorRole: "authenticated",
      table: "booking_requests",
      rowCustomerId: other,
      bookingCustomerId: other,
    }), false);
    assert.equal(bookingMaintenanceWriteAllowed({
      ...paused,
      actorId: other,
      actorRole: "authenticated",
      table: "booking_requests",
      rowCustomerId: customer,
      bookingCustomerId: customer,
    }), false);
    assert.equal(bookingMaintenanceWriteAllowed({
      ...paused,
      actorId: null,
      actorRole: null,
      table: "booking_requests",
      rowCustomerId: customer,
      bookingCustomerId: customer,
    }), false);
    assert.equal(bookingMaintenanceWriteAllowed({
      ...paused,
      actorId: null,
      actorRole: "authenticated",
      table: "booking_appointments",
      rowCustomerId: null,
      bookingCustomerId: customer,
    }), false);
    assert.equal(bookingMaintenanceWriteAllowed({
      paused: true,
      allowlist: [],
      actorId: customer,
      actorRole: "authenticated",
      table: "booking_requests",
      rowCustomerId: customer,
      bookingCustomerId: customer,
    }), false);
  });

  it("does not treat provider ownership as permission to book or pay", () => {
    assert.equal(bookingMaintenanceWriteAllowed({
      paused: true,
      allowlist: [],
      actorId: providerOwner,
      actorRole: "authenticated",
      table: "booking_requests",
      rowCustomerId: providerOwner,
      bookingCustomerId: providerOwner,
    }), false);
    assert.equal(bookingMaintenanceWriteAllowed({
      ...paused,
      actorId: providerOwner,
      actorRole: "authenticated",
      table: "booking_appointments",
      rowCustomerId: null,
      bookingCustomerId: customer,
    }), false);
    assert.equal(bookingMaintenanceWriteAllowed({
      ...paused,
      actorId: providerOwner,
      actorRole: "authenticated",
      table: "payments",
      rowCustomerId: customer,
      bookingCustomerId: customer,
    }), false);
  });

  it("allows the allowlisted customer and a matching service-role payment", () => {
    assert.equal(bookingMaintenanceWriteAllowed({
      ...paused,
      actorId: customer,
      actorRole: "authenticated",
      table: "booking_requests",
      rowCustomerId: customer,
      bookingCustomerId: customer,
    }), true);
    assert.equal(bookingMaintenanceWriteAllowed({
      ...paused,
      actorId: customer,
      actorRole: "authenticated",
      table: "booking_appointments",
      rowCustomerId: null,
      bookingCustomerId: customer,
    }), true);
    assert.equal(bookingMaintenanceWriteAllowed({
      ...paused,
      actorId: null,
      actorRole: "service_role",
      table: "payments",
      rowCustomerId: customer,
      bookingCustomerId: customer,
    }), true);
    assert.equal(bookingMaintenanceWriteAllowed({
      ...paused,
      actorId: null,
      actorRole: "service_role",
      table: "payments",
      rowCustomerId: customer,
      bookingCustomerId: other,
    }), false);
    assert.equal(bookingMaintenanceWriteAllowed({
      ...paused,
      actorId: null,
      actorRole: null,
      table: "payments",
      rowCustomerId: customer,
      bookingCustomerId: customer,
    }), false);
    assert.equal(bookingMaintenanceWriteAllowed({
      paused: false,
      allowlist: [],
      actorId: null,
      actorRole: null,
      table: "booking_requests",
      rowCustomerId: other,
      bookingCustomerId: other,
    }), true);
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
    assert.match(createBooking, /readBookingCreationDecision\(\)/);
    assert.doesNotMatch(createBooking, /formData\.get\("customerId"\)/);
    assert.match(maintenanceReader, /auth\.getUser\(\)/);
    assert.doesNotMatch(maintenanceReader, /formData|searchParams|customerId/);
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

  it("keeps the allowlist empty and limited to the database administrator", () => {
    assert.match(allowlistMigration, /values \('booking_maintenance_allowlist', '\[\]'::jsonb\)/);
    assert.match(allowlistMigration, /on conflict \(key\) do nothing/);
    assert.match(allowlistMigration, /new\.customer_id is not distinct from actor/);
    assert.match(allowlistMigration, /new\.customer_id is not distinct from booking_customer/);
    assert.match(allowlistMigration, /request\.customer_id/);
    assert.match(allowlistMigration, /actor is null and coalesce\(auth\.role\(\), ''\) = 'service_role'/);
    assert.match(allowlistMigration, /security invoker/);
    assert.match(allowlistMigration, /jsonb_array_length\(new\.value\) > 1/);
    assert.match(allowlistMigration, /clear_booking_maintenance_allowlist/);
    assert.match(allowlistMigration, /set value = '\[\]'::jsonb/);
    assert.match(allowlistMigration, /revoke all on function public\.clear_booking_maintenance_allowlist\(\) from public, anon, authenticated/);
    assert.doesNotMatch(allowlistMigration, /owns_provider|is_admin|user_metadata|raw_user_meta|set_config\(/);
    assert.doesNotMatch(allowlistMigration, /before update on public\.booking_requests/i);
    assert.doesNotMatch(allowlistMigration, /public\.refunds/);
    assert.doesNotMatch(allowlistMigration, /disable trigger/i);
  });
});
