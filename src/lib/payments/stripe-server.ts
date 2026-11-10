import Stripe from "stripe";
import { assertTestStripeKey, resolveSiteUrl } from "@/lib/payments/money";

export function isStripeTestConfigured() {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  return key.startsWith("sk_test_") && Boolean(process.env.STRIPE_WEBHOOK_SECRET);
}

export function stripeTestKeyConfigured() {
  return (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_");
}

// STRIPE_SECRET_KEY belongs in .env.local as sk_test_... Never put it in client code.
export function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is missing. Add a Stripe test secret key to .env.local.");
  }
  assertTestStripeKey(key);
  return new Stripe(key);
}

export function siteUrl() {
  return resolveSiteUrl(process.env.NEXT_PUBLIC_SITE_URL, process.env.NODE_ENV);
}
