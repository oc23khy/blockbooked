import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppointmentCalendar, AppointmentConfirm } from "@/components/appointment-request";
import { BookingRequest } from "@/components/booking-request";
import { bookingSurface } from "@/lib/scheduling/booking";
import { loadPublicSchedule, mediaUrl } from "@/lib/scheduling/public";
import { categoryName } from "@/lib/marketplace";
import { stripeTestKeyConfigured } from "@/lib/payments/stripe-server";
import { isServiceRoleConfigured } from "@/lib/supabase/admin";
import { getVisibleProvider, type BookingRow } from "@/lib/providers";
import { getSession } from "@/lib/session";

type ProviderPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; notice?: string; service?: string; starts?: string }>;
};

export async function generateMetadata({ params }: ProviderPageProps): Promise<Metadata> {
  const { id } = await params;
  const provider = await getVisibleProvider(id);
  if (!provider || (provider.status && provider.status !== "approved")) {
    return { title: "Provider · BlockBooked", robots: { index: false, follow: false } };
  }
  return {
    title: `${provider.name} · BlockBooked`,
    description: `${provider.specialty} in ${provider.serviceAreas.join(", ") || "Illinois"}.`,
    alternates: { canonical: `/providers/${provider.id}` },
    robots: { index: true, follow: true },
  };
}

export default async function ProviderPage({ params, searchParams }: ProviderPageProps) {
  const { id } = await params;
  const query = await searchParams;
  const provider = await getVisibleProvider(id);
  if (!provider) notFound();

  const session = await getSession();
  const ownsListing = session?.user.id === provider.ownerId;
  let existing: BookingRow | null = null;

  if (session && provider.status === "approved") {
    const { data } = await session.supabase
      .from("booking_requests")
      .select("*")
      .eq("customer_id", session.user.id)
      .eq("provider_id", provider.id)
      .in("status", ["pending", "accepted", "requested"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    existing = (data as BookingRow | null) ?? null;
  }

  const preview = provider.status && provider.status !== "approved";
  const schedule = await loadPublicSchedule(provider.id);
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const cover = mediaUrl(schedule?.coverPath ?? null);
  const offeredStarts = schedule
    ? Object.values(schedule.slotsByService).flatMap((slots) => slots.map((slot) => slot.start))
    : [];
  const selectedService = schedule?.services.find((service) => service.id === query.service && service.durationMinutes);
  const selectedOffered = selectedService ? (schedule?.slotsByService[selectedService.id] ?? []).map((slot) => slot.start) : [];
  const surface = bookingSurface({
    offeredStarts,
    selectedStart: selectedService && query.starts && selectedOffered.includes(query.starts) ? query.starts : null,
  });
  let existingAppointment: string | null = null;
  if (existing && session) {
    const appointment = await session.supabase
      .from("booking_appointments")
      .select("starts_at")
      .eq("booking_id", existing.id)
      .maybeSingle();
    existingAppointment = appointment.data?.starts_at ?? null;
  }

  return (
    <main className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[1.2fr_0.8fr]">
      <article>
        <Link href="/#providers" className="text-sm font-semibold text-accent-dark hover:text-ink">
          Back to providers
        </Link>
        {provider.demo ? (
          <p className="mt-4 rounded-2xl border border-accent/30 bg-[#f8efe6] px-4 py-3 text-sm leading-6 text-ink">
            <span className="font-semibold">Demo listing.</span> This sample profile is not a real
            business on BlockBooked.
          </p>
        ) : null}
        {preview ? (
          <p className="mt-4 rounded-2xl border border-line bg-card px-4 py-3 text-sm leading-6 text-ink">
            <span className="font-semibold">Not public yet.</span> This application is{" "}
            {provider.status}. Only you and an admin can view it until it is approved.
          </p>
        ) : null}
        {cover ? (
          <img src={cover} alt="" className="mt-6 h-56 w-full rounded-3xl object-cover" />
        ) : null}
        <div className="mt-6 flex items-start gap-4">
          <div
            className="grid h-16 w-16 place-items-center rounded-2xl text-base font-semibold text-white"
            style={{ backgroundColor: provider.tone }}
            aria-hidden
          >
            {provider.initials}
          </div>
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-ink/50">
              {provider.demo ? "Demo listing · " : ""}
              {categoryName(provider.categoryId)} · {provider.serviceAreas.join(", ") || "Illinois"}
            </p>
            <h1 className="mt-1 font-serif text-4xl tracking-tight text-ink sm:text-5xl">
              {provider.name}
            </h1>
            <p className="mt-2 text-ink/75">{provider.specialty}</p>
          </div>
        </div>

        <dl className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="From" value={`$${provider.priceFrom}`} />
          <Stat label="Unit" value={provider.priceUnit} />
          {provider.years > 0 ? <Stat label="Experience" value={`${provider.years} yrs`} /> : null}
          <Stat label="Areas" value={String(provider.serviceAreas.length)} />
        </dl>

        <p className="mt-8 max-w-2xl text-base leading-7 text-ink/80">{provider.about}</p>
        <p className="mt-3 text-sm text-ink/60">No verified reviews yet. BlockBooked does not show background checks, insurance, or licenses until those checks are recorded. Hours, prices, languages, and travel distance are submitted by the business and are not independently verified.</p>
        {schedule && (schedule.languages.length > 0 || schedule.travelRadiusMiles != null) ? (
          <p className="mt-2 text-sm text-ink/70">
            {[
              schedule.languages.length > 0 ? `Languages: ${schedule.languages.join(", ")}` : "",
              schedule.travelRadiusMiles != null ? `Travels up to ${schedule.travelRadiusMiles} miles` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : null}
        {schedule && schedule.windows.length > 0 ? (
          <div className="mt-6">
            <h2 className="font-serif text-2xl text-ink">Business hours</h2>
            <p className="mt-1 text-sm text-ink/60">{schedule.timeZone}. A blank day is closed.</p>
            <ul className="mt-3 grid gap-1 text-sm text-ink">
              {weekdays.map((day, weekday) => {
                const windows = schedule.windows.filter((window) => window.weekday === weekday);
                const label = windows
                  .map((window) => `${clock(window.opensMinute)}–${clock(window.closesMinute)}`)
                  .join(", ");
                return (
                  <li key={day} className="flex justify-between gap-4 border-b border-line py-1">
                    <span>{day}</span>
                    <span>{label || "Closed"}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        {schedule && schedule.images.length > 0 ? (
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {schedule.images.map((image) => (
              <img key={image.path} src={mediaUrl(image.path) ?? ""} alt={image.caption || `${provider.name} photo`} className="aspect-square w-full rounded-2xl object-cover" />
            ))}
          </div>
        ) : null}
        <p className="mt-3 text-sm text-ink/60">
          {[provider.responseTime, provider.nextOpening ? `Availability: ${provider.nextOpening}` : ""]
            .filter(Boolean)
            .join(". ")}
        </p>

        <h2 className="mt-10 font-serif text-2xl text-ink">Services and prices</h2>
        <ul className="mt-4 divide-y divide-line overflow-hidden rounded-3xl border border-line bg-card">
          {schedule && schedule.services.length > 0 ? (
            schedule.services.map((service) => (
              <li key={service.id} className="flex items-start justify-between gap-4 px-5 py-4">
                <div>
                  <p className="font-semibold text-ink">{service.name}</p>
                  <p className="mt-1 text-sm text-ink/65">{service.description}</p>
                  <p className="mt-1 text-xs text-ink/50">
                    {service.durationMinutes ? `${service.durationMinutes} minutes` : "No appointment duration yet"}
                    {service.pricingType === "quote" ? " · Quote" : service.pricingType === "starting" ? " · Starting price" : " · Fixed price"}
                  </p>
                </div>
                <p className="shrink-0 text-sm font-semibold text-ink">
                  {service.priceCents == null ? "Quote" : `$${(service.priceCents / 100).toFixed(2)}`}
                </p>
              </li>
            ))
          ) : provider.services.length === 0 ? (
            <li className="px-5 py-4 text-sm text-ink/65">No individual services listed yet.</li>
          ) : (
            provider.services.map((service) => (
              <li key={service.name} className="flex items-start justify-between gap-4 px-5 py-4">
                <div>
                  <p className="font-semibold text-ink">{service.name}</p>
                  <p className="mt-1 text-sm text-ink/65">{service.detail}</p>
                </div>
                <p className="shrink-0 text-sm font-semibold text-ink">{service.price}</p>
              </li>
            ))
          )}
        </ul>
        <p className="mt-3 text-sm text-ink/55">
          A service with a fixed dollar price is charged at checkout. Completion still requires the customer PIN.
        </p>
        {schedule && !schedule.scheduleError && surface !== "fallback" ? (
          <AppointmentCalendar
            providerId={provider.id}
            timeZone={schedule.timeZone}
            services={schedule.services}
            slotsByService={schedule.slotsByService}
            selectedServiceId={query.service ?? ""}
            signedIn={Boolean(session)}
          />
        ) : null}
      </article>

      <aside className="lg:pt-10">
        {ownsListing ? (
          <div className="rounded-3xl border border-line bg-card p-6">
            <h2 className="font-serif text-3xl text-ink">This is your listing</h2>
            <p className="mt-2 text-sm leading-6 text-ink/70">
              Edit prices, categories, availability, and service areas from your dashboard.
            </p>
            <Link
              href="/dashboard"
              className="mt-5 inline-flex rounded-full bg-ink px-4 py-3 text-sm font-semibold text-white"
            >
              Open dashboard
            </Link>
          </div>
        ) : provider.status === "approved" || !provider.status ? (
          <>
          {schedule?.scheduleError ? (
            <p className="mb-3 text-sm font-medium text-accent-dark">{schedule.scheduleError}</p>
          ) : null}
          {existing ? (
            <BookingRequest
              providerId={provider.id}
              providerName={provider.name}
              signedIn={Boolean(session)}
              existing={existing}
              services={provider.services}
              paymentsEnabled={stripeTestKeyConfigured() && isServiceRoleConfigured()}
              error={surface === "confirm" ? undefined : query.error}
              notice={surface === "confirm" ? undefined : query.notice}
              appointmentStart={existingAppointment}
              timeZone={schedule?.timeZone ?? "America/Chicago"}
            />
          ) : null}
          {surface === "confirm" && schedule && selectedService ? (
            <AppointmentConfirm
              providerId={provider.id}
              providerName={provider.name}
              timeZone={schedule.timeZone}
              service={selectedService}
              startsAt={query.starts ?? ""}
              paymentsEnabled={stripeTestKeyConfigured() && isServiceRoleConfigured()}
              signedIn={Boolean(session)}
              error={query.error}
              notice={query.notice}
            />
          ) : null}
          {surface === "fallback" && schedule && schedule.windows.length > 0 ? (
            <p className="mb-3 rounded-3xl border border-line bg-card p-4 text-sm leading-6 text-ink/75">
              {schedule.settings
                ? "Booking rules and weekly hours are saved. Exact appointment times appear after a shown service with a duration of 15 to 480 minutes is saved."
                : "Weekly hours are saved. Exact appointment times also require saved booking rules and a shown service with a duration."}
            </p>
          ) : null}
          {surface === "fallback" && !existing ? (
            <BookingRequest
              providerId={provider.id}
              providerName={provider.name}
              signedIn={Boolean(session)}
              existing={existing}
              services={provider.services}
              paymentsEnabled={stripeTestKeyConfigured() && isServiceRoleConfigured()}
              error={query.error}
              notice={query.notice}
            />
          ) : null}
          {surface === "calendar" && !existing ? (
            <p className="rounded-3xl border border-line bg-card p-6 text-sm leading-6 text-ink/75">
              Choose an open time and click Book. Morning, afternoon, and evening requests are used only when this provider has no exact openings.
            </p>
          ) : null}
          </>
        ) : null}
      </aside>
    </main>
  );
}

function clock(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-line bg-card px-3 py-3">
      <dt className="text-xs uppercase tracking-wide text-ink/45">{label}</dt>
      <dd className="mt-1 font-semibold text-ink">{value}</dd>
    </div>
  );
}
