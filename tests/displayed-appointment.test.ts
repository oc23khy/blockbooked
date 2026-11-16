import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { acceptedCancellationDecision } from "../src/lib/booking-status.ts";
import { historicalAppointmentLabel, selectDisplayedAppointments } from "../src/lib/bookings/displayed-appointment.ts";

const historicalStart = "2026-11-20T16:00:00.000Z";

describe("displayed appointment history", () => {
  it("prefers a confirmed appointment over a held or released one", () => {
    const selected = selectDisplayedAppointments([
      { booking_id: "booking", starts_at: "2026-11-18T16:00:00.000Z", status: "released" },
      { booking_id: "booking", starts_at: "2026-11-19T16:00:00.000Z", status: "held" },
      { booking_id: "booking", starts_at: historicalStart, status: "confirmed" },
    ]);
    assert.deepEqual(selected.get("booking"), { startsAt: historicalStart, status: "confirmed" });
  });

  it("keeps a released appointment and its original time when no active appointment exists", () => {
    const selected = selectDisplayedAppointments([
      { booking_id: "closed", starts_at: historicalStart, status: "released" },
      { booking_id: "held", starts_at: "2026-11-21T16:00:00.000Z", status: "held" },
      { booking_id: "held", starts_at: "2026-11-22T16:00:00.000Z", status: "released" },
    ]);
    assert.deepEqual(selected.get("closed"), { startsAt: historicalStart, status: "released" });
    assert.deepEqual(selected.get("held"), { startsAt: "2026-11-21T16:00:00.000Z", status: "held" });
  });

  it("leaves a booking without an appointment unset", () => {
    const selected = selectDisplayedAppointments([
      { booking_id: "other", starts_at: historicalStart, status: "released" },
    ]);
    assert.equal(selected.get("quote"), undefined);
  });

  it("labels a released time as former and does not make it cancellable", () => {
    for (const bookingStatus of ["cancelled", "declined", "expired"]) {
      assert.equal(
        historicalAppointmentLabel({ bookingStatus, appointmentStatus: "released", hasStart: true }),
        "Former appointment — this time was released.",
      );
    }
    assert.equal(historicalAppointmentLabel({ bookingStatus: "cancelled", appointmentStatus: null, hasStart: false }), null);
    assert.equal(
      historicalAppointmentLabel({ bookingStatus: "accepted", appointmentStatus: "confirmed", hasStart: true }),
      "Confirmed appointment.",
    );
    assert.equal(
      acceptedCancellationDecision({
        isBookingOwner: true,
        currentStatus: "accepted",
        appointmentStatus: "released",
        startsAt: historicalStart,
        nowMs: Date.parse("2026-11-16T12:00:00.000Z"),
      }),
      "unavailable",
    );
  });

  it("uses the historical selector on the account page and the confirmed appointment for cancellation", () => {
    const page = readFileSync(new URL("../src/app/account/page.tsx", import.meta.url), "utf8");
    const action = readFileSync(new URL("../src/app/actions/bookings.ts", import.meta.url), "utf8");
    assert.match(page, /selectDisplayedAppointments/);
    assert.doesNotMatch(page, /if \(!active\) continue/);
    assert.match(action, /\.eq\("status", "confirmed"\)/);
  });
});
