import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createUnsubscribeSecret } from "../src/lib/outreach/unsubscribe.ts";
import {
  buildSendPlan,
  confirmationMatches,
  nextOutreachAttempt,
  outreachIdempotencyKey,
  outreachSendAllowance,
  outreachSendingEnabled,
  outreachTransportEnabled,
  planOutreachDelivery,
  prepareOutreachMessage,
  readOutreachLimits,
  recheckOutreachSuppression,
  type QueuedRecipient,
} from "../src/lib/outreach/sending.ts";
import { RATE_LIMITS } from "../src/lib/rate-limit-decision.ts";
import type { AudienceProspect, CampaignDraft } from "../src/lib/outreach/campaigns.ts";

const migration = readFileSync(new URL("../supabase/migrations/20261114010000_outreach_send_queue.sql", import.meta.url), "utf8");
const actions = readFileSync(new URL("../src/app/actions/outreach-sending.ts", import.meta.url), "utf8");
const sending = readFileSync(new URL("../src/lib/outreach/sending.ts", import.meta.url), "utf8");
const review = readFileSync(new URL("../src/app/admin/outreach/campaigns/[id]/review/page.tsx", import.meta.url), "utf8");
const notifications = readFileSync(new URL("../src/lib/notifications/dispatch.ts", import.meta.url), "utf8");
const rateLimit = readFileSync(new URL("../src/lib/rate-limit.ts", import.meta.url), "utf8");

const prospect = (overrides: Partial<AudienceProspect> = {}): AudienceProspect => ({
  id: "00000000-0000-4000-8000-000000000001",
  businessName: "North Clean",
  category: "Cleaning",
  location: "Rockford",
  contactEmail: "owner@north.example",
  source: "chamber",
  leadStatus: "new",
  ...overrides,
});

const draft = (overrides: Partial<CampaignDraft> = {}): CampaignDraft => ({
  name: "Spring introduction",
  subject: "Hello {{business_name}}",
  body: "We work in {{city}}.",
  senderName: "BlockBooked",
  senderEmail: "notifications@blockbooked.org",
  physicalAddress: "100 State Street, Rockford, IL 61101",
  unsubscribeFooter: "Unsubscribe from these updates.",
  filters: { leadStatus: "", category: "", location: "", source: "" },
  ...overrides,
});

describe("outreach send plan", () => {
  it("queues a personalized recipient and drops suppressed, invalid, and duplicate addresses", () => {
    const plan = buildSendPlan({
      campaignId: "campaign-1",
      campaign: draft(),
      prospects: [
        prospect(),
        prospect({ id: "00000000-0000-4000-8000-000000000002", businessName: "Second", contactEmail: " Owner@North.Example " }),
        prospect({ id: "00000000-0000-4000-8000-000000000003", businessName: "Opted", contactEmail: "gone@example.com" }),
        prospect({ id: "00000000-0000-4000-8000-000000000004", businessName: "Closed", contactEmail: "closed@example.com", leadStatus: "suppressed" }),
        prospect({ id: "00000000-0000-4000-8000-000000000005", businessName: "Bad", contactEmail: "not-an-email" }),
      ],
      suppressedEmails: ["Gone@Example.com"],
      sentToday: 0,
      sentThisMinute: 0,
      dailyLimit: 50,
      perMinuteLimit: 5,
    });
    assert.equal(plan.sendable, true);
    assert.deepEqual(plan.queued.map((item: QueuedRecipient) => item.email), ["owner@north.example"]);
    assert.equal(plan.queued[0]?.subject, "Hello North Clean");
    assert.match(plan.queued[0]?.body ?? "", /Rockford/);
    assert.equal(plan.duplicates, 1);
    assert.equal(plan.suppressed, 2);
    assert.equal(plan.invalid, 1);
    assert.equal(plan.allowedNow, 1);
    assert.equal(recheckOutreachSuppression(" Owner@North.Example ", ["owner@north.example"]), "suppressed");
    assert.equal(outreachIdempotencyKey("campaign-1", "Owner@North.Example"), outreachIdempotencyKey("campaign-1", "owner@north.example"));
  });

  it("refuses a queue without a physical address and keeps the rate limits", () => {
    const plan = buildSendPlan({
      campaignId: "campaign-1",
      campaign: draft({ physicalAddress: "" }),
      prospects: [prospect()],
      suppressedEmails: [],
      sentToday: 0,
      sentThisMinute: 0,
      dailyLimit: 50,
      perMinuteLimit: 5,
    });
    assert.equal(plan.sendable, false);
    assert.equal(plan.allowedNow, 0);
    assert.ok(plan.errors.includes("physical mailing address"));
    assert.equal(outreachSendAllowance({ sentToday: 50, sentThisMinute: 0, dailyLimit: 50, perMinuteLimit: 5 }), 0);
    assert.equal(outreachSendAllowance({ sentToday: 0, sentThisMinute: 5, dailyLimit: 50, perMinuteLimit: 5 }), 0);
    assert.equal(readOutreachLimits("50", "5")?.dailyLimit, 50);
    assert.equal(readOutreachLimits("0", "5"), null);
    assert.equal(RATE_LIMITS.outreachSend.max, 10);
    assert.equal(nextOutreachAttempt("failed", 1), "retry");
    assert.equal(nextOutreachAttempt("failed", 3), "exhausted");
    assert.equal(confirmationMatches("Spring introduction", "Spring introduction"), true);
    assert.equal(confirmationMatches("  Spring introduction  ", "Spring introduction"), true);
    assert.equal(confirmationMatches("Spring introduction", "Spring introduction "), false);
    assert.equal(confirmationMatches("Spring introduction", "send"), false);
  });

  it("keeps a suppressed lead from sharing its address with another prospect", () => {
    const plan = buildSendPlan({
      campaignId: "campaign-1",
      campaign: draft(),
      prospects: [
        prospect({ id: "00000000-0000-4000-8000-000000000006", businessName: "Closed", contactEmail: "shared@example.com", leadStatus: "suppressed" }),
        prospect({ id: "00000000-0000-4000-8000-000000000007", businessName: "Open", contactEmail: "Shared@Example.com", leadStatus: "new" }),
      ],
      suppressedEmails: [],
      sentToday: 0,
      sentThisMinute: 0,
      dailyLimit: 50,
      perMinuteLimit: 5,
    });
    assert.equal(plan.queued.length, 0);
    assert.equal(plan.suppressed, 2);
    const campaign = "00000000-0000-4000-8000-000000000010";
    const firstKey = outreachIdempotencyKey(campaign, `${"a".repeat(180)}1@example.com`);
    const secondKey = outreachIdempotencyKey(campaign, `${"a".repeat(180)}2@example.com`);
    assert.notEqual(firstKey, secondKey);
    assert.match(firstKey, /1@example.com$/);
    assert.match(secondKey, /2@example.com$/);
  });

  it("builds one unsubscribe header per token and does not send while the switch is off", () => {
    const first = createUnsubscribeSecret();
    const second = createUnsubscribeSecret();
    const message = prepareOutreachMessage({
      origin: "https://blockbooked.org",
      token: first.token,
      subject: "Hello",
      body: "Body",
      footer: "Unsubscribe any time.",
    });
    assert.equal(message?.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.match(message?.headers["List-Unsubscribe"] ?? "", new RegExp(first.token));
    assert.equal(prepareOutreachMessage({ origin: "https://blockbooked.org", token: second.token, subject: "Hello", body: "Body", footer: "Unsubscribe" })?.headers["List-Unsubscribe"]?.includes(first.token), false);
    assert.equal(outreachSendingEnabled(undefined, false), false);
    assert.equal(outreachSendingEnabled("true", false), false);
    assert.equal(outreachTransportEnabled(), false);
    assert.deepEqual(planOutreachDelivery({ sendingEnabled: false, stillSuppressed: false, tokenReady: true }), { step: "blocked", reason: "sending_disabled" });
    assert.deepEqual(planOutreachDelivery({ sendingEnabled: true, stillSuppressed: true, tokenReady: true }), { step: "skipped", reason: "suppressed" });
    assert.deepEqual(planOutreachDelivery({ sendingEnabled: true, stillSuppressed: false, tokenReady: true }), { step: "blocked", reason: "transport_disabled" });
  });
});

describe("outreach send access", () => {
  it("keeps the queue admin-only and separate from booking mail", () => {
    assert.match(actions, /requireAdmin\(/);
    assert.equal(actions.match(/redirectIfRateLimited\("outreachSend"/g)?.length, 4);
    assert.match(actions, /confirmationMatches/);
    assert.match(actions, /create_outreach_send_queue/);
    assert.match(actions, /confirm_outreach_send_queue/);
    assert.match(actions, /retry_outreach_send_queue/);
    assert.doesNotMatch(actions, /\.insert\(|console\.|issueOutreachUnsubscribeToken|prepareOutreachMessage|customerFacingError\(/);
    assert.match(review, /requireAdmin\(/);
    assert.match(review, /Sending is/);
    assert.match(review, /saved\.status === "blocked"/);
    assert.doesNotMatch(actions, /resend|stripe|notifyBookingEvent|api\.resend\.com|fetch\(/i);
    assert.doesNotMatch(sending, /resend|stripe|api\.resend\.com|fetch\(/i);
    assert.match(sending, /export function outreachTransportEnabled\(\) \{\r?\n  return false;\r?\n\}/);
    assert.doesNotMatch(notifications, /outreach_send|planOutreachDelivery/);
    assert.match(rateLimit, /consume_rate_limit/);
    assert.doesNotMatch(rateLimit, /new Map\(/);
    assert.match(migration, /force row level security/);
    assert.match(migration, /using \(public\.is_admin\(\)\)/);
    assert.match(migration, /sending_enabled boolean not null default false/);
    assert.match(migration, /raise exception 'Outreach sending is disabled'/);
    assert.match(migration, /revoke all on table public\.outreach_send_recipients from public, anon, authenticated/);
    assert.match(migration, /outreach_send_jobs_one_campaign/);
    assert.match(migration, /when unique_violation then/);
    assert.match(migration, /raise exception 'Outreach send queue already exists'/);
    assert.match(migration, /raise exception 'Outreach recipient is not eligible'/);
    assert.match(migration, /security invoker/);
    assert.doesNotMatch(migration, /security definer/i);
    assert.match(migration, /outreach_email_is_blocked/);
    assert.match(migration, /char_length\(physical_address\) >= 12/);
    assert.match(migration, /for update/);
    assert.match(migration, /attempt_count < 3/);
    assert.match(migration, /blocked:sending_disabled/);
    assert.match(migration, /event_type in \('queued', 'suppressed', 'blocked', 'retry', 'failed'\)/);
    assert.doesNotMatch(migration, /status in \('queued', 'suppressed', 'blocked', 'failed', 'sent'\)/);
    assert.match(migration, /if new\.status = 'sent' then/);
    assert.doesNotMatch(migration, /'delivered'/);
    assert.doesNotMatch(migration, /grant delete|grant truncate|grant all/i);
    assert.doesNotMatch(migration, /grant execute on function public\.create_outreach_send_queue\(uuid, integer, integer, integer, integer, integer, jsonb\) to service_role/);
    assert.match(migration, /revoke all on function public\.create_outreach_send_queue\(uuid, integer, integer, integer, integer, integer, jsonb\) from public, anon, authenticated/);
    assert.doesNotMatch(migration, /public\.booking_requests|public\.payments|notification_deliveries|stripe/i);
    assert.match(migration, /Applying this file does not send mail/);
  });
});
