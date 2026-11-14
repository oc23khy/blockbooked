import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { RATE_LIMITS } from "../src/lib/rate-limit-decision.ts";
import {
  canonicalUnsubscribeEmail,
  confirmUnsubscribeToken,
  createUnsubscribeSecret,
  hashUnsubscribeToken,
  isOneClickUnsubscribe,
  isUnsubscribeToken,
  outreachListUnsubscribeHeaders,
  outreachUnsubscribePageUrl,
  planUnsubscribe,
  publicUnsubscribeOutcome,
  readUnsubscribeResultProof,
  UNSUBSCRIBE_TOKEN_TTL_MS,
  unsubscribeResultProof,
  unsubscribePageCopy,
  unsubscribeRateSubject,
} from "../src/lib/outreach/unsubscribe.ts";

const migration = readFileSync(new URL("../supabase/migrations/20261112040000_outreach_unsubscribe.sql", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/app/api/outreach/unsubscribe/[token]/route.ts", import.meta.url), "utf8");
const confirmRoute = readFileSync(new URL("../src/app/api/outreach/unsubscribe/route.ts", import.meta.url), "utf8");
const limiter = readFileSync(new URL("../src/lib/rate-limit.ts", import.meta.url), "utf8");
const rateMigration = readFileSync(new URL("../supabase/migrations/20261111200000_rate_limits.sql", import.meta.url), "utf8");
const proxy = readFileSync(new URL("../src/lib/supabase/proxy.ts", import.meta.url), "utf8");
const nextConfig = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/app/outreach/unsubscribe/[token]/page.tsx", import.meta.url), "utf8");
const resultPage = readFileSync(new URL("../src/app/outreach/unsubscribe/result/page.tsx", import.meta.url), "utf8");
const store = readFileSync(new URL("../src/lib/outreach/unsubscribe-store.ts", import.meta.url), "utf8");
const guide = readFileSync(new URL("../docs/outreach-unsubscribe.md", import.meta.url), "utf8");
const robots = readFileSync(new URL("../src/app/robots.ts", import.meta.url), "utf8");
const campaigns = readFileSync(new URL("../src/app/actions/outreach-campaigns.ts", import.meta.url), "utf8");
const notifications = readFileSync(new URL("../src/lib/notifications/dispatch.ts", import.meta.url), "utf8");

const now = Date.parse("2026-11-12T00:00:00Z");

function recordFor(token: string, overrides: { email?: string; expiresAtMs?: number; usedAtMs?: number | null } = {}) {
  return {
    tokenHash: hashUnsubscribeToken(token),
    normalizedEmail: overrides.email ?? "owner@north.example",
    expiresAtMs: overrides.expiresAtMs ?? now + 60_000,
    usedAtMs: overrides.usedAtMs ?? null,
  };
}

describe("outreach unsubscribe tokens", () => {
  it("accepts a valid token, ignores case, and treats a repeat as the same suppression", () => {
    const secret = createUnsubscribeSecret();
    assert.equal(isUnsubscribeToken(secret.token), true);
    assert.equal(secret.tokenHash, hashUnsubscribeToken(secret.token));
    assert.equal(secret.tokenHash.length, 64);
    assert.equal(unsubscribeRateSubject(secret.tokenHash).includes(secret.token), false);
    assert.equal(canonicalUnsubscribeEmail(" Owner@North.Example "), "owner@north.example");
    const first = planUnsubscribe({
      token: secret.token,
      nowMs: now,
      records: [recordFor(secret.token, { email: "Owner@North.Example" })],
    });
    assert.equal(first.outcome, "unsubscribed");
    assert.equal(first.suppressEmail, "owner@north.example");
    const again = planUnsubscribe({
      token: secret.token,
      nowMs: now,
      records: [recordFor(secret.token, { usedAtMs: now })],
    });
    assert.equal(again.outcome, "repeated");
    assert.equal(again.suppressEmail, "owner@north.example");
    const other = createUnsubscribeSecret();
    const scoped = planUnsubscribe({
      token: secret.token,
      nowMs: now,
      records: [
        recordFor(other.token, { email: "other@north.example" }),
        recordFor(secret.token, { email: "owner@north.example" }),
      ],
    });
    assert.equal(scoped.suppressEmail, "owner@north.example");
    assert.equal(publicUnsubscribeOutcome("unsubscribed"), "done");
    assert.equal(publicUnsubscribeOutcome("repeated"), "done");
    const proof = unsubscribeResultProof("done", "test-secret", now);
    assert.equal(proof.includes("@"), false);
    assert.equal(readUnsubscribeResultProof(proof, "test-secret", now), "done");
    assert.equal(readUnsubscribeResultProof(proof, "test-secret", now + 120_000), "done");
    assert.equal(readUnsubscribeResultProof(proof, "test-secret", now + 120_001), "");
    assert.equal(readUnsubscribeResultProof(proof, "other-secret", now), "");
    assert.equal(readUnsubscribeResultProof("done.1.forged", "test-secret", now), "");
    assert.equal(readUnsubscribeResultProof(proof, "test-secret", now + 3 * 60 * 1000), "");
  });

  it("rejects an unknown token and an expired token without a suppression", () => {
    const secret = createUnsubscribeSecret();
    const missing = planUnsubscribe({ token: secret.token, nowMs: now, records: [] });
    assert.equal(missing.outcome, "invalid");
    assert.equal(missing.suppressEmail, "");
    const expired = planUnsubscribe({
      token: secret.token,
      nowMs: now,
      records: [recordFor(secret.token, { expiresAtMs: now })],
    });
    assert.equal(expired.outcome, "expired");
    assert.equal(expired.suppressEmail, "");
    assert.equal(planUnsubscribe({ token: "not-a-token", nowMs: now, records: [] }).outcome, "invalid");
    assert.equal(publicUnsubscribeOutcome("invalid"), "invalid");
    assert.equal(publicUnsubscribeOutcome("expired"), "invalid");
    assert.equal(unsubscribePageCopy("invalid").body, unsubscribePageCopy("expired").body);
    assert.equal(unsubscribePageCopy("invalid").body.includes("@"), false);
    assert.equal(unsubscribePageCopy("unsubscribed").body.includes("@"), false);
  });

  it("builds one-click headers and accepts only the RFC body or the confirmation body", () => {
    const secret = createUnsubscribeSecret();
    const headers = outreachListUnsubscribeHeaders("https://blockbooked.org", secret.token);
    assert.equal(headers?.["List-Unsubscribe"], `<https://blockbooked.org/api/outreach/unsubscribe/${secret.token}>`);
    assert.equal(headers?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.equal(outreachUnsubscribePageUrl("https://blockbooked.org", secret.token), `https://blockbooked.org/outreach/unsubscribe/${secret.token}`);
    assert.equal(outreachListUnsubscribeHeaders("https://blockbooked.org/admin", secret.token), null);
    assert.equal(outreachListUnsubscribeHeaders("https://blockbooked.org", "owner@north.example"), null);
    assert.equal(isOneClickUnsubscribe("application/x-www-form-urlencoded", "List-Unsubscribe=One-Click"), true);
    assert.equal(isOneClickUnsubscribe("application/json", "List-Unsubscribe=One-Click"), false);
    assert.equal(isOneClickUnsubscribe("application/x-www-form-urlencoded", "List-Unsubscribe=One-Click&email=owner@north.example"), false);
    assert.equal(confirmUnsubscribeToken("application/x-www-form-urlencoded", `confirm=1&token=${secret.token}`), secret.token);
    assert.equal(confirmUnsubscribeToken("application/x-www-form-urlencoded", "confirm=1&email=owner@north.example"), "");
    assert.equal(isOneClickUnsubscribe("application/x-www-form-urlencoded", ""), false);
    assert.equal(UNSUBSCRIBE_TOKEN_TTL_MS, 180 * 24 * 60 * 60 * 1000);
    assert.equal(UNSUBSCRIBE_TOKEN_TTL_MS < 366 * 24 * 60 * 60 * 1000, true);
    assert.equal(RATE_LIMITS.outreachUnsubscribeIp.max, 60);
    assert.equal(RATE_LIMITS.outreachUnsubscribeToken.max, 8);
  });
});

describe("outreach unsubscribe access", () => {
  it("keeps the table private and the public response separate from booking mail", () => {
    assert.match(migration, /force row level security/);
    assert.match(migration, /revoke all on table public\.outreach_unsubscribe_tokens from public, anon, authenticated/);
    assert.match(migration, /on conflict \(normalized_email\) do nothing/);
    assert.match(migration, /lead_status = 'suppressed'/);
    assert.match(migration, /return 'expired'/);
    assert.match(migration, /return 'repeated'/);
    assert.match(migration, /grant execute on function public\.redeem_outreach_unsubscribe\(text\) to service_role/);
    assert.doesNotMatch(migration, /create policy|grant select|grant insert|grant update|grant delete|grant truncate|grant all/i);
    assert.doesNotMatch(migration, /grant execute on function[^\n]+to (public|anon|authenticated)/i);
    assert.doesNotMatch(migration, /public\.booking_requests|public\.payments|notification_deliveries|stripe/i);
    assert.doesNotMatch(migration, /^update\s/im);
    assert.match(migration, /Applying this file does not insert tokens/);
    const expiredAt = migration.indexOf("return 'expired'");
    const insertAt = migration.indexOf("insert into public.outreach_suppressions");
    assert.equal(expiredAt > -1 && expiredAt < insertAt, true);
    assert.equal(migration.split(/\r?\n/).filter((line) => line.trim() === "set search_path = public").length, 3);
    assert.match(migration, /where normalized_email = target/);
    assert.doesNotMatch(migration, /delete from public\.outreach_suppressions/i);
    assert.doesNotMatch(migration, /function public\.redeem_outreach_unsubscribe\([^)]*email/i);
    const gate = route.indexOf("return empty(400)");
    const redeem = route.indexOf("await redeemOutreachUnsubscribe");
    assert.equal(gate > -1 && gate < redeem, true);
    assert.doesNotMatch(route, /export async function GET|export function GET|cookies\(|requireSession/);
    assert.match(confirmRoute, /confirmUnsubscribeToken/);
    assert.match(confirmRoute, /Location: location/);
    assert.match(confirmRoute, /\/outreach\/unsubscribe\/result\?proof=/);
    assert.doesNotMatch(confirmRoute, /request\.url|export async function GET|cookies\(|requireSession/);
    assert.match(page, /action="\/api\/outreach\/unsubscribe"/);
    assert.doesNotMatch(page, /unsubscribe-store|redeemOutreachUnsubscribe|createAdminClient|requireSession|type="email"|name="email"/);
    assert.match(limiter, /rpc\("consume_rate_limit"/);
    assert.doesNotMatch(limiter, /new Map/);
    assert.match(rateMigration, /on conflict \(bucket\) do update/i);
    assert.match(store, /consumeRateLimit\("outreachUnsubscribeIp"/);
    assert.match(store, /consumeRateLimit\("outreachUnsubscribeToken"/);
    assert.match(proxy, /Referrer-Policy", "no-referrer"/);
    assert.match(nextConfig, /\/outreach\/unsubscribe\/:path\*/);
    assert.match(nextConfig, /no-referrer/);
    assert.match(nextConfig, /no-store/);
    assert.match(resultPage, /readUnsubscribeResultProof/);
    assert.doesNotMatch(route, /notifications|stripe|resend|normalized_email|contact_email/i);
    assert.doesNotMatch(resultPage, /token|createAdminClient|requireSession/);
    assert.match(store, /raw_hash: tokenHash/);
    assert.doesNotMatch(store, /from\("outreach_|notifications|stripe|resend/i);
    assert.doesNotMatch(campaigns, /issueOutreachUnsubscribeToken|List-Unsubscribe/);
    assert.doesNotMatch(notifications, /outreach\/unsubscribe|List-Unsubscribe/);
    assert.match(robots, /\/outreach\/unsubscribe/);
    assert.match(guide, /issueOutreachUnsubscribeToken/);
    assert.match(guide, /List-Unsubscribe-Post/);
  });
});
