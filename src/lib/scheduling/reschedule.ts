import type { TimeRange } from "./rules.ts";

export function rescheduleDecision(input: {
  ownsProvider: boolean;
  bookingStatus: string;
  requestStatus: string;
  conflict: boolean;
  movedToRequest: boolean;
}) {
  if (!input.ownsProvider) return { result: "forbidden" as const, requestStatus: input.requestStatus, appointmentMoved: false };
  if (input.bookingStatus !== "accepted") return { result: "not_accepted" as const, requestStatus: input.requestStatus, appointmentMoved: false };
  if (input.requestStatus !== "pending") return { result: "not_pending" as const, requestStatus: input.requestStatus, appointmentMoved: false };
  if (input.conflict || !input.movedToRequest) {
    return { result: input.conflict ? ("conflict" as const) : ("not_moved" as const), requestStatus: "pending" as const, appointmentMoved: false };
  }
  return { result: "approved" as const, requestStatus: "approved" as const, appointmentMoved: true };
}

export function priceAdjustmentRequired(originalCents: number | null, requestedCents: number | null) {
  return originalCents !== requestedCents;
}

export function withoutOwnHold(busy: TimeRange[], own: TimeRange | null) {
  if (!own) return busy;
  return busy.filter((range) => range.start !== own.start || range.end !== own.end);
}

export const PRICE_ADJUSTMENT_MESSAGE =
  "This change has a different price. Approving it does not charge or refund the difference. The original payment stays in place, and a separate approved payment adjustment is required.";
