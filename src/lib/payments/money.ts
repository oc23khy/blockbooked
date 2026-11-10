export const DEFAULT_COMMISSION_BPS = 800;
export const PLATFORM_FEE_BEARER = "platform" as const;

export type FeeBearer = typeof PLATFORM_FEE_BEARER;

export function parseFixedPriceCents(value: string | number | null | undefined): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const cents = Math.round(value * 100);
    return cents > 0 && cents <= 100_000_000 ? cents : null;
  }
  if (!value) return null;
  const match = value.trim().match(/^\$?\s*(\d{1,6})(?:\.(\d{2}))?\s*$/);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + (match[2] ? Number(match[2]) : 0);
  if (!Number.isInteger(cents) || cents <= 0 || cents > 100_000_000) return null;
  return cents;
}

export function validateMilestones(
  totalCents: number,
  parts: { label: string; amountCents: number }[],
) {
  if (!Number.isInteger(totalCents) || totalCents <= 0) {
    throw new Error("The agreed price must be set before adding milestones.");
  }
  if (parts.length < 2 || parts.length > 6) {
    throw new Error("Use 2 to 6 milestones.");
  }
  const normalized = parts.map((part, index) => ({
    label: part.label.trim().slice(0, 80),
    amountCents: part.amountCents,
    position: index + 1,
  }));
  if (normalized.some((part) => !part.label || !Number.isInteger(part.amountCents) || part.amountCents <= 0)) {
    throw new Error("Each milestone needs a name and a positive dollar amount.");
  }
  const sum = normalized.reduce((total, part) => total + part.amountCents, 0);
  if (sum !== totalCents) {
    throw new Error("Milestones must add up to the agreed price.");
  }
  return normalized;
}

export function quoteFromCatalog(catalogPrice: string | number, clientAmount?: unknown) {
  void clientAmount;
  const amountCents = parseFixedPriceCents(catalogPrice);
  if (amountCents == null) {
    throw new Error("This service does not have a fixed dollar price.");
  }
  return amountCents;
}

export function quoteServicePayment(amountCents: number, commissionBps: number) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error("Payment amount must be a positive number of cents.");
  }
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10_000) {
    throw new Error("Commission must be between 0% and 100%.");
  }
  const commissionCents = Math.round((amountCents * commissionBps) / 10_000);
  return {
    amountCents,
    commissionBps,
    commissionCents,
    providerShareCents: amountCents - commissionCents,
    feeBearer: PLATFORM_FEE_BEARER,
  };
}

export function percentToBps(percent: number) {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error("Enter a commission from 0 to 100 percent.");
  }
  return Math.round(percent * 100);
}

export function refundShares(input: {
  refundCents: number;
  amountCents: number;
  providerShareCents: number;
  alreadyRefundedCents?: number;
  alreadyProviderReversedCents?: number;
}) {
  const alreadyRefunded = input.alreadyRefundedCents ?? 0;
  const alreadyProvider = input.alreadyProviderReversedCents ?? 0;
  const remaining = input.amountCents - alreadyRefunded;
  const providerRemaining = input.providerShareCents - alreadyProvider;
  if (!Number.isInteger(input.refundCents) || input.refundCents <= 0 || input.refundCents > remaining) {
    throw new Error("Refund amount is outside the remaining balance.");
  }
  if (remaining < 0 || providerRemaining < 0) {
    throw new Error("Refund history is inconsistent.");
  }

  const providerReversalCents =
    input.refundCents === remaining
      ? providerRemaining
      : Math.min(
          providerRemaining,
          Math.round((input.refundCents * input.providerShareCents) / input.amountCents),
        );
  return {
    providerReversalCents,
    commissionReversalCents: input.refundCents - providerReversalCents,
  };
}

export function nextRecordedTransferAmount(current: number | null, incoming: number | null) {
  if (current != null) return current;
  if (incoming == null || !Number.isInteger(incoming) || incoming < 0) return null;
  return incoming;
}

export function nextRecordedTransferReversal(current: number | null, incoming: number | null) {
  if (incoming == null || !Number.isInteger(incoming) || incoming < 0) return current;
  if (current == null) return incoming;
  return Math.max(current, incoming);
}

export function remainingProviderTransferCents(input: {
  providerShareCents: number;
  amountCents: number;
  refundedCents: number;
}) {
  if (input.refundedCents <= 0) return input.providerShareCents;
  if (input.refundedCents >= input.amountCents) return 0;
  const reversed = refundShares({
    refundCents: input.refundedCents,
    amountCents: input.amountCents,
    providerShareCents: input.providerShareCents,
  }).providerReversalCents;
  return input.providerShareCents - reversed;
}

export function bookingStatusAfterPayment(status: string) {
  return status;
}

export function paymentStatusAfterFailure(status: string) {
  if (status === "succeeded" || status === "refunded" || status === "partially_refunded" || status === "disputed") {
    return status;
  }
  return "failed";
}

export function assertCanManagePayments(role: string) {
  void role;
  return { ok: false as const, reason: "unauthorized" };
}

export function resolveSiteUrl(value: string | undefined, nodeEnv: string | undefined) {
  const configured = (value ?? "").trim().replace(/\/$/, "");
  const local = !configured || /^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/i.test(configured);
  if (nodeEnv === "production" && (local || !configured.startsWith("https://"))) {
    throw new Error("NEXT_PUBLIC_SITE_URL must be the deployed https URL.");
  }
  return configured || "http://localhost:3000";
}

export function assertTestStripeKey(secretKey: string) {
  if (!secretKey.startsWith("sk_test_")) {
    throw new Error("Stripe test mode is required. Live payments are not enabled.");
  }
}

export function shouldReverseTransfer(input: {
  refundStatus: string;
  transferId: string | null;
  providerReversalCents: number;
  reversalStatus: string | null;
}) {
  return (
    input.refundStatus === "succeeded" &&
    Boolean(input.transferId) &&
    input.providerReversalCents > 0 &&
    input.reversalStatus !== "succeeded"
  );
}

export function formatUsd(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
