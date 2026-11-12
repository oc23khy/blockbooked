import type { SupabaseClient } from "@supabase/supabase-js";
import { customerFacingError } from "../public-error.ts";

export type AdminBookingRecord = {
  id: string;
  status: string;
  serviceName: string;
  preferredDate: string;
  timeWindow: string;
  appointment: string | null;
  customerName: string;
  providerName: string;
  paymentStatus: string;
  payoutStatus: string;
};

type BookingRow = {
  id: string;
  status: string;
  service_name: string | null;
  preferred_date: string;
  time_window: string;
  customer_id: string;
  provider_id: string;
};

export function appointmentLabel(startsAt: string | null, timeZone: string) {
  if (!startsAt) return null;
  const parsed = new Date(startsAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || "America/Chicago",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

export function filterAdminBookings(
  records: AdminBookingRecord[],
  filters: { query?: string; status?: string; payment?: string; payout?: string },
) {
  const query = filters.query?.trim().toLowerCase() ?? "";
  return records.filter((record) => {
    if (filters.status && record.status !== filters.status) return false;
    if (filters.payment && record.paymentStatus !== filters.payment) return false;
    if (filters.payout && record.payoutStatus !== filters.payout) return false;
    if (!query) return true;
    return [record.customerName, record.providerName, record.serviceName, record.id, record.appointment ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
}

export async function loadAdminBookings(supabase: SupabaseClient) {
  const bookings = await supabase
    .from("booking_requests")
    .select("id, status, service_name, preferred_date, time_window, customer_id, provider_id, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (bookings.error) return { records: [] as AdminBookingRecord[], error: customerFacingError(bookings.error.message, "Bookings could not be loaded.") };

  const rows = (bookings.data ?? []) as BookingRow[];
  const bookingIds = rows.map((row) => row.id);
  const customerIds = [...new Set(rows.map((row) => row.customer_id))];
  const providerIds = [...new Set(rows.map((row) => row.provider_id))];
  const [customers, providers, appointments, payments] = await Promise.all([
    customerIds.length
      ? supabase.from("profiles").select("id, full_name").in("id", customerIds)
      : Promise.resolve({ data: [], error: null }),
    providerIds.length
      ? supabase.from("providers").select("id, business_name, timezone").in("id", providerIds)
      : Promise.resolve({ data: [], error: null }),
    bookingIds.length
      ? supabase.from("booking_appointments").select("booking_id, starts_at, status").in("booking_id", bookingIds)
      : Promise.resolve({ data: [], error: null }),
    bookingIds.length
      ? supabase.from("payments").select("booking_id, status, transfer_status").in("booking_id", bookingIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const error = customers.error?.message || providers.error?.message || appointments.error?.message || payments.error?.message;
  if (error) return { records: [] as AdminBookingRecord[], error: customerFacingError(error, "Bookings could not be loaded.") };

  const customerName = new Map(((customers.data ?? []) as { id: string; full_name: string }[]).map((row) => [row.id, row.full_name]));
  const providerInfo = new Map(
    ((providers.data ?? []) as { id: string; business_name: string; timezone: string | null }[]).map((row) => [row.id, row]),
  );
  const appointmentByBooking = new Map(
    ((appointments.data ?? []) as { booking_id: string; starts_at: string; status: string }[]).map((row) => [row.booking_id, row]),
  );
  const paymentByBooking = new Map(
    ((payments.data ?? []) as { booking_id: string; status: string; transfer_status: string }[]).map((row) => [row.booking_id, row]),
  );

  return {
    error: null,
    records: rows.map((row) => {
      const provider = providerInfo.get(row.provider_id);
      const visit = appointmentByBooking.get(row.id);
      const payment = paymentByBooking.get(row.id);
      return {
        id: row.id,
        status: row.status,
        serviceName: row.service_name || "General request",
        preferredDate: row.preferred_date,
        timeWindow: row.time_window,
        appointment: visit ? appointmentLabel(visit.starts_at, provider?.timezone || "America/Chicago") : null,
        customerName: customerName.get(row.customer_id) || "Customer",
        providerName: provider?.business_name || "Provider",
        paymentStatus: payment?.status ?? "none",
        payoutStatus: payment?.transfer_status ?? "none",
      } satisfies AdminBookingRecord;
    }),
  };
}
