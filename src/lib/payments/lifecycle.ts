export function firstChargeDecision(
  payment: { paymentIntentId: string | null },
  incomingIntent: string | null,
) {
  if (incomingIntent && payment.paymentIntentId && payment.paymentIntentId !== incomingIntent) {
    return "duplicate" as const;
  }
  return "record" as const;
}

export function terminalRefundDecision(status: string) {
  if (status === "cancelled" || status === "declined" || status === "expired") return "refund" as const;
  return "keep" as const;
}

export const DUPLICATE_REFUND_ATTEMPT_LIMIT = 5;

const PERMANENT_REFUND_FAILURES = new Set([
  "lost_or_stolen_card",
  "expired_or_canceled_card",
  "charge_for_pending_refund",
]);

export function duplicateRefundKey(paymentIntentId: string, attempt = 1) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("Refund attempt must be a positive integer.");
  }
  if (attempt === 1) return `duplicate_refund_${paymentIntentId}`;
  return `duplicate_refund_${paymentIntentId}_${attempt}`;
}

export function refundRetryKey(refundId: string, attempt = 1) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("Refund attempt must be a positive integer.");
  }
  if (attempt === 1) return `refund_${refundId}`;
  return `refund_${refundId}_${attempt}`;
}

export function duplicateRefundPlan(input: {
  outcome: "succeeded" | "pending" | "failed" | "canceled" | "uncertain" | "rejected";
  failureCode: string | null;
  attemptCount: number;
  nowMs: number;
}) {
  if (input.outcome === "succeeded") {
    return { status: "refunded" as const, attemptCount: input.attemptCount, nextRetryAtMs: null, review: false };
  }
  const permanent = input.outcome === "rejected" || (input.failureCode != null && PERMANENT_REFUND_FAILURES.has(input.failureCode));
  const nextAttempt = input.outcome === "pending" || input.outcome === "uncertain" ? input.attemptCount : input.attemptCount + 1;
  if (permanent || nextAttempt >= DUPLICATE_REFUND_ATTEMPT_LIMIT) {
    return { status: "needs_review" as const, attemptCount: nextAttempt, nextRetryAtMs: null, review: true };
  }
  const minutes = [5, 15, 45, 120][Math.min(Math.max(nextAttempt - 1, 0), 3)];
  return {
    status: "refund_pending" as const,
    attemptCount: nextAttempt,
    nextRetryAtMs: input.nowMs + minutes * 60 * 1000,
    review: false,
  };
}

export function savedChargeResult(input: { error: string | null; savedId: string | null; existingId: string | null }) {
  if (input.error) return { ok: false as const, message: input.error };
  if (input.savedId || input.existingId) return { ok: true as const };
  return { ok: false as const, message: "The extra charge was not saved." };
}

export function checkoutReuseDecision(session: { status: string | null; url: string | null }) {
  if (session.status === "open" && session.url) return { action: "reuse" as const, url: session.url };
  if (session.status === "complete") return { action: "wait" as const };
  return { action: "create" as const };
}
