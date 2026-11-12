"use client";

import { useEffect, useState } from "react";
import { CalendarBoard } from "@/components/calendar-board";
import { readCalendarQuery, todayKey, type CalendarEvent } from "@/lib/calendar";

export function CustomerCalendar({
  events,
  view,
  date,
  error,
}: {
  events: CalendarEvent[];
  view?: string;
  date?: string;
  error?: string | null;
}) {
  const [timeZone, setTimeZone] = useState<string | null>(null);
  useEffect(() => {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setTimeZone(resolved || "UTC");
  }, []);
  if (!timeZone) {
    return <p className="mt-6 text-sm text-ink/70">Loading calendar…</p>;
  }
  const today = todayKey(timeZone);
  const selected = readCalendarQuery({ view, date, today });
  return (
    <>
      <p className="mt-3 text-sm text-ink/70">
        Today follows your time zone ({timeZone}). Each appointment time is labeled in the provider’s time zone. A request without a scheduled time stays on its preferred date and window.
      </p>
      <CalendarBoard audience="customer" events={events} view={selected.view} date={selected.date} today={today} error={error} />
    </>
  );
}
