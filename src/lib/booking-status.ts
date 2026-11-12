export const bookingStatuses = ["pending", "accepted", "declined", "completed", "cancelled", "expired"] as const;

export type BookingStatus = (typeof bookingStatuses)[number];

export function normalizeBookingStatus(status: string): BookingStatus {
  if (status === "requested") return "pending";
  if (bookingStatuses.includes(status as BookingStatus)) return status as BookingStatus;
  return "pending";
}

export function bookingStatusLabel(status: string) {
  const normalized = normalizeBookingStatus(status);
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function customerCanCancel(status: string) {
  return normalizeBookingStatus(status) === "pending";
}

export function acceptanceTransitionAllowed(currentStatus: string) {
  return currentStatus === "pending" || currentStatus === "requested";
}

export function providerActions(status: string): Array<"accepted" | "declined"> {
  const normalized = normalizeBookingStatus(status);
  if (normalized === "pending") return ["accepted", "declined"];
  return [];
}

export function providerCanVerifyPin(status: string) {
  return normalizeBookingStatus(status) === "accepted";
}

const confirmedPaymentStatuses = new Set(["succeeded", "partially_refunded"]);

export function paidAcceptanceAllowed(
  payments: { status: string; amountCents: number; refundedCents: number }[],
) {
  return payments.some(
    (payment) =>
      confirmedPaymentStatuses.has(payment.status) &&
      Number.isInteger(payment.amountCents) &&
      Number.isInteger(payment.refundedCents) &&
      payment.refundedCents >= 0 &&
      payment.refundedCents < payment.amountCents,
  );
}

export function canChangeBookingStatus(input: {
  isCustomer: boolean;
  isProvider: boolean;
  currentStatus: string;
  nextStatus: string;
}) {
  if (!bookingStatuses.includes(input.nextStatus as BookingStatus)) return false;
  if (input.nextStatus === "completed" || input.nextStatus === "expired") return false;
  if (input.nextStatus === "accepted" && !acceptanceTransitionAllowed(input.currentStatus)) return false;
  const current = normalizeBookingStatus(input.currentStatus);
  if (input.isCustomer && input.nextStatus === "cancelled" && customerCanCancel(current)) return true;
  return input.isProvider && providerActions(current).some((action) => action === input.nextStatus);
}

export function isOpenBooking(status: string) {
  const normalized = normalizeBookingStatus(status);
  return normalized === "pending" || normalized === "accepted";
}

const pinMessages: Record<string, string> = {
  not_accepted: "This booking is not waiting for a completion PIN.",
  forbidden: "You cannot complete this booking.",
  not_found: "That booking could not be found.",
  invalid_format: "Enter the 6-digit PIN from the customer.",
  unavailable: "This PIN can no longer be used.",
  error: "The PIN could not be checked.",
};

export function pinAttemptMessage(result: string) {
  if (result.startsWith("locked:")) {
    const until = new Date(result.slice("locked:".length));
    if (Number.isNaN(until.getTime())) {
      return "Too many incorrect PINs. This booking is locked for 15 minutes.";
    }
    const when = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Chicago",
    }).format(until);
    return `Too many incorrect PINs. This booking is locked until ${when}.`;
  }

  if (result === "incorrect" || result.startsWith("incorrect:")) {
    const count = result === "incorrect" ? Number.NaN : Number(result.slice("incorrect:".length));
    if (Number.isInteger(count) && count > 0 && count < 5) {
      const remaining = 5 - count;
      const noun = remaining === 1 ? "attempt" : "attempts";
      return `That PIN does not match. ${remaining} ${noun} remaining before a 15-minute lockout.`;
    }
    return "That PIN does not match. Five wrong attempts lock this booking for 15 minutes.";
  }

  return pinMessages[result] ?? pinMessages.unavailable;
}
