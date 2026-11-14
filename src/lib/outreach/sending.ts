import {
  campaignCompliance,
  personalizeCampaign,
  prospectMatchesFilters,
  type AudienceProspect,
  type CampaignDraft,
} from "./campaigns.ts";
import { normalizeEmail } from "./prospects.ts";
import { outreachListUnsubscribeHeaders, outreachUnsubscribePageUrl } from "./unsubscribe.ts";

export const DEFAULT_OUTREACH_DAILY_LIMIT = 50;
export const DEFAULT_OUTREACH_PER_MINUTE_LIMIT = 5;
export const OUTREACH_ATTEMPT_LIMIT = 3;

export function outreachSendingEnabled(flag: string | undefined, storedEnabled: boolean) {
  return flag === "true" && storedEnabled === true;
}

export function outreachTransportEnabled() {
  return false;
}

export function readOutreachLimits(daily: string, minute: string) {
  const dailyLimit = Number(daily);
  const perMinuteLimit = Number(minute);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 500) return null;
  if (!Number.isInteger(perMinuteLimit) || perMinuteLimit < 1 || perMinuteLimit > 30) return null;
  return { dailyLimit, perMinuteLimit };
}

export function outreachSendAllowance(input: {
  sentToday: number;
  sentThisMinute: number;
  dailyLimit: number;
  perMinuteLimit: number;
}) {
  const daily = Math.max(0, Math.min(500, input.dailyLimit) - Math.max(0, input.sentToday));
  const minute = Math.max(0, Math.min(30, input.perMinuteLimit) - Math.max(0, input.sentThisMinute));
  return Math.min(daily, minute);
}

export function outreachIdempotencyKey(campaignId: string, email: string) {
  const normalized = normalizeEmail(email);
  if (!normalized) return "";
  return `outreach:${campaignId}:${normalized}`;
}

export function confirmationMatches(campaignName: string, phrase: string) {
  const name = campaignName.trim();
  return name.length > 0 && phrase === name;
}

export function recheckOutreachSuppression(email: string, suppressedEmails: string[]) {
  const normalized = normalizeEmail(email);
  if (!normalized) return "invalid" as const;
  const blocked = new Set(suppressedEmails.map((item) => normalizeEmail(item)).filter(Boolean));
  return blocked.has(normalized) ? ("suppressed" as const) : ("ready" as const);
}

export function nextOutreachAttempt(status: string, attemptCount: number) {
  if (attemptCount >= OUTREACH_ATTEMPT_LIMIT) return "exhausted" as const;
  if (status === "queued" || status === "failed" || status === "blocked") return "retry" as const;
  return "skip" as const;
}

export type QueuedRecipient = {
  prospectId: string;
  email: string;
  subject: string;
  body: string;
  idempotencyKey: string;
};

export function buildSendPlan(input: {
  campaignId: string;
  campaign: CampaignDraft;
  prospects: AudienceProspect[];
  suppressedEmails: string[];
  sentToday: number;
  sentThisMinute: number;
  dailyLimit: number;
  perMinuteLimit: number;
}) {
  const errors = campaignCompliance(input.campaign);
  const blocked = new Set(input.suppressedEmails.map((email) => normalizeEmail(email)).filter(Boolean));
  for (const prospect of input.prospects) {
    const email = normalizeEmail(prospect.contactEmail);
    if (email && prospect.leadStatus === "suppressed") blocked.add(email);
  }
  const seen = new Set<string>();
  const queued: QueuedRecipient[] = [];
  let suppressed = 0;
  let invalid = 0;
  let duplicates = 0;
  for (const prospect of input.prospects) {
    const email = normalizeEmail(prospect.contactEmail);
    const comparable = prospect.leadStatus === "suppressed"
      ? { ...prospect, leadStatus: input.campaign.filters.leadStatus || "new" }
      : prospect;
    if (!prospectMatchesFilters(comparable, input.campaign.filters)) continue;
    if (!email || prospect.leadStatus === "suppressed" || blocked.has(email)) {
      if (!email) invalid += 1;
      else suppressed += 1;
      continue;
    }
    if (seen.has(email)) {
      duplicates += 1;
      continue;
    }
    seen.add(email);
    queued.push({
      prospectId: prospect.id,
      email,
      subject: personalizeCampaign(input.campaign.subject, prospect).slice(0, 160),
      body: personalizeCampaign(input.campaign.body, prospect).slice(0, 8000),
      idempotencyKey: outreachIdempotencyKey(input.campaignId, email),
    });
  }
  const allowedNow = outreachSendAllowance({
    sentToday: input.sentToday,
    sentThisMinute: input.sentThisMinute,
    dailyLimit: input.dailyLimit,
    perMinuteLimit: input.perMinuteLimit,
  });
  return {
    sendable: errors.length === 0,
    errors,
    queued,
    suppressed,
    invalid,
    duplicates,
    allowedNow: errors.length > 0 ? 0 : Math.min(allowedNow, queued.length),
  };
}

export function prepareOutreachMessage(input: { origin: string; token: string; subject: string; body: string; footer: string }) {
  const headers = outreachListUnsubscribeHeaders(input.origin, input.token);
  const page = outreachUnsubscribePageUrl(input.origin, input.token);
  if (!headers || !page) return null;
  return {
    subject: input.subject,
    text: `${input.body}\n\n${input.footer}\n${page}`,
    headers,
  };
}

export function planOutreachDelivery(input: { sendingEnabled: boolean; stillSuppressed: boolean; tokenReady: boolean }) {
  if (!input.sendingEnabled) return { step: "blocked" as const, reason: "sending_disabled" };
  if (input.stillSuppressed) return { step: "skipped" as const, reason: "suppressed" };
  if (!input.tokenReady) return { step: "blocked" as const, reason: "unsubscribe_token" };
  if (!outreachTransportEnabled()) return { step: "blocked" as const, reason: "transport_disabled" };
  return { step: "would_send" as const, reason: "" };
}
