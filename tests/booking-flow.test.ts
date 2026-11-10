import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bookPath, bookingSurface, heldVisit, loginPathForBooking } from "../src/lib/scheduling/booking.ts";
import { claimVisit, openSlots, type Visit } from "../src/lib/scheduling/rules.ts";

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

  it("uses Morning, Afternoon, or Evening only when no exact slot is open", () => {
    assert.equal(bookingSurface({ offeredStarts: [], selectedStart: "2026-11-16T15:00:00.000Z" }), "fallback");
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
});
