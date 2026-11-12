import type { Metadata } from "next";
import Link from "next/link";
import { updateProfile } from "@/app/actions/auth";
import { BookingCard, type BookingView } from "@/components/booking-card";
import { accountPaymentNotice } from "@/lib/payments/account-notice";
import { shownError } from "@/lib/public-error";
import { displayedDeadline } from "@/lib/scheduling/expiration";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Your account · BlockBooked" };
export const dynamic = "force-dynamic";

type CustomerBooking = {
  id: string;
  preferred_date: string;
  time_window: string;
  notes: string;
  contact_phone: string;
  service_name: string | null;
  status: string;
  completed_at?: string | null;
  review_requested_at?: string | null;
  created_at?: string;
  acceptance_deadline?: string | null;
  expiration_grace?: boolean | null;
  providers: { business_name: string; timezone?: string } | { business_name: string; timezone?: string }[] | null;
};

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; checkout?: string }>;
}) {
  const query = await searchParams;
  const { supabase, profile } = await requireSession("/account");
  const bookingQuery = await supabase
    .from("booking_requests")
    .select(
      "id, preferred_date, time_window, notes, contact_phone, service_name, status, completed_at, review_requested_at, created_at, acceptance_deadline, expiration_grace, providers(business_name, timezone)",
    )
    .eq("customer_id", profile.id)
    .order("created_at", { ascending: false });
  const legacyBookingQuery = bookingQuery.error
    ? await supabase
        .from("booking_requests")
        .select("id, preferred_date, time_window, notes, contact_phone, service_name, status, providers(business_name)")
        .eq("customer_id", profile.id)
        .order("created_at", { ascending: false })
    : null;
  const bookings = legacyBookingQuery?.data ?? bookingQuery.data;
  const error = legacyBookingQuery?.error ?? (legacyBookingQuery ? null : bookingQuery.error);
  const rows = (bookings ?? []) as CustomerBooking[];
  const pinQuery =
    !legacyBookingQuery && rows.length > 0
      ? await supabase
          .from("customer_completion_pins")
          .select("booking_id, pin_code")
          .in(
            "booking_id",
            rows.map((booking) => booking.id),
          )
      : { data: [], error: null };
  const paymentQuery =
    rows.length > 0
      ? await supabase
          .from("payments")
          .select("booking_id, status, amount_cents, provider_share_cents, transfer_status, milestone_id")
          .in(
            "booking_id",
            rows.map((booking) => booking.id),
          )
      : { data: [], error: null };
  const paymentRows = paymentQuery.error ? [] : ((paymentQuery.data ?? []) as {
    booking_id: string;
    status: string;
    amount_cents: number;
    provider_share_cents: number;
    transfer_status: string;
    milestone_id: string | null;
  }[]);
  const bookingIds = rows.map((booking) => booking.id);
  const planQuery =
    bookingIds.length > 0
      ? await supabase.from("booking_payment_plans").select("booking_id, plan").in("booking_id", bookingIds)
      : { data: [], error: null };
  const quoteQuery =
    bookingIds.length > 0
      ? await supabase.from("booking_quotes").select("booking_id, amount_cents, status").in("booking_id", bookingIds)
      : { data: [], error: null };
  const milestoneQuery =
    bookingIds.length > 0
      ? await supabase.from("booking_milestones").select("id, booking_id").in("booking_id", bookingIds)
      : { data: [], error: null };
  const plans = new Map(
    ((planQuery.error ? [] : (planQuery.data ?? [])) as { booking_id: string; plan: string }[]).map((plan) => [
      plan.booking_id,
      plan.plan,
    ]),
  );
  const quotes = new Map(
    ((quoteQuery.error ? [] : (quoteQuery.data ?? [])) as { booking_id: string; amount_cents: number; status: string }[]).map(
      (quote) => [quote.booking_id, quote],
    ),
  );
  const milestones = (milestoneQuery.error ? [] : (milestoneQuery.data ?? [])) as { id: string; booking_id: string }[];
  const payments = new Map(paymentRows.map((payment) => [payment.booking_id, payment]));
  const appointmentQuery =
    bookingIds.length > 0
      ? await supabase.from("booking_appointments").select("booking_id, starts_at").in("booking_id", bookingIds)
      : { data: [], error: null };
  const appointmentStarts = new Map(
    ((appointmentQuery.error ? [] : appointmentQuery.data) ?? []).map((row) => [
      row.booking_id as string,
      row.starts_at as string,
    ]),
  );
  const rescheduleQuery =
    bookingIds.length > 0
      ? await supabase
          .from("booking_reschedule_requests")
          .select("id, booking_id, starts_at, status, price_adjustment_required")
          .in("booking_id", bookingIds)
          .order("created_at", { ascending: false })
      : { data: [], error: null };
  const reschedules = new Map<string, NonNullable<BookingView["rescheduleRequests"]>>();
  for (const request of (rescheduleQuery.error ? [] : rescheduleQuery.data ?? []) as {
    id: string;
    booking_id: string;
    starts_at: string;
    status: string;
    price_adjustment_required: boolean;
  }[]) {
    const list = reschedules.get(request.booking_id) ?? [];
    list.push({
      id: request.id,
      startsAt: request.starts_at,
      status: request.status,
      priceAdjustmentRequired: request.price_adjustment_required,
    });
    reschedules.set(request.booking_id, list);
  }
  const pins = new Map(
    ((pinQuery.data ?? []) as { booking_id: string; pin_code: string | null }[]).map((pin) => [
      pin.booking_id,
      pin.pin_code,
    ]),
  );
  const history = rows.map((booking) => {
    const related = Array.isArray(booking.providers) ? booking.providers[0] : booking.providers;
    return {
      id: booking.id,
      preferredDate: booking.preferred_date,
      timeWindow: booking.time_window,
      serviceName: booking.service_name ?? "",
      notes: booking.notes,
      contactPhone: booking.contact_phone,
      contactEmail: profile.email,
      customerName: profile.full_name || profile.email,
      providerName: related?.business_name ?? "Provider",
      status: booking.status,
      completionPin: pins.get(booking.id) ?? null,
      reviewRequested: Boolean(booking.review_requested_at),
      completedAt: booking.completed_at,
      paymentStatus: payments.get(booking.id)?.status ?? null,
      paymentAmountCents: payments.get(booking.id)?.amount_cents ?? null,
      paymentPlan: plans.get(booking.id) ?? null,
      quoteAmountCents: quotes.get(booking.id)?.amount_cents ?? null,
      quoteStatus: quotes.get(booking.id)?.status ?? null,
      appointmentStart: appointmentStarts.get(booking.id) ?? null,
      timeZone: related?.timezone ?? "America/Chicago",
      acceptanceDeadline: displayedDeadline(
        booking.acceptance_deadline ?? null,
        appointmentStarts.get(booking.id) ?? null,
        Boolean(booking.expiration_grace),
      ),
      rescheduleRequests: reschedules.get(booking.id) ?? [],
      needsPayment:
        booking.status !== "cancelled" &&
        booking.status !== "declined" &&
        booking.status !== "completed" &&
        booking.status !== "expired" &&
        (paymentRows.some(
          (payment) =>
            payment.booking_id === booking.id &&
            (payment.status === "requires_payment" || payment.status === "failed" || payment.status === "canceled"),
        ) ||
          ((quotes.get(booking.id)?.status === "offered" || quotes.get(booking.id)?.status === "accepted") &&
            !paymentRows.some(
              (payment) =>
                payment.booking_id === booking.id &&
                (payment.status === "succeeded" || payment.status === "partially_refunded"),
            )) ||
          milestones.some(
            (milestone) =>
              milestone.booking_id === booking.id &&
              !paymentRows.some((payment) => payment.milestone_id === milestone.id),
          )),
    } satisfies BookingView;
  });

  return (
    <main className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 lg:grid-cols-2">
      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="font-serif text-5xl tracking-tight text-ink">Your account</h1>
          <div className="flex gap-2">
            <Link href="/account/calendar" className="rounded-full border border-ink px-4 py-2 text-sm font-semibold text-ink">
              Calendar
            </Link>
            <Link href="/account/messages" className="rounded-full border border-ink px-4 py-2 text-sm font-semibold text-ink">
              Messages
            </Link>
          </div>
        </div>
        <p className="mt-3 text-ink/70">
          Signed in as {profile.email}. Role: {profile.role}.
        </p>
        {accountPaymentNotice({ notice: query.notice, checkout: query.checkout, bookings: history }) ? (
          <p className="mt-4 text-sm font-medium text-ink">
            {accountPaymentNotice({ notice: query.notice, checkout: query.checkout, bookings: history })}
          </p>
        ) : null}
        {shownError(query.error) ? <p className="mt-4 text-sm font-medium text-accent-dark">{shownError(query.error)}</p> : null}
        <form action={updateProfile} className="mt-6 grid gap-3 rounded-3xl border border-line bg-card p-6">
          <label className="block text-sm font-medium text-ink">
            Full name
            <input
              name="fullName"
              defaultValue={profile.full_name}
              required
              className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5 outline-none focus:border-ink"
            />
          </label>
          <label className="block text-sm font-medium text-ink">
            Phone
            <input
              name="phone"
              type="tel"
              defaultValue={profile.phone}
              className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5 outline-none focus:border-ink"
            />
          </label>
          <label className="block text-sm font-medium text-ink">
            Email
            <input
              defaultValue={profile.email}
              readOnly
              className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5 text-ink/60"
            />
          </label>
          <button
            type="submit"
            className="mt-2 rounded-full bg-ink px-4 py-3 text-sm font-semibold text-white"
          >
            Save profile
          </button>
        </form>
      </section>
      <section>
        <h2 className="font-serif text-3xl text-ink">Booking history</h2>
        <p className="mt-2 text-sm text-ink/70">
          Pending requests can be cancelled here. After a provider accepts, your completion PIN appears on that booking.
          Share it only after the service is finished to your satisfaction.
        </p>
        {error || pinQuery.error ? (
          <p className="mt-4 text-sm font-medium text-accent-dark">{error?.message || pinQuery.error?.message}</p>
        ) : null}
        <ul className="mt-4 grid gap-3">
          {history.length === 0 ? (
            <li className="rounded-3xl border border-dashed border-line bg-card px-5 py-8 text-sm text-ink/70">
              You have not requested a time yet.{" "}
              <Link href="/#providers" className="font-semibold text-accent-dark">
                Browse providers
              </Link>
            </li>
          ) : (
            history.map((booking) => <BookingCard key={booking.id} booking={booking} audience="customer" />)
          )}
        </ul>
      </section>
    </main>
  );
}
