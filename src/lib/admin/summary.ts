export const collectedPaymentStatuses = ["succeeded", "partially_refunded", "refunded", "disputed"] as const;

export type AdminPaymentSnapshot = {
  status: string;
  amountCents: number;
  commissionCents: number;
  providerShareCents: number;
  refundedCents: number;
  stripeFeeCents: number | null;
  transferStatus: string;
  transferId?: string | null;
  transferAmountCents?: number | null;
  transferReversedCents?: number | null;
  id?: string;
};

export type AdminRefundSnapshot = {
  status: string;
  amountCents: number;
  commissionReversalCents: number;
  providerReversalCents: number;
  reversalStatus?: string | null;
  paymentId?: string | null;
};

export type AdminMoneySummary = {
  collectedCount: number;
  grossCustomerPaymentsCents: number;
  refundsCents: number;
  stripeFeesCents: number;
  stripeFeesKnownCents: number;
  stripeFeesRecordedCount: number;
  stripeFeesMissingCount: number;
  stripeFeesComplete: boolean;
  createdTransferCount: number;
  recordedTransferCount: number;
  providerTransfersCents: number;
  providerTransfersComplete: boolean;
  transferReversalsCents: number;
  netProviderTransfersCents: number | null;
  grossCommissionCents: number;
  commissionReductionCents: number;
  netCommissionCents: number;
  recordedCommissionCents: number;
  contributionMarginCents: number | null;
};

export function providerTransferWasCreated(payment: { transferId?: string | null; transferStatus: string }) {
  if (payment.transferId) return true;
  return payment.transferStatus === "paid" || payment.transferStatus === "partially_reversed";
}

export function summarizeAdminMoney(payments: AdminPaymentSnapshot[], refunds: AdminRefundSnapshot[]): AdminMoneySummary {
  const collected = payments.filter((payment) =>
    collectedPaymentStatuses.includes(payment.status as (typeof collectedPaymentStatuses)[number]),
  );
  const succeededRefunds = refunds.filter((refund) => refund.status === "succeeded");
  const stripeFeesKnownCents = collected.reduce(
    (sum, payment) => sum + (payment.stripeFeeCents == null ? 0 : payment.stripeFeeCents),
    0,
  );
  const stripeFeesRecordedCount = collected.filter((payment) => payment.stripeFeeCents != null).length;
  const stripeFeesComplete = stripeFeesRecordedCount === collected.length;
  const grossCommissionCents = collected.reduce((sum, payment) => sum + payment.commissionCents, 0);
  const commissionReductionCents = succeededRefunds.reduce((sum, refund) => sum + refund.commissionReversalCents, 0);
  const netCommissionCents = grossCommissionCents - commissionReductionCents;
  const createdTransfers = collected.filter((payment) => providerTransferWasCreated(payment));
  const recordedTransfers = createdTransfers.filter((payment) => payment.transferAmountCents != null);
  const providerTransfersComplete = recordedTransfers.length === createdTransfers.length;
  const providerTransfersCents = recordedTransfers.reduce((sum, payment) => sum + (payment.transferAmountCents ?? 0), 0);
  const reversalFromColumn = new Set(
    createdTransfers.filter((payment) => payment.id && payment.transferReversedCents != null).map((payment) => payment.id),
  );
  const transferReversalsCents =
    createdTransfers.reduce((sum, payment) => sum + (payment.transferReversedCents ?? 0), 0) +
    succeededRefunds.reduce((sum, refund) => {
      if (refund.reversalStatus !== "succeeded") return sum;
      if (refund.paymentId && reversalFromColumn.has(refund.paymentId)) return sum;
      return sum + refund.providerReversalCents;
    }, 0);
  return {
    collectedCount: collected.length,
    grossCustomerPaymentsCents: collected.reduce((sum, payment) => sum + payment.amountCents, 0),
    refundsCents: collected.reduce((sum, payment) => sum + payment.refundedCents, 0),
    stripeFeesCents: stripeFeesKnownCents,
    stripeFeesKnownCents,
    stripeFeesRecordedCount,
    stripeFeesMissingCount: collected.length - stripeFeesRecordedCount,
    stripeFeesComplete,
    createdTransferCount: createdTransfers.length,
    recordedTransferCount: recordedTransfers.length,
    providerTransfersCents,
    providerTransfersComplete,
    transferReversalsCents,
    netProviderTransfersCents: providerTransfersComplete ? providerTransfersCents - transferReversalsCents : null,
    grossCommissionCents,
    commissionReductionCents,
    netCommissionCents,
    recordedCommissionCents: netCommissionCents,
    contributionMarginCents: stripeFeesComplete ? netCommissionCents - stripeFeesKnownCents : null,
  };
}

export function providerTransferLabel(summary: AdminMoneySummary, format: (cents: number) => string) {
  if (summary.createdTransferCount === 0 || summary.providerTransfersComplete) return format(summary.providerTransfersCents);
  return `${format(summary.providerTransfersCents)} recorded on ${summary.recordedTransferCount} of ${summary.createdTransferCount} transfers`;
}

export function stripeFeeLabel(summary: AdminMoneySummary, format: (cents: number) => string) {
  if (summary.collectedCount === 0 || summary.stripeFeesComplete) return format(summary.stripeFeesKnownCents);
  return `${format(summary.stripeFeesKnownCents)} recorded on ${summary.stripeFeesRecordedCount} of ${summary.collectedCount} payments`;
}

export function countByStatus(statuses: string[]) {
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  return {
    total: statuses.length,
    pending: counts.get("pending") ?? 0,
    accepted: counts.get("accepted") ?? 0,
    completed: counts.get("completed") ?? 0,
    declined: counts.get("declined") ?? 0,
    cancelled: counts.get("cancelled") ?? 0,
    expired: counts.get("expired") ?? 0,
  };
}
