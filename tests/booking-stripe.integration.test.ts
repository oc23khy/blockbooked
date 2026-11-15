import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { duplicateRefundKey, duplicateRefundPlan } from "../src/lib/payments/lifecycle.ts";
import { assertStripeTestKey } from "./integration-guard.ts";

const key = process.env.BLOCKBOOKED_STRIPE_TEST_KEY;

type StripeClient = {
  paymentIntents: {
    create(input: Record<string, unknown>, options?: { idempotencyKey?: string }): Promise<{ id: string; status: string }>;
    retrieve(id: string): Promise<{ id: string; status: string }>;
  };
  refunds: {
    create(input: { payment_intent: string; amount?: number }, options?: { idempotencyKey?: string }): Promise<{ id: string; status: string | null }>;
    list(input: { payment_intent: string; limit: number }): Promise<{ data: Array<{ id: string }> }>;
  };
};

function stripeFor(secret: string) {
  const require = createRequire(import.meta.url);
  const Stripe = require("stripe") as new (key: string) => StripeClient;
  return new Stripe(secret);
}

if (!key) {
  describe("Stripe test-mode booking integration", () => {
    it("does not call Stripe until a separate test key is configured", () => {
      assert.equal(process.env.BLOCKBOOKED_STRIPE_TEST_KEY, undefined);
    });
  });
} else {
  assertStripeTestKey(key);
  describe("Stripe test-mode booking integration", () => {
    it("creates two test charges, preserves the first, and refunds the duplicate once", async () => {
      const stripe = stripeFor(key);
      const marker = `booking-safety-${Date.now()}`;
      const created: string[] = [];
      try {
        const first = await stripe.paymentIntents.create({
          amount: 50,
          currency: "usd",
          payment_method: "pm_card_visa",
          allowed_payment_method_types: ["card"],
          confirm: true,
          metadata: { blockbooked_integration: marker, role: "original" },
        });
        created.push(first.id);
        const second = await stripe.paymentIntents.create({
          amount: 50,
          currency: "usd",
          payment_method: "pm_card_visa",
          allowed_payment_method_types: ["card"],
          confirm: true,
          metadata: { blockbooked_integration: marker, role: "duplicate" },
        });
        created.push(second.id);
        assert.notEqual(first.id, second.id);
        assert.equal(first.status, "succeeded");
        assert.equal(second.status, "succeeded");
        const refundKey = duplicateRefundKey(second.id, 1);
        const refund = await stripe.refunds.create({ payment_intent: second.id }, { idempotencyKey: refundKey });
        const replay = await stripe.refunds.create({ payment_intent: second.id }, { idempotencyKey: refundKey });
        assert.equal(replay.id, refund.id);
        const listed = await stripe.refunds.list({ payment_intent: second.id, limit: 10 });
        assert.equal(listed.data.length, 1);
        const original = await stripe.paymentIntents.retrieve(first.id);
        assert.equal(original.status, "succeeded");
        const waiting = duplicateRefundPlan({
          outcome: "uncertain",
          failureCode: "timeout",
          attemptCount: 1,
          nowMs: Date.now(),
        });
        assert.equal(waiting.status, "refund_pending");
        assert.equal(duplicateRefundKey(second.id, waiting.attemptCount), refundKey);
        const review = duplicateRefundPlan({
          outcome: "failed",
          failureCode: "lost_or_stolen_card",
          attemptCount: 0,
          nowMs: Date.now(),
        });
        assert.equal(review.status, "needs_review");
      } finally {
        const stripe = stripeFor(key);
        for (const id of created) {
          const current = await stripe.paymentIntents.retrieve(id);
          if (current.status === "succeeded") {
            await stripe.refunds.create({ payment_intent: id }, { idempotencyKey: `booking_safety_cleanup_${id}` }).catch(() => undefined);
          }
        }
      }
    });
  });
}
