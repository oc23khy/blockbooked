import type { Metadata } from "next";
import { bookingStatuses } from "@/lib/booking-status";
import { filterAdminBookings, loadAdminBookings } from "@/lib/admin/records";
import { payoutLabel } from "@/lib/payments/guards";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Admin bookings · BlockBooked" };

const paymentFilters = ["succeeded", "partially_refunded", "refunded", "requires_payment", "processing", "failed", "disputed", "canceled", "none"];
const payoutFilters = ["not_ready", "pending", "paid", "failed", "reversed", "partially_reversed", "none"];

export default async function AdminBookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; payment?: string; payout?: string }>;
}) {
  const query = await searchParams;
  const { supabase } = await requireAdmin("/admin/bookings");
  const loaded = await loadAdminBookings(supabase);
  const records = filterAdminBookings(loaded.records, query);

  return (
    <main>
      <h1 className="font-serif text-4xl tracking-tight text-ink">Bookings</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-ink/70">
        The latest 200 bookings visible to an administrator. This page does not refund, transfer, or complete a booking.
      </p>
      {loaded.error ? <p className="mt-4 text-sm font-medium text-accent-dark">{loaded.error}</p> : null}
      <form method="get" className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <input
          name="q"
          defaultValue={query.q ?? ""}
          placeholder="Customer, provider, or service"
          className="rounded-xl border border-line bg-sand px-3 py-2 text-sm outline-none focus:border-ink lg:col-span-2"
        />
        <select name="status" defaultValue={query.status ?? ""} className="rounded-xl border border-line bg-sand px-3 py-2 text-sm">
          <option value="">Any booking status</option>
          {bookingStatuses.map((status) => (
            <option key={status} value={status}>{status}</option>
          ))}
        </select>
        <select name="payment" defaultValue={query.payment ?? ""} className="rounded-xl border border-line bg-sand px-3 py-2 text-sm">
          <option value="">Any payment</option>
          {paymentFilters.map((status) => (
            <option key={status} value={status}>{status.replaceAll("_", " ")}</option>
          ))}
        </select>
        <select name="payout" defaultValue={query.payout ?? ""} className="rounded-xl border border-line bg-sand px-3 py-2 text-sm">
          <option value="">Any payout</option>
          {payoutFilters.map((status) => (
            <option key={status} value={status}>{status === "none" ? "none" : payoutLabel(status) || status}</option>
          ))}
        </select>
        <button type="submit" className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white sm:col-span-2 lg:col-span-1">
          Filter
        </button>
      </form>
      <ul className="mt-6 grid gap-3">
        {records.length === 0 ? (
          <li className="rounded-3xl border border-dashed border-line bg-card px-5 py-8 text-sm text-ink/70">No bookings match.</li>
        ) : (
          records.map((record) => (
            <li key={record.id} className="rounded-3xl border border-line bg-card p-5">
              <p className="font-semibold text-ink">{record.serviceName}</p>
              <p className="mt-1 text-sm text-ink/75">
                {record.customerName} · {record.providerName}
              </p>
              <p className="mt-1 text-sm text-ink/75">
                {record.appointment ?? `${record.preferredDate} · ${record.timeWindow}`}
              </p>
              <p className="mt-2 text-sm text-ink">
                Booking {record.status} · payment {record.paymentStatus.replaceAll("_", " ")} · payout{" "}
                {record.payoutStatus === "none" ? "none" : payoutLabel(record.payoutStatus)}
              </p>
            </li>
          ))
        )}
      </ul>
    </main>
  );
}
