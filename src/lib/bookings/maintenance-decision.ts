export const BOOKING_MAINTENANCE_MESSAGE =
  "Booking is temporarily paused for maintenance. You can still view, cancel, or manage an existing booking.";

export const BOOKING_MAINTENANCE_UNAVAILABLE =
  "Booking could not be checked. Try again in a few minutes.";

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function canonicalUserId(value: unknown) {
  if (typeof value !== "string" || !USER_ID.test(value)) return null;
  return value.toLowerCase();
}

// One exact signed-in user. An empty, malformed, or longer list matches nobody.
export function allowlistedActor(allowlist: unknown, actorId: string | null) {
  const actor = canonicalUserId(actorId);
  if (!actor || !Array.isArray(allowlist) || allowlist.length !== 1) return false;
  return allowlist[0] === actor;
}

export function bookingCreationDecision(input: {
  readFailed: boolean;
  maintenance: unknown;
  allowlist: unknown;
  actorId: string | null;
}) {
  if (input.readFailed) return "unavailable" as const;
  if (input.maintenance !== true) return "open" as const;
  if (allowlistedActor(input.allowlist, input.actorId)) return "open" as const;
  return "paused" as const;
}

export function bookingCreationBlock(decision: ReturnType<typeof bookingCreationDecision>) {
  if (decision === "paused") return BOOKING_MAINTENANCE_MESSAGE;
  if (decision === "unavailable") return BOOKING_MAINTENANCE_UNAVAILABLE;
  return null;
}

// The database trigger is authoritative for inserts. This mirrors that decision so
// tests can show a forged customer id, a missing session, or provider ownership
// does not open the pause. It does not read a browser-supplied id.
export function bookingMaintenanceWriteAllowed(input: {
  paused: boolean;
  allowlist: unknown;
  actorId: string | null;
  actorRole: string | null;
  table: "booking_requests" | "booking_appointments" | "payments";
  rowCustomerId: string | null;
  bookingCustomerId: string | null;
}) {
  if (!input.paused) return true;
  const actor = canonicalUserId(input.actorId);
  const actorListed = allowlistedActor(input.allowlist, actor);
  const bookingCustomer = canonicalUserId(input.bookingCustomerId);
  const rowCustomer = canonicalUserId(input.rowCustomerId);

  if (input.table === "booking_requests") {
    return actorListed && rowCustomer === actor;
  }
  if (input.table === "booking_appointments") {
    return actorListed && bookingCustomer === actor;
  }

  const bookingListed = allowlistedActor(input.allowlist, bookingCustomer);
  if (!bookingListed || rowCustomer !== bookingCustomer) return false;
  if (actor !== null && actor === bookingCustomer) return true;
  return actor === null && input.actorRole === "service_role";
}
