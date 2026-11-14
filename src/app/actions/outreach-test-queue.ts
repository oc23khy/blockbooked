"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  buildTestQueuePlan,
  TEST_QUEUE_CAMPAIGN_NAME,
  TEST_QUEUE_RESET_PHRASE,
  testConfirmationMatches,
  type TestFixture,
} from "@/lib/outreach/test-queue";
import { redirectIfRateLimited } from "@/lib/rate-limit";
import { requireAdmin } from "@/lib/session";

const path = "/admin/outreach/test-queue";

function sendError(message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

function testFailure(error: { code?: string; message?: string; details?: string } | null) {
  if (!error) return "";
  const text = `${error.message} ${error.details ?? ""}`;
  if ((error.code === "23505" && text.includes("outreach_test_jobs_one_campaign")) || text.includes("Outreach test queue already exists")) return "saved";
  if (text.includes("Outreach confirmation does not match")) return "confirmation";
  return "unavailable";
}

async function loadFixture(supabase: Awaited<ReturnType<typeof requireAdmin>>["supabase"]) {
  const [campaign, fixtures, suppressions] = await Promise.all([
    supabase.from("outreach_test_campaigns").select("id, name, subject, body").eq("name", TEST_QUEUE_CAMPAIGN_NAME).maybeSingle(),
    supabase.from("outreach_test_recipients_fixture").select("id, business_name, city, contact_email").order("contact_email", { ascending: true }),
    supabase.from("outreach_test_suppressions").select("normalized_email"),
  ]);
  if (campaign.error || fixtures.error || suppressions.error || !campaign.data) return null;
  const rows: TestFixture[] = (fixtures.data ?? []).map((row) => ({
    id: row.id,
    businessName: row.business_name,
    city: row.city,
    contactEmail: row.contact_email,
  }));
  return {
    campaign: campaign.data,
    fixtures: rows,
    suppressed: (suppressions.data ?? []).map((row) => row.normalized_email),
  };
}

export async function saveOutreachTestQueue() {
  const session = await requireAdmin(path);
  await redirectIfRateLimited("outreachSend", session.user.id, path);
  const loaded = await loadFixture(session.supabase);
  if (!loaded) sendError("The test queue is not available.");
  const plan = buildTestQueuePlan({
    campaignId: loaded.campaign.id,
    subject: loaded.campaign.subject,
    body: loaded.campaign.body,
    fixtures: loaded.fixtures,
    suppressedEmails: loaded.suppressed,
  });
  if (plan.queued.length === 0) sendError("No synthetic recipient is left to queue.");
  const existing = await session.supabase.from("outreach_test_jobs").select("id").eq("test_campaign_id", loaded.campaign.id).limit(1).maybeSingle();
  if (existing.error) sendError("The test queue could not be saved.");
  if (existing.data) redirect(`${path}?notice=Test%20queue%20saved`);
  const saved = await session.supabase.rpc("create_outreach_test_queue", {
    target_campaign: loaded.campaign.id,
    recipient_count: plan.queued.length,
    suppressed_count: plan.suppressed,
    invalid_count: plan.invalid,
    duplicate_count: plan.duplicates,
    allowed_count: plan.allowedNow,
    recipients: plan.queued.map((recipient) => ({
      fixture_id: recipient.fixtureId,
      normalized_email: recipient.email,
      personalized_subject: recipient.subject,
      personalized_body: recipient.body,
    })),
  });
  if (testFailure(saved.error) === "saved") redirect(`${path}?notice=Test%20queue%20saved`);
  if (saved.error || !saved.data) sendError("The test queue could not be saved.");
  revalidatePath(path);
  redirect(`${path}?notice=Test%20queue%20saved`);
}

export async function confirmOutreachTestQueue(formData: FormData) {
  const session = await requireAdmin(path);
  await redirectIfRateLimited("outreachSend", session.user.id, path);
  const loaded = await loadFixture(session.supabase);
  if (!loaded) sendError("The test queue is not available.");
  const phrase = String(formData.get("confirmation") ?? "");
  const jobId = String(formData.get("jobId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(jobId) || !testConfirmationMatches(loaded.campaign.name, phrase)) {
    sendError("Type the test campaign name to confirm. Nothing was sent.");
  }
  const confirmed = await session.supabase.rpc("confirm_outreach_test_queue", {
    target_campaign: loaded.campaign.id,
    target_job: jobId,
    confirmation: phrase,
  });
  if (testFailure(confirmed.error) === "confirmation") sendError("Type the test campaign name to confirm. Nothing was sent.");
  if (confirmed.error || confirmed.data !== "blocked") sendError("The test queue could not be confirmed. Nothing was sent.");
  revalidatePath(path);
  redirect(`${path}?notice=Test%20confirmation%20recorded.%20No%20email%20was%20sent.`);
}

export async function retryOutreachTestQueue(formData: FormData) {
  const session = await requireAdmin(path);
  await redirectIfRateLimited("outreachSend", session.user.id, path);
  const loaded = await loadFixture(session.supabase);
  if (!loaded) sendError("The test queue is not available.");
  const jobId = String(formData.get("jobId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) sendError("The test queue could not be retried.");
  const retried = await session.supabase.rpc("retry_outreach_test_queue", {
    target_campaign: loaded.campaign.id,
    target_job: jobId,
  });
  if (retried.error || (retried.data !== "blocked" && retried.data !== "exhausted")) {
    sendError("The test queue could not be retried. Nothing was sent.");
  }
  revalidatePath(path);
  redirect(`${path}?notice=${retried.data === "exhausted" ? "Test%20retry%20limit%20reached.%20No%20email%20was%20sent." : "Test%20retry%20recorded.%20No%20email%20was%20sent."}`);
}

export async function suppressOutreachTestRecipient(formData: FormData) {
  const session = await requireAdmin(path);
  await redirectIfRateLimited("outreachSend", session.user.id, path);
  const fixtureId = String(formData.get("fixtureId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(fixtureId)) sendError("That test recipient could not be suppressed.");
  const fixture = await session.supabase.from("outreach_test_recipients_fixture").select("contact_email").eq("id", fixtureId).maybeSingle();
  if (fixture.error || !fixture.data) sendError("That test recipient could not be suppressed.");
  const suppressed = await session.supabase.rpc("suppress_outreach_test_recipient", { raw_email: fixture.data.contact_email });
  if (suppressed.error || suppressed.data !== "suppressed") sendError("That test recipient could not be suppressed.");
  revalidatePath(path);
  redirect(`${path}?notice=Synthetic%20address%20suppressed.%20No%20live%20prospect%20was%20changed.`);
}

export async function resetOutreachTestQueue(formData: FormData) {
  const session = await requireAdmin(path);
  await redirectIfRateLimited("outreachSend", session.user.id, path);
  const phrase = String(formData.get("confirmation") ?? "");
  if (phrase !== TEST_QUEUE_RESET_PHRASE) sendError("Type Reset test queue to reset. Nothing was sent.");
  const reset = await session.supabase.rpc("reset_outreach_test_queue", { confirmation: phrase });
  if (reset.error || reset.data !== "reset") sendError("The test queue could not be reset. Nothing was sent.");
  revalidatePath(path);
  redirect(`${path}?notice=Test%20queue%20reset.%20No%20email%20was%20sent.`);
}
