import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarBoard } from "@/components/calendar-board";
import { calendarScope, readCalendarQuery, todayKey } from "@/lib/calendar";
import { loadCalendar } from "@/lib/calendar-load";
import { shownError } from "@/lib/public-error";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Business calendar · BlockBooked" };
export const dynamic = "force-dynamic";

export default async function ProviderCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; date?: string; error?: string; customerId?: string; providerId?: string; bookingId?: string }>;
}) {
  const query = await searchParams;
  const session = await requireSession("/dashboard/calendar");
  if (session.profile.role !== "provider" && session.profile.role !== "admin") redirect("/list-your-business");
  const owned = await session.supabase.from("providers").select("id, timezone").eq("owner_id", session.user.id).maybeSingle();
  const timeZone = (owned.data?.timezone as string | undefined) || "America/Chicago";
  const scope = calendarScope({
    audience: "provider",
    sessionUserId: session.user.id,
    ownedProviderId: (owned.data?.id as string | undefined) ?? null,
    searchParams: query,
  });
  const loaded = scope.providerId
    ? await loadCalendar(session.supabase, session.user.id, "provider", scope.providerId)
    : { events: [], error: null, timeZone };
  const today = todayKey(timeZone);
  const selected = readCalendarQuery({ view: query.view, date: query.date, today });
  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <Link href="/dashboard" className="text-sm font-semibold text-accent-dark">Back to dashboard</Link>
      <p className="mt-3 text-sm text-ink/70">Times follow this business time zone ({timeZone}). The length of a visit is the stored start and end, not a default hour.</p>
      <CalendarBoard
        audience="provider"
        events={loaded.events}
        view={selected.view}
        date={selected.date}
        today={today}
        error={shownError(query.error) ?? shownError(loaded.error, "The calendar could not be loaded.")}
      />
    </main>
  );
}
