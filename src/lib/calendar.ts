import { bookingStatusLabel, normalizeBookingStatus } from "./booking-status.ts";
import { zonedParts } from "./scheduling/rules.ts";

export const calendarViews = ["month", "week", "day"] as const;
export type CalendarView = (typeof calendarViews)[number];

const windows = new Set(["Morning", "Afternoon", "Evening"]);

export type CalendarBooking = {
  id: string;
  customerId: string;
  providerOwnerId: string;
  providerId: string;
  status: string;
  serviceName: string;
  preferredDate: string;
  timeWindow: string;
  customerName: string;
  providerName: string;
  timeZone: string;
  startsAt: string | null;
  endsAt: string | null;
};

export type CalendarEvent = {
  id: string;
  status: string;
  statusLabel: string;
  title: string;
  serviceName: string;
  timeZone: string;
  dateKey: string;
  startsAt: string | null;
  endsAt: string | null;
  startMinute: number | null;
  durationMinutes: number | null;
  windowLabel: string | null;
  timed: boolean;
};

export function durationMinutes(startsAt: string, endsAt: string) {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const minutes = Math.round((end - start) / 60_000);
  if (minutes < 1 || minutes > 8 * 60) return null;
  return minutes;
}

export function eventsForViewer(bookings: CalendarBooking[], viewerId: string, audience: "customer" | "provider") {
  return bookings
    .filter((booking) => (audience === "customer" ? booking.customerId === viewerId : booking.providerOwnerId === viewerId))
    .map((booking) => toEvent(booking, audience))
    .filter((event): event is CalendarEvent => event !== null);
}

function toEvent(booking: CalendarBooking, audience: "customer" | "provider"): CalendarEvent | null {
  const status = normalizeBookingStatus(booking.status);
  const shared = {
    id: booking.id,
    status,
    statusLabel: bookingStatusLabel(status),
    title: audience === "customer" ? booking.providerName || "Provider" : booking.customerName || "Customer",
    serviceName: booking.serviceName || "Service",
    timeZone: booking.timeZone || "America/Chicago",
  };
  const minutes = booking.startsAt && booking.endsAt ? durationMinutes(booking.startsAt, booking.endsAt) : null;
  if (booking.startsAt && booking.endsAt && minutes) {
    const start = new Date(booking.startsAt);
    const parts = zonedParts(start, shared.timeZone);
    if (!parts.dateKey || parts.minuteOfDay < 0) return null;
    return {
      ...shared,
      dateKey: parts.dateKey,
      startsAt: new Date(booking.startsAt).toISOString(),
      endsAt: new Date(booking.endsAt).toISOString(),
      startMinute: parts.minuteOfDay,
      durationMinutes: minutes,
      windowLabel: null,
      timed: true,
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(booking.preferredDate)) return null;
  const windowLabel = windows.has(booking.timeWindow) ? booking.timeWindow : "Requested";
  return {
    ...shared,
    dateKey: booking.preferredDate,
    startsAt: null,
    endsAt: null,
    startMinute: null,
    durationMinutes: null,
    windowLabel,
    timed: false,
  };
}

export function replaceStatus(events: CalendarEvent[], bookingId: string, status: string) {
  const normalized = normalizeBookingStatus(status);
  return events.map((event) =>
    event.id === bookingId ? { ...event, status: normalized, statusLabel: bookingStatusLabel(normalized) } : event,
  );
}

export function eventsOnDates(events: CalendarEvent[], dateKeys: string[]) {
  const wanted = new Set(dateKeys);
  return events
    .filter((event) => wanted.has(event.dateKey))
    .sort((left, right) => left.dateKey.localeCompare(right.dateKey) || (left.startMinute ?? 24 * 60) - (right.startMinute ?? 24 * 60) || left.title.localeCompare(right.title));
}

export function readCalendarQuery(input: { view?: string; date?: string; today: string }) {
  const view = calendarViews.includes(input.view as CalendarView) ? (input.view as CalendarView) : "month";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date ?? "") ? input.date! : input.today;
  return { view, date };
}

export function shiftDate(dateKey: string, view: CalendarView, direction: -1 | 1) {
  if (view === "month") return addMonths(dateKey, direction);
  if (view === "week") return addDays(dateKey, direction * 7);
  return addDays(dateKey, direction);
}

export function visibleDateKeys(view: CalendarView, anchor: string) {
  if (view === "day") return [anchor];
  if (view === "week") {
    const start = startOfWeek(anchor);
    return Array.from({ length: 7 }, (_, index) => addDays(start, index));
  }
  return monthCells(anchor).flat();
}

export function monthCells(anchor: string) {
  const first = `${anchor.slice(0, 7)}-01`;
  const start = startOfWeek(first);
  const [year, month] = first.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const cells: string[] = [];
  let cursor = start;
  while (cells.length < 42) {
    cells.push(cursor);
    if (cursor >= last && cells.length % 7 === 0) break;
    cursor = addDays(cursor, 1);
  }
  const weeks: string[][] = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return weeks;
}

export function clockLabel(minute: number) {
  const normalized = ((minute % (24 * 60)) + 24 * 60) % (24 * 60);
  const hour24 = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour = hour24 % 12 || 12;
  return `${hour}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

export function zonedClock(value: string, timeZone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(date);
}

export function todayKey(timeZone: string, now = new Date()) {
  return zonedParts(now, timeZone).dateKey;
}

const statusClass: Record<string, string> = {
  pending: "border-[#e2c2a4] bg-[#f3e2d4] text-accent-dark",
  accepted: "border-[#b7d8cf] bg-[#dceee6] text-[#1f6f6a]",
  declined: "border-[#efcfc3] bg-[#f8e4dc] text-accent-dark",
  completed: "border-ink bg-ink text-white",
  cancelled: "border-line bg-sand text-ink/60 line-through",
  expired: "border-line bg-sand text-ink/60",
};

export function calendarStatusClass(status: string) {
  return statusClass[normalizeBookingStatus(status)] ?? statusClass.pending;
}

export function calendarScope(input: {
  audience: "customer" | "provider";
  sessionUserId: string;
  ownedProviderId: string | null;
  searchParams: { customerId?: string; providerId?: string; bookingId?: string };
}) {
  return {
    customerId: input.audience === "customer" ? input.sessionUserId : null,
    providerId: input.audience === "provider" ? input.ownedProviderId : null,
  };
}

export function appointmentDetailPath(audience: "customer" | "provider", bookingId: string) {
  return audience === "customer" ? `/account#booking-${bookingId}` : `/dashboard#booking-${bookingId}`;
}

export function appointmentMessagePath(bookingId: string) {
  return `/account/messages/${bookingId}`;
}

function startOfWeek(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addDays(dateKey, -weekday);
}

function addDays(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}

function addMonths(dateKey: string, months: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}
