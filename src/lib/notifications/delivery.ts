import type { OutboundNotice } from "./content.ts";

export const DELIVERY_STALE_MS = 10 * 60 * 1000;
export const DELIVERY_ATTEMPT_LIMIT = 50;
export const NOTIFICATION_FROM = "BlockBooked Notifications <notifications@blockbooked.org>";

export type DeliveryStatus = "pending" | "sent" | "failed" | "skipped";

export type DeliveryRow = {
  idempotencyKey: string;
  status: DeliveryStatus;
  updatedAt: string;
  attemptCount: number;
};

export type DeliveryLog = {
  insertPending(notice: OutboundNotice, now: Date): Promise<"inserted" | "exists">;
  read(idempotencyKey: string): Promise<DeliveryRow | null>;
  claimRetry(idempotencyKey: string, mode: "failed" | "stale", staleBefore: string, now: Date): Promise<number | null>;
  finish(
    idempotencyKey: string,
    status: Exclude<DeliveryStatus, "pending">,
    errorCode: string | null,
    providerMessageId: string | null,
    now: Date,
    attemptCount: number,
  ): Promise<boolean>;
  close(idempotencyKey: string, errorCode: string, now: Date): Promise<void>;
};

export type MailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
};

export type MailTransport = (message: MailMessage) => Promise<{ id: string }>;

export function notificationsEnabled(env: { enabled?: string; apiKey?: string } = {
  enabled: process.env.NOTIFICATIONS_ENABLED,
  apiKey: process.env.RESEND_API_KEY,
}) {
  return env.enabled === "true" && Boolean(env.apiKey?.trim());
}

export function deliveryDue(status: DeliveryStatus, updatedAt: string, now: Date) {
  if (status === "failed") return true;
  if (status !== "pending") return false;
  return updatedAt < new Date(now.getTime() - DELIVERY_STALE_MS).toISOString();
}

export function resendTransport(fetchImpl: typeof fetch = fetch, apiKey?: string): MailTransport | null {
  if (typeof window !== "undefined") throw new Error("Email delivery runs on the server.");
  const key = (apiKey ?? process.env.RESEND_API_KEY ?? "").trim();
  if (!key) return null;
  return async (message) => {
    let response: Response;
    try {
      response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Idempotency-Key": message.idempotencyKey,
        },
        body: JSON.stringify({
          from: NOTIFICATION_FROM,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw deliveryError("resend_network");
    }
    if (!response.ok) throw deliveryError(`resend_${response.status}`);
    const body = (await response.json().catch(() => ({}))) as { id?: unknown };
    return { id: typeof body.id === "string" ? body.id.slice(0, 80) : "" };
  };
}

function deliveryError(code: string) {
  const error = new Error("Email delivery failed.");
  (error as Error & { code: string }).code = code;
  return error;
}

function errorCode(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "resend_network";
  return /^resend_(network|[1-5][0-9]{2})$/.test(code) ? code : "resend_network";
}

export async function deliverNotification(
  notice: OutboundNotice,
  log: DeliveryLog,
  transport: MailTransport | null,
  now = new Date(),
): Promise<"sent" | "failed" | "skipped"> {
  const inserted = await log.insertPending(notice, now);
  let attempt = 1;
  if (inserted === "exists") {
    const existing = await log.read(notice.idempotencyKey);
    if (!existing || existing.status === "sent" || existing.status === "skipped") return "skipped";
    if (existing.attemptCount >= DELIVERY_ATTEMPT_LIMIT) {
      await log.close(notice.idempotencyKey, "attempt_limit", now);
      return "skipped";
    }
    const staleBefore = new Date(now.getTime() - DELIVERY_STALE_MS).toISOString();
    const mode = existing.status === "failed" ? "failed" : existing.updatedAt < staleBefore ? "stale" : null;
    if (!mode) return "skipped";
    const claimed = await log.claimRetry(notice.idempotencyKey, mode, staleBefore, now);
    if (claimed == null) return "skipped";
    attempt = claimed;
  }
  return finishDelivery(notice, log, transport, now, attempt);
}

async function recordOutcome(
  log: DeliveryLog,
  notice: OutboundNotice,
  status: Exclude<DeliveryStatus, "pending">,
  error: string | null,
  providerMessageId: string | null,
  now: Date,
  attempt: number,
) {
  let lastError: unknown;
  for (let tryNumber = 0; tryNumber < 3; tryNumber += 1) {
    try {
      return await log.finish(notice.idempotencyKey, status, error, providerMessageId, now, attempt);
    } catch (caught) {
      lastError = caught;
    }
  }
  throw lastError;
}

async function finishDelivery(
  notice: OutboundNotice,
  log: DeliveryLog,
  transport: MailTransport | null,
  now: Date,
  attempt: number,
) {
  if (!notice.to) {
    await recordOutcome(log, notice, "skipped", "missing_recipient", null, now, attempt);
    return "skipped";
  }
  if (!transport) {
    await recordOutcome(log, notice, "failed", "not_configured", null, now, attempt);
    return "failed";
  }
  let sent: { id: string };
  try {
    sent = await transport({
      to: notice.to,
      subject: notice.subject,
      html: notice.html,
      text: notice.text,
      idempotencyKey: notice.idempotencyKey,
    });
  } catch (error) {
    await recordOutcome(log, notice, "failed", errorCode(error), null, now, attempt);
    return "failed";
  }
  await recordOutcome(log, notice, "sent", null, sent.id || null, now, attempt);
  return "sent";
}
