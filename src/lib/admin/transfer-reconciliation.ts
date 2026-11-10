import { nextRecordedTransferAmount, nextRecordedTransferReversal } from "../payments/money.ts";

export type TransferAmountCandidate = {
  id: string;
  transferId: string | null;
  transferAmountCents: number | null;
};

export type StoredTransferPayment = {
  id: string;
  transferId: string;
  chargeId: string | null;
  transferAmountCents: number | null;
  transferReversedCents: number | null;
};

export type RetrievedTransfer = {
  id: string;
  livemode: boolean;
  amount: number | null;
  amountReversed: number | null;
  currency: string | null;
  metadataPaymentId: string | null;
  sourceTransactionId: string | null;
  destinationId: string | null;
};

export function planTransferAmountReads(payments: TransferAmountCandidate[]) {
  return payments
    .filter((payment) => payment.transferId && payment.transferAmountCents == null)
    .map((payment) => ({ paymentId: payment.id, transferId: payment.transferId as string }));
}

export function recordedTransferAmountFromStripe(current: number | null, stripeAmount: number | null) {
  return nextRecordedTransferAmount(current, stripeAmount);
}

export function transferReconciliationAllowed(role: string | null | undefined, stripeKey: string) {
  if (role !== "admin") return { ok: false as const, reason: "unauthorized" as const };
  if (!stripeKey.startsWith("sk_test_")) return { ok: false as const, reason: "test_mode_required" as const };
  return { ok: true as const };
}

function integerCents(value: number | null) {
  return value != null && Number.isInteger(value) && value >= 0 ? value : null;
}

export function assessStoredTransfer(input: {
  payment: StoredTransferPayment;
  platformAccountId: string;
  transfer: RetrievedTransfer | null;
}) {
  const transfer = input.transfer;
  if (!input.platformAccountId.startsWith("acct_")) return { ok: false as const, reason: "platform_account" as const };
  if (!transfer) return { ok: false as const, reason: "missing" as const };
  if (transfer.id !== input.payment.transferId) return { ok: false as const, reason: "mismatched_id" as const };
  if (transfer.livemode || transfer.currency !== "usd") return { ok: false as const, reason: "unexpected_transfer" as const };
  if (!transfer.destinationId || transfer.destinationId === input.platformAccountId) {
    return { ok: false as const, reason: "platform_account" as const };
  }
  if (transfer.metadataPaymentId && transfer.metadataPaymentId !== input.payment.id) {
    return { ok: false as const, reason: "mismatched_payment" as const };
  }
  if (
    transfer.sourceTransactionId &&
    input.payment.chargeId &&
    transfer.sourceTransactionId !== input.payment.chargeId
  ) {
    return { ok: false as const, reason: "mismatched_payment" as const };
  }
  const paymentMatched =
    transfer.metadataPaymentId === input.payment.id ||
    (Boolean(input.payment.chargeId) && transfer.sourceTransactionId === input.payment.chargeId);
  if (!paymentMatched) return { ok: false as const, reason: "mismatched_payment" as const };

  const amount = integerCents(transfer.amount);
  const reversed = integerCents(transfer.amountReversed);
  if (
    input.payment.transferAmountCents != null &&
    amount != null &&
    input.payment.transferAmountCents !== amount
  ) {
    return { ok: false as const, reason: "amount_conflict" as const };
  }
  if (input.payment.transferAmountCents == null && amount == null) {
    return { ok: false as const, reason: "amount_missing" as const };
  }
  const nextAmount = nextRecordedTransferAmount(input.payment.transferAmountCents, amount);
  const nextReversal = nextRecordedTransferReversal(input.payment.transferReversedCents, reversed);
  return {
    ok: true as const,
    amountToStore: nextAmount === input.payment.transferAmountCents ? null : nextAmount,
    reversalToStore: nextReversal === input.payment.transferReversedCents ? null : nextReversal,
  };
}

export async function reconcileSandboxTransfers(input: {
  role: string | null | undefined;
  stripeKey: string;
  platformAccountId: string;
  payments: StoredTransferPayment[];
  readTransfer: (transferId: string) => Promise<RetrievedTransfer | null>;
  saveTransfer: (
    paymentId: string,
    update: { amountCents: number | null; reversalCents: number | null },
  ) => Promise<{ amountWritten: boolean; reversalWritten: boolean }>;
}) {
  const allowed = transferReconciliationAllowed(input.role, input.stripeKey);
  if (!allowed.ok) {
    return { ok: false as const, reason: allowed.reason, reconciled: 0, skipped: 0, failed: 0 };
  }
  if (!input.platformAccountId.startsWith("acct_")) {
    return { ok: false as const, reason: "platform_account" as const, reconciled: 0, skipped: 0, failed: 0 };
  }

  let reconciled = 0;
  let skipped = 0;
  let failed = 0;
  for (const payment of input.payments) {
    const transfer = await input.readTransfer(payment.transferId);
    const decision = assessStoredTransfer({
      payment,
      platformAccountId: input.platformAccountId,
      transfer,
    });
    if (!decision.ok) {
      failed += 1;
      continue;
    }
    if (decision.amountToStore == null && decision.reversalToStore == null) {
      skipped += 1;
      continue;
    }
    const saved = await input.saveTransfer(payment.id, {
      amountCents: decision.amountToStore,
      reversalCents: decision.reversalToStore,
    });
    if (saved.amountWritten || saved.reversalWritten) reconciled += 1;
    else skipped += 1;
  }
  return { ok: true as const, reconciled, skipped, failed };
}
