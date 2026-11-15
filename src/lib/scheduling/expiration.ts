export const ACCEPTANCE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const UNPAID_HOLD_MS = 30 * 60 * 1000;
export const UNPAID_HOLD_LIMIT = 2;

export function expirationRpcBookingId(row: { booking_id?: string | null; expired_booking_id?: string | null }) {
  const id = row.expired_booking_id ?? row.booking_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function displayedDeadline(
  storedDeadline: string | null,
  appointmentStart: string | null,
  grace = false,
  createdAt: string | null = null,
  paid = true,
) {
  if (!storedDeadline) return null;
  if (grace) return storedDeadline;
  const acceptance = earlierDeadline(storedDeadline, appointmentStart);
  if (paid || !appointmentStart || !createdAt) return acceptance;
  const unpaid = new Date(Date.parse(createdAt) + UNPAID_HOLD_MS).toISOString();
  return earlierDeadline(acceptance, unpaid);
}

export function unpaidHoldAllowed(existingUnpaidHolds: number) {
  return existingUnpaidHolds < UNPAID_HOLD_LIMIT;
}

export function expirationRefundPlan(input: {
  bookingStatus: string;
  paymentStatus: string;
  amountCents: number;
  refundedCents: number;
  openRefundId: string | null;
}) {
  if (input.bookingStatus !== "expired" && input.bookingStatus !== "cancelled" && input.bookingStatus !== "declined") {
    return "skip" as const;
  }
  if (input.paymentStatus !== "succeeded" && input.paymentStatus !== "partially_refunded") return "skip" as const;
  if (input.refundedCents >= input.amountCents) return "skip" as const;
  if (input.openRefundId) return "replay" as const;
  return "create" as const;
}

export function earlierDeadline(storedDeadline: string | null, appointmentStart: string | null) {
  if (!storedDeadline) return null;
  if (!appointmentStart) return storedDeadline;
  return Date.parse(appointmentStart) < Date.parse(storedDeadline) ? appointmentStart : storedDeadline;
}

export function acceptanceDeadline(createdAt: Date, appointmentStart: Date | null) {
  const limit = new Date(createdAt.getTime() + ACCEPTANCE_WINDOW_MS);
  if (!appointmentStart || Number.isNaN(appointmentStart.getTime())) return limit;
  return appointmentStart.getTime() < limit.getTime() ? appointmentStart : limit;
}

export type ExpirableBooking = {
  id: string;
  status: string;
  deadline: number;
  appointmentStart?: number | null;
  grace?: boolean;
  locked?: boolean;
};

export function claimExpired(rows: ExpirableBooking[], now: number) {
  const claimed: string[] = [];
  for (const row of rows) {
    if (row.locked || row.status !== "pending") continue;
    const start = row.appointmentStart ?? null;
    const effective = row.grace || start == null ? row.deadline : Math.min(row.deadline, start);
    if (effective > now) continue;
    row.status = "expired";
    claimed.push(row.id);
  }
  return claimed;
}

export function resolvePendingRace(first: "accept" | "expire", second: "accept" | "expire") {
  let status = "pending";
  const apply = (action: "accept" | "expire") => {
    if (status !== "pending") return false;
    status = action === "accept" ? "accepted" : "expired";
    return true;
  };
  const firstApplied = apply(first);
  const secondApplied = apply(second);
  return { status, firstApplied, secondApplied };
}
