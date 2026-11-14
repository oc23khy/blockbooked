import { headers } from "next/headers";
import { consumeRateLimit } from "@/lib/rate-limit";
import { trustedClientAddress } from "@/lib/rate-limit-decision";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  canonicalUnsubscribeEmail,
  createUnsubscribeSecret,
  hashUnsubscribeToken,
  isUnsubscribeToken,
  unsubscribeExpiry,
  unsubscribeRateSubject,
  type UnsubscribeOutcome,
} from "@/lib/outreach/unsubscribe";

async function allowUnsubscribe(tokenHash: string) {
  const headerList = await headers();
  const address = trustedClientAddress(headerList, process.env.VERCEL === "1");
  if (address) {
    const ip = await consumeRateLimit("outreachUnsubscribeIp", `ip:${address}`);
    if (!ip.allowed) return false;
  }
  const token = await consumeRateLimit("outreachUnsubscribeToken", unsubscribeRateSubject(tokenHash));
  return token.allowed;
}

export async function redeemOutreachUnsubscribe(token: string): Promise<UnsubscribeOutcome> {
  if (!isUnsubscribeToken(token)) {
    const headerList = await headers();
    const address = trustedClientAddress(headerList, process.env.VERCEL === "1");
    if (address) {
      const ip = await consumeRateLimit("outreachUnsubscribeIp", `ip:${address}`);
      if (!ip.allowed) return "limited";
    }
    return "invalid";
  }
  const tokenHash = hashUnsubscribeToken(token);
  try {
    if (!(await allowUnsubscribe(tokenHash))) return "limited";
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("redeem_outreach_unsubscribe", { raw_hash: tokenHash });
    if (error || typeof data !== "string") return "unavailable";
    if (data === "unsubscribed" || data === "repeated" || data === "expired" || data === "invalid") return data;
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function issueOutreachUnsubscribeToken(email: string, nowMs = Date.now()) {
  const normalized = canonicalUnsubscribeEmail(email);
  if (!normalized) return { token: "", ok: false as const };
  const secret = createUnsubscribeSecret();
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("issue_outreach_unsubscribe_token", {
      raw_email: normalized,
      raw_hash: secret.tokenHash,
      token_expires_at: unsubscribeExpiry(nowMs),
    });
    if (error || data !== "issued") return { token: "", ok: false as const };
    return { token: secret.token, ok: true as const };
  } catch {
    return { token: "", ok: false as const };
  }
}
