import Link from "next/link";
import { createBooking } from "@/app/actions/bookings";
import { appointmentLabel, bookPath, loginPathForBooking } from "@/lib/scheduling/booking";
import type { CatalogService } from "@/lib/scheduling/public";
import { zonedParts } from "@/lib/scheduling/rules";

function money(cents: number | null) {
  if (cents == null) return "Quote";
  return `$${(cents / 100).toFixed(2)}`;
}

export function AppointmentCalendar({
  providerId,
  timeZone,
  services,
  slotsByService,
  selectedServiceId,
  signedIn,
}: {
  providerId: string;
  timeZone: string;
  services: CatalogService[];
  slotsByService: Record<string, { start: string; end: string }[]>;
  selectedServiceId: string;
  signedIn: boolean;
}) {
  const bookable = services.filter((service) => service.durationMinutes && (slotsByService[service.id]?.length ?? 0) > 0);
  const selected = bookable.find((service) => service.id === selectedServiceId) ?? bookable[0];
  const slots = selected ? slotsByService[selected.id] ?? [] : [];
  const dates = new Map<string, { start: string }[]>();
  for (const slot of slots) {
    const key = zonedParts(new Date(slot.start), timeZone).dateKey;
    dates.set(key, [...(dates.get(key) ?? []), slot]);
  }

  return (
    <div className="mt-8">
      <h2 className="font-serif text-2xl text-ink">Available appointments</h2>
      <p className="mt-1 text-sm text-ink/60">Times use {timeZone}. Choose Book on an open time. Only these times can be reserved.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {bookable.map((service) => (
          <Link
            key={service.id}
            href={`/providers/${providerId}?service=${service.id}`}
            className={`rounded-full border px-3 py-1.5 text-sm ${service.id === selected?.id ? "border-ink bg-ink text-white" : "border-line bg-card text-ink"}`}
          >
            {service.name} · {service.pricingType === "quote" ? "Quote" : money(service.priceCents)} · {service.durationMinutes} min
          </Link>
        ))}
      </div>
      <div className="mt-4 grid gap-3">
        {[...dates.entries()].map(([date, times]) => (
          <section key={date} className="rounded-3xl border border-line bg-card p-4">
            <h3 className="text-sm font-semibold text-ink">{date}</h3>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {times.map((slot) => {
                const href = selected
                  ? signedIn
                    ? bookPath(providerId, selected.id, slot.start)
                    : loginPathForBooking(providerId, selected.id, slot.start)
                  : `/login?next=${encodeURIComponent(`/providers/${providerId}`)}`;
                return (
                  <li key={slot.start} className="flex items-center justify-between gap-3 rounded-2xl border border-line px-3 py-2">
                    <span className="text-sm text-ink">{appointmentLabel(slot.start, timeZone)}</span>
                    <Link href={href} className="rounded-full bg-accent px-3 py-1.5 text-sm font-semibold text-white">
                      Book
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

export function AppointmentConfirm({
  providerId,
  providerName,
  timeZone,
  service,
  startsAt,
  paymentsEnabled,
  signedIn,
  error,
  notice,
}: {
  providerId: string;
  providerName: string;
  timeZone: string;
  service: CatalogService;
  startsAt: string;
  paymentsEnabled: boolean;
  signedIn: boolean;
  error?: string;
  notice?: string;
}) {
  const when = appointmentLabel(startsAt, timeZone);
  if (!signedIn) {
    return (
      <div className="rounded-3xl border border-line bg-card p-6">
        <h2 className="font-serif text-3xl text-ink">Book this time</h2>
        <p className="mt-3 text-sm leading-6 text-ink">
          {service.name} with {providerName}
          <br />
          {when}
        </p>
        <Link href={loginPathForBooking(providerId, service.id, startsAt)} className="mt-5 inline-flex rounded-full bg-accent px-4 py-3 text-sm font-semibold text-white">
          Log in to book
        </Link>
      </div>
    );
  }

  return (
    <form action={createBooking} className="rounded-3xl border border-line bg-card p-6">
      <h2 className="font-serif text-3xl text-ink">Book this time</h2>
      <p className="mt-2 text-sm leading-6 text-ink/70">
        This request holds the time until {providerName} accepts it. A payment does not confirm the appointment.
      </p>
      <input type="hidden" name="providerId" value={providerId} />
      <input type="hidden" name="serviceId" value={service.id} />
      <input type="hidden" name="startsAt" value={startsAt} />
      <dl className="mt-4 space-y-2 text-sm text-ink">
        <div className="flex justify-between gap-4 border-b border-line py-2">
          <dt className="text-ink/55">Service</dt>
          <dd>{service.name}</dd>
        </div>
        <div className="flex justify-between gap-4 border-b border-line py-2">
          <dt className="text-ink/55">Appointment</dt>
          <dd className="text-right">{when}</dd>
        </div>
        <div className="flex justify-between gap-4 border-b border-line py-2">
          <dt className="text-ink/55">Price</dt>
          <dd>{service.pricingType === "quote" ? "Quote" : money(service.priceCents)}</dd>
        </div>
      </dl>
      <label className="mt-3 block text-sm font-medium text-ink">
        Phone
        <input name="phone" type="tel" className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5" />
      </label>
      {paymentsEnabled && service.pricingType !== "quote" ? (
        <fieldset className="mt-3 grid gap-2 text-sm text-ink">
          <legend className="font-medium">How to pay</legend>
          <label className="flex gap-2"><input type="radio" name="paymentPlan" value="single" defaultChecked /> Pay {money(service.priceCents)} now</label>
          <label className="flex gap-2"><input type="radio" name="paymentPlan" value="quote" /> Ask for a quote instead</label>
          <label className="flex gap-2"><input type="radio" name="paymentPlan" value="milestones" /> Pay {money(service.priceCents)} in milestones</label>
        </fieldset>
      ) : (
        <input type="hidden" name="paymentPlan" value="quote" />
      )}
      <label className="mt-3 block text-sm font-medium text-ink">
        Notes
        <textarea name="notes" rows={3} className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5" />
      </label>
      {error ? <p className="mt-3 text-sm font-medium text-accent-dark">{error}</p> : null}
      {notice ? <p className="mt-3 text-sm font-medium text-ink">{notice}</p> : null}
      <button className="mt-5 w-full rounded-full bg-accent px-4 py-3 text-sm font-semibold text-white">Confirm this appointment</button>
    </form>
  );
}
