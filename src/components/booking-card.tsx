import Link from "next/link";
import { requestCompletionReview, submitCompletionPin, updateBookingStatus } from "@/app/actions/bookings";
import { payForBooking, saveMilestones, sendQuote } from "@/app/actions/payments";
import { cancelReschedule, decideReschedule } from "@/app/actions/reschedule";
import { payoutLabel } from "@/lib/payments/guards";
import { formatUsd } from "@/lib/payments/money";
import { PRICE_ADJUSTMENT_MESSAGE } from "@/lib/scheduling/reschedule";
import { BookingStatusBadge } from "@/components/booking-status-badge";
import { customerCanCancel, providerActions, providerCanVerifyPin } from "@/lib/booking-status";

export type BookingView = {
  id: string;
  preferredDate: string;
  timeWindow: string;
  serviceName: string;
  notes: string;
  contactPhone: string;
  contactEmail: string;
  customerName: string;
  providerName: string;
  status: string;
  completionPin?: string | null;
  reviewRequested?: boolean;
  completedAt?: string | null;
  paymentStatus?: string | null;
  paymentAmountCents?: number | null;
  providerShareCents?: number | null;
  transferStatus?: string | null;
  paymentPlan?: string | null;
  quoteAmountCents?: number | null;
  quoteStatus?: string | null;
  needsPayment?: boolean;
  appointmentStart?: string | null;
  timeZone?: string | null;
  acceptanceDeadline?: string | null;
  rescheduleRequests?: {
    id: string;
    startsAt: string;
    status: string;
    priceAdjustmentRequired: boolean;
  }[];
};

function shownTime(value: string, timeZone = "America/Chicago") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(date);
}

export function BookingCard({
  booking,
  audience,
}: {
  booking: BookingView;
  audience: "customer" | "provider";
}) {
  const actions = audience === "provider" ? providerActions(booking.status) : [];
  const canCancel = audience === "customer" && customerCanCancel(booking.status);

  return (
    <li className="rounded-3xl border border-line bg-card px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-ink">
            {audience === "customer" ? booking.providerName : booking.customerName}
          </p>
          <p className="mt-1 text-sm text-ink/70">
            {booking.appointmentStart
              ? shownTime(booking.appointmentStart, booking.timeZone ?? "America/Chicago")
              : `${booking.preferredDate} · ${booking.timeWindow}`}
          </p>
          {booking.appointmentStart ? (
            <p className="mt-1 text-sm text-ink/70">
              {booking.status === "accepted" || booking.status === "completed"
                ? "Confirmed appointment."
                : booking.status === "pending"
                  ? "Held until the provider accepts. A successful payment does not confirm it."
                  : booking.status === "expired"
                    ? "The acceptance deadline passed and this time was released."
                    : "This time was released."}
            </p>
          ) : null}
          {booking.status === "pending" && booking.acceptanceDeadline ? (
            <p className="mt-1 text-sm text-ink/70">Accept by {shownTime(booking.acceptanceDeadline, booking.timeZone ?? "America/Chicago")}.</p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          <BookingStatusBadge status={booking.status} />
          {booking.reviewRequested ? (
            <span className="rounded-full bg-sand px-2.5 py-1 text-xs font-semibold text-ink/70">
              Manual review requested
            </span>
          ) : null}
        </div>
      </div>
      <dl className="mt-3 grid gap-1 text-sm text-ink/80">
        {audience === "provider" ? (
          <div>
            <dt className="inline text-ink/50">Contact: </dt>
            <dd className="inline">
              {[booking.contactPhone, booking.contactEmail].filter(Boolean).join(" · ") || "No contact on file"}
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="inline text-ink/50">Service: </dt>
          <dd className="inline">{booking.serviceName || "General request"}</dd>
        </div>
        {booking.notes ? (
          <div>
            <dt className="text-ink/50">Details</dt>
            <dd className="mt-1">{booking.notes}</dd>
          </div>
        ) : null}
        {booking.paymentStatus ? (
          <div>
            <dt className="inline text-ink/50">Payment: </dt>
            <dd className="inline">
              {booking.paymentStatus.replaceAll("_", " ")}
              {typeof booking.paymentAmountCents === "number" ? ` · ${formatUsd(booking.paymentAmountCents)}` : ""}
            </dd>
          </div>
        ) : null}
        {audience === "provider" && typeof booking.providerShareCents === "number" ? (
          <div>
            <dt className="inline text-ink/50">Your gross share: </dt>
            <dd className="inline">
              {formatUsd(booking.providerShareCents)}
              {payoutLabel(booking.transferStatus) ? ` · ${payoutLabel(booking.transferStatus)}` : ""}
            </dd>
          </div>
        ) : null}
        {booking.completedAt ? (
          <div>
            <dt className="inline text-ink/50">Completed: </dt>
            <dd className="inline">{shownTime(booking.completedAt, booking.timeZone ?? "America/Chicago")}</dd>
          </div>
        ) : null}
      </dl>
      {audience === "customer" && providerCanVerifyPin(booking.status) && !booking.completionPin ? (
        <p className="mt-4 text-sm leading-6 text-ink/70">
          Your completion PIN is not on this booking yet. Refresh this page after the provider accepts it.
        </p>
      ) : null}
      {audience === "customer" && booking.completionPin && providerCanVerifyPin(booking.status) ? (
        <div className="mt-4 rounded-2xl border border-line bg-sand px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">Completion PIN</p>
          <p className="mt-1 font-mono text-2xl tracking-[0.3em] text-ink">{booking.completionPin}</p>
          <p className="mt-2 text-sm leading-6 text-ink/70">
            Share this PIN with the provider only after the service is finished to your satisfaction.
          </p>
        </div>
      ) : null}
      {(booking.rescheduleRequests ?? []).length > 0 ? (
        <ul className="mt-4 grid gap-2">
          {(booking.rescheduleRequests ?? []).map((request) => (
            <li key={request.id} className="rounded-2xl bg-sand px-3 py-2 text-sm text-ink">
              <p>
                Reschedule {request.status}: {shownTime(request.startsAt, booking.timeZone ?? "America/Chicago")}
              </p>
              {request.priceAdjustmentRequired ? <p className="mt-1 text-ink/70">{PRICE_ADJUSTMENT_MESSAGE}</p> : null}
              {request.status === "pending" && audience === "provider" ? (
                <form action={decideReschedule} className="mt-2 flex flex-wrap gap-2">
                  <input type="hidden" name="requestId" value={request.id} />
                  <button name="decision" value="approve" className="rounded-full bg-ink px-3 py-1.5 text-sm font-semibold text-white">Approve new time</button>
                  <button name="decision" value="decline" className="rounded-full border border-ink px-3 py-1.5 text-sm font-semibold text-ink">Decline change</button>
                </form>
              ) : null}
              {request.status === "pending" && audience === "customer" ? (
                <form action={cancelReschedule} className="mt-2">
                  <input type="hidden" name="requestId" value={request.id} />
                  <button className="rounded-full border border-ink px-3 py-1.5 text-sm font-semibold text-ink">Cancel change request</button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {audience === "customer" && booking.status === "accepted" && booking.appointmentStart ? (
        <Link href={`/account/reschedule/${booking.id}`} className="mt-4 inline-flex rounded-full border border-ink px-4 py-2 text-sm font-semibold text-ink">
          Request a new time
        </Link>
      ) : null}
      {actions.length > 0 || canCancel ? (
        <form action={updateBookingStatus} className="mt-4 flex flex-wrap gap-2">
          <input type="hidden" name="bookingId" value={booking.id} />
          <input type="hidden" name="returnTo" value={audience === "customer" ? "/account" : "/dashboard"} />
          {actions.includes("accepted") ? (
            <button name="status" value="accepted" className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">
              Accept
            </button>
          ) : null}
          {actions.includes("declined") ? (
            <button
              name="status"
              value="declined"
              className="rounded-full border border-ink px-4 py-2 text-sm font-semibold text-ink"
            >
              Decline
            </button>
          ) : null}
          {canCancel ? (
            <button
              name="status"
              value="cancelled"
              className="rounded-full border border-ink px-4 py-2 text-sm font-semibold text-ink"
            >
              Cancel request
            </button>
          ) : null}
        </form>
      ) : null}
      {audience === "provider" && booking.paymentPlan === "quote" && booking.quoteStatus !== "offered" ? (
        <form action={sendQuote} className="mt-4 grid gap-2">
          <input type="hidden" name="bookingId" value={booking.id} />
          <label className="text-sm font-medium text-ink">
            Quote in dollars
            <input name="amount" inputMode="decimal" required className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2 outline-none focus:border-ink" />
          </label>
          <textarea name="note" rows={2} placeholder="What the quote covers" className="rounded-xl border border-line bg-sand px-3 py-2 text-sm outline-none focus:border-ink" />
          <button type="submit" className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">Send quote</button>
        </form>
      ) : null}
      {audience === "provider" && booking.paymentPlan === "milestones" && !booking.paymentStatus ? (
        <form action={saveMilestones} className="mt-4 grid gap-2">
          <input type="hidden" name="bookingId" value={booking.id} />
          <p className="text-sm text-ink/70">Split the agreed price into milestones. The amounts must add up exactly.</p>
          {[1, 2].map((index) => (
            <div key={index} className="grid grid-cols-2 gap-2">
              <input name={`label${index}`} placeholder={`Milestone ${index}`} className="rounded-xl border border-line bg-sand px-3 py-2 text-sm outline-none focus:border-ink" />
              <input name={`amount${index}`} inputMode="decimal" placeholder="Dollars" className="rounded-xl border border-line bg-sand px-3 py-2 text-sm outline-none focus:border-ink" />
            </div>
          ))}
          <button type="submit" className="rounded-full border border-ink px-4 py-2 text-sm font-semibold text-ink">Save milestones</button>
        </form>
      ) : null}
      {audience === "customer" && booking.needsPayment ? (
        <form action={payForBooking} className="mt-4">
          <input type="hidden" name="bookingId" value={booking.id} />
          <button type="submit" className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white">
            {booking.quoteStatus === "offered" && typeof booking.quoteAmountCents === "number"
            ? `Accept quote and pay ${formatUsd(booking.quoteAmountCents)}`
            : "Pay for this booking"}
          </button>
        </form>
      ) : null}
      {audience === "provider" && providerCanVerifyPin(booking.status) ? (
        <div className="mt-4 grid gap-3">
          <form action={submitCompletionPin} className="grid gap-2">
            <input type="hidden" name="bookingId" value={booking.id} />
            <label className="text-sm font-medium text-ink">
              Customer completion PIN
              <input
                name="pin"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                pattern="[0-9]{6}"
                placeholder="6 digits"
                className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5 tracking-[0.2em] outline-none focus:border-ink"
              />
            </label>
            <button type="submit" className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white">
              Complete with PIN
            </button>
          </form>
          {booking.reviewRequested ? (
            <p className="text-sm leading-6 text-ink/70">
              Manual review is requested. You still cannot mark this booking completed without the customer PIN.
            </p>
          ) : (
            <form action={requestCompletionReview} className="grid gap-2">
              <input type="hidden" name="bookingId" value={booking.id} />
              <label className="text-sm font-medium text-ink">
                Customer cannot provide the PIN
                <textarea
                  name="note"
                  rows={3}
                  maxLength={500}
                  placeholder="What happened, and how can an admin reach you?"
                  className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5 outline-none focus:border-ink"
                />
              </label>
              <button type="submit" className="rounded-full border border-ink px-4 py-2 text-sm font-semibold text-ink">
                Request manual review
              </button>
            </form>
          )}
        </div>
      ) : null}
    </li>
  );
}
