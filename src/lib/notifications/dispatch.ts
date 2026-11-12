import { siteUrl } from "@/lib/payments/stripe-server";
import {
  planNotices,
  shouldNotifyAfterWebhook,
  type NoticeBooking,
  type NoticePayment,
  type NotificationEvent,
  type OutboundNotice,
} from "@/lib/notifications/content";
import {
  deliverNotification,
  deliveryDue,
  notificationsEnabled,
  resendTransport,
  type DeliveryLog,
  type DeliveryStatus,
  type MailTransport,
} from "@/lib/notifications/delivery";
import { createAdminClient, isServiceRoleConfigured } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

export async function notifyBookingEvent(event: NotificationEvent, bookingId: string) {
  if (!notificationsEnabled() || event === "payment_succeeded" || event === "refund_issued") return;
  await sendSafely(() => sendBookingEvent(event, bookingId));
}

export async function notifyRefundIssued(bookingId: string, paymentId: string) {
  if (!notificationsEnabled()) return;
  await sendSafely(async () => {
    if (!isServiceRoleConfigured()) return;
    const admin = createAdminClient();
    const payment = await loadPaymentById(admin, paymentId);
    if (!payment || payment.bookingId !== bookingId) return;
    await deliverEvent("refund_issued", bookingId, payment);
  });
}

export async function retryDueNotifications(now = new Date()) {
  if (!notificationsEnabled() || !isServiceRoleConfigured()) return { checked: 0, sent: 0, failed: 0, skipped: 0 };
  const admin = createAdminClient();
  const due = await admin
    .from("notification_deliveries")
    .select("idempotency_key, event_type, booking_id, recipient_role, status, updated_at")
    .in("status", ["pending", "failed"])
    .order("updated_at", { ascending: true })
    .limit(25);
  if (due.error || !due.data) return { checked: 0, sent: 0, failed: 0, skipped: 0 };
  const counts = { checked: 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of due.data as DueDelivery[]) {
    if (!deliveryDue(row.status, row.updated_at, now)) continue;
    counts.checked += 1;
    try {
      const outcome = await retryOne(row);
      counts[outcome] += 1;
    } catch {
      counts.failed += 1;
    }
  }
  return counts;
}

export async function notifyPersistedStripeEvent(input: {
  deliveryStatus: string;
  type: string;
  livemode: boolean;
  object: Record<string, unknown>;
}) {
  if (!notificationsEnabled() || !shouldNotifyAfterWebhook(input.deliveryStatus) || input.livemode) return;
  await sendSafely(async () => {
    if (!isServiceRoleConfigured()) return;
    const admin = createAdminClient();
    const payment = await loadPayment(admin, input.object);
    if (!payment) return;
    if (
      (input.type === "checkout.session.completed" || input.type === "checkout.session.async_payment_succeeded") &&
      input.object.payment_status === "paid"
    ) {
      await deliverEvent("payment_succeeded", payment.bookingId, payment);
    }
    if (refundEventConfirmed(input.type, input.object)) {
      await deliverEvent("refund_issued", payment.bookingId, payment);
    }
  });
}

async function sendBookingEvent(event: NotificationEvent, bookingId: string) {
  if (!isServiceRoleConfigured()) return;
  const admin = createAdminClient();
  const booking = await loadBooking(admin, bookingId);
  if (!booking) return;
  await deliverPrepared(planNotices({ event, booking, origin: siteUrl() }));
}

async function deliverEvent(event: NotificationEvent, bookingId: string, payment: NoticePayment) {
  const admin = createAdminClient();
  const booking = await loadBooking(admin, bookingId);
  if (!booking) return;
  await deliverPrepared(planNotices({ event, booking, payment, origin: siteUrl() }));
}

async function deliverPrepared(notices: OutboundNotice[], transport: MailTransport | null = resendTransport()) {
  if (!isServiceRoleConfigured()) return;
  const log = supabaseDeliveryLog(createAdminClient());
  for (const notice of notices) {
    await deliverNotification(notice, log, transport);
  }
}

async function sendSafely(work: () => Promise<void>) {
  try {
    await work();
  } catch {
    // The booking or payment is already saved. Mail cannot roll that back.
  }
}

async function loadBooking(admin: AdminClient, bookingId: string): Promise<NoticeBooking | null> {
  const booking = await admin
    .from("booking_requests")
    .select("id, customer_id, provider_id, service_name, preferred_date, time_window, status")
    .eq("id", bookingId)
    .maybeSingle();
  if (booking.error || !booking.data) return null;
  const row = booking.data as {
    id: string;
    customer_id: string;
    provider_id: string;
    service_name: string | null;
    preferred_date: string;
    time_window: string;
    status: string;
  };
  const [customer, provider, appointment] = await Promise.all([
    admin.from("profiles").select("id, email, full_name").eq("id", row.customer_id).maybeSingle(),
    admin.from("providers").select("id, business_name, owner_id, timezone").eq("id", row.provider_id).maybeSingle(),
    admin.from("booking_appointments").select("starts_at").eq("booking_id", row.id).maybeSingle(),
  ]);
  const ownerId = (provider.data?.owner_id as string | undefined) ?? "";
  const owner = ownerId
    ? await admin.from("profiles").select("id, email").eq("id", ownerId).maybeSingle()
    : { data: null };
  return {
    id: row.id,
    status: row.status,
    serviceName: row.service_name || "Service",
    preferredDate: String(row.preferred_date),
    timeWindow: row.time_window,
    startsAt: (appointment.data?.starts_at as string | undefined) ?? null,
    timeZone: (provider.data?.timezone as string | undefined) || "America/Chicago",
    businessName: (provider.data?.business_name as string | undefined) || "Provider",
    customerName: (customer.data?.full_name as string | undefined) || "",
    customerUserId: row.customer_id,
    customerEmail: (customer.data?.email as string | undefined) || "",
    providerUserId: ownerId,
    providerEmail: (owner.data?.email as string | undefined) || "",
  };
}

type DueDelivery = {
  idempotency_key: string;
  event_type: NotificationEvent;
  booking_id: string;
  recipient_role: "customer" | "provider";
  status: DeliveryStatus;
  updated_at: string;
};

async function retryOne(row: DueDelivery): Promise<"sent" | "failed" | "skipped"> {
  const admin = createAdminClient();
  const log = supabaseDeliveryLog(admin);
  const booking = await loadBooking(admin, row.booking_id);
  const loaded =
    row.event_type === "payment_succeeded" || row.event_type === "refund_issued"
      ? await loadPaymentById(admin, paymentIdFromKey(row.idempotency_key))
      : null;
  const payment = loaded && loaded.bookingId === row.booking_id ? loaded : null;
  const notice = booking
    ? planNotices({
        event: row.event_type,
        booking,
        payment: payment ?? undefined,
        origin: siteUrl(),
      }).find((item) => item.idempotencyKey === row.idempotency_key && item.role === row.recipient_role)
    : null;
  if (!notice) {
    await log.close(row.idempotency_key, "status_mismatch", new Date());
    return "skipped";
  }
  return deliverNotification(notice, log, resendTransport());
}

function paymentIdFromKey(key: string) {
  return key.split(":")[1] ?? "";
}

async function loadPaymentById(admin: AdminClient, paymentId: string) {
  if (!paymentId) return null;
  const payment = await admin
    .from("payments")
    .select("id, booking_id, status, amount_cents, refunded_cents")
    .eq("id", paymentId)
    .maybeSingle();
  if (payment.error || !payment.data) return null;
  return mapPayment(payment.data as Record<string, unknown>);
}

async function loadPayment(admin: AdminClient, object: Record<string, unknown>) {
  const meta = metadata(object);
  let query = admin.from("payments").select("id, booking_id, status, amount_cents, refunded_cents");
  if (meta.payment_id) query = query.eq("id", meta.payment_id);
  else if (typeof object.id === "string" && object.object === "checkout.session") query = query.eq("checkout_session_id", object.id);
  else if (typeof object.payment_intent === "string") query = query.eq("payment_intent_id", object.payment_intent);
  else if (typeof object.charge === "string") query = query.eq("charge_id", object.charge);
  else if (object.object === "charge" && typeof object.id === "string") query = query.eq("charge_id", object.id);
  else return null;
  const payment = await query.maybeSingle();
  if (payment.error || !payment.data) return null;
  return mapPayment(payment.data as Record<string, unknown>);
}

function mapPayment(row: Record<string, unknown>): NoticePayment & { bookingId: string } {
  return {
    id: String(row.id),
    bookingId: String(row.booking_id),
    status: String(row.status),
    amountCents: Number(row.amount_cents),
    refundedCents: Number(row.refunded_cents),
  };
}

function metadata(object: Record<string, unknown>) {
  const raw = object.metadata;
  if (!raw || typeof raw !== "object") return {} as Record<string, string>;
  return raw as Record<string, string>;
}

function refundEventConfirmed(type: string, object: Record<string, unknown>) {
  if (type !== "charge.refunded" && type !== "refund.updated" && type !== "charge.refund.updated") return false;
  if (object.object === "refund") return object.status === "succeeded";
  return object.object === "charge" && typeof object.amount_refunded === "number" && object.amount_refunded > 0;
}

function supabaseDeliveryLog(admin: AdminClient): DeliveryLog {
  return {
    async insertPending(notice, now) {
      const inserted = await admin
        .from("notification_deliveries")
        .insert({
          idempotency_key: notice.idempotencyKey,
          event_type: notice.event,
          booking_id: notice.bookingId,
          recipient_role: notice.role,
          recipient_user_id: notice.userId || null,
          status: "pending",
          attempt_count: 1,
          updated_at: now.toISOString(),
        })
        .select("id")
        .maybeSingle();
      if (!inserted.error && inserted.data) return "inserted";
      if (inserted.error && isUniqueViolation(inserted.error)) return "exists";
      throw new Error("The notification record could not be saved.");
    },
    async read(idempotencyKey) {
      const row = await admin
        .from("notification_deliveries")
        .select("idempotency_key, status, updated_at, attempt_count")
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (row.error || !row.data) return null;
      const data = row.data as {
        idempotency_key: string;
        status: "pending" | "sent" | "failed" | "skipped";
        updated_at: string;
        attempt_count: number;
      };
      return {
        idempotencyKey: data.idempotency_key,
        status: data.status,
        updatedAt: data.updated_at,
        attemptCount: data.attempt_count,
      };
    },
    async claimRetry(idempotencyKey, mode, staleBefore, now) {
      const current = await admin
        .from("notification_deliveries")
        .select("attempt_count")
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      const attempt = Number(current.data?.attempt_count ?? 0);
      if (!current.data || attempt >= 50) return null;
      const nextAttempt = attempt + 1;
      let claimedQuery = admin
        .from("notification_deliveries")
        .update({ status: "pending", updated_at: now.toISOString(), attempt_count: nextAttempt })
        .eq("idempotency_key", idempotencyKey)
        .eq("attempt_count", attempt)
        .eq("status", mode === "failed" ? "failed" : "pending");
      if (mode === "stale") claimedQuery = claimedQuery.lt("updated_at", staleBefore);
      const claimed = await claimedQuery.select("id").maybeSingle();
      return claimed.data ? nextAttempt : null;
    },
    async finish(idempotencyKey, status, errorCode, providerMessageId, now, attemptCount) {
      const saved = await admin
        .from("notification_deliveries")
        .update({
          status,
          error_code: errorCode,
          provider_message_id: providerMessageId,
          updated_at: now.toISOString(),
        })
        .eq("idempotency_key", idempotencyKey)
        .eq("status", "pending")
        .eq("attempt_count", attemptCount)
        .select("id")
        .maybeSingle();
      if (saved.error) throw new Error("The notification result could not be saved.");
      return Boolean(saved.data);
    },
    async close(idempotencyKey, errorCode, now) {
      await admin
        .from("notification_deliveries")
        .update({ status: "skipped", error_code: errorCode, updated_at: now.toISOString() })
        .eq("idempotency_key", idempotencyKey)
        .in("status", ["pending", "failed"]);
    },
  };
}

function isUniqueViolation(error: { code?: string; message?: string }) {
  return error.code === "23505" || /duplicate key|idempotency_key/i.test(error.message ?? "");
}
