import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  appointmentDetailPath,
  appointmentMessagePath,
  calendarScope,
  calendarStatusClass,
  durationMinutes,
  eventsForViewer,
  eventsOnDates,
  monthCells,
  readCalendarQuery,
  replaceStatus,
  shiftDate,
  todayKey,
  visibleDateKeys,
  zonedClock,
  type CalendarBooking,
} from "../src/lib/calendar.ts";
import { localInstants } from "../src/lib/scheduling/rules.ts";

const board = readFileSync(new URL("../src/components/calendar-board.tsx", import.meta.url), "utf8");
const customerCalendar = readFileSync(new URL("../src/components/customer-calendar.tsx", import.meta.url), "utf8");
const bookingCard = readFileSync(new URL("../src/components/booking-card.tsx", import.meta.url), "utf8");

function booking(overrides: Partial<CalendarBooking> = {}): CalendarBooking {
  return {
    id: "booking-1",
    customerId: "customer-1",
    providerOwnerId: "owner-1",
    providerId: "provider-1",
    status: "accepted",
    serviceName: "Mow",
    preferredDate: "2026-11-12",
    timeWindow: "Morning",
    customerName: "Casey",
    providerName: "North Lawn",
    timeZone: "America/Chicago",
    startsAt: "2026-11-12T15:00:00.000Z",
    endsAt: "2026-11-12T16:30:00.000Z",
    ...overrides,
  };
}

describe("calendar visibility", () => {
  it("shows a customer only their bookings across providers", () => {
    const events = eventsForViewer(
      [
        booking({ id: "a", providerId: "provider-1", providerName: "North Lawn" }),
        booking({ id: "b", providerId: "provider-2", providerName: "South Lawn", providerOwnerId: "owner-2" }),
        booking({ id: "c", customerId: "customer-2" }),
      ],
      "customer-1",
      "customer",
    );
    assert.deepEqual(events.map((event) => event.id), ["a", "b"]);
    assert.deepEqual(events.map((event) => event.title), ["North Lawn", "South Lawn"]);
  });

  it("shows a provider only bookings they own", () => {
    const events = eventsForViewer(
      [booking({ id: "mine" }), booking({ id: "theirs", providerOwnerId: "owner-2", providerId: "provider-2" })],
      "owner-1",
      "provider",
    );
    assert.deepEqual(events.map((event) => event.id), ["mine"]);
    assert.equal(events[0].title, "Casey");
  });

  it("hides another account when the viewer id does not match", () => {
    assert.equal(eventsForViewer([booking()], "stranger", "customer").length, 0);
    assert.equal(eventsForViewer([booking()], "stranger", "provider").length, 0);
  });

  it("keeps several jobs on the same day", () => {
    const events = eventsForViewer(
      [
        booking({ id: "early", startsAt: "2026-11-12T15:00:00.000Z", endsAt: "2026-11-12T16:00:00.000Z" }),
        booking({ id: "late", startsAt: "2026-11-12T20:00:00.000Z", endsAt: "2026-11-12T21:00:00.000Z", serviceName: "Trim" }),
      ],
      "customer-1",
      "customer",
    );
    const day = eventsOnDates(events, ["2026-11-12"]);
    assert.deepEqual(day.map((event) => event.id), ["early", "late"]);
  });

  it("updates the displayed status without moving the appointment", () => {
    const [event] = eventsForViewer([booking({ status: "pending" })], "customer-1", "customer");
    const updated = replaceStatus([event], event.id, "cancelled");
    assert.equal(updated[0].status, "cancelled");
    assert.equal(updated[0].startsAt, event.startsAt);
    assert.equal(replaceStatus([event], event.id, "completed")[0].status, "completed");
    assert.equal(replaceStatus([event], event.id, "declined")[0].status, "declined");
    assert.equal(replaceStatus([event], event.id, "expired")[0].status, "expired");
  });
});

describe("appointment duration and time zones", () => {
  it("uses the stored start and end instead of assuming one hour", () => {
    assert.equal(durationMinutes("2026-11-12T15:00:00.000Z", "2026-11-12T16:30:00.000Z"), 90);
    const [event] = eventsForViewer([booking()], "owner-1", "provider");
    assert.equal(event.durationMinutes, 90);
    assert.equal(event.timed, true);
  });

  it("keeps an unscheduled request on its date and window", () => {
    const [event] = eventsForViewer(
      [booking({ startsAt: null, endsAt: null, timeWindow: "Evening", preferredDate: "2026-11-20", status: "requested" })],
      "customer-1",
      "customer",
    );
    assert.equal(event.timed, false);
    assert.equal(event.dateKey, "2026-11-20");
    assert.equal(event.windowLabel, "Evening");
    assert.equal(event.durationMinutes, null);
    assert.equal(event.status, "pending");
  });

  it("places a Chicago appointment on the local date", () => {
    const [event] = eventsForViewer([booking()], "customer-1", "customer");
    assert.equal(event.dateKey, "2026-11-12");
    assert.equal(event.startMinute, 9 * 60);
    assert.match(zonedClock(event.startsAt!, "America/Chicago"), /9:00 AM/);
  });

  it("handles the spring-forward and fall-back boundaries", () => {
    assert.equal(localInstants("2026-03-08", 2 * 60 + 30, "America/Chicago").length, 0);
    const spring = eventsForViewer(
      [booking({ startsAt: "2026-03-08T07:30:00.000Z", endsAt: "2026-03-08T09:00:00.000Z" })],
      "customer-1",
      "customer",
    )[0];
    assert.equal(spring.dateKey, "2026-03-08");
    assert.equal(spring.startMinute, 90);
    assert.equal(spring.durationMinutes, 90);
    assert.match(zonedClock(spring.startsAt!, "America/Chicago"), /1:30 AM/);
    assert.match(zonedClock(spring.endsAt!, "America/Chicago"), /4:00 AM CDT/);

    const repeated = localInstants("2026-11-01", 90, "America/Chicago");
    assert.equal(repeated.length, 2);
    const labels = repeated.map((instant) => zonedClock(instant.toISOString(), "America/Chicago"));
    assert.match(labels[0], /CDT/);
    assert.match(labels[1], /CST/);
    const first = eventsForViewer(
      [booking({ startsAt: repeated[0].toISOString(), endsAt: new Date(repeated[0].getTime() + 90 * 60_000).toISOString() })],
      "customer-1",
      "customer",
    )[0];
    const second = eventsForViewer(
      [booking({ id: "second", startsAt: repeated[1].toISOString(), endsAt: new Date(repeated[1].getTime() + 90 * 60_000).toISOString() })],
      "customer-1",
      "customer",
    )[0];
    assert.equal(first.dateKey, "2026-11-01");
    assert.equal(second.dateKey, "2026-11-01");
    assert.equal(first.startMinute, 90);
    assert.equal(second.startMinute, 90);
    assert.notEqual(first.startsAt, second.startsAt);
  });
});

describe("calendar navigation", () => {
  it("returns an empty selection when there are no bookings", () => {
    assert.deepEqual(eventsForViewer([], "customer-1", "customer"), []);
    assert.deepEqual(eventsOnDates([], ["2026-11-12"]), []);
  });

  it("moves by month, week, and day and rejects a bad view", () => {
    assert.equal(shiftDate("2026-01-31", "month", 1), "2026-02-28");
    assert.equal(shiftDate("2026-11-12", "week", 1), "2026-11-19");
    assert.equal(shiftDate("2026-11-12", "day", -1), "2026-11-11");
    assert.deepEqual(readCalendarQuery({ view: "year", date: "nope", today: "2026-11-12" }), { view: "month", date: "2026-11-12" });
    assert.equal(visibleDateKeys("day", "2026-11-12").length, 1);
    assert.equal(visibleDateKeys("week", "2026-11-12").length, 7);
    const weeks = monthCells("2026-11-12");
    assert.equal(weeks[0].length, 7);
    assert.ok(weeks.flat().includes("2026-11-01"));
    assert.ok(weeks.flat().includes("2026-11-30"));
  });

  it("uses the provider time zone for today", () => {
    const now = new Date("2026-11-12T04:30:00.000Z");
    assert.equal(todayKey("America/Chicago", now), "2026-11-11");
    assert.equal(todayKey("America/New_York", now), "2026-11-11");
  });

  it("keeps a Chicago evening visit on the provider date for a later time zone", () => {
    const startsAt = "2026-11-12T03:30:00.000Z";
    const endsAt = "2026-11-12T04:30:00.000Z";
    const [event] = eventsForViewer([booking({ startsAt, endsAt, timeZone: "America/Chicago" })], "customer-1", "customer");
    const instant = new Date(startsAt);
    assert.equal(event.dateKey, "2026-11-11");
    assert.equal(todayKey("Europe/London", instant), "2026-11-12");
    assert.match(zonedClock(event.startsAt!, event.timeZone), /CST|CDT/);
    assert.equal(event.startMinute, 21 * 60 + 30);
  });

  it("shows a preferred window without an invented start", () => {
    const [event] = eventsForViewer(
      [booking({ startsAt: null, endsAt: null, preferredDate: "2026-12-01", timeWindow: "Afternoon", status: "pending" })],
      "customer-1",
      "customer",
    );
    assert.equal(event.timed, false);
    assert.equal(event.dateKey, "2026-12-01");
    assert.equal(event.windowLabel, "Afternoon");
    assert.equal(event.startMinute, null);
    assert.equal(event.startsAt, null);
  });

  it("ignores customer, provider, and booking ids supplied in the URL", () => {
    const scope = calendarScope({
      audience: "customer",
      sessionUserId: "customer-1",
      ownedProviderId: null,
      searchParams: { customerId: "customer-2", providerId: "provider-9", bookingId: "booking-9" },
    });
    assert.deepEqual(scope, { customerId: "customer-1", providerId: null });
    const providerScope = calendarScope({
      audience: "provider",
      sessionUserId: "owner-1",
      ownedProviderId: "provider-1",
      searchParams: { customerId: "customer-2", providerId: "provider-9", bookingId: "booking-9" },
    });
    assert.deepEqual(providerScope, { customerId: null, providerId: "provider-1" });
  });

  it("opens the booking card and the customer conversation", () => {
    assert.equal(appointmentDetailPath("customer", "booking-1"), "/account#booking-booking-1");
    assert.equal(appointmentDetailPath("provider", "booking-1"), "/dashboard#booking-booking-1");
    assert.equal(appointmentMessagePath("booking-1"), "/account/messages/booking-1");
    assert.match(bookingCard, /id=\{`booking-\$\{booking\.id\}`\}/);
    assert.match(board, /appointmentMessagePath\(event\.id\)/);
  });

  it("styles closed bookings differently", () => {
    const completed = calendarStatusClass("completed");
    const cancelled = calendarStatusClass("cancelled");
    const declined = calendarStatusClass("declined");
    const expired = calendarStatusClass("expired");
    assert.equal(new Set([completed, cancelled, declined, expired]).size, 4);
    assert.match(cancelled, /line-through/);
    assert.doesNotMatch(completed, /line-through/);
  });

  it("uses the browser time zone for customer navigation", () => {
    assert.match(customerCalendar, /resolvedOptions\(\)\.timeZone/);
    assert.doesNotMatch(customerCalendar, /America\/Chicago/);
  });

  it("stacks the week on a narrow screen and labels the controls", () => {
    assert.match(board, /grid-cols-1 gap-3 sm:grid-cols-7/);
    assert.match(board, /aria-label="Previous"/);
    assert.match(board, /aria-label="Today"/);
    assert.match(board, /aria-label="Calendar view"/);
    assert.match(board, /Message provider/);
  });
});
