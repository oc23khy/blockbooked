export type Visit = {
  id: string;
  start: number;
  end: number;
  bufferMinutes: number;
};

export type BusinessWindow = {
  weekday: number;
  opensMinute: number;
  closesMinute: number;
};

const weekdays: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function blockedEnd(visit: Visit) {
  return visit.end + visit.bufferMinutes * 60_000;
}

export function visitsConflict(left: Visit, right: Visit) {
  if (left.id === right.id) return false;
  return left.start < blockedEnd(right) && right.start < blockedEnd(left);
}

export function claimVisit(existing: Visit[], next: Visit) {
  if (existing.some((visit) => visitsConflict(visit, next))) return "conflict" as const;
  existing.push(next);
  return "booked" as const;
}

export function releaseVisit(existing: Visit[], bookingId: string, status: string) {
  if (status === "declined" || status === "cancelled" || status === "expired") {
    return existing.filter((visit) => visit.id !== bookingId);
  }
  return existing;
}

export function zonedParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(read("hour"));
  return {
    weekday: weekdays[read("weekday")] ?? -1,
    dateKey: `${read("year")}-${read("month")}-${read("day")}`,
    minuteOfDay: (hour === 24 ? 0 : hour) * 60 + Number(read("minute")),
    second: Number(read("second")),
  };
}

export function fitsBusinessHours(start: Date, end: Date, timeZone: string, windows: BusinessWindow[]) {
  const startParts = zonedParts(start, timeZone);
  const endParts = zonedParts(end, timeZone);
  if (startParts.dateKey !== endParts.dateKey || startParts.second !== 0 || endParts.second !== 0) return false;
  return windows.some(
    (window) =>
      window.weekday === startParts.weekday &&
      window.opensMinute <= startParts.minuteOfDay &&
      window.closesMinute >= endParts.minuteOfDay,
  );
}

export function matchesDuration(start: Date, end: Date, durationMinutes: number) {
  return end.getTime() - start.getTime() === durationMinutes * 60_000;
}

export type TimeRange = { start: number; end: number };

export function localInstants(dateKey: string, minuteOfDay: number, timeZone: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  if (!year || !month || !day || hour < 0 || hour > 23 || minute < 0 || minute > 59) return [];
  const found = new Map<number, Date>();
  for (let offset = -14; offset <= 14; offset += 1) {
    const candidate = new Date(Date.UTC(year, month - 1, day, hour - offset, minute));
    const parts = zonedParts(candidate, timeZone);
    if (parts.dateKey === dateKey && parts.minuteOfDay === minuteOfDay && parts.second === 0) {
      found.set(candidate.getTime(), candidate);
    }
  }
  return [...found.values()].sort((left, right) => left.getTime() - right.getTime());
}

function dateKeys(startKey: string, endKey: string) {
  const keys: string[] = [];
  const [year, month, day] = startKey.split("-").map(Number);
  const cursor = new Date(Date.UTC(year, month - 1, day));
  const [endYear, endMonth, endDay] = endKey.split("-").map(Number);
  const end = Date.UTC(endYear, endMonth - 1, endDay);
  while (cursor.getTime() <= end && keys.length < 120) {
    const key = cursor.toISOString().slice(0, 10);
    keys.push(key);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

export function openSlots(input: {
  timeZone: string;
  windows: BusinessWindow[];
  durationMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  busy: TimeRange[];
  timeOff: TimeRange[];
  now?: Date;
}) {
  if (input.durationMinutes < 15 || input.windows.length === 0) return [];
  const now = input.now ?? new Date();
  const earliest = now.getTime() + input.minNoticeMinutes * 60_000;
  const latest = now.getTime() + input.maxAdvanceDays * 86_400_000;
  const startKey = zonedParts(new Date(earliest), input.timeZone).dateKey;
  const endKey = zonedParts(new Date(latest), input.timeZone).dateKey;
  const slots: { start: string; end: string }[] = [];
  const reserved: TimeRange[] = [];

  for (const dateKey of dateKeys(startKey, endKey)) {
    const noon = localInstants(dateKey, 12 * 60, input.timeZone)[0];
    if (!noon) continue;
    const weekday = zonedParts(noon, input.timeZone).weekday;
    for (const window of input.windows.filter((item) => item.weekday === weekday)) {
      for (
        let minute = window.opensMinute;
        minute + input.durationMinutes <= window.closesMinute && slots.length < 240;
        minute += input.durationMinutes
      ) {
        for (const start of localInstants(dateKey, minute, input.timeZone)) {
          const end = start.getTime() + input.durationMinutes * 60_000;
          const blockedUntil = end + input.bufferMinutes * 60_000;
          if (start.getTime() < earliest || start.getTime() > latest) continue;
          if (!fitsBusinessHours(start, new Date(end), input.timeZone, [window])) continue;
          const overlaps = [...input.busy, ...input.timeOff, ...reserved].some(
            (range) => range.start < blockedUntil && start.getTime() < range.end,
          );
          if (overlaps) continue;
          reserved.push({ start: start.getTime(), end: blockedUntil });
          slots.push({ start: start.toISOString(), end: new Date(end).toISOString() });
        }
      }
    }
  }
  return slots;
}
