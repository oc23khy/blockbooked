import type { SupabaseClient } from "@supabase/supabase-js";
import { eventsForViewer, type CalendarBooking } from "@/lib/calendar";

type BookingRow = {
  id: string;
  customer_id: string;
  provider_id: string;
  status: string;
  service_name: string | null;
  preferred_date: string;
  time_window: string;
  profiles?: { full_name: string | null } | { full_name: string | null }[] | null;
  providers?: { business_name: string | null; timezone: string | null; owner_id: string } | { business_name: string | null; timezone: string | null; owner_id: string }[] | null;
};

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

export async function loadCalendar(supabase: SupabaseClient, viewerId: string, audience: "customer" | "provider", providerId?: string) {
  let query = supabase
    .from("booking_requests")
    .select("id, customer_id, provider_id, status, service_name, preferred_date, time_window, profiles(full_name), providers(business_name, timezone, owner_id)");
  query = audience === "customer" ? query.eq("customer_id", viewerId) : query.eq("provider_id", providerId ?? "");
  const bookings = await query;
  if (bookings.error) return { events: [], error: bookings.error.message, timeZone: "America/Chicago" };
  const rows = (bookings.data ?? []) as BookingRow[];
  const ids = rows.map((row) => row.id);
  const appointments = ids.length
    ? await supabase.from("booking_appointments").select("booking_id, starts_at, ends_at").in("booking_id", ids)
    : { data: [], error: null };
  if (appointments.error) return { events: [], error: appointments.error.message, timeZone: "America/Chicago" };
  const times = new Map(
    ((appointments.data ?? []) as { booking_id: string; starts_at: string; ends_at: string }[]).map((row) => [row.booking_id, row]),
  );
  const records: CalendarBooking[] = rows.map((row) => {
    const provider = one(row.providers);
    const customer = one(row.profiles);
    const visit = times.get(row.id);
    return {
      id: row.id,
      customerId: row.customer_id,
      providerOwnerId: provider?.owner_id ?? (audience === "provider" ? viewerId : ""),
      providerId: row.provider_id,
      status: row.status,
      serviceName: row.service_name ?? "Service",
      preferredDate: row.preferred_date,
      timeWindow: row.time_window,
      customerName: customer?.full_name ?? "Customer",
      providerName: provider?.business_name ?? "Provider",
      timeZone: provider?.timezone || "America/Chicago",
      startsAt: visit?.starts_at ?? null,
      endsAt: visit?.ends_at ?? null,
    };
  });
  const timeZone = audience === "provider" ? records[0]?.timeZone || "America/Chicago" : "America/Chicago";
  return { events: eventsForViewer(records, viewerId, audience), error: null, timeZone };
}
