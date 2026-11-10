import { refundExpiredBooking } from "@/lib/bookings/expire";
import { isAccountRequirementsEvent } from "@/lib/payments/connect";
import { applyStripeEvent } from "@/lib/payments/events";
import { refreshConnectedAccountByStripeId, settleRefundFromStripe } from "@/lib/payments/service";
import { createPaymentStore } from "@/lib/payments/store";
import { feeFromStripeCharge, readChargeProcessingFee } from "@/lib/payments/stripe-fee";
import { getStripe } from "@/lib/payments/stripe-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !secret) {
    return Response.json({ error: "Missing webhook signature." }, { status: 400 });
  }

  let stripe: ReturnType<typeof getStripe>;
  try {
    stripe = getStripe();
  } catch {
    return Response.json({ error: "Stripe test mode is not configured." }, { status: 500 });
  }

  let event: ReturnType<typeof stripe.webhooks.constructEvent>;
  try {
    event = stripe.webhooks.constructEvent(body, signature, secret);
  } catch {
    return handleThinAccountEvent(stripe, body, signature, secret);
  }

  const object = event.data.object as unknown as Record<string, unknown>;
  if (
    (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") &&
    typeof object.payment_intent === "string"
  ) {
    try {
      const intent = await stripe.paymentIntents.retrieve(object.payment_intent, {
        expand: ["latest_charge.balance_transaction"],
      });
      const charge = intent.latest_charge;
      if (typeof charge === "string") {
        object.charge_id = charge;
        const fee = await readChargeProcessingFee(
          (chargeId) => stripe.charges.retrieve(chargeId, { expand: ["balance_transaction"] }),
          charge,
        );
        if (fee != null) object.stripe_fee_cents = fee;
      } else if (charge) {
        object.charge_id = charge.id;
        const fee = feeFromStripeCharge(charge);
        if (fee != null) object.stripe_fee_cents = fee;
      }
    } catch {
      // The payment can still be recorded. A provider transfer waits until the charge id is known.
    }
  }
  if (event.type === "charge.updated" && typeof object.id === "string") {
    const fee = await readChargeProcessingFee(
      (chargeId) => stripe.charges.retrieve(chargeId, { expand: ["balance_transaction"] }),
      object.id,
    );
    if (fee != null) object.stripe_fee_cents = fee;
  }

  const result = await applyStripeEvent(
    { id: event.id, type: event.type, livemode: event.livemode, object },
    createPaymentStore(),
  );
  if (result.status === "failed") return Response.json({ received: false }, { status: 500 });

  const metadata = object.metadata;
  const bookingId =
    metadata && typeof metadata === "object" && "booking_id" in metadata && typeof metadata.booking_id === "string"
      ? metadata.booking_id
      : null;
  if (bookingId && (event.type === "checkout.session.completed" || event.type === "payment_intent.succeeded")) {
    try {
      await refundExpiredBooking(bookingId);
    } catch {
      // The payment is already recorded. The expiration worker retries the refund.
    }
  }

  if (
    (event.type === "refund.updated" || event.type === "charge.refund.updated") &&
    object.object === "refund" &&
    object.status === "succeeded" &&
    typeof object.id === "string"
  ) {
    await settleRefundFromStripe(object.id);
  }

  return Response.json({ received: true });
}

async function handleThinAccountEvent(
  stripe: ReturnType<typeof getStripe>,
  body: string,
  signature: string,
  secret: string,
) {
  try {
    // V2 account events arrive as thin notifications. The signature is verified
    // here, then the full event is loaded before any account status changes.
    const thinEvent = stripe.parseEventNotification(body, signature, secret);
    const event = await stripe.v2.core.events.retrieve(thinEvent.id);
    if (event.livemode || !isAccountRequirementsEvent(event.type)) {
      return Response.json({ received: true });
    }
    const related = "related_object" in event ? event.related_object : null;
    const accountId = related && "id" in related && typeof related.id === "string" ? related.id : undefined;
    if (accountId) await refreshConnectedAccountByStripeId(accountId);
    return Response.json({ received: true });
  } catch {
    return Response.json({ error: "Invalid webhook signature." }, { status: 400 });
  }
}
