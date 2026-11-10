import { createBooking } from "@/app/actions/bookings";
import { BookingStatusBadge } from "@/components/booking-status-badge";
import { normalizeBookingStatus } from "@/lib/booking-status";
import { appointmentLabel } from "@/lib/scheduling/booking";
import type { ServiceOffering } from "@/lib/marketplace";
import type { BookingRow } from "@/lib/providers";
import Link from "next/link";

export function BookingRequest({
  providerId,
  providerName,
  signedIn,
  existing,
  services,
  paymentsEnabled,
  error,
  notice,
  appointmentStart,
  timeZone = "America/Chicago",
}: {
  providerId: string;
  providerName: string;
  signedIn: boolean;
  existing: BookingRow | null;
  services: ServiceOffering[];
  paymentsEnabled?: boolean;
  error?: string;
  notice?: string;
  appointmentStart?: string | null;
  timeZone?: string;
}) {
  if (!signedIn) {
    return (
      <div className="rounded-3xl border border-line bg-card p-6">
        <h2 className="font-serif text-3xl text-ink">Request a time</h2>
        <p className="mt-2 text-sm leading-6 text-ink/70">
          Log in to ask {providerName} for a time.
          {paymentsEnabled ? " A fixed-price booking continues to Stripe test checkout." : " BlockBooked does not collect payment until Stripe test mode is configured."}
        </p>
        <Link
          href={`/login?next=${encodeURIComponent(`/providers/${providerId}`)}`}
          className="mt-5 inline-flex rounded-full bg-accent px-4 py-3 text-sm font-semibold text-white hover:bg-accent-dark"
        >
          Log in to request
        </Link>
      </div>
    );
  }

  if (existing && (normalizeBookingStatus(existing.status) === "pending" || normalizeBookingStatus(existing.status) === "accepted")) {
    return (
      <div className="rounded-3xl border border-line bg-card p-6">
        <BookingStatusBadge status={existing.status} />
        <h2 className="mt-3 font-serif text-3xl text-ink">You asked {providerName} for a time.</h2>
        <p className="mt-3 text-sm leading-6 text-ink/75">
          This request is stored in your BlockBooked account. You can cancel a pending request from your
          booking history. Paying does not mark the service completed.
        </p>
        <dl className="mt-5 space-y-2 text-sm text-ink">
          <div className="flex justify-between gap-4 border-b border-line py-2">
            <dt className="text-ink/55">{appointmentStart ? "Appointment" : "Preferred"}</dt>
            <dd>
              {appointmentStart ? appointmentLabel(appointmentStart, timeZone) : `${existing.preferred_date} · ${existing.time_window}`}
            </dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-line py-2">
            <dt className="text-ink/55">Phone</dt>
            <dd>{existing.contact_phone}</dd>
          </div>
          {existing.service_name ? (
            <div className="flex justify-between gap-4 border-b border-line py-2">
              <dt className="text-ink/55">Service</dt>
              <dd>{existing.service_name}</dd>
            </div>
          ) : null}
          {existing.notes ? (
            <div className="py-2">
              <dt className="text-ink/55">Details</dt>
              <dd className="mt-1">{existing.notes}</dd>
            </div>
          ) : null}
        </dl>
        <Link href="/account" className="mt-5 inline-flex text-sm font-semibold text-accent-dark">
          View booking history
        </Link>
      </div>
    );
  }

  return (
    <form action={createBooking} className="rounded-3xl border border-line bg-card p-6">
      <h2 className="font-serif text-3xl text-ink">Request a time</h2>
      <p className="mt-2 text-sm leading-6 text-ink/70">
        Tell {providerName} when you need them.
        {paymentsEnabled
          ? " The price is taken from their listing, then Stripe test checkout collects it. The service is completed later with the customer's PIN."
          : " No payment is collected until Stripe test mode is configured."}
      </p>
      <input type="hidden" name="providerId" value={providerId} />
      <div className="mt-5 grid gap-3">
        {services.length > 0 ? (
          <label className="block text-sm font-medium text-ink">
            Service
            <select
              name="serviceName"
              className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5 outline-none focus:border-ink"
              defaultValue={services[0]?.name ?? ""}
            >
              {services.map((service) => (
                <option key={service.name} value={service.name}>
                  {service.name}
                  {service.price ? ` (${service.price})` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="block text-sm font-medium text-ink">
          Phone
          <input
            name="phone"
            type="tel"
            className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5 outline-none focus:border-ink"
          />
        </label>
        <label className="block text-sm font-medium text-ink">
          Preferred date
          <input
            name="date"
            type="date"
            required
            className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5 outline-none focus:border-ink"
          />
        </label>
        <label className="block text-sm font-medium text-ink">
          Time of day
          <select
            name="window"
            defaultValue="Morning"
            className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5 outline-none focus:border-ink"
          >
            <option>Morning</option>
            <option>Afternoon</option>
            <option>Evening</option>
          </select>
        </label>
        {paymentsEnabled ? (
          <fieldset className="grid gap-2 text-sm text-ink">
            <legend className="font-medium">How to pay</legend>
            <label className="flex gap-2"><input type="radio" name="paymentPlan" value="single" defaultChecked /> Pay the listed fixed price</label>
            <label className="flex gap-2"><input type="radio" name="paymentPlan" value="quote" /> Ask the provider for a quote</label>
            <label className="flex gap-2"><input type="radio" name="paymentPlan" value="milestones" /> Pay the listed price in milestones</label>
          </fieldset>
        ) : null}
        <label className="block text-sm font-medium text-ink">
          What should they know?
          <textarea
            name="notes"
            rows={4}
            placeholder="Address area, pets, stairs, or the job details."
            className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5 outline-none focus:border-ink"
          />
        </label>
      </div>
      {error ? <p className="mt-3 text-sm font-medium text-accent-dark">{error}</p> : null}
      {notice ? <p className="mt-3 text-sm font-medium text-ink">{notice}</p> : null}
      <button
        type="submit"
        className="mt-5 w-full rounded-full bg-accent px-4 py-3 text-sm font-semibold text-white hover:bg-accent-dark"
      >
        {paymentsEnabled ? "Continue to payment" : "Send booking request"}
      </button>
    </form>
  );
}
