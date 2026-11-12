import { zonedClock } from "../calendar.ts";
import { formatUsd } from "../payments/money.ts";

export const notificationEvents = [
  "booking_requested",
  "booking_accepted",
  "payment_succeeded",
  "booking_cancelled",
  "refund_issued",
  "booking_completed",
] as const;

export type NotificationEvent = (typeof notificationEvents)[number];
export type NotificationRole = "customer" | "provider";

export type NoticeBooking = {
  id: string;
  status: string;
  serviceName: string;
  preferredDate: string;
  timeWindow: string;
  startsAt: string | null;
  timeZone: string;
  businessName: string;
  customerName: string;
  customerUserId: string;
  customerEmail: string;
  providerUserId: string;
  providerEmail: string;
};

export type NoticePayment = {
  id: string;
  status: string;
  amountCents: number;
  refundedCents: number;
};

export type OutboundNotice = {
  event: NotificationEvent;
  role: NotificationRole;
  bookingId: string;
  userId: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
};

const subjects: Record<NotificationEvent, string> = {
  booking_requested: "New booking request",
  booking_accepted: "Your booking was accepted",
  payment_succeeded: "Payment received",
  booking_cancelled: "Booking canceled",
  refund_issued: "Refund issued",
  booking_completed: "Booking completed",
};

const nextActions: Record<NotificationEvent, string> = {
  booking_requested: "Review the request and accept it after the payment is confirmed.",
  booking_accepted: "Open the booking to see the appointment and your next step.",
  payment_succeeded: "The provider can accept the booking once this payment shows as received.",
  booking_cancelled: "Open the booking to see its current status.",
  refund_issued: "The refund goes back to the original payment method and can take several days to appear.",
  booking_completed: "Open the booking if you need the receipt of this visit.",
};

export function rolesForEvent(event: NotificationEvent): NotificationRole[] {
  if (event === "booking_requested") return ["provider"];
  if (event === "booking_accepted" || event === "payment_succeeded" || event === "refund_issued") return ["customer"];
  return ["customer", "provider"];
}

export function eventMatchesRecord(event: NotificationEvent, bookingStatus: string, payment?: NoticePayment) {
  if (event === "booking_requested") return bookingStatus === "pending" || bookingStatus === "requested";
  if (event === "booking_accepted") return bookingStatus === "accepted";
  if (event === "booking_cancelled") return bookingStatus === "cancelled";
  if (event === "booking_completed") return bookingStatus === "completed";
  if (event === "payment_succeeded") return payment?.status === "succeeded";
  if (event === "refund_issued") {
    return Boolean(payment && payment.refundedCents > 0 && (payment.status === "refunded" || payment.status === "partially_refunded"));
  }
  return false;
}

export function shouldNotifyAfterWebhook(status: string) {
  return status === "processed";
}

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function sanitizeSubject(value: string) {
  return displayText(value).slice(0, 120);
}

export function displayText(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

const bookingIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function safeBookingId(value: string) {
  return bookingIdPattern.test(value) ? value.toLowerCase() : "";
}

export function safeOrigin(value: string) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return "";
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol === "https:" || (url.protocol === "http:" && local)) return url.origin;
  } catch {
    return "";
  }
  return "";
}

function usableAddress(value: string) {
  const address = value.trim();
  if (address.length < 3 || address.length > 320 || /[\r\n]/.test(address)) return "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : "";
}

export function trustedRecipient(role: NotificationRole, booking: NoticeBooking) {
  return usableAddress(role === "customer" ? booking.customerEmail : booking.providerEmail);
}

export function idempotencyKey(event: NotificationEvent, booking: NoticeBooking, role: NotificationRole, payment?: NoticePayment) {
  if (event === "payment_succeeded" && payment) return `payment_succeeded:${payment.id}:${role}`;
  if (event === "refund_issued" && payment) return `refund_issued:${payment.id}:${payment.refundedCents}:${role}`;
  return `${event}:${booking.id}:${role}`;
}

export function bookingPath(role: NotificationRole, bookingId: string) {
  return role === "customer" ? `/account#booking-${bookingId}` : `/dashboard#booking-${bookingId}`;
}

export function planNotices(input: {
  event: NotificationEvent;
  booking: NoticeBooking;
  payment?: NoticePayment;
  origin: string;
}): OutboundNotice[] {
  const origin = safeOrigin(input.origin);
  const bookingId = safeBookingId(input.booking.id);
  if (!origin || !bookingId || !eventMatchesRecord(input.event, input.booking.status, input.payment)) return [];
  const when = noticeWhen(input.booking);
  return rolesForEvent(input.event).map((role) => {
    const to = trustedRecipient(role, input.booking);
    const link = `${origin}${bookingPath(role, bookingId)}`;
    const subject = sanitizeSubject(`${subjects[input.event]} · ${input.booking.serviceName || "BlockBooked"}`);
    const facts = noticeFacts(input.event, input.booking, when, input.payment);
    const action = nextActions[input.event];
    return {
      event: input.event,
      role,
      bookingId,
      userId: role === "customer" ? input.booking.customerUserId : input.booking.providerUserId,
      to,
      subject,
      html: renderHtml({ subject, facts, action, link }),
      text: renderText({ subject, facts, action, link }),
      idempotencyKey: idempotencyKey(input.event, { ...input.booking, id: bookingId }, role, input.payment),
    };
  });
}

function noticeWhen(booking: NoticeBooking) {
  const clock = booking.startsAt ? zonedClock(booking.startsAt, booking.timeZone || "America/Chicago") : "";
  return clock ? `${booking.preferredDate} · ${clock}` : `${booking.preferredDate} · ${booking.timeWindow}`;
}

function noticeFacts(event: NotificationEvent, booking: NoticeBooking, when: string, payment?: NoticePayment) {
  const facts = [
    ["Service", displayText(booking.serviceName || "Service")],
    ["When", displayText(when)],
    ["Provider", displayText(booking.businessName || "Your provider")],
  ];
  if (event === "booking_requested" && booking.customerName) facts.push(["Customer", displayText(booking.customerName)]);
  if (event === "payment_succeeded" && payment) facts.push(["Amount paid", formatUsd(payment.amountCents)]);
  if (event === "refund_issued" && payment) facts.push(["Refunded total", formatUsd(payment.refundedCents)]);
  return facts;
}

function renderHtml(input: { subject: string; facts: string[][]; action: string; link: string }) {
  const rows = input.facts
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 0;color:#6d6256;font-size:14px;">${escapeHtml(label)}</td><td style="padding:6px 0 6px 16px;color:#142033;font-size:14px;font-weight:600;">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<style>@media (max-width:600px){.card{width:100%!important;}}</style>
</head>
<body style="margin:0;padding:0;background:#f4f1ea;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ea;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" class="card" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:560px;background:#fffcf8;border:1px solid #e3dbd0;border-radius:16px;">
<tr><td style="padding:28px 28px 8px;font-family:Georgia,serif;font-size:28px;color:#142033;">BlockBooked</td></tr>
<tr><td style="padding:0 28px 8px;font-family:Arial,sans-serif;font-size:20px;line-height:1.4;color:#142033;">${escapeHtml(input.subject)}</td></tr>
<tr><td style="padding:8px 28px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>
<tr><td style="padding:18px 28px 0;font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#142033;">${escapeHtml(input.action)}</td></tr>
<tr><td style="padding:20px 28px 28px;"><a href="${escapeHtml(input.link)}" style="display:inline-block;background:#c45c26;color:#ffffff;text-decoration:none;border-radius:999px;padding:12px 18px;font-family:Arial,sans-serif;font-size:14px;font-weight:700;">View booking</a></td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function renderText(input: { subject: string; facts: string[][]; action: string; link: string }) {
  const lines = ["BlockBooked", input.subject, ""];
  for (const [label, value] of input.facts) lines.push(`${label}: ${value}`);
  lines.push("", input.action, input.link);
  return lines.join("\n");
}
