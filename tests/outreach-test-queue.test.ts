import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  buildTestQueuePlan,
  syntheticTestEmail,
  TEST_QUEUE_CAMPAIGN_ID,
  TEST_QUEUE_RESET_PHRASE,
  testConfirmationMatches,
  testIdempotencyKey,
  testRetryDecision,
} from "../src/lib/outreach/test-queue.ts";
import { outreachTransportEnabled } from "../src/lib/outreach/sending.ts";

const migration = readFileSync(new URL("../supabase/migrations/20261114020000_outreach_test_queue.sql", import.meta.url), "utf8");
const resetMigration = readFileSync(new URL("../supabase/migrations/20261114030000_outreach_test_queue_reset.sql", import.meta.url), "utf8");
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
    assert.doesNotMatch(migration, /reset_outreach_test_queue/);
  });
});

function functionBody(sql: string, name: string) {
  const start = sql.indexOf(`function public.${name}`);
  const end = sql.indexOf("$$;", start);
  return sql.slice(start, end);
}

describe("outreach test queue reset", () => {
  it("rejects an unauthorized reset and keeps delete privileges off the tables", () => {
    const reset = functionBody(resetMigration, "reset_outreach_test_queue(confirmation text)");
    const lock = functionBody(resetMigration, "outreach_test_lock_seed");
    assert.match(actions, /export async function resetOutreachTestQueue/);
    assert.match(actions, /requireAdmin\(/);
    assert.match(actions, /phrase !== TEST_QUEUE_RESET_PHRASE/);
    assert.match(actions, /rpc\("reset_outreach_test_queue", \{ confirmation: phrase \}\)/);
    assert.match(page, /requireAdmin\(/);
    assert.match(page, /Reset test queue/);
    assert.match(page, /TEST_QUEUE_RESET_PHRASE/);
    assert.equal(TEST_QUEUE_RESET_PHRASE, "Reset test queue");
    assert.match(lock, /auth\.uid\(\) is null or not public\.is_admin\(\)/);
    assert.match(reset, /auth\.uid\(\) is null or not public\.is_admin\(\)/);
    assert.ok(reset.indexOf("is_admin()") < reset.indexOf("delete from"));
    assert.match(resetMigration, /revoke all on function public\.reset_outreach_test_queue\(\) from public, anon, authenticated/);
    assert.match(resetMigration, /drop function public\.reset_outreach_test_queue\(\)/);
    assert.match(resetMigration, /grant execute on function public\.reset_outreach_test_queue\(text\) to authenticated/);
    assert.match(resetMigration, /revoke all on function public\.reset_outreach_test_queue\(text\) from public, anon, authenticated/);
    assert.match(resetMigration, /revoke all on function public\.reset_outreach_test_queue\(text\) from service_role/);
    assert.doesNotMatch(resetMigration, /grant execute on function public\.reset_outreach_test_queue\(\)/);
    assert.match(resetMigration, /revoke all on function public\.outreach_test_lock_seed\(uuid\) from public, anon, authenticated/);
    assert.doesNotMatch(resetMigration, /grant delete|grant truncate|grant all/i);
    assert.match(reset, /security definer/);
    assert.match(lock, /set search_path = public/);
    assert.match(reset, /set search_path = public/);
  });

  it("rejects a missing or wrong confirmation before it locks or deletes", () => {
    const reset = functionBody(resetMigration, "reset_outreach_test_queue(confirmation text)");
    const gate = reset.indexOf("confirmation is distinct from 'Reset test queue'");
    const lock = reset.indexOf("outreach_test_lock_seed");
    const removal = reset.indexOf("delete from");
    assert.equal(TEST_QUEUE_RESET_PHRASE, "Reset test queue");
    assert.ok(gate >= 0 && gate < lock && lock < removal);
    assert.match(reset, /auth\.uid\(\) is null or not public\.is_admin\(\)/);
    assert.ok(reset.indexOf("is_admin()") < lock);
    assert.match(actions, /phrase !== TEST_QUEUE_RESET_PHRASE/);
    assert.match(actions, /confirmation: phrase/);
    assert.doesNotMatch(reset, /btrim\(confirmation\)|lower\(confirmation\)/);
  });

  it("removes one simulation and leaves the seeded campaign, fixtures, and original suppression", () => {
    const reset = functionBody(resetMigration, "reset_outreach_test_queue(confirmation text)");
    assert.match(reset, /00000000-0000-4000-8000-0000000000a1/);
    assert.match(reset, /delete from public\.outreach_test_events/);
    assert.match(reset, /delete from public\.outreach_test_queue_recipients/);
    assert.match(reset, /delete from public\.outreach_test_jobs/);
    assert.match(reset, /delete from public\.outreach_test_suppressions\s+where reason = 'test'/);
    assert.doesNotMatch(reset, /delete from public\.outreach_test_campaigns|delete from public\.outreach_test_recipients_fixture/);
    assert.match(migration, /'queue-test-c@example\.com', 'fixture'/);
    assert.doesNotMatch(resetMigration, /outreach_send_settings|public\.outreach_prospects|public\.outreach_suppressions|public\.outreach_send_|create_outreach_send_queue|resend|stripe|booking_requests/);
    assert.doesNotMatch(actions, /outreach_prospects|outreach_suppressions|outreach_send_|resend|stripe|issueOutreachUnsubscribeToken|api\.resend\.com/);
    assert.equal(outreachTransportEnabled(), false);
  });

  it("lets a second queue be saved after reset and shares one campaign lock with save", () => {
    const reset = functionBody(resetMigration, "reset_outreach_test_queue(confirmation text)");
    const create = functionBody(resetMigration, "create_outreach_test_queue");
    assert.ok(reset.indexOf("outreach_test_lock_seed") < reset.indexOf("delete from public.outreach_test_jobs"));
    assert.ok(create.indexOf("outreach_test_lock_seed") < create.indexOf("insert into public.outreach_test_jobs"));
    assert.match(functionBody(resetMigration, "confirm_outreach_test_queue"), /outreach_test_lock_seed/);
    assert.match(functionBody(resetMigration, "retry_outreach_test_queue"), /outreach_test_lock_seed/);
    assert.match(functionBody(resetMigration, "suppress_outreach_test_recipient"), /outreach_test_lock_seed/);
    assert.match(resetMigration, /for update/);

    const fixtures = [
      fixture("b1", "queue-test-a@example.com"),
      fixture("b3", "queue-test-b@example.com", "South Test"),
      fixture("b4", "queue-test-c@example.com", "Opted Test"),
    ];
    const before = {
      campaign: TEST_QUEUE_CAMPAIGN_ID,
      fixtures,
      suppressions: [
        { email: "queue-test-c@example.com", reason: "fixture" },
        { email: "queue-test-d@example.com", reason: "test" },
      ],
      jobs: ["job-1"],
      recipients: ["job-1"],
      events: ["job-1"],
    };
    const after = {
      ...before,
      suppressions: before.suppressions.filter((row) => row.reason !== "test"),
      jobs: [],
      recipients: [],
      events: [],
    };
    assert.deepEqual(after.fixtures, fixtures);
    assert.deepEqual(after.suppressions, [{ email: "queue-test-c@example.com", reason: "fixture" }]);
    assert.equal(after.jobs.length, 0);
    const plan = buildTestQueuePlan({
      campaignId: after.campaign,
      subject: "Hello {{business_name}}",
      body: "This simulation mentions {{city}}.",
      fixtures: after.fixtures,
      suppressedEmails: after.suppressions.map((row) => row.email),
    });
    assert.deepEqual(plan.queued.map((item) => item.email), ["queue-test-a@example.com", "queue-test-b@example.com"]);
    assert.match(page, /!saved/);
  });
});
