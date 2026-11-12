import type { Metadata } from "next";
import { payoutLabel } from "@/lib/payments/guards";
import { formatUsd } from "@/lib/payments/money";
import { shownError } from "@/lib/public-error";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Manual review · BlockBooked" };

type ReviewRow = {
  id: string;
  preferred_date: string;
  time_window: string;
  service_name: string | null;
  review_note: string | null;
  review_requested_at: string;
  customer_id: string;
  provider_id: string;
};

export default async function AdminReviewsPage() {
  const { supabase } = await requireAdmin("/admin/reviews");
  const reviews = await supabase
    .from("booking_requests")
    .select("id, preferred_date, time_window, service_name, review_note, review_requested_at, customer_id, provider_id")
    .eq("status", "accepted")
    .not("review_requested_at", "is", null)
    .order("review_requested_at", { ascending: true });
  const rows = (reviews.data ?? []) as ReviewRow[];
  const customerIds = [...new Set(rows.map((row) => row.customer_id))];
  const providerIds = [...new Set(rows.map((row) => row.provider_id))];
  const bookingIds = rows.map((row) => row.id);
  const [customers, providers, appointments, payments] = await Promise.all([
    customerIds.length ? supabase.from("profiles").select("id, full_name").in("id", customerIds) : Promise.resolve({ data: [], error: null }),
    providerIds.length ? supabase.from("providers").select("id, business_name, timezone").in("id", providerIds) : Promise.resolve({ data: [], error: null }),
    bookingIds.length ? supabase.from("booking_appointments").select("booking_id, starts_at").in("booking_id", bookingIds) : Promise.resolve({ data: [], error: null }),
    bookingIds.length ? supabase.from("payments").select("booking_id, status, transfer_status, amount_cents, refunded_cents").in("booking_id", bookingIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const error = reviews.error || customers.error || providers.error || appointments.error || payments.error;
  const customerName = new Map(((customers.data ?? []) as { id: string; full_name: string }[]).map((row) => [row.id, row.full_name]));
  const providerName = new Map(((providers.data ?? []) as { id: string; business_name: string }[]).map((row) => [row.id, row.business_name]));
  const appointment = new Map(((appointments.data ?? []) as { booking_id: string; starts_at: string }[]).map((row) => [row.booking_id, row.starts_at]));
  const payment = new Map(
    ((payments.data ?? []) as { booking_id: string; status: string; transfer_status: string; amount_cents: number; refunded_cents: number }[]).map(
      (row) => [row.booking_id, row],
    ),
  );

  return (
    <main>
      <h1 className="font-serif text-4xl tracking-tight text-ink">Manual review</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-ink/70">
        These accepted bookings were flagged because a customer PIN was not used. This queue does not mark a booking
        complete, reveal the PIN, or send a provider transfer.
      </p>
      {shownError(error?.message) ? <p className="mt-4 text-sm font-medium text-accent-dark">{shownError(error?.message)}</p> : null}
      <ul className="mt-6 grid gap-4">
        {rows.length === 0 ? (
          <li className="rounded-3xl border border-dashed border-line bg-card px-5 py-8 text-sm text-ink/70">
            No completion reviews are waiting.
          </li>
        ) : (
          rows.map((row) => {
            const paid = payment.get(row.id);
            return (
              <li key={row.id} className="rounded-3xl border border-line bg-card p-5">
                <p className="font-semibold text-ink">{row.service_name || "General request"}</p>
                <p className="mt-1 text-sm text-ink/75">
                  {customerName.get(row.customer_id) || "Customer"} · {providerName.get(row.provider_id) || "Provider"}
                </p>
                <p className="mt-1 text-sm text-ink/75">
                  {appointment.get(row.id) ?? `${row.preferred_date} · ${row.time_window}`}
                </p>
                <p className="mt-2 text-sm text-ink">
                  Booking accepted · payment {paid ? paid.status.replaceAll("_", " ") : "none"} · payout{" "}
                  {paid ? payoutLabel(paid.transfer_status) : "none"}
                  {paid ? ` · refunded ${formatUsd(paid.refunded_cents)} of ${formatUsd(paid.amount_cents)}` : ""}
                </p>
                <p className="mt-3 text-sm leading-6 text-ink/80">{row.review_note || "No note from the provider."}</p>
              </li>
            );
          })
        )}
      </ul>
    </main>
  );
}
