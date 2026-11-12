import type { Metadata } from "next";
import Link from "next/link";
import { CustomerCalendar } from "@/components/customer-calendar";
import { calendarScope } from "@/lib/calendar";
import { loadCalendar } from "@/lib/calendar-load";
import { shownError } from "@/lib/public-error";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Calendar · BlockBooked" };
export const dynamic = "force-dynamic";

export default async function CustomerCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; date?: string; error?: string; customerId?: string; providerId?: string; bookingId?: string }>;
}) {
  const query = await searchParams;
  const { supabase, user } = await requireSession("/account/calendar");
  const scope = calendarScope({
    audience: "customer",
    sessionUserId: user.id,
    ownedProviderId: null,
    searchParams: query,
  });
  const loaded = await loadCalendar(supabase, scope.customerId ?? user.id, "customer");
  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <Link href="/account" className="text-sm font-semibold text-accent-dark">Back to account</Link>
      <CustomerCalendar
        events={loaded.events}
        view={query.view}
        date={query.date}
        error={shownError(query.error) ?? shownError(loaded.error, "The calendar could not be loaded.")}
      />
    </main>
  );
}
