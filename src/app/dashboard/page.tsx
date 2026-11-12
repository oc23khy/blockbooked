import type { Metadata } from "next";
import { ProviderEditor } from "@/components/provider-editor";
import { ScheduleManager } from "@/components/schedule-manager";
import { BookingCard, type BookingView } from "@/components/booking-card";
import { connectStripeAccount } from "@/app/actions/payments";
import { refreshConnectedAccount } from "@/lib/payments/service";
import { stripeTestKeyConfigured } from "@/lib/payments/stripe-server";
import { isServiceRoleConfigured } from "@/lib/supabase/admin";
import type { ProviderRow } from "@/lib/providers";
import { displayedDeadline } from "@/lib/scheduling/expiration";
import { shownError } from "@/lib/public-error";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Provider dashboard · BlockBooked" };

type ProviderBooking = {
  id: string;
  preferred_date: string;
  time_window: string;
  notes: string;
  contact_phone: string;
  service_name: string | null;
  status: string;
  completed_at?: string | null;
  review_requested_at?: string | null;
  acceptance_deadline?: string | null;
  expiration_grace?: boolean | null;
  profiles:
    | { full_name: string; phone: string; email: string }
    | { full_name: string; phone: string; email: string }[]
    | null;
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; stripe?: string }>;
}) {
  const query = await searchParams;
  const { supabase, user } = await requireSession("/dashboard");
  const { data: provider } = await supabase
    .from("providers")
    .select("*")
    .eq("owner_id", user.id)
    .maybeSingle();
  const listing = (provider as ProviderRow | null) ?? null;
  if (listing && (query.stripe === "return" || query.stripe === "refresh")) {
    await refreshConnectedAccount(listing.id);
  }
  const stripeAccount = listing
    ? await supabase.from("provider_stripe_accounts").select("*").eq("provider_id", listing.id).maybeSingle()
    : { data: null, error: null };
  const paymentsReady = stripeTestKeyConfigured() && isServiceRoleConfigured();
  let liveStripe: Awaited<ReturnType<typeof refreshConnectedAccount>> = null;
  let liveStripeError: string | null = null;
  if (listing && paymentsReady) {
    try {
      liveStripe = await refreshConnectedAccount(listing.id);
    } catch (error) {
      liveStripeError = shownError(error instanceof Error ? error.message : "Stripe account status could not be loaded.", "Stripe account status could not be loaded.");
    }
  }

  const requestQuery = listing
    ? await supabase
        .from("booking_requests")
        .select(
          "id, preferred_date, time_window, notes, contact_phone, service_name, status, completed_at, review_requested_at, acceptance_deadline, expiration_grace, profiles(full_name, phone, email)",
        )
        .eq("provider_id", listing.id)
        .order("created_at", { ascending: false })
    : { data: [], error: null };
  const legacyRequestQuery =
    listing && requestQuery.error
      ? await supabase
          .from("booking_requests")
          .select("id, preferred_date, time_window, notes, contact_phone, service_name, status, profiles(full_name, phone, email)")
          .eq("provider_id", listing.id)
          .order("created_at", { ascending: false })
      : null;
  const requestRows = legacyRequestQuery?.data ?? requestQuery.data;
  const requestError = legacyRequestQuery?.error ?? (legacyRequestQuery ? null : requestQuery.error);
  const bookingIds = ((requestRows ?? []) as { id: string }[]).map((request) => request.id);
  const paymentQuery =
    bookingIds.length > 0
      ? await supabase
          .from("payments")
          .select("booking_id, status, amount_cents, provider_share_cents, transfer_status, milestone_id")
          .in("booking_id", bookingIds)
      : { data: [], error: null };
  const paymentRows = paymentQuery.error
    ? []
    : ((paymentQuery.data ?? []) as {
        booking_id: string;
        status: string;
        amount_cents: number;
        provider_share_cents: number;
        transfer_status: string;
        milestone_id: string | null;
      }[]);
  const planQuery =
    bookingIds.length > 0
      ? await supabase.from("booking_payment_plans").select("booking_id, plan").in("booking_id", bookingIds)
      : { data: [], error: null };
  const quoteQuery =
    bookingIds.length > 0
      ? await supabase.from("booking_quotes").select("booking_id, amount_cents, status").in("booking_id", bookingIds)
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
  const payments = new Map(paymentRows.map((payment) => [payment.booking_id, payment]));
  const appointmentQuery =
    listing && bookingIds.length > 0
      ? await supabase.from("booking_appointments").select("booking_id, starts_at, status").in("booking_id", bookingIds)
      : { data: [], error: null };
  const appointments = new Map(
    ((appointmentQuery.error ? [] : appointmentQuery.data) ?? []).map((row) => [row.booking_id as string, row]),
  );
  const rescheduleQuery =
    bookingIds.length > 0
      ? await supabase
          .from("booking_reschedule_requests")
          .select("id, booking_id, starts_at, status, price_adjustment_required")
          .in("booking_id", bookingIds)
          .order("created_at", { ascending: false })
      : { data: [], error: null };
  const reschedules = new Map<string, BookingView["rescheduleRequests"]>();
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
  const schedule = listing
    ? await Promise.all([
        supabase.from("provider_business_hours").select("weekday, opens_minute, closes_minute").eq("provider_id", listing.id),
        supabase.from("provider_services").select("id, name, description, pricing_type, price_cents, duration_minutes, active").eq("provider_id", listing.id).order("sort_order"),
        supabase.from("provider_schedule_settings").select("min_notice_minutes, max_advance_days, buffer_minutes").eq("provider_id", listing.id).maybeSingle(),
        supabase.from("provider_time_off").select("id, starts_at, ends_at, note").eq("provider_id", listing.id).order("starts_at"),
        supabase.from("provider_images").select("storage_path, caption").eq("provider_id", listing.id).order("sort_order"),
      ])
    : null;
  const scheduleError = shownError(schedule?.find((result) => result.error)?.error?.message, "The schedule could not be loaded.");
  const history = ((requestRows ?? []) as ProviderBooking[]).map((request) => {
    const customer = Array.isArray(request.profiles) ? request.profiles[0] : request.profiles;
    return {
      id: request.id,
      preferredDate: request.preferred_date,
      timeWindow: request.time_window,
      serviceName: request.service_name ?? "",
      notes: request.notes,
      contactPhone: request.contact_phone || customer?.phone || "",
      contactEmail: customer?.email ?? "",
      customerName: customer?.full_name || "Customer",
      providerName: listing?.business_name ?? "",
      status: request.status,
      reviewRequested: Boolean(request.review_requested_at),
      completedAt: request.completed_at,
      paymentStatus: payments.get(request.id)?.status ?? null,
      paymentAmountCents: payments.get(request.id)?.amount_cents ?? null,
      providerShareCents: payments.get(request.id)?.provider_share_cents ?? null,
      transferStatus: payments.get(request.id)?.transfer_status ?? null,
      paymentPlan: plans.get(request.id) ?? null,
      quoteAmountCents: quotes.get(request.id)?.amount_cents ?? null,
      quoteStatus: quotes.get(request.id)?.status ?? null,
      appointmentStart: (appointments.get(request.id)?.starts_at as string | undefined) ?? null,
      timeZone: listing?.timezone ?? "America/Chicago",
      acceptanceDeadline: displayedDeadline(
        request.acceptance_deadline ?? null,
        (appointments.get(request.id)?.starts_at as string | undefined) ?? null,
        Boolean(request.expiration_grace),
      ),
      rescheduleRequests: reschedules.get(request.id) ?? [],
    } satisfies BookingView;
  });
  const now = Date.now();
  const upcoming = history.filter(
    (booking) =>
      booking.appointmentStart &&
      Date.parse(booking.appointmentStart) >= now &&
      (booking.status === "pending" || booking.status === "accepted"),
  );
  const earlier = history.filter((booking) => !upcoming.some((item) => item.id === booking.id));

  const formError = shownError(query.error);
  return (
    <main className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[1.15fr_0.85fr]">
      <section>
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-accent-dark">
          Provider dashboard
        </p>
        <h1 className="mt-2 font-serif text-5xl tracking-tight text-ink">Your business</h1>
        <p className="mt-3 max-w-xl text-ink/70">
          {listing
            ? `Status: ${listing.status}. ${
                listing.status === "approved"
                  ? "Customers can find this listing."
                  : "This listing stays off the public site until an admin approves it."
              }`
            : "Submit your services, prices, availability, and towns. An admin reviews the application before it appears publicly."}
        </p>
        {listing?.review_note ? (
          <p className="mt-4 rounded-2xl border border-line bg-card px-4 py-3 text-sm text-ink">
            Review note: {listing.review_note}
          </p>
        ) : null}
        {query.notice ? <p className="mt-4 text-sm font-medium text-ink">{query.notice}</p> : null}
        {formError ? <p className="mt-4 text-sm font-medium text-accent-dark">{formError}</p> : null}
        <div className="mt-6 rounded-3xl border border-line bg-card p-5">
          <h2 className="font-serif text-2xl text-ink">Stripe payouts</h2>
          <p className="mt-2 text-sm leading-6 text-ink/70">
            Customers pay BlockBooked securely through Stripe. BlockBooked retains an 8% commission,
            and your share is transferred after the service is verified. Stripe test mode does not send real payouts.
          </p>
          {stripeAccount.error || liveStripeError ? (
            <p className="mt-3 text-sm font-medium text-accent-dark">{liveStripeError ?? shownError(stripeAccount.error?.message, "Stripe account status could not be loaded.")}</p>
          ) : (
            <p className="mt-3 text-sm text-ink">
              {liveStripe?.readyToReceivePayments
                ? "Payout eligible. Transfers are created only after verified completion."
                : liveStripe?.stripe_account_id
                  ? `Onboarding is incomplete${liveStripe.requirementsStatus ? ` (${liveStripe.requirementsStatus.replaceAll("_", " ")})` : ""}.`
                  : "No Stripe account is connected."}
            </p>
          )}
          {listing?.status === "approved" && paymentsReady ? (
            <form action={connectStripeAccount} className="mt-4">
              <button type="submit" className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">
                {liveStripe?.stripe_account_id ? "Continue Stripe onboarding" : "Onboard to collect payments"}
              </button>
            </form>
          ) : (
            <p className="mt-3 text-sm text-ink/70">
              {listing?.status === "approved"
                ? "Add the Stripe test keys before connecting an account."
                : "Stripe onboarding opens after an admin approves this listing."}
            </p>
          )}
        </div>
        <div className="mt-6">
          <ProviderEditor provider={listing} />
        </div>
        {listing && schedule ? (
          <div className="mt-6">
            {scheduleError ? <p className="mb-3 text-sm font-medium text-accent-dark">{scheduleError}</p> : null}
            <ScheduleManager
              hours={schedule[0].error ? [] : (schedule[0].data ?? [])}
              services={schedule[1].error ? [] : (schedule[1].data ?? [])}
              settings={schedule[2].error ? null : schedule[2].data}
              timeOff={schedule[3].error ? [] : (schedule[3].data ?? [])}
              images={schedule[4].error ? [] : (schedule[4].data ?? [])}
              timeZone={listing.timezone ?? "America/Chicago"}
            />
          </div>
        ) : null}
      </section>
      <section>
        <h2 className="font-serif text-3xl text-ink">Upcoming appointments</h2>
        <p className="mt-2 text-sm text-ink/70">
          Accept or decline pending requests. Accepting confirms the held time. An accepted booking is completed only when the customer gives you their PIN.
        </p>
        {requestError ? (
          <p className="mt-4 text-sm font-medium text-accent-dark">{requestError.message}</p>
        ) : null}
        <ul className="mt-4 grid gap-3">
          {upcoming.length === 0 ? (
            <li className="rounded-3xl border border-dashed border-line bg-card px-5 py-8 text-sm text-ink/70">
              No upcoming appointments.
            </li>
          ) : (
            upcoming.map((booking) => <BookingCard key={booking.id} booking={booking} audience="provider" />)
          )}
        </ul>
        <h2 className="mt-8 font-serif text-3xl text-ink">Earlier requests</h2>
        <ul className="mt-4 grid gap-3">
          {earlier.length === 0 ? (
            <li className="rounded-3xl border border-dashed border-line bg-card px-5 py-8 text-sm text-ink/70">
              No earlier requests.
            </li>
          ) : (
            earlier.map((booking) => <BookingCard key={booking.id} booking={booking} audience="provider" />)
          )}
        </ul>
      </section>
    </main>
  );
}
