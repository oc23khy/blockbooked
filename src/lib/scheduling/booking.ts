import { zonedParts } from "./rules.ts";

export function bookPath(providerId: string, serviceId: string, startsAt: string) {
  const params = new URLSearchParams({ service: serviceId, starts: startsAt });
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
