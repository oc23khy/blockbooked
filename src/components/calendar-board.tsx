import Link from "next/link";
import {
  appointmentDetailPath,
  appointmentMessagePath,
  calendarStatusClass,
  clockLabel,
  eventsOnDates,
  monthCells,
  shiftDate,
  visibleDateKeys,
  zonedClock,
  type CalendarEvent,
  type CalendarView,
} from "@/lib/calendar";

const gridStart = 7 * 60;
const gridEnd = 20 * 60;

export function CalendarBoard({
  audience,
  events,
  view,
  date,
  today,
  error,
}: {
  audience: "customer" | "provider";
  events: CalendarEvent[];
  view: CalendarView;
  date: string;
  today: string;
  error?: string | null;
}) {
  const base = audience === "customer" ? "/account/calendar" : "/dashboard/calendar";
  const href = (nextView: CalendarView, nextDate: string) => `${base}?view=${nextView}&date=${nextDate}`;
  const dates = visibleDateKeys(view, date);
  const visible = eventsOnDates(events, dates);
  const heading = view === "day" ? formatDay(date) : view === "week" ? `${formatDay(dates[0])} – ${formatDay(dates[6])}` : formatMonth(date);

  return (
    <section className="mt-6" aria-labelledby="calendar-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="calendar-heading" className="font-serif text-4xl tracking-tight text-ink sm:text-5xl">
          {heading}
        </h1>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Calendar navigation">
          <Link href={href(view, shiftDate(date, view, -1))} className="rounded-full border border-ink px-3 py-2 text-sm font-semibold text-ink" aria-label="Previous">
            Previous
          </Link>
          <Link href={href(view, today)} className="rounded-full border border-ink px-3 py-2 text-sm font-semibold text-ink" aria-label="Today">
            Today
          </Link>
          <Link href={href(view, shiftDate(date, view, 1))} className="rounded-full border border-ink px-3 py-2 text-sm font-semibold text-ink" aria-label="Next">
            Next
          </Link>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Calendar view">
        {(["month", "week", "day"] as CalendarView[]).map((option) => (
          <Link
            key={option}
            href={href(option, date)}
            aria-current={option === view ? "page" : undefined}
            className={`rounded-full px-3 py-2 text-sm font-semibold capitalize ${option === view ? "bg-ink text-white" : "border border-line text-ink"}`}
          >
            {option}
          </Link>
        ))}
      </div>
      {error ? <p className="mt-4 text-sm font-medium text-accent-dark">{error}</p> : null}
      {events.length === 0 && !error ? (
        <p className="mt-6 rounded-3xl border border-dashed border-line bg-card px-4 py-8 text-sm text-ink/70">
          {audience === "customer" ? "No bookings yet. A request appears here as soon as it is created." : "No bookings for this business yet."}
        </p>
      ) : null}
      {events.length > 0 && visible.length === 0 && !error ? (
        <p className="mt-6 text-sm text-ink/70">Nothing is scheduled in this {view}.</p>
      ) : null}
      {view === "month" ? <MonthGrid audience={audience} anchor={date} events={events} /> : null}
      {view === "week" ? <WeekGrid audience={audience} dates={dates} events={visible} /> : null}
      {view === "day" ? <DayGrid audience={audience} date={date} events={visible} /> : null}
    </section>
  );
}

function MonthGrid({ audience, anchor, events }: { audience: "customer" | "provider"; anchor: string; events: CalendarEvent[] }) {
  const weeks = monthCells(anchor);
  const month = anchor.slice(0, 7);
  return (
    <div className="mt-6">
      <div className="grid grid-cols-7 gap-1 text-center text-xs font-semibold uppercase tracking-wide text-ink/50">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
          <div key={day}>{day}</div>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-7">
        {weeks.flat().map((day) => {
          const daily = eventsOnDates(events, [day]);
          const outside = !day.startsWith(month);
          return (
            <div key={day} className={`min-h-28 rounded-2xl border border-line p-2 ${outside ? "bg-sand/60" : "bg-card"}`}>
              <p className="text-xs font-semibold text-ink/60">{Number(day.slice(-2))}</p>
              <ul className="mt-1 grid gap-1">
                {daily.slice(0, 3).map((event) => (
                  <li key={event.id}>
                    <EventLink audience={audience} event={event} compact />
                  </li>
                ))}
              </ul>
              {daily.length > 3 ? <p className="mt-1 text-xs text-ink/60">+{daily.length - 3} more</p> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekGrid({ audience, dates, events }: { audience: "customer" | "provider"; dates: string[]; events: CalendarEvent[] }) {
  return (
    <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-7">
      {dates.map((day) => (
        <section key={day} aria-label={formatDay(day)} className="rounded-2xl border border-line bg-card p-2">
          <h2 className="text-sm font-semibold text-ink">{formatDay(day)}</h2>
          <ul className="mt-2 grid gap-2">
            {eventsOnDates(events, [day]).map((event) => (
              <li key={event.id}>
                <EventLink audience={audience} event={event} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function DayGrid({ audience, date, events }: { audience: "customer" | "provider"; date: string; events: CalendarEvent[] }) {
  const daily = eventsOnDates(events, [date]);
  const windows = daily.filter((event) => !event.timed);
  const timed = daily.filter((event) => event.timed);
  const outside = timed.filter((event) => (event.startMinute ?? 0) < gridStart || (event.startMinute ?? 0) >= gridEnd);
  const inside = timed.filter((event) => (event.startMinute ?? 0) >= gridStart && (event.startMinute ?? 0) < gridEnd);
  const hours = Array.from({ length: (gridEnd - gridStart) / 60 }, (_, index) => gridStart + index * 60);
  return (
    <div className="mt-6 grid gap-4">
      {windows.length > 0 ? (
        <ul className="grid gap-2">
          {windows.map((event) => (
            <li key={event.id}>
              <EventLink audience={audience} event={event} />
            </li>
          ))}
        </ul>
      ) : null}
      {outside.length > 0 ? (
        <ul className="grid gap-2">
          {outside.map((event) => (
            <li key={event.id}>
              <EventLink audience={audience} event={event} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="relative rounded-3xl border border-line bg-card" style={{ minHeight: `${hours.length * 3.5}rem` }}>
        {hours.map((minute) => (
          <div key={minute} className="flex h-14 border-b border-line/70">
            <span className="w-20 shrink-0 px-3 py-1 text-xs font-semibold text-ink/50">{clockLabel(minute)}</span>
          </div>
        ))}
        <div className="absolute inset-y-0 right-0 left-20">
          {inside.map((event, index) => {
            const start = event.startMinute ?? gridStart;
            const duration = event.durationMinutes;
            if (!duration) return null;
            const top = ((start - gridStart) / (gridEnd - gridStart)) * 100;
            const height = Math.max((duration / (gridEnd - gridStart)) * 100, 8);
            return (
              <div key={event.id} className="absolute px-1" style={{ top: `${top}%`, height: `${height}%`, left: `${(index % 3) * 33}%`, width: "32%" }}>
                <EventLink audience={audience} event={event} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function EventLink({ audience, event, compact = false }: { audience: "customer" | "provider"; event: CalendarEvent; compact?: boolean }) {
  const tone = calendarStatusClass(event.status);
  const when = event.timed && event.startsAt
    ? `${zonedClock(event.startsAt, event.timeZone)}${event.endsAt ? ` – ${zonedClock(event.endsAt, event.timeZone)}` : ""}`
    : event.windowLabel;
  return (
    <div className={`rounded-xl border px-2 py-1 ${tone}`}>
      <Link href={appointmentDetailPath(audience, event.id)} className="block text-sm font-semibold">
        <span className="sr-only">{event.statusLabel}. </span>
        {event.title}
        {compact ? null : <span className="mt-0.5 block text-xs font-medium">{event.serviceName}</span>}
        <span className="mt-0.5 block text-xs font-medium">{when}</span>
      </Link>
      {audience === "customer" && !compact ? (
        <Link href={appointmentMessagePath(event.id)} className="mt-1 inline-block text-xs font-semibold underline">
          Message provider
        </Link>
      ) : null}
    </div>
  );
}

function formatMonth(dateKey: string) {
  const [year, month] = dateKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function formatDay(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}
