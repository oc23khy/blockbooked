import { nextRecordedTransferReversal } from "./money.ts";
import { nextStripeFeeCents } from "./stripe-fee.ts";

export type StoredEvent = { status: "processing" | "processed" | "ignored" | "failed" };

export function decideWebhookDelivery(existing: StoredEvent | null): "process" | "retry" | "skip" {
  if (!existing) return "process";
  if (existing.status === "failed") return "retry";
  return "skip";
}

export type NormalizedStripeEvent = {
  id: string;
  type: string;
  livemode: boolean;
  object: Record<string, unknown>;
};

export type PaymentSnapshot = {
  id: string;
  bookingId: string;
  amountCents: number;
  commissionCents: number;
  providerShareCents: number;
  status: string;
  paymentIntentId: string | null;
  chargeId: string | null;
  transferId: string | null;
  refundedCents: number;
  stripeFeeCents: number | null;
  transferReversedCents: number | null;
};

export type LedgerDraft = {
  paymentId: string | null;
  bookingId: string | null;
  entryType: string;
  amountCents: number;
  stripeObjectId: string | null;
  note: string;
};

export type PaymentPatch = Partial<PaymentSnapshot> & {
  id: string;
  transferStatus?: string;
  transferReversedCents?: number | null;
};

export interface PaymentStore {
  claimEvent(event: NormalizedStripeEvent): Promise<"process" | "retry" | "skip">;
  finishEvent(id: string, status: StoredEvent["status"], error?: string): Promise<void>;
  findPayment(query: { paymentId?: string; checkoutSessionId?: string; paymentIntentId?: string; chargeId?: string }): Promise<PaymentSnapshot | null>;
  savePayment(patch: PaymentPatch): Promise<void>;
  addLedger(entry: LedgerDraft): Promise<void>;
  saveConnectedAccount(input: {
    stripeAccountId: string;
    detailsSubmitted: boolean;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    transfersEnabled: boolean;
    disabledReason: string | null;
  }): Promise<void>;
  markRefund(stripeRefundId: string, status: string): Promise<void>;
}

function text(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integer(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function metadata(object: Record<string, unknown>) {
  const raw = object.metadata;
  if (!raw || typeof raw !== "object") return {} as Record<string, string>;
  return raw as Record<string, string>;
}

export async function applyStripeEvent(event: NormalizedStripeEvent, store: PaymentStore) {
  const delivery = await store.claimEvent(event);
  if (delivery === "skip") return { status: "duplicate" as const };

  try {
    if (event.livemode) {
      await store.addLedger({
        paymentId: null,
        bookingId: null,
        entryType: "live_event_rejected",
        amountCents: 0,
        stripeObjectId: event.id,
        note: "A live-mode Stripe event was ignored. BlockBooked is in test mode.",
      });
      await store.finishEvent(event.id, "ignored");
      return { status: "ignored" as const };
    }

    await dispatchEvent(event, store);
    await store.finishEvent(event.id, "processed");
    return { status: "processed" as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed.";
    await store.finishEvent(event.id, "failed", message.slice(0, 500));
    return { status: "failed" as const };
  }
}

async function dispatchEvent(event: NormalizedStripeEvent, store: PaymentStore) {
  const object = event.object;
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    await applyCheckoutCompleted(object, store);
    return;
  }
  if (event.type === "checkout.session.expired") {
    const payment = await findFromMetadata(object, store, text(object.id));
    if (payment && payment.status === "requires_payment") {
      await store.savePayment({ id: payment.id, status: "canceled" });
      await store.addLedger({
        paymentId: payment.id,
        bookingId: payment.bookingId,
        entryType: "checkout_expired",
        amountCents: 0,
        stripeObjectId: text(object.id),
        note: "Checkout expired before payment.",
      });
    }
    return;
  }
  if (event.type === "payment_intent.payment_failed") {
    const payment = await findFromMetadata(object, store, null);
    if (!payment) return;
    const next = paymentStatusAfterKnownFailure(payment.status);
    await store.savePayment({ id: payment.id, status: next, paymentIntentId: text(object.id) ?? payment.paymentIntentId });
    await store.addLedger({
      paymentId: payment.id,
      bookingId: payment.bookingId,
      entryType: "payment_failed",
      amountCents: payment.amountCents,
      stripeObjectId: text(object.id),
      note: "Stripe reported that the payment failed.",
    });
    return;
  }
  if (event.type === "charge.updated") {
    await applyProcessingFee(object, store);
    return;
  }
  if (event.type === "charge.refunded" || event.type === "refund.updated" || event.type === "charge.refund.updated") {
    await applyRefundUpdate(object, store);
    return;
  }
  if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed") {
    await applyDispute(event.type, object, store);
    return;
  }
  if (event.type === "account.updated") {
    const capabilities = object.capabilities;
    const transfers =
      capabilities && typeof capabilities === "object"
        ? (capabilities as Record<string, unknown>).transfers === "active"
        : false;
    await store.saveConnectedAccount({
      stripeAccountId: text(object.id) ?? "",
      detailsSubmitted: object.details_submitted === true,
      chargesEnabled: object.charges_enabled === true,
      payoutsEnabled: object.payouts_enabled === true,
      transfersEnabled: transfers,
      disabledReason: text((object.requirements as { disabled_reason?: unknown } | undefined)?.disabled_reason),
    });
    return;
  }
  if (event.type === "transfer.reversed") {
    const payment = await store.findPayment({ chargeId: text(object.source_transaction) ?? undefined });
    if (!payment) return;
    const confirmedReversal = integer(object.amount_reversed);
    const reversed = confirmedReversal ?? payment.refundedCents;
    const recordedReversal = nextRecordedTransferReversal(payment.transferReversedCents, confirmedReversal);
    await store.savePayment({
      id: payment.id,
      transferStatus: reversed >= payment.providerShareCents ? "reversed" : "partially_reversed",
      ...(recordedReversal == null || recordedReversal === payment.transferReversedCents
        ? {}
        : { transferReversedCents: recordedReversal }),
    });
    await store.addLedger({
      paymentId: payment.id,
      bookingId: payment.bookingId,
      entryType: "transfer_reversed",
      amountCents: reversed,
      stripeObjectId: text(object.id),
      note: "Stripe confirmed a transfer reversal.",
    });
  }
}

async function applyCheckoutCompleted(object: Record<string, unknown>, store: PaymentStore) {
  const payment = await findFromMetadata(object, store, text(object.id));
  if (!payment) return;
  const amount = integer(object.amount_total);
  const paid = object.payment_status === "paid";
  if (!paid || amount !== payment.amountCents || object.currency !== "usd") {
    await store.addLedger({
      paymentId: payment.id,
      bookingId: payment.bookingId,
      entryType: "payment_mismatch",
      amountCents: amount ?? 0,
      stripeObjectId: text(object.id),
      note: "Checkout did not match the server-calculated amount. The booking was not marked paid.",
    });
    return;
  }
  const fee = nonNegativeInteger(object.stripe_fee_cents);
  if (payment.status === "succeeded") {
    await recordProcessingFee(payment, fee, store);
    return;
  }
  await store.savePayment({
    id: payment.id,
    status: "succeeded",
    paymentIntentId: text(object.payment_intent) ?? payment.paymentIntentId,
    chargeId: text(object.charge_id) ?? payment.chargeId,
    ...(fee == null ? {} : { stripeFeeCents: fee }),
  });
  await store.addLedger({
    paymentId: payment.id,
    bookingId: payment.bookingId,
    entryType: "payment_succeeded",
    amountCents: payment.amountCents,
    stripeObjectId: text(object.payment_intent),
    note: "Stripe confirmed the customer payment. The service is not completed by this event.",
  });
  await store.addLedger({
    paymentId: payment.id,
    bookingId: payment.bookingId,
    entryType: "commission_earned",
    amountCents: payment.commissionCents,
    stripeObjectId: text(object.payment_intent),
    note: "BlockBooked commission is retained until a provider transfer is created after verified completion.",
  });
}

async function applyProcessingFee(object: Record<string, unknown>, store: PaymentStore) {
  const chargeId = text(object.id);
  const payment =
    (chargeId ? await store.findPayment({ chargeId }) : null) ?? (await findFromMetadata(object, store, null));
  if (!payment) return;
  await recordProcessingFee(payment, nonNegativeInteger(object.stripe_fee_cents), store);
}

async function recordProcessingFee(payment: PaymentSnapshot, fee: number | null, store: PaymentStore) {
  const next = nextStripeFeeCents(payment.stripeFeeCents, fee);
  if (next == null || next === payment.stripeFeeCents) return;
  await store.savePayment({ id: payment.id, stripeFeeCents: next });
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

async function applyRefundUpdate(object: Record<string, unknown>, store: PaymentStore) {
  const chargeId = text(object.charge) ?? (object.object === "charge" ? text(object.id) : null);
  const payment =
    (chargeId ? await store.findPayment({ chargeId }) : null) ??
    (await findFromMetadata(object, store, null));
  if (!payment) return;
  const refunded = integer(object.amount_refunded) ?? integer(object.amount);
  if (refunded != null && object.object === "charge") {
    const status = refunded >= payment.amountCents ? "refunded" : refunded > 0 ? "partially_refunded" : payment.status;
    await store.savePayment({ id: payment.id, status, refundedCents: refunded, chargeId: chargeId ?? payment.chargeId });
  }
  const refundId = object.object === "refund" ? text(object.id) : null;
  if (refundId && typeof object.status === "string") {
    await store.markRefund(refundId, object.status);
    await store.addLedger({
      paymentId: payment.id,
      bookingId: payment.bookingId,
      entryType: object.status === "succeeded" ? "refund_confirmed" : "refund_updated",
      amountCents: integer(object.amount) ?? 0,
      stripeObjectId: refundId,
      note: `Stripe refund status: ${object.status}.`,
    });
  }
}

async function applyDispute(type: string, object: Record<string, unknown>, store: PaymentStore) {
  const chargeId = text(object.charge);
  const payment = chargeId ? await store.findPayment({ chargeId }) : null;
  if (!payment) return;
  if (type === "charge.dispute.created") {
    await store.savePayment({ id: payment.id, status: "disputed" });
  }
  await store.addLedger({
    paymentId: payment.id,
    bookingId: payment.bookingId,
    entryType: type === "charge.dispute.created" ? "dispute_opened" : "dispute_closed",
    amountCents: integer(object.amount) ?? 0,
    stripeObjectId: text(object.id),
    note: `Stripe dispute status: ${text(object.status) ?? "unknown"}.`,
  });
}

async function findFromMetadata(object: Record<string, unknown>, store: PaymentStore, checkoutSessionId: string | null) {
  const meta = metadata(object);
  if (meta.payment_id) {
    const byId = await store.findPayment({ paymentId: meta.payment_id });
    if (byId) return byId;
  }
  if (checkoutSessionId) {
    const bySession = await store.findPayment({ checkoutSessionId });
    if (bySession) return bySession;
  }
  const intent = text(object.payment_intent) ?? (object.object === "payment_intent" ? text(object.id) : null);
  if (intent) return store.findPayment({ paymentIntentId: intent });
  return null;
}

function paymentStatusAfterKnownFailure(status: string) {
  if (status === "succeeded" || status === "refunded" || status === "partially_refunded" || status === "disputed") return status;
  return "failed";
}
