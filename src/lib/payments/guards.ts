export type StripeFailureKind = "rejected" | "uncertain";

export function classifyStripeFailure(input: { type?: string; statusCode?: number; message?: string }): StripeFailureKind {
  const type = input.type ?? "";
  if (
    type === "StripeConnectionError" ||
    type === "StripeAPIError" ||
    type === "StripeRateLimitError" ||
    type === "StripeIdempotencyError"
  ) {
    return "uncertain";
  }
  if (typeof input.statusCode === "number" && input.statusCode >= 500) return "uncertain";
  if (typeof input.statusCode !== "number" && /timeout|network|ECONNRESET|ETIMEDOUT|fetch failed/i.test(input.message ?? "")) {
    return "uncertain";
  }
  return "rejected";
}

export function refundActorAllowed(input: { automatic?: boolean; actorRole?: string | null }) {
  void input.actorRole;
  return input.automatic === true;
}

export function transferIdempotencyKey(paymentId: string, attempt: number) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("Transfer attempt must be a positive integer.");
  }
  return `transfer_${paymentId}_${attempt}`;
}

export function transferClaimDecision(input: {
  paymentId: string;
  transferId: string | null;
  transferStatus: string;
  attempt: number;
}) {
  if (input.transferId || input.transferStatus === "paid") {
    return { action: "skip" as const, reason: "already_transferred" as const };
  }
  if (input.transferStatus === "pending") {
    const attempt = Math.max(1, input.attempt);
    return {
      action: "replay" as const,
      attempt,
      idempotencyKey: transferIdempotencyKey(input.paymentId, attempt),
    };
  }
  if (input.transferStatus === "not_ready" || input.transferStatus === "failed") {
    const attempt = input.attempt + 1;
    return {
      action: "claim" as const,
      attempt,
      idempotencyKey: transferIdempotencyKey(input.paymentId, attempt),
    };
  }
  return { action: "stop" as const, reason: input.transferStatus };
}

export function claimedTransferKey(paymentId: string, attempt: number) {
  return transferIdempotencyKey(paymentId, attempt);
}

export function payoutLabel(status: string | null | undefined) {
  switch (status) {
    case "paid":
      return "payout paid";
    case "pending":
      return "payout pending confirmation";
    case "failed":
      return "payout failed";
    case "reversed":
      return "payout reversed";
    case "partially_reversed":
      return "payout partially reversed";
    case "not_ready":
      return "payout not sent";
    default:
      return "";
  }
}

export function refundIdempotencyKey(refundId: string) {
  return `refund_${refundId}`;
}

export function reversalIdempotencyKey(refundId: string) {
  return `reversal_${refundId}`;
}

export function recordedRefundCoverage(input: {
  amountCents: number;
  refundedCents: number;
  succeededRefundCents: number;
  openRefundId: string | null;
}) {
  if (input.openRefundId) return { action: "replay" as const };
  const covered = Math.max(input.refundedCents, input.succeededRefundCents);
  if (covered >= input.amountCents) {
    return {
      action: "settled" as const,
      refundedCents: input.amountCents,
      needsRepair: input.refundedCents < input.amountCents,
    };
  }
  return {
    action: "create" as const,
    alreadyRefundedCents: covered,
    needsRepair: input.succeededRefundCents > input.refundedCents,
  };
}

export function refundClaimDecision(input: { openRefundId: string | null }) {
  if (input.openRefundId) {
    return { action: "replay" as const, refundId: input.openRefundId, idempotencyKey: refundIdempotencyKey(input.openRefundId) };
  }
  return { action: "create" as const };
}

export function concurrentRefundResults(input: {
  amountCents: number;
  providerShareCents: number;
  refundedCents: number;
  requests: number[];
  shares: (refundCents: number, alreadyRefundedCents: number) => void;
}) {
  const judged = input.requests.map((refundCents) => {
    try {
      input.shares(refundCents, input.refundedCents);
      return { refundCents, accepted: true as const };
    } catch {
      return { refundCents, accepted: false as const, reason: "balance" as const };
    }
  });
  let open = false;
  return judged.map((result) => {
    if (!result.accepted) return result;
    if (open) return { refundCents: result.refundCents, accepted: false as const, reason: "pending" as const };
    open = true;
    return result;
  });
}

export const ADMIN_EXCEPTION_ENTRY_TYPES = [
  "payment_failed",
  "payment_mismatch",
  "transfer_failed",
  "transfer_uncertain",
  "transfer_blocked",
  "transfer_reversal_failed",
  "transfer_reversal_uncertain",
  "refund_failed",
  "refund_uncertain",
  "dispute_opened",
  "dispute_closed",
  "live_event_rejected",
] as const;

export function exceptionShownToAdmin(entryType: string) {
  return (ADMIN_EXCEPTION_ENTRY_TYPES as readonly string[]).includes(entryType);
}

export type TransferAttemptPayment = {
  id: string;
  transferId: string | null;
  transferStatus: string;
  transferAttempt: number;
  chargeId: string | null;
};

export type TransferAttemptResult =
  | "transferred"
  | "failed"
  | "uncertain"
  | "already_transferred"
  | "in_progress"
  | "provider_not_eligible"
  | "stop";

function failureOf(error: unknown) {
  if (!error || typeof error !== "object") {
    return { message: error instanceof Error ? error.message : "Transfer failed." };
  }
  const typed = error as { type?: string; statusCode?: number; message?: string };
  return {
    type: typed.type,
    statusCode: typed.statusCode,
    message: typed.message ?? (error instanceof Error ? error.message : "Transfer failed."),
  };
}

export async function attemptProviderTransfer(input: {
  payment: TransferAttemptPayment;
  bookingId: string;
  amount: number;
  destination: () => Promise<{ accountId: string | null; eligible: boolean }>;
  claim: (attempt: number) => Promise<{ ok: true; attempt: number } | { ok: false }>;
  mark: (patch: { transferId?: string; transferStatus: string; transferAmountCents?: number }) => Promise<boolean>;
  ledger: (entry: { entryType: string; amountCents: number; note: string; stripeObjectId?: string | null }) => Promise<void>;
  createTransfer: (request: {
    amount: number;
    destination: string;
    transferGroup: string;
    sourceTransaction?: string;
    idempotencyKey: string;
  }) => Promise<{ id: string }>;
}): Promise<TransferAttemptResult> {
  const decision = transferClaimDecision({
    paymentId: input.payment.id,
    transferId: input.payment.transferId,
    transferStatus: input.payment.transferStatus,
    attempt: input.payment.transferAttempt,
  });
  if (decision.action === "skip") return "already_transferred";
  if (decision.action === "stop") return "stop";

  let attempt = decision.attempt;
  if (decision.action === "claim") {
    const claimed = await input.claim(decision.attempt);
    if (!claimed.ok) return "in_progress";
    attempt = claimed.attempt;
    input.payment.transferStatus = "pending";
    input.payment.transferAttempt = attempt;
  }

  const connected = await input.destination();
  if (!connected.accountId || !connected.eligible) {
    if (decision.action === "claim") {
      await input.mark({ transferStatus: "failed" });
      input.payment.transferStatus = "failed";
    }
    await input.ledger({
      entryType: "transfer_blocked",
      amountCents: input.amount,
      note: "The provider is not eligible for a payout yet. The service completion was not changed.",
    });
    return "provider_not_eligible";
  }

  const idempotencyKey = claimedTransferKey(input.payment.id, attempt);
  try {
    const transfer = await input.createTransfer({
      amount: input.amount,
      destination: connected.accountId,
      transferGroup: input.bookingId,
      sourceTransaction: input.payment.chargeId ?? undefined,
      idempotencyKey,
    });
    const saved = await input.mark({
      transferId: transfer.id,
      transferStatus: "paid",
      transferAmountCents: input.amount,
    });
    if (saved) {
      input.payment.transferId = transfer.id;
      input.payment.transferStatus = "paid";
      await input.ledger({
        entryType: "transfer_created",
        amountCents: input.amount,
        note: "Provider share transferred after verified completion.",
        stripeObjectId: transfer.id,
      });
    }
    return "transferred";
  } catch (error) {
    const details = failureOf(error);
    const message = details.message ?? "Transfer failed.";
    if (classifyStripeFailure(details) === "uncertain") {
      await input.mark({ transferStatus: "pending" });
      input.payment.transferStatus = "pending";
      await input.ledger({
        entryType: "transfer_uncertain",
        amountCents: input.amount,
        note: `Stripe did not confirm the transfer. Retry uses the same attempt. ${message}`.slice(0, 500),
      });
      return "uncertain";
    }
    await input.mark({ transferStatus: "failed" });
    input.payment.transferStatus = "failed";
    await input.ledger({
      entryType: "transfer_failed",
      amountCents: input.amount,
      note: message.slice(0, 500),
    });
    return "failed";
  }
}

export function payoutIsPaid(status: string | null | undefined) {
  return payoutLabel(status) === "payout paid";
}

export function settleRefundAmounts(input: {
  priorStatus: string;
  stripeStatus: string;
  refundedCents: number;
  refundCents: number;
  amountCents: number;
}) {
  const countRefund = input.priorStatus === "pending" && input.stripeStatus === "succeeded";
  const refundedCents = countRefund ? input.refundedCents + input.refundCents : input.refundedCents;
  return {
    countRefund,
    refundedCents,
    paymentStatus: refundedCents >= input.amountCents ? "refunded" : refundedCents > 0 ? "partially_refunded" : "succeeded",
  };
}
