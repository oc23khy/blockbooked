import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  buildTestQueuePlan,
  syntheticTestEmail,
  testConfirmationMatches,
  testIdempotencyKey,
  testRetryDecision,
} from "../src/lib/outreach/test-queue.ts";
import { outreachTransportEnabled } from "../src/lib/outreach/sending.ts";

const migration = readFileSync(new URL("../supabase/migrations/20261114020000_outreach_test_queue.sql", import.meta.url), "utf8");
const production = readFileSync(new URL("../supabase/migrations/20261114010000_outreach_send_queue.sql", import.meta.url), "utf8");
const actions = readFileSync(new URL("../src/app/actions/outreach-test-queue.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/app/admin/outreach/test-queue/page.tsx", import.meta.url), "utf8");
const liveReview = readFileSync(new URL("../src/app/admin/outreach/campaigns/[id]/review/page.tsx", import.meta.url), "utf8");

const fixture = (id: string, email: string, businessName = "North Test") => ({
  id,
  businessName,
  city: "Rockford",
  contactEmail: email,
});

describe("outreach test queue plan", () => {
  it("queues each synthetic address once and drops duplicates, suppressions, and real domains", () => {
    const plan = buildTestQueuePlan({
      campaignId: "00000000-0000-4000-8000-0000000000a1",
      subject: "Hello {{business_name}}",
      body: "This simulation mentions {{city}}.",
      fixtures: [
        fixture("1", "queue-test-a@example.com"),
        fixture("2", " Queue-Test-A@Example.com ", "North Test Copy"),
        fixture("3", "queue-test-b@example.com", "South Test"),
        fixture("4", "queue-test-c@example.com", "Opted Test"),
        fixture("5", "owner@real-business.com", "Real Business"),
      ],
      suppressedEmails: ["Queue-Test-C@Example.com"],
    });
    assert.deepEqual(plan.queued.map((item) => item.email), ["queue-test-a@example.com", "queue-test-b@example.com"]);
    assert.equal(plan.queued[0]?.subject, "Hello North Test");
    assert.match(plan.queued[0]?.body ?? "", /Rockford/);
    assert.equal(plan.duplicates, 1);
    assert.equal(plan.suppressed, 1);
    assert.equal(plan.invalid, 1);
    assert.equal(syntheticTestEmail("owner@real-business.com"), "");
    assert.equal(syntheticTestEmail("a@sub.example.com"), "");
    assert.equal(syntheticTestEmail("a@example.com.evil"), "");
    assert.equal(syntheticTestEmail("queue-test-a@example.com"), "queue-test-a@example.com");
    assert.equal(
      testIdempotencyKey("00000000-0000-4000-8000-0000000000a1", "Queue-Test-A@Example.com"),
      "outreach-test:00000000-0000-4000-8000-0000000000a1:queue-test-a@example.com",
    );
  });

  it("requires the exact test name and stops retries after three blocked attempts", () => {
    assert.equal(testConfirmationMatches("Queue test", "Queue test"), true);
    assert.equal(testConfirmationMatches("Queue test", "Queue test "), false);
    assert.equal(testRetryDecision(2), "retry");
    assert.equal(testRetryDecision(3), "exhausted");
    assert.equal(outreachTransportEnabled(), false);
  });
});

describe("outreach test queue isolation", () => {
  it("keeps the simulation in its own admin-only tables", () => {
    assert.match(actions, /requireAdmin\(/);
    assert.match(actions, /redirectIfRateLimited\("outreachSend"/);
    assert.match(actions, /create_outreach_test_queue/);
    assert.match(actions, /confirm_outreach_test_queue/);
    assert.match(actions, /retry_outreach_test_queue/);
    assert.match(actions, /suppress_outreach_test_recipient/);
    assert.match(page, /requireAdmin\(/);
    assert.match(page, /@example.com/);
    assert.doesNotMatch(actions, /outreach_prospects|outreach_suppressions|outreach_send_|resend|stripe|issueOutreachUnsubscribeToken|api\.resend\.com/);
    assert.doesNotMatch(page, /outreach_prospects|outreach_send_|resend|stripe/);
    assert.doesNotMatch(liveReview, /outreach_test_/);
    assert.match(migration, /force row level security/);
    assert.match(migration, /using \(public\.is_admin\(\)\)/);
    assert.match(migration, /security invoker/);
    assert.doesNotMatch(migration, /security definer/i);
    assert.match(migration, /@example\\.com/);
    assert.match(migration, /detail ~ '\^test:'/);
    assert.match(migration, /test:blocked:sending_disabled/);
    assert.match(migration, /attempt_count < 3/);
    assert.match(migration, /new\.attempt_count < old\.attempt_count/);
    assert.match(migration, /from public\.outreach_test_recipients_fixture/);
    assert.doesNotMatch(migration, /recipient->>'personalized_subject'/);
    assert.match(migration, /for update/);
    assert.match(migration, /when unique_violation then/);
    assert.match(migration, /queue-test-a@example.com/);
    assert.match(migration, /revoke all on function public\.suppress_outreach_test_recipient\(text\) from public, anon, authenticated/);
    assert.doesNotMatch(migration, /outreach_send_settings|public\.outreach_prospects|public\.outreach_suppressions|public\.outreach_send_|create_outreach_send_queue|resend|stripe|booking_requests/);
    assert.doesNotMatch(migration, /grant delete|grant truncate|grant all/i);
    assert.match(production, /char_length\(physical_address\) >= 12/);
    assert.match(production, /if new\.sending_enabled is true then/);
    assert.match(production, /if new\.status = 'sent' then/);
  });
});
