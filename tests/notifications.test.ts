import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  escapeHtml,
  eventMatchesRecord,
  planNotices,
  rolesForEvent,
  safeOrigin,
  sanitizeSubject,
  shouldNotifyAfterWebhook,
  type NoticeBooking,
  type NoticePayment,
  type OutboundNotice,
} from "../src/lib/notifications/content.ts";
import {
  NOTIFICATION_FROM,
  deliverNotification,
  deliveryDue,
  notificationsEnabled,
  resendTransport,
  type DeliveryLog,
  type DeliveryRow,
  type MailTransport,
} from "../src/lib/notifications/delivery.ts";

const bookingId = "00000000-0000-4000-8000-000000000001";
const paymentId = "00000000-0000-4000-8000-000000000002";

const bookings = readFileSync(new URL("../src/app/actions/bookings.ts", import.meta.url), "utf8");
const webhook = readFileSync(new URL("../src/app/api/stripe/webhook/route.ts", import.meta.url), "utf8");
const cron = readFileSync(new URL("../src/app/api/cron/expire-bookings/route.ts", import.meta.url), "utf8");
const payments = readFileSync(new URL("../src/lib/payments/service.ts", import.meta.url), "utf8");
const dispatch = readFileSync(new URL("../src/lib/notifications/dispatch.ts", import.meta.url), "utf8");
const content = readFileSync(new URL("../src/lib/notifications/content.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20261112010000_notification_deliveries.sql", import.meta.url), "utf8");
const auth = readFileSync(new URL("../src/app/actions/auth.ts", import.meta.url), "utf8");

function booking(overrides: Partial<NoticeBooking> = {}): NoticeBooking {
  return {
    id: bookingId,
    status: "pending",
    serviceName: "House cleaning",
    preferredDate: "2026-11-20",
    timeWindow: "Morning",
    startsAt: null,
    timeZone: "America/Chicago",
    businessName: "BlockBooked Test Cleaning",
    customerName: "Casey Customer",
    customerUserId: "customer-1",
    customerEmail: "customer@example.com",
    providerUserId: "provider-1",
    providerEmail: "owner@example.com",
    ...overrides,
  };
}

function payment(overrides: Partial<NoticePayment> = {}): NoticePayment {
  return { id: paymentId, status: "succeeded", amountCents: 10000, refundedCents: 0, ...overrides };
}

class MemoryLog implements DeliveryLog {
  rows = new Map<string, DeliveryRow & { errorCode: string | null }>();

  async insertPending(notice: OutboundNotice, now: Date) {
    if (this.rows.has(notice.idempotencyKey)) return "exists" as const;
    this.rows.set(notice.idempotencyKey, {
      idempotencyKey: notice.idempotencyKey,
      status: "pending",
      updatedAt: now.toISOString(),
      attemptCount: 1,
      errorCode: null,
    });
    return "inserted" as const;
  }

  async read(idempotencyKey: string) {
    return this.rows.get(idempotencyKey) ?? null;
  }

  async claimRetry(idempotencyKey: string, mode: "failed" | "stale", staleBefore: string, now: Date) {
    const row = this.rows.get(idempotencyKey);
    if (!row || row.attemptCount >= 50) return null;
    if (mode === "failed" && row.status !== "failed") return null;
    if (mode === "stale" && (row.status !== "pending" || row.updatedAt >= staleBefore)) return null;
    row.status = "pending";
    row.updatedAt = now.toISOString();
    row.attemptCount += 1;
    return row.attemptCount;
  }

  async finish(
    idempotencyKey: string,
    status: "sent" | "failed" | "skipped",
    errorCode: string | null,
    _providerMessageId: string | null,
    _now: Date,
    attemptCount: number,
  ) {
    const row = this.rows.get(idempotencyKey);
    if (!row) throw new Error("missing");
    if (row.status !== "pending" || row.attemptCount !== attemptCount) return false;
    row.status = status;
    row.errorCode = errorCode;
    return true;
  }

  async close(idempotencyKey: string, errorCode: string) {
    const row = this.rows.get(idempotencyKey);
    if (!row || (row.status !== "pending" && row.status !== "failed")) return;
    row.status = "skipped";
    row.errorCode = errorCode;
  }
}

describe("notification recipients and events", () => {
  it("sends each event to the account that should receive it", () => {
    assert.deepEqual(rolesForEvent("booking_requested"), ["provider"]);
    assert.deepEqual(rolesForEvent("booking_accepted"), ["customer"]);
    assert.deepEqual(rolesForEvent("payment_succeeded"), ["customer"]);
    assert.deepEqual(rolesForEvent("refund_issued"), ["customer"]);
    assert.deepEqual(rolesForEvent("booking_cancelled"), ["customer", "provider"]);
    assert.deepEqual(rolesForEvent("booking_completed"), ["customer", "provider"]);

    const requested = planNotices({ event: "booking_requested", booking: booking(), origin: "https://blockbooked.org" });
    assert.deepEqual(requested.map((notice) => notice.to), ["owner@example.com"]);
    assert.equal(requested[0]?.subject.startsWith("New booking request"), true);

    const accepted = planNotices({
      event: "booking_accepted",
      booking: booking({ status: "accepted" }),
      origin: "https://blockbooked.org",
    });
    assert.deepEqual(accepted.map((notice) => notice.to), ["customer@example.com"]);
    assert.match(accepted[0]?.html ?? "", new RegExp(`/account#booking-${bookingId}`));

    const cancelled = planNotices({
      event: "booking_cancelled",
      booking: booking({ status: "cancelled" }),
      origin: "https://blockbooked.org",
    });
    assert.deepEqual(
      cancelled.map((notice) => notice.to),
      ["customer@example.com", "owner@example.com"],
    );
    assert.match(cancelled[1]?.html ?? "", new RegExp(`/dashboard#booking-${bookingId}`));
  });

  it("follows the saved booking status and ignores a stranger address", () => {
    assert.equal(eventMatchesRecord("booking_accepted", "pending"), false);
    assert.equal(eventMatchesRecord("booking_cancelled", "declined"), true);
    assert.equal(eventMatchesRecord("booking_cancelled", "canceled"), false);
    assert.equal(eventMatchesRecord("booking_completed", "accepted"), false);
    assert.deepEqual(planNotices({ event: "booking_accepted", booking: booking({ status: "pending" }), origin: "https://blockbooked.org" }), []);
    const sent = planNotices({
      event: "booking_completed",
      booking: booking({ status: "completed", customerEmail: "customer@example.com", providerEmail: "owner@example.com" }),
      origin: "https://blockbooked.org",
    });
    assert.deepEqual(sent.map((notice) => notice.to).sort(), ["customer@example.com", "owner@example.com"]);
    assert.equal(sent.some((notice) => notice.to === "stranger@example.com"), false);
  });

  it("maps payment and refund totals without repeating the same refund", () => {
    const paid = planNotices({
      event: "payment_succeeded",
      booking: booking({ status: "pending" }),
      payment: payment(),
      origin: "https://blockbooked.org",
    });
    assert.equal(paid.length, 1);
    assert.match(paid[0]?.text ?? "", /\$100\.00/);
    assert.equal(paid[0]?.idempotencyKey, `payment_succeeded:${paymentId}:customer`);

    const partial = planNotices({
      event: "refund_issued",
      booking: booking({ status: "cancelled" }),
      payment: payment({ status: "partially_refunded", refundedCents: 2500 }),
      origin: "https://blockbooked.org",
    });
    const full = planNotices({
      event: "refund_issued",
      booking: booking({ status: "cancelled" }),
      payment: payment({ status: "refunded", refundedCents: 10000 }),
      origin: "https://blockbooked.org",
    });
    assert.equal(partial[0]?.idempotencyKey, `refund_issued:${paymentId}:2500:customer`);
    assert.notEqual(partial[0]?.idempotencyKey, full[0]?.idempotencyKey);
    assert.equal(planNotices({ event: "refund_issued", booking: booking(), payment: payment({ refundedCents: 0 }), origin: "https://blockbooked.org" }).length, 0);
    assert.equal(shouldNotifyAfterWebhook("processed"), true);
    assert.equal(shouldNotifyAfterWebhook("duplicate"), false);
    assert.equal(shouldNotifyAfterWebhook("failed"), false);
  });
});

describe("notification delivery", () => {
  const notice = () =>
    planNotices({ event: "booking_requested", booking: booking(), origin: "https://blockbooked.org" })[0]!;

  it("sends once when the same event is delivered twice", async () => {
    const log = new MemoryLog();
    let calls = 0;
    const transport: MailTransport = async () => {
      calls += 1;
      return { id: "msg_1" };
    };
    assert.equal(await deliverNotification(notice(), log, transport), "sent");
    assert.equal(await deliverNotification(notice(), log, transport), "skipped");
    assert.equal(calls, 1);
  });

  it("records a provider failure and retries it without throwing", async () => {
    const log = new MemoryLog();
    let calls = 0;
    const keys: string[] = [];
    const failing: MailTransport = async (message) => {
      calls += 1;
      keys.push(message.idempotencyKey);
      const error = new Error("Email delivery failed.");
      (error as Error & { code: string }).code = "resend_503";
      throw error;
    };
    assert.equal(await deliverNotification(notice(), log, failing), "failed");
    assert.equal(log.rows.get(notice().idempotencyKey)?.errorCode, "resend_503");
    const recovering: MailTransport = async (message) => {
      calls += 1;
      keys.push(message.idempotencyKey);
      return { id: "msg_2" };
    };
    assert.equal(await deliverNotification(notice(), log, recovering), "sent");
    assert.equal(calls, 2);
    assert.equal(keys[0], keys[1]);
  });

  it("records a successful provider response once when the database update needs another try", async () => {
    const log = new MemoryLog();
    const realFinish = log.finish.bind(log);
    let finishAttempts = 0;
    log.finish = async (...args) => {
      finishAttempts += 1;
      if (finishAttempts < 3) throw new Error("database unavailable");
      return realFinish(...args);
    };
    let calls = 0;
    const result = await deliverNotification(notice(), log, async (message) => {
      calls += 1;
      assert.equal(message.idempotencyKey, notice().idempotencyKey);
      return { id: "msg_saved" };
    });
    assert.equal(result, "sent");
    assert.equal(calls, 1);
    assert.equal(log.rows.get(notice().idempotencyKey)?.status, "sent");
  });

  it("does not let a late attempt replace a recorded delivery", async () => {
    const log = new MemoryLog();
    await deliverNotification(notice(), log, async () => ({ id: "msg_1" }));
    const row = log.rows.get(notice().idempotencyKey);
    assert.equal(row?.status, "sent");
    const replaced = await log.finish(notice().idempotencyKey, "failed", "resend_500", null, new Date(), row?.attemptCount ?? 1);
    assert.equal(replaced, false);
    assert.equal(log.rows.get(notice().idempotencyKey)?.status, "sent");
  });

  it("retries a stale pending row with the same provider key and leaves a fresh pending row alone", async () => {
    const log = new MemoryLog();
    const first = notice();
    await log.insertPending(first, new Date("2026-11-12T00:00:00.000Z"));
    const fresh = await deliverNotification(first, log, async () => ({ id: "should-not-send" }), new Date("2026-11-12T00:05:00.000Z"));
    assert.equal(fresh, "skipped");
    let key = "";
    const stale = await deliverNotification(first, log, async (message) => {
      key = message.idempotencyKey;
      return { id: "msg_retry" };
    }, new Date("2026-11-12T00:20:00.000Z"));
    assert.equal(stale, "sent");
    assert.equal(key, first.idempotencyKey);
    assert.equal(deliveryDue("pending", "2026-11-12T00:00:00.000Z", new Date("2026-11-12T00:20:00.000Z")), true);
    assert.equal(deliveryDue("pending", "2026-11-12T00:16:00.000Z", new Date("2026-11-12T00:20:00.000Z")), false);
    assert.equal(deliveryDue("failed", "2026-11-12T00:19:00.000Z", new Date("2026-11-12T00:20:00.000Z")), true);
    assert.equal(deliveryDue("sent", "2026-11-12T00:00:00.000Z", new Date("2026-11-12T00:20:00.000Z")), false);
  });

  it("skips a missing address and does not call the mail provider", async () => {
    const log = new MemoryLog();
    let calls = 0;
    const missing = planNotices({
      event: "booking_requested",
      booking: booking({ providerEmail: "" }),
      origin: "https://blockbooked.org",
    })[0]!;
    const result = await deliverNotification(missing, log, async () => {
      calls += 1;
      return { id: "msg" };
    });
    assert.equal(result, "skipped");
    assert.equal(calls, 0);
    assert.equal(log.rows.get(missing.idempotencyKey)?.errorCode, "missing_recipient");
  });

  it("keeps the Resend key out of the message and skips the network when it is absent", async () => {
    assert.equal(resendTransport(fetch, ""), null);
    const requests: { url: string; body: string; authorization: string }[] = [];
    const transport = resendTransport(async (url, init) => {
      const headers = new Headers(init?.headers);
      requests.push({ url: String(url), body: String(init?.body), authorization: headers.get("authorization") ?? "" });
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    }, "test-resend-key");
    const sent = await transport?.(notice());
    assert.equal(sent?.id, "email_1");
    assert.equal(requests.length, 1);
    assert.match(requests[0]!.body, new RegExp(NOTIFICATION_FROM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(requests[0]!.body.includes("test-resend-key"), false);
    assert.equal(requests[0]!.authorization, "Bearer test-resend-key");

    const failed = resendTransport(async () => new Response("no", { status: 422 }), "test-resend-key");
    await assert.rejects(() => failed?.(notice()), /Email delivery failed/);
  });
});

describe("cancellation notifications", () => {
  it("tells both people when a paid or unpaid booking is canceled or declined", () => {
    const paid = planNotices({
      event: "booking_cancelled",
      booking: booking({ status: "cancelled" }),
      payment: payment({ status: "refunded", refundedCents: 10000 }),
      origin: "https://blockbooked.org",
    });
    const unpaid = planNotices({
      event: "booking_cancelled",
      booking: booking({ status: "cancelled" }),
      origin: "https://blockbooked.org",
    });
    const declined = planNotices({
      event: "booking_cancelled",
      booking: booking({ status: "declined" }),
      payment: payment({ status: "refunded", refundedCents: 10000 }),
      origin: "https://blockbooked.org",
    });
    const refund = planNotices({
      event: "refund_issued",
      booking: booking({ status: "declined" }),
      payment: payment({ status: "refunded", refundedCents: 10000 }),
      origin: "https://blockbooked.org",
    });
    for (const notices of [paid, unpaid, declined]) {
      assert.deepEqual(notices.map((notice) => notice.role), ["customer", "provider"]);
      assert.deepEqual(notices.map((notice) => notice.to), ["customer@example.com", "owner@example.com"]);
    }
    assert.match(paid[0]?.subject ?? "", /^Booking canceled/);
    assert.match(declined[0]?.subject ?? "", /^Booking declined/);
    assert.equal(refund.length, 1);
    assert.equal(refund[0]?.role, "customer");
    assert.notEqual(refund[0]?.idempotencyKey, declined[0]?.idempotencyKey);
    assert.equal(declined[0]?.idempotencyKey, `booking_cancelled:${bookingId}:customer`);
    assert.equal(declined[1]?.idempotencyKey, `booking_cancelled:${bookingId}:provider`);
  });

  it("sends one cancellation email when the same cancellation is dispatched twice", async () => {
    const log = new MemoryLog();
    const [customerNotice] = planNotices({
      event: "booking_cancelled",
      booking: booking({ status: "declined" }),
      origin: "https://blockbooked.org",
    });
    let calls = 0;
    const transport: MailTransport = async () => {
      calls += 1;
      return { id: "cancel_1" };
    };
    assert.equal(await deliverNotification(customerNotice!, log, transport), "sent");
    assert.equal(await deliverNotification(customerNotice!, log, transport), "skipped");
    assert.equal(calls, 1);
  });
});

describe("notification content safety", () => {
  it("escapes service details and leaves private fields out of the message", () => {
    const hostile = booking({
      status: "accepted",
      serviceName: `<script>alert("x")</script>\nBcc: evil@example.com`,
      businessName: `Tom & "Jerry"`,
    });
    const [message] = planNotices({ event: "booking_accepted", booking: hostile, origin: "https://blockbooked.org" });
    assert.match(message?.html ?? "", /&lt;script&gt;/);
    assert.doesNotMatch(message?.html ?? "", /<script>/);
    assert.match(message?.html ?? "", /Tom &amp; &quot;Jerry&quot;/);
    assert.equal(sanitizeSubject(hostile.serviceName).includes("\n"), false);
    assert.doesNotMatch(message?.text ?? "", /PIN|notes|contact_phone/i);
    assert.doesNotMatch(message?.html ?? "", /javascript:/);
    assert.equal(safeOrigin("javascript:alert(1)"), "");
    assert.equal(planNotices({ event: "booking_requested", booking: booking(), origin: "javascript:alert(1)" }).length, 0);
    assert.equal(notificationsEnabled({ enabled: "true", apiKey: "present" }), true);
    assert.equal(notificationsEnabled({ enabled: undefined, apiKey: "present" }), false);
    assert.equal(notificationsEnabled({ enabled: "true", apiKey: "" }), false);
    assert.match(content, /escapeHtml/);
    assert.doesNotMatch(content, /contact_phone|completion pin|notes/i);
  });
});

describe("notification wiring", () => {
  it("sends only after the booking or payment write and keeps auth email on Supabase", () => {
    assert.match(bookings, /await notifyBookingEvent\("booking_requested", inserted\.data\.id\)/);
    assert.match(bookings, /if \(nextStatus === "accepted"\) await notifyBookingEvent\("booking_accepted", bookingId\)/);
    assert.match(bookings, /if \(nextStatus === "cancelled" \|\| nextStatus === "declined"\) await notifyBookingEvent\("booking_cancelled", bookingId\)/);
    const cancellation = bookings.indexOf('await notifyBookingEvent("booking_cancelled"');
    const refund = bookings.indexOf("await requestRefund({");
    assert.ok(cancellation > -1 && cancellation < refund);
    assert.match(bookings, /await notifyBookingEvent\("booking_completed", bookingId\)/);
    assert.doesNotMatch(bookings, /notifyBookingEvent\("booking_declined"/);
    const completed = bookings.indexOf('await notifyBookingEvent("booking_completed"');
    const transfer = bookings.indexOf("await releaseProviderTransfer(bookingId)");
    assert.ok(completed > -1 && completed < transfer);

    const processed = webhook.indexOf("await applyStripeEvent");
    const mailed = webhook.indexOf("await notifyPersistedStripeEvent");
    assert.ok(processed > -1 && mailed > processed);
    assert.match(webhook, /deliveryStatus: result\.status/);

    const saved = payments.indexOf("const savedPayment = await admin");
    const mailedRefund = payments.indexOf("await notifyRefundIssued(input.bookingId, input.payment.id)");
    assert.ok(saved > -1 && mailedRefund > saved);

    assert.match(dispatch, /select\("id, customer_id, provider_id, service_name, preferred_date, time_window, status"\)/);
    assert.match(dispatch, /notificationsEnabled\(\)/);
    assert.match(dispatch, /\.eq\("status", "pending"\)/);
    assert.doesNotMatch(dispatch, /notes|contact_phone|\bpin\b/i);
    assert.match(migration, /enable row level security/);
    assert.match(migration, /force row level security/);
    assert.match(migration, /revoke all on table public\.notification_deliveries from public, anon, authenticated, service_role/);
    assert.match(migration, /grant select, insert, update on table public\.notification_deliveries to service_role/);
    assert.match(migration, /error_code ~ '\^\[a-z0-9_\]\{1,80\}\$'/);
    assert.doesNotMatch(migration, /create policy/i);
    assert.match(cron, /retryDueNotifications/);
    assert.match(auth, /supabase\.auth\.signUp/);
    assert.doesNotMatch(auth, /resend|notifications@blockbooked\.org/);

    const clientImports = sourceFiles("src").filter((file) => file.source.startsWith('"use client"') || file.source.includes('\n"use client"'));
    assert.equal(clientImports.some((file) => file.source.includes("lib/notifications")), false);
    assert.deepEqual(
      sourceFiles("src")
        .filter((file) => file.source.includes("RESEND_API_KEY"))
        .map((file) => file.path.replaceAll("\\", "/")),
      ["src/lib/notifications/delivery.ts"],
    );
  });
});

function sourceFiles(directory: string): { path: string; source: string }[] {
  const found: { path: string; source: string }[] = [];
  for (const entry of readdirSync(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true })) {
    const child = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sourceFiles(child));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      found.push({ path: child, source: readFileSync(new URL(`../${child}`, import.meta.url), "utf8") });
    }
  }
  return found;
}
