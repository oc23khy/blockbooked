import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseCatalogSubmission } from "../src/lib/scheduling/catalog.ts";
import {
  claimVisit,
  fitsBusinessHours,
  localInstants,
  matchesDuration,
  openSlots,
  releaseVisit,
  visitsConflict,
  zonedParts,
  type Visit,
} from "../src/lib/scheduling/rules.ts";

const migration = readFileSync(
  new URL("../supabase/migrations/20261110260000_provider_schedules.sql", import.meta.url),
  "utf8",
);

function visit(id: string, start: string, end: string, bufferMinutes = 0): Visit {
  return { id, start: Date.parse(start), end: Date.parse(end), bufferMinutes };
}

describe("appointment migration contract", () => {
  it("confirms a visit only from the booking acceptance trigger", () => {
    const updateGuard = migration.slice(
      migration.indexOf("if tg_op = 'UPDATE'"),
      migration.indexOf("-- INSERT."),
    );
    assert.equal(updateGuard.includes("owns_provider"), false);
    assert.equal(updateGuard.includes("is_admin"), false);
    assert.equal(updateGuard.includes("set_config("), false);
    assert.match(migration, /Appointments can only be confirmed when the booking is accepted/);
    assert.match(migration, /blockbooked_private\.appointment_transition/);
    assert.match(migration, /issued_nonce/);
    assert.equal(/nonce = nonce/.test(migration), false);
    assert.match(migration, /force row level security/);
    assert.match(migration, /appointment_transition_no_api/);
    assert.match(migration, /revoke all on function public\.sync_booking_appointment\(\) from public, anon, authenticated/);
    assert.match(migration, /revoke all on function public\.guard_booking_appointment\(\) from public, anon, authenticated/);
    assert.match(migration, /revoke insert, update, delete on table public\.booking_appointments from service_role/);
    assert.equal(/\bdrop (policy|trigger|constraint)\b/i.test(migration), false);
  });

  it("keeps the overlap index immutable and still includes the buffer", () => {
    assert.match(migration, /blocked_until timestamptz not null/);
    assert.match(migration, /tstzrange\(starts_at, blocked_until\)/);
    assert.match(migration, /new\.blocked_until := new\.ends_at \+ \(new\.buffer_minutes \* interval '1 minute'\)/);
    assert.equal(/tstzrange\(\s*starts_at,\s*ends_at \+/.test(migration), false);
  });

  it("requires a duration-backed service and defines an unscheduled quote", () => {
    assert.match(migration, /service_id uuid not null references public\.provider_services/);
    assert.match(migration, /Choose an active service that has a duration/);
    assert.match(migration, /A booking_requests row may exist with no booking_appointments row/);
    assert.match(migration, /if booking\.status <> 'pending'/);
    assert.match(migration, /request\.status = 'pending'/);
  });

  it("keeps time-off notes off the public API and blocks direct rescheduling", () => {
    assert.equal(/grant select on public\.provider_time_off to anon/.test(migration), false);
    assert.match(migration, /provider_time_off_ranges/);
    assert.match(migration, /The private note stays on the table and is not returned/);
    assert.match(migration, /Appointment times cannot be changed\. Rescheduling is not available yet\./);
    assert.match(migration, /Appointments cannot be removed\. Decline or cancel the booking to release the time\./);
    assert.match(migration, /status = 'released'/);
    assert.equal(/delete from public\.booking_appointments/i.test(migration), false);
    assert.match(migration, /Nothing in this file expires a booking/);
  });
});

describe("buffered overlap", () => {
  it("rejects an overlapping visit and a visit inside the buffer", () => {
    const first = visit("a", "2026-11-16T15:00:00Z", "2026-11-16T16:00:00Z", 15);
    const overlap = visit("b", "2026-11-16T15:30:00Z", "2026-11-16T16:30:00Z", 15);
    const insideBuffer = visit("c", "2026-11-16T16:10:00Z", "2026-11-16T17:10:00Z", 15);
    const afterBuffer = visit("d", "2026-11-16T16:15:00Z", "2026-11-16T17:15:00Z", 15);
    assert.equal(visitsConflict(first, overlap), true);
    assert.equal(visitsConflict(first, insideBuffer), true);
    assert.equal(visitsConflict(first, afterBuffer), false);
  });

  it("lets only one of two serialized claims keep the time", async () => {
    const holds: Visit[] = [];
    let chain: Promise<unknown> = Promise.resolve();
    const requested = visit("one", "2026-11-16T15:00:00Z", "2026-11-16T16:00:00Z", 30);

    function lockedClaim(id: string) {
      const run = chain.then(() => claimVisit(holds, { ...requested, id }));
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }

    const results = (await Promise.all([lockedClaim("one"), lockedClaim("two")])).sort();
    assert.deepEqual(results, ["booked", "conflict"]);
    assert.equal(holds.length, 1);
  });

  it("frees the time on decline or cancellation and keeps a completed visit", () => {
    const holds = [visit("job", "2026-11-16T15:00:00Z", "2026-11-16T16:00:00Z", 0)];
    assert.equal(releaseVisit(holds, "job", "completed").length, 1);
    assert.equal(releaseVisit(holds, "job", "cancelled").length, 0);
    assert.equal(releaseVisit(holds, "job", "declined").length, 0);
    const unscheduledQuote: Visit[] = [];
    assert.equal(visitsConflict(holds[0], visit("other", "2026-11-16T15:00:00Z", "2026-11-16T16:00:00Z")), true);
    assert.equal(unscheduledQuote.length, 0);
  });
});

describe("timezone boundaries", () => {
  const zone = "America/Chicago";

  it("uses absolute time across the spring-forward gap", () => {
    const start = new Date("2026-03-08T07:30:00Z");
    const end = new Date("2026-03-08T08:30:00Z");
    assert.equal(zonedParts(start, zone).minuteOfDay, 90);
    assert.equal(zonedParts(end, zone).minuteOfDay, 210);
    assert.equal(matchesDuration(start, end, 60), true);
    assert.equal(fitsBusinessHours(start, end, zone, [{ weekday: 0, opensMinute: 0, closesMinute: 120 }]), false);
    assert.equal(fitsBusinessHours(start, end, zone, [{ weekday: 0, opensMinute: 0, closesMinute: 240 }]), true);
  });

  it("offers only open times inside published hours", () => {
    const slots = openSlots({
      timeZone: "America/Chicago",
      windows: [{ weekday: 1, opensMinute: 9 * 60, closesMinute: 11 * 60 }],
      durationMinutes: 60,
      bufferMinutes: 15,
      minNoticeMinutes: 0,
      maxAdvanceDays: 14,
      busy: [],
      timeOff: [],
      now: new Date("2026-11-15T12:00:00Z"),
    });
    assert.deepEqual(slots.map((slot) => slot.start), [
      "2026-11-16T15:00:00.000Z",
      "2026-11-23T15:00:00.000Z",
    ]);
    const blocked = openSlots({
      timeZone: "America/Chicago",
      windows: [{ weekday: 1, opensMinute: 9 * 60, closesMinute: 11 * 60 }],
      durationMinutes: 60,
      bufferMinutes: 0,
      minNoticeMinutes: 0,
      maxAdvanceDays: 14,
      busy: [{ start: Date.parse("2026-11-16T15:00:00Z"), end: Date.parse("2026-11-16T16:00:00Z") }],
      timeOff: [],
      now: new Date("2026-11-15T12:00:00Z"),
    });
    assert.deepEqual(blocked.map((slot) => slot.start), [
      "2026-11-16T16:00:00.000Z",
      "2026-11-23T15:00:00.000Z",
      "2026-11-23T16:00:00.000Z",
    ]);
  });

  it("skips the missing spring-forward hour and keeps both fall-back hours", () => {
    assert.equal(localInstants("2026-03-08", 2 * 60 + 30, "America/Chicago").length, 0);
    assert.equal(localInstants("2026-11-01", 1 * 60 + 30, "America/Chicago").length, 2);
  });

  it("treats the repeated fall-back hour as two different instants", () => {
    const first = visit("early", "2026-11-01T06:30:00Z", "2026-11-01T07:30:00Z", 0);
    const second = visit("late", "2026-11-01T07:30:00Z", "2026-11-01T08:30:00Z", 0);
    assert.equal(zonedParts(new Date(first.start), zone).minuteOfDay, 90);
    assert.equal(zonedParts(new Date(second.start), zone).minuteOfDay, 90);
    assert.equal(visitsConflict(first, second), false);
    assert.equal(visitsConflict({ ...first, bufferMinutes: 15 }, second), true);
  });
});

describe("catalog service save", () => {
  it("rejects a blank service form instead of reporting success", () => {
    const form = new FormData();
    for (let index = 0; index < 4; index += 1) {
      form.set(`id-${index}`, "");
      form.set(`name-${index}`, "");
      form.set(`pricing-${index}`, "fixed");
      form.set(`price-${index}`, "");
      form.set(`duration-${index}`, "");
      form.set(`active-${index}`, "yes");
      form.set(`detail-${index}`, "");
    }
    const parsed = parseCatalogSubmission(form);
    assert.equal(parsed.rows.length, 0);
    assert.match(parsed.error ?? "", /No service was saved/);
  });

  it("keeps the service name, dollar price, and duration that the customer can book", () => {
    const form = new FormData();
    form.set("id-0", "");
    form.set("name-0", "Standard cleaning");
    form.set("pricing-0", "fixed");
    form.set("price-0", "$50");
    form.set("duration-0", "60 minutes");
    form.set("active-0", "yes");
    form.set("detail-0", "Kitchen and bathrooms");
    const parsed = parseCatalogSubmission(form);
    assert.equal(parsed.error, null);
    assert.equal(parsed.rows.length, 1);
    assert.deepEqual(parsed.rows[0], {
      index: 0,
      id: null,
      name: "Standard cleaning",
      description: "Kitchen and bathrooms",
      pricing: "fixed",
      priceCents: 5000,
      durationMinutes: 60,
      active: true,
    });
  });

  it("rejects a duration that cannot become an appointment", () => {
    const form = new FormData();
    form.set("name-0", "Quick clean");
    form.set("pricing-0", "fixed");
    form.set("price-0", "50");
    form.set("duration-0", "10");
    form.set("active-0", "yes");
    const parsed = parseCatalogSubmission(form);
    assert.equal(parsed.rows.length, 0);
    assert.match(parsed.error ?? "", /15 to 480/);
  });
});
