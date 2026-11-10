import { requestRefund } from "@/lib/payments/service";
import { expirationRpcBookingId } from "@/lib/scheduling/expiration";
import { createAdminClient, isServiceRoleConfigured } from "@/lib/supabase/admin";

export function cronAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function refundExpiredBooking(bookingId: string) {
  if (!isServiceRoleConfigured()) return { attempted: false, ok: false, message: "Payments are not configured." };
  try {
    return await refundExpiredBookingOnce(bookingId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The expiration refund could not be started.";
    await createAdminClient()
      .from("booking_requests")
      .update({ expiration_refund_error: message.slice(0, 500) })
      .eq("id", bookingId)
      .eq("status", "expired");
    return { attempted: true, ok: false, message };
  }
}

async function refundExpiredBookingOnce(bookingId: string) {
  const admin = createAdminClient();
  const booking = await admin.from("booking_requests").select("id, status, customer_id").eq("id", bookingId).maybeSingle();
  if (!booking.data || booking.data.status !== "expired") return { attempted: false, ok: true, message: "Not expired." };
  const payments = await admin
    .from("payments")
    .select("id, status, amount_cents, refunded_cents")
    .eq("booking_id", bookingId);
  const targets = ((payments.data ?? []) as { id: string; status: string; amount_cents: number; refunded_cents: number }[]).filter(
    (payment) =>
      (payment.status === "succeeded" || payment.status === "partially_refunded") &&
      payment.refunded_cents < payment.amount_cents,
  );
  if (targets.length === 0) {
    await admin.from("booking_requests").update({ expiration_refund_error: null }).eq("id", bookingId).eq("status", "expired");
    return { attempted: false, ok: true, message: "No refund is due." };
  }
  let failure: string | null = null;
  for (const target of targets) {
    const refund = await requestRefund({
      bookingId,
      paymentId: target.id,
      actorId: booking.data.customer_id,
      actorRole: "customer",
      reason: "acceptance_expired",
      automatic: true,
    });
    if (!refund.ok && refund.message !== "There is no confirmed Stripe payment to refund.") failure = refund.message;
  }
  await admin
    .from("booking_requests")
    .update({ expiration_refund_error: failure })
    .eq("id", bookingId)
    .eq("status", "expired");
  return { attempted: true, ok: failure == null, message: failure ?? "Refund submitted." };
}

export async function expireDueBookings() {
  if (!isServiceRoleConfigured()) {
    return { expired: [] as string[], refunds: [] as { bookingId: string; ok: boolean; message: string }[], error: "The service role is not configured." };
  }
  const admin = createAdminClient();
  const claimed = await admin.rpc("claim_expired_bookings", { batch_limit: 25 });
  const expired = claimed.error
    ? []
    : ((claimed.data ?? []) as { booking_id?: string | null; expired_booking_id?: string | null }[])
        .map((row) => expirationRpcBookingId(row))
        .filter((id): id is string => id !== null);
  const refunds: { bookingId: string; ok: boolean; message: string }[] = [];
  const seen = new Set(expired);
  for (const bookingId of expired) {
    const refund = await refundExpiredBooking(bookingId);
    if (refund.attempted || !refund.ok) refunds.push({ bookingId, ok: refund.ok, message: refund.message });
  }
  // A crash after expiration, or a payment that succeeds later, still needs a
  // refund even when expiration_refund_error was never written.
  const outstanding = await admin.rpc("bookings_needing_expiration_refund", { batch_limit: 25 });
  if (outstanding.error) {
    return { expired, refunds, error: outstanding.error.message };
  }
  for (const row of (outstanding.data ?? []) as { booking_id?: string | null; expired_booking_id?: string | null }[]) {
    const bookingId = expirationRpcBookingId(row);
    if (!bookingId || seen.has(bookingId)) continue;
    seen.add(bookingId);
    const refund = await refundExpiredBooking(bookingId);
    if (refund.attempted || !refund.ok) refunds.push({ bookingId, ok: refund.ok, message: refund.message });
  }
  return { expired, refunds, error: claimed.error?.message ?? null };
}
