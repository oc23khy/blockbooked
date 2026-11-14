import { personalizeCampaign } from "./campaigns.ts";
import { normalizeEmail } from "./prospects.ts";
import { confirmationMatches, nextOutreachAttempt } from "./sending.ts";

export const TEST_QUEUE_CAMPAIGN_ID = "00000000-0000-4000-8000-0000000000a1";
export const TEST_QUEUE_CAMPAIGN_NAME = "Queue test";
export const TEST_QUEUE_RESET_PHRASE = "Reset test queue";

export type TestFixture = {
  id: string;
  businessName: string;
  city: string;
  contactEmail: string;
};

export type TestQueueRecipient = {
  fixtureId: string;
  email: string;
  subject: string;
  body: string;
  idempotencyKey: string;
};

export function syntheticTestEmail(value: string) {
  const email = normalizeEmail(value);
  if (!/^[^@\s]+@example\.com$/.test(email)) return "";
  return email;
}

export function testIdempotencyKey(campaignId: string, email: string) {
  const normalized = syntheticTestEmail(email);
  if (!normalized) return "";
  return `outreach-test:${campaignId}:${normalized}`;
}

export function buildTestQueuePlan(input: {
  campaignId: string;
  subject: string;
  body: string;
  fixtures: TestFixture[];
  suppressedEmails: string[];
}) {
  const blocked = new Set(input.suppressedEmails.map((email) => syntheticTestEmail(email)).filter(Boolean));
  const seen = new Set<string>();
  const queued: TestQueueRecipient[] = [];
  let suppressed = 0;
  let invalid = 0;
  let duplicates = 0;
  for (const fixture of input.fixtures) {
    const email = syntheticTestEmail(fixture.contactEmail);
    if (!email) {
      invalid += 1;
      continue;
    }
    if (blocked.has(email)) {
      suppressed += 1;
      continue;
    }
    if (seen.has(email)) {
      duplicates += 1;
      continue;
    }
    seen.add(email);
    const prospect = { businessName: fixture.businessName, location: fixture.city };
    queued.push({
      fixtureId: fixture.id,
      email,
      subject: personalizeCampaign(input.subject, prospect).slice(0, 160),
      body: personalizeCampaign(input.body, prospect).slice(0, 8000),
      idempotencyKey: testIdempotencyKey(input.campaignId, email),
    });
  }
  return { queued, suppressed, invalid, duplicates, allowedNow: queued.length };
}

export function testConfirmationMatches(campaignName: string, phrase: string) {
  return confirmationMatches(campaignName, phrase);
}

export function testRetryDecision(attemptCount: number) {
  return nextOutreachAttempt("blocked", attemptCount);
}
