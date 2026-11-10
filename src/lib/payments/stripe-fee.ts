export function nextStripeFeeCents(current: number | null, incoming: number | null) {
  if (incoming == null || !Number.isInteger(incoming) || incoming < 0) return current;
  return incoming;
}

export function feeFromStripeCharge(charge: { livemode?: boolean | null; balance_transaction?: unknown }) {
  if (charge.livemode) return null;
  const balance = charge.balance_transaction;
  if (!balance || typeof balance !== "object") return null;
  const fee = (balance as { fee?: unknown }).fee;
  if (typeof fee !== "number" || !Number.isInteger(fee) || fee < 0) return null;
  return fee;
}

export async function readChargeProcessingFee(
  retrieve: (chargeId: string) => Promise<{ livemode?: boolean | null; balance_transaction?: unknown }>,
  chargeId: string,
) {
  try {
    return feeFromStripeCharge(await retrieve(chargeId));
  } catch {
    return null;
  }
}
