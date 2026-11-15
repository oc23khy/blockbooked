import { zonedParts } from "./rules.ts";

export function bookPath(providerId: string, serviceId: string, startsAt: string, reserveId?: string) {
  const params = new URLSearchParams({ service: serviceId, starts: startsAt });
  if (reserveId) params.set("reserve", reserveId);
  return `/providers/${providerId}?${params.toString()}`;
}

export function loginPathForBooking(providerId: string, serviceId: string, startsAt: string) {
  return `/login?next=${encodeURIComponent(bookPath(providerId, serviceId, startsAt))}`;
}

export function bookingSurface(input: { offeredStarts: string[]; selectedStart: string | null }) {
  if (input.offeredStarts.length === 0) return "fallback" as const;
  if (input.selectedStart && input.offeredStarts.includes(input.selectedStart)) return "confirm" as const;
  return "calendar" as const;
}

export function appointmentLabel(startsAt: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(startsAt));
}

export type BookingCreationPlan =
  | { action: "reject"; message: string }
  | { action: "quote-request" }
  | { action: "reserve"; charge: boolean };

export function bookingCreationPlan(input: {
  startsAt: string;
  paymentPlan: string;
  pricingType: "fixed" | "starting" | "quote" | null;
  durationMinutes: number | null;
  offeredStarts: string[];
}): BookingCreationPlan {
  const start = input.startsAt.trim();
  const plan = input.paymentPlan === "quote" || input.paymentPlan === "milestones" ? input.paymentPlan : "single";
  if (!start) {
    if (input.pricingType === "fixed" || input.pricingType === "starting" || plan !== "quote") {
      return {
        action: "reject",
        message: "Choose an open appointment time. A time of day does not reserve an appointment.",
      };
    }
    return { action: "quote-request" };
  }
  if (input.durationMinutes == null || !Number.isInteger(input.durationMinutes) || input.durationMinutes < 15 || input.durationMinutes > 480) {
    return { action: "reject", message: "This service does not have an appointment duration." };
  }
  const parsed = new Date(start);
  if (Number.isNaN(parsed.getTime()) || !input.offeredStarts.includes(parsed.toISOString())) {
    return { action: "reject", message: "Choose one of the open appointment times." };
  }
  return {
    action: "reserve",
    charge: plan === "single" && (input.pricingType === "fixed" || input.pricingType === "starting"),
  };
}

export function quoteConversionReady(input: { reserved: boolean; quoteOffered: boolean; paid: boolean }) {
  if (!input.reserved) return "needs-reservation" as const;
  if (!input.quoteOffered) return "needs-quote" as const;
  if (!input.paid) return "needs-payment" as const;
  return "can-accept" as const;
}

export function reservationOutcome(saved: boolean) {
  return saved ? ("hold" as const) : ("cancel-without-charge" as const);
}

export function heldVisit(input: {
  serviceId: string;
  serviceName: string;
  startsAt: string;
  durationMinutes: number;
  timeZone: string;
  offeredStarts: string[];
}) {
  const start = new Date(input.startsAt);
  if (Number.isNaN(start.getTime()) || !input.offeredStarts.includes(start.toISOString())) {
    throw new Error("Choose one of the open appointment times.");
  }
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 15) {
    throw new Error("This service does not have an appointment duration.");
  }
  const parts = zonedParts(start, input.timeZone);
  const hour = Math.floor(parts.minuteOfDay / 60);
  return {
    serviceId: input.serviceId,
    serviceName: input.serviceName.slice(0, 120),
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + input.durationMinutes * 60_000).toISOString(),
    preferredDate: parts.dateKey,
    timeWindow: hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening",
    label: appointmentLabel(start.toISOString(), input.timeZone),
  };
}
