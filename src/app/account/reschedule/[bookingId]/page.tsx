import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requestReschedule } from "@/app/actions/reschedule";
import { appointmentLabel } from "@/lib/scheduling/booking";
import { loadPublicSchedule } from "@/lib/scheduling/public";
import { PRICE_ADJUSTMENT_MESSAGE, withoutOwnHold } from "@/lib/scheduling/reschedule";
import { openSlots } from "@/lib/scheduling/rules";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Reschedule · BlockBooked" };
export const dynamic = "force-dynamic";

export default async function ReschedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ bookingId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { bookingId } = await params;
  const query = await searchParams;
  const { supabase, user } = await requireSession(`/account/reschedule/${bookingId}`);
  const booking = await supabase
    .from("booking_requests")
    .select("id, status, customer_id, provider_id, service_name, providers(business_name, timezone)")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking.data || booking.data.customer_id !== user.id) notFound();
  if (booking.data.status !== "accepted") redirect("/account?error=Only%20an%20accepted%20appointment%20can%20be%20rescheduled");
  const appointment = await supabase
    .from("booking_appointments")
    .select("service_id, starts_at, blocked_until, status")
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (!appointment.data || appointment.data.status !== "confirmed") {
    redirect("/account?error=This%20booking%20has%20no%20confirmed%20appointment");
  }
  const schedule = await loadPublicSchedule(booking.data.provider_id);
  const provider = Array.isArray(booking.data.providers) ? booking.data.providers[0] : booking.data.providers;
  const timeZone = schedule?.timeZone || provider?.timezone || "America/Chicago";
  const own = {
    start: Date.parse(appointment.data.starts_at),
    end: Date.parse(appointment.data.blocked_until),
  };
  const services = (schedule?.services ?? []).filter((service) => service.durationMinutes);
  const slotsByService = Object.fromEntries(
    services.map((service) => [
      service.id,
      schedule?.settings
        ? openSlots({
            timeZone,
            windows: schedule.windows,
            durationMinutes: service.durationMinutes ?? 0,
            bufferMinutes: schedule.settings.bufferMinutes,
            minNoticeMinutes: schedule.settings.minNoticeMinutes,
            maxAdvanceDays: schedule.settings.maxAdvanceDays,
            busy: withoutOwnHold(schedule.busy, own),
            timeOff: schedule.timeOff,
          })
        : [],
    ]),
  );
  const payment = await supabase
    .from("payments")
    .select("amount_cents, status")
    .eq("booking_id", bookingId)
    .in("status", ["succeeded", "partially_refunded"]);
  const paidCents = ((payment.error ? [] : payment.data) ?? []).reduce((sum, row) => sum + row.amount_cents, 0);

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link href="/account" className="text-sm font-semibold text-accent-dark">Back to your account</Link>
      <h1 className="mt-3 font-serif text-5xl tracking-tight text-ink">Request a new time</h1>
      <p className="mt-3 text-ink/70">
        {provider?.business_name ?? "Your provider"} keeps {appointmentLabel(appointment.data.starts_at, timeZone)} reserved until they approve a replacement.
      </p>
      {query.error ? <p className="mt-4 text-sm font-medium text-accent-dark">{query.error}</p> : null}
      {schedule?.scheduleError ? <p className="mt-4 text-sm font-medium text-accent-dark">{schedule.scheduleError}</p> : null}
      <div className="mt-6 grid gap-4">
        {services.map((service) => {
          const slots = slotsByService[service.id] ?? [];
          const adjustment = service.priceCents !== (paidCents || null);
          return (
            <section key={service.id} className="rounded-3xl border border-line bg-card p-5">
              <h2 className="font-semibold text-ink">{service.name}</h2>
              <p className="mt-1 text-sm text-ink/70">
                {service.durationMinutes} minutes
                {service.priceCents == null ? "" : ` · $${(service.priceCents / 100).toFixed(2)}`}
              </p>
              {adjustment ? <p className="mt-2 text-sm leading-6 text-ink/75">{PRICE_ADJUSTMENT_MESSAGE}</p> : null}
              <ul className="mt-3 grid gap-2">
                {slots.slice(0, 12).map((slot) => (
                  <li key={slot.start}>
                    <form action={requestReschedule} className="flex flex-wrap items-center justify-between gap-2">
                      <input type="hidden" name="bookingId" value={bookingId} />
                      <input type="hidden" name="serviceId" value={service.id} />
                      <input type="hidden" name="startsAt" value={slot.start} />
                      <span className="text-sm text-ink">{appointmentLabel(slot.start, timeZone)}</span>
                      <button className="rounded-full bg-ink px-3 py-1.5 text-sm font-semibold text-white">Request this time</button>
                    </form>
                  </li>
                ))}
                {slots.length === 0 ? <li className="text-sm text-ink/70">No open times for this service.</li> : null}
              </ul>
            </section>
          );
        })}
        {services.length === 0 ? <p className="text-sm text-ink/70">This provider has no services with a duration.</p> : null}
      </div>
    </main>
  );
}
