const collectedPaymentStatuses = new Set(["succeeded", "partially_refunded", "refunded", "disputed"]);

export type FeeBackfillPayment = {
  id: string;
  status: string;
  chargeId: string | null;
  stripeFeeCents: number | null;
};

export type ChargeFeeRead = {
  livemode: boolean;
  feeCents: number | null;
};

export function reconciliationAllowed(role: string | null | undefined, stripeKey: string) {
  if (role !== "admin") return { ok: false as const, reason: "unauthorized" as const };
  if (!stripeKey.startsWith("sk_test_")) return { ok: false as const, reason: "test_mode_required" as const };
  return { ok: true as const };
}

export function selectFeeBackfillCandidates(payments: FeeBackfillPayment[]) {
  return payments.filter(
    (payment) =>
      payment.stripeFeeCents == null &&
      Boolean(payment.chargeId) &&
      collectedPaymentStatuses.has(payment.status),
  );
}

export async function backfillSandboxProcessingFees(input: {
  role: string | null | undefined;
  stripeKey: string;
  payments: FeeBackfillPayment[];
  readCharge: (chargeId: string) => Promise<ChargeFeeRead>;
  saveFee: (paymentId: string, feeCents: number) => Promise<boolean>;
}) {
  const allowed = reconciliationAllowed(input.role, input.stripeKey);
  if (!allowed.ok) return { ok: false as const, reason: allowed.reason, updated: 0, skipped: 0 };

  let updated = 0;
  let skipped = 0;
  for (const payment of selectFeeBackfillCandidates(input.payments)) {
    const charge = await input.readCharge(payment.chargeId!);
    if (charge.livemode || charge.feeCents == null || !Number.isInteger(charge.feeCents) || charge.feeCents < 0) {
      skipped += 1;
      continue;
    }
    const wrote = await input.saveFee(payment.id, charge.feeCents);
    if (wrote) updated += 1;
    else skipped += 1;
  }
  return { ok: true as const, updated, skipped };
}
