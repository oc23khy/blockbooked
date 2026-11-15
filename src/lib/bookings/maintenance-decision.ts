export const BOOKING_MAINTENANCE_MESSAGE =
  "Booking is temporarily paused for maintenance. You can still view, cancel, or manage an existing booking.";

export const BOOKING_MAINTENANCE_UNAVAILABLE =
  "Booking could not be checked. Try again in a few minutes.";

export function bookingCreationDecision(input: { readFailed: boolean; value: unknown }) {
  if (input.readFailed) return "unavailable" as const;
  if (input.value === true) return "paused" as const;
  return "open" as const;
}

export function bookingCreationBlock(decision: ReturnType<typeof bookingCreationDecision>) {
  if (decision === "paused") return BOOKING_MAINTENANCE_MESSAGE;
  if (decision === "unavailable") return BOOKING_MAINTENANCE_UNAVAILABLE;
  return null;
}
