import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { bookPath, bookingCreationPlan, bookingSurface, heldVisit, loginPathForBooking, quoteConversionReady, reservationOutcome } from "../src/lib/scheduling/booking.ts";
import { claimVisit, openSlots, type Visit } from "../src/lib/scheduling/rules.ts";

const bookingAction = readFileSync(new URL("../src/app/actions/bookings.ts", import.meta.url), "utf8");
const paymentService = readFileSync(new URL("../src/lib/payments/service.ts", import.meta.url), "utf8");
const reservationMigration = readFileSync(new URL("../supabase/migrations/20261114040000_require_reserved_appointment.sql", import.meta.url), "utf8");

const providerId = "df44047b-11a8-4448-b645-dea9635abc68";
const serviceId = "11111111-1111-4111-8111-111111111111";

function offered() {
  return openSlots({
    timeZone: "America/Chicago",
    windows: [{ weekday: 1, opensMinute: 9 * 60, closesMinute: 12 * 60 }],
    durationMinutes: 60,
    bufferMinutes: 0,
    minNoticeMinutes: 0,
    maxAdvanceDays: 7,
    busy: [],
    timeOff: [],
    now: new Date("2026-11-15T12:00:00Z"),
  });
}

describe("selecting an appointment and booking it", () => {
  it("keeps the selected service and exact time from Book through submit", () => {
    const slots = offered();
    const selected = slots[0];
    assert.equal(selected.start, "2026-11-16T15:00:00.000Z");
    assert.equal(bookingSurface({ offeredStarts: slots.map((slot) => slot.start), selectedStart: null }), "calendar");

    const booked = bookPath(providerId, serviceId, selected.start);
    const params = new URLSearchParams(booked.split("?")[1]);
    assert.equal(params.get("service"), serviceId);
    assert.equal(params.get("starts"), selected.start);
    assert.equal(
      bookingSurface({ offeredStarts: slots.map((slot) => slot.start), selectedStart: params.get("starts") }),
      "confirm",
    );

    const visit = heldVisit({
      serviceId,
      serviceName: "Standard clean",
      startsAt: params.get("starts") ?? "",
      durationMinutes: 60,
      timeZone: "America/Chicago",
      offeredStarts: slots.map((slot) => slot.start),
    });
    assert.equal(visit.serviceId, serviceId);
    assert.equal(visit.startsAt, "2026-11-16T15:00:00.000Z");
    assert.equal(visit.endsAt, "2026-11-16T16:00:00.000Z");
    assert.equal(visit.preferredDate, "2026-11-16");
    assert.match(visit.label, /9:00/);
    assert.doesNotMatch(visit.label, /Morning|Afternoon|Evening/);
  });

  it("sends a logged-out Book click back to the same appointment", () => {
    const start = "2026-11-16T15:00:00.000Z";
    const next = new URL(`http://localhost${loginPathForBooking(providerId, serviceId, start)}`).searchParams.get("next");
    const params = new URLSearchParams(String(next).split("?")[1]);
    assert.equal(params.get("service"), serviceId);
    assert.equal(params.get("starts"), start);
  });

  it("uses Morning, Afternoon, or Evening only as an unscheduled quote", () => {
    assert.equal(bookingSurface({ offeredStarts: [], selectedStart: "2026-11-16T15:00:00.000Z" }), "fallback");
    assert.equal(
      bookingCreationPlan({
        startsAt: "",
        paymentPlan: "quote",
        pricingType: "quote",
        durationMinutes: null,
        offeredStarts: [],
      }).action,
      "quote-request",
    );
    assert.equal(
      bookingCreationPlan({
        startsAt: "",
        paymentPlan: "single",
        pricingType: "fixed",
        durationMinutes: 60,
        offeredStarts: [],
      }).action,
      "reject",
    );
  });

  it("rejects a second booking of the same slot and a time that was not offered", () => {
    const slots = offered();
    const selected = slots[0];
    const visit = heldVisit({
      serviceId,
      serviceName: "Standard clean",
      startsAt: selected.start,
      durationMinutes: 60,
      timeZone: "America/Chicago",
      offeredStarts: slots.map((slot) => slot.start),
    });
    const claimed: Visit[] = [];
    assert.equal(
      claimVisit(claimed, { id: "booking-1", start: Date.parse(visit.startsAt), end: Date.parse(visit.endsAt), bufferMinutes: 0 }),
      "booked",
    );
    assert.equal(
      claimVisit(claimed, { id: "booking-2", start: Date.parse(visit.startsAt), end: Date.parse(visit.endsAt), bufferMinutes: 0 }),
      "conflict",
    );
    assert.throws(() =>
      heldVisit({
        serviceId,
        serviceName: "Standard clean",
        startsAt: "2026-11-16T18:00:00.000Z",
        durationMinutes: 60,
        timeZone: "America/Chicago",
        offeredStarts: slots.map((slot) => slot.start),
      }),
    );
  });

  it("rejects a fixed-price booking without an offered start and keeps a quote unscheduled", () => {
    const slots = offered();
    const missing = bookingCreationPlan({
      startsAt: "",
      paymentPlan: "single",
      pricingType: "fixed",
      durationMinutes: 60,
      offeredStarts: slots.map((slot) => slot.start),
    });
    assert.equal(missing.action, "reject");
    const invalid = bookingCreationPlan({
      startsAt: "2026-11-16T18:00:00.000Z",
      paymentPlan: "single",
      pricingType: "fixed",
      durationMinutes: 60,
      offeredStarts: slots.map((slot) => slot.start),
    });
    assert.equal(invalid.action, "reject");
    const reserved = bookingCreationPlan({
      startsAt: slots[0].start,
      paymentPlan: "single",
      pricingType: "fixed",
      durationMinutes: 60,
      offeredStarts: slots.map((slot) => slot.start),
    });
    assert.deepEqual(reserved, { action: "reserve", charge: true });
    const quote = bookingCreationPlan({
      startsAt: "",
      paymentPlan: "quote",
      pricingType: null,
      durationMinutes: null,
      offeredStarts: [],
    });
    assert.equal(quote.action, "quote-request");
  });

  it("keeps two customers and a buffered neighbor from sharing one appointment", () => {
    const slots = offered();
    const start = Date.parse(slots[0].start);
    const claimed: Visit[] = [];
    assert.equal(claimVisit(claimed, { id: "a", start, end: start + 60 * 60_000, bufferMinutes: 30 }), "booked");
    assert.equal(claimVisit(claimed, { id: "b", start, end: start + 60 * 60_000, bufferMinutes: 30 }), "conflict");
    assert.equal(claimVisit(claimed, { id: "c", start: start + 60 * 60_000, end: start + 120 * 60_000, bufferMinutes: 0 }), "conflict");
    assert.equal(claimed[0]?.id, "a");
  });

  it("requires a reserved time before a quote can be accepted", () => {
    assert.equal(quoteConversionReady({ reserved: false, quoteOffered: true, paid: true }), "needs-reservation");
    assert.equal(quoteConversionReady({ reserved: true, quoteOffered: false, paid: false }), "needs-quote");
    assert.equal(quoteConversionReady({ reserved: true, quoteOffered: true, paid: false }), "needs-payment");
    assert.equal(quoteConversionReady({ reserved: true, quoteOffered: true, paid: true }), "can-accept");
    assert.equal(reservationOutcome(false), "cancel-without-charge");
    assert.equal(reservationOutcome(true), "hold");
  });

  it("does not offer the missing spring-forward hour", () => {
    const slots = openSlots({
      timeZone: "America/Chicago",
      windows: [{ weekday: 0, opensMinute: 60, closesMinute: 4 * 60 }],
      durationMinutes: 60,
      bufferMinutes: 0,
      minNoticeMinutes: 0,
      maxAdvanceDays: 2,
      busy: [],
      timeOff: [],
      now: new Date("2026-03-07T12:00:00Z"),
    });
    assert.equal(slots.some((slot) => zonedHour(slot.start) === 2), false);
    const fall = openSlots({
      timeZone: "America/Chicago",
      windows: [{ weekday: 0, opensMinute: 60, closesMinute: 3 * 60 }],
      durationMinutes: 60,
      bufferMinutes: 0,
      minNoticeMinutes: 0,
      maxAdvanceDays: 2,
      busy: [],
      timeOff: [],
      now: new Date("2026-10-31T12:00:00Z"),
    });
    const repeated = fall.filter((slot) => zonedHour(slot.start) === 1);
    assert.equal(new Set(repeated.map((slot) => slot.start)).size, repeated.length);
  });

  it("reserves an appointment before checkout and blocks acceptance without one", () => {
    const reserveAt = bookingAction.indexOf('rpc("create_reserved_booking"');
    const checkoutAt = bookingAction.indexOf("startCheckout(");
    assert.ok(reserveAt > 0 && reserveAt < checkoutAt);
    assert.match(bookingAction, /cancel-without-charge/);
    assert.match(bookingAction, /Accepting requires a reserved appointment/);
    assert.match(bookingAction, /appointment_required !== false/);
    assert.match(paymentService, /Choose an appointment time before paying/);
    assert.match(reservationMigration, /Acceptance requires a reserved appointment/);
    assert.match(reservationMigration, /appointment_required/);
    assert.match(reservationMigration, /status = 'held'/);
    assert.doesNotMatch(reservationMigration, /outreach_send_settings|resend|stripe/);
  });
});

function zonedHour(value: string) {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    hourCycle: "h23",
  }).format(new Date(value));
  return Number(hour);
}
