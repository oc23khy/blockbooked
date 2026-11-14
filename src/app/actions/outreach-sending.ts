"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { readAllPages } from "@/lib/admin/read-all";
import { type AudienceProspect, type CampaignDraft } from "@/lib/outreach/campaigns";
import { isLeadStatus } from "@/lib/outreach/prospects";
import {
  buildSendPlan,
  confirmationMatches,
  DEFAULT_OUTREACH_DAILY_LIMIT,
  DEFAULT_OUTREACH_PER_MINUTE_LIMIT,
  readOutreachLimits,
} from "@/lib/outreach/sending";
import { redirectIfRateLimited } from "@/lib/rate-limit";
import { requireAdmin } from "@/lib/session";

function sendError(path: string, message: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);
}

function reviewPath(campaignId: string) {
  return `/admin/outreach/campaigns/${campaignId}/review`;
}

type LoadedAudience = {
  draft: CampaignDraft;
  name: string;
  audience: AudienceProspect[];
  suppressed: string[];
};

function isLoadedAudience(value: LoadedAudience | { error: string }): value is LoadedAudience {
  return "draft" in value;
}

async function loadAudience(supabase: Awaited<ReturnType<typeof requireAdmin>>["supabase"], campaignId: string): Promise<LoadedAudience | { error: string }> {
  const campaign = await supabase.from("outreach_campaigns").select("*").eq("id", campaignId).eq("campaign_status", "draft").maybeSingle();
  if (campaign.error || !campaign.data) return { error: campaign.error?.message || "That campaign could not be found." };
  const row = campaign.data as {
    name: string;
    subject: string;
    body: string;
    sender_name: string;
    sender_email: string;
    physical_address: string;
    unsubscribe_footer: string;
    filter_lead_status: string;
    filter_category: string;
    filter_location: string;
    filter_source: string;
  };
  const status = row.filter_lead_status === "suppressed" || !isLeadStatus(row.filter_lead_status) ? "" : row.filter_lead_status;
  const draft: CampaignDraft = {
    name: row.name,
    subject: row.subject,
    body: row.body,
    senderName: row.sender_name || "",
    senderEmail: row.sender_email || "",
    physicalAddress: row.physical_address || "",
    unsubscribeFooter: row.unsubscribe_footer || "",
    filters: {
      leadStatus: status as CampaignDraft["filters"]["leadStatus"],
      category: row.filter_category || "",
      location: row.filter_location || "",
      source: row.filter_source || "",
    },
  };
  const [prospects, suppressions] = await Promise.all([
    readAllPages<{ id: string; business_name: string; category: string; location: string; contact_email: string; source: string; lead_status: string }>((from, to) =>
      supabase
        .from("outreach_prospects")
        .select("id, business_name, category, location, contact_email, source, lead_status")
        .order("id", { ascending: true })
        .range(from, to),
    ),
    readAllPages<{ id: string; normalized_email: string }>((from, to) =>
      supabase.from("outreach_suppressions").select("id, normalized_email").order("id", { ascending: true }).range(from, to),
    ),
  ]);
  if (prospects.error || suppressions.error) return { error: prospects.error || suppressions.error || "The audience could not be read." };
  const audience: AudienceProspect[] = prospects.rows.map((prospect) => ({
    id: prospect.id,
    businessName: prospect.business_name,
    category: prospect.category,
    location: prospect.location,
    contactEmail: prospect.contact_email,
    source: prospect.source,
    leadStatus: prospect.lead_status,
  }));
  return { draft, name: row.name, audience, suppressed: suppressions.rows.map((item) => item.normalized_email) };
}

export async function saveOutreachSendQueue(formData: FormData) {
  const campaignId = String(formData.get("campaignId") ?? "");
  const path = reviewPath(campaignId);
  const session = await requireAdmin(path);
  if (!/^[0-9a-f-]{36}$/i.test(campaignId)) sendError("/admin/outreach/campaigns", "That campaign could not be reviewed.");
  await redirectIfRateLimited("outreachSend", session.user.id, path);
  const loaded = await loadAudience(session.supabase, campaignId);
  if (!isLoadedAudience(loaded)) sendError(path, "The audience could not be read.");
  const settings = await session.supabase.from("outreach_send_settings").select("daily_limit, per_minute_limit, sending_enabled").eq("id", true).maybeSingle();
  const dailyLimit = settings.data?.daily_limit ?? DEFAULT_OUTREACH_DAILY_LIMIT;
  const perMinuteLimit = settings.data?.per_minute_limit ?? DEFAULT_OUTREACH_PER_MINUTE_LIMIT;
  const plan = buildSendPlan({
    campaignId,
    campaign: loaded.draft,
    prospects: loaded.audience,
    suppressedEmails: loaded.suppressed,
    sentToday: 0,
    sentThisMinute: 0,
    dailyLimit,
    perMinuteLimit,
  });
  if (!plan.sendable) sendError(path, "Add the missing sender details before saving a queue.");
  if (plan.queued.length === 0) sendError(path, "No eligible recipient is left to queue.");
  const existing = await session.supabase.from("outreach_send_jobs").select("id").eq("campaign_id", campaignId).limit(1).maybeSingle();
  if (existing.error) sendError(path, "The send queue could not be saved.");
  if (existing.data) redirect(`${path}?notice=Review%20saved`);
  const saved = await session.supabase.rpc("create_outreach_send_queue", {
    target_campaign: campaignId,
    recipient_count: plan.queued.length,
    suppressed_count: plan.suppressed,
    invalid_count: plan.invalid,
    duplicate_count: plan.duplicates,
    allowed_count: plan.allowedNow,
    recipients: plan.queued.map((recipient) => ({
      prospect_id: recipient.prospectId,
      normalized_email: recipient.email,
      personalized_subject: recipient.subject,
      personalized_body: recipient.body,
      idempotency_key: recipient.idempotencyKey,
    })),
  });
  const outcome = queueFailure(saved.error);
  if (outcome === "saved") redirect(`${path}?notice=Review%20saved`);
  if (outcome === "sendable") sendError(path, "Add the missing sender details before saving a queue.");
  if (saved.error || !saved.data) sendError(path, "The send queue could not be saved.");
  revalidatePath(path);
  redirect(`${path}?notice=Review%20saved`);
}

export async function confirmOutreachSendQueue(formData: FormData) {
  const campaignId = String(formData.get("campaignId") ?? "");
  const jobId = String(formData.get("jobId") ?? "");
  const path = reviewPath(campaignId);
  const session = await requireAdmin(path);
  if (!/^[0-9a-f-]{36}$/i.test(campaignId) || !/^[0-9a-f-]{36}$/i.test(jobId)) sendError(path, "That send queue could not be confirmed.");
  await redirectIfRateLimited("outreachSend", session.user.id, path);
  const loaded = await loadAudience(session.supabase, campaignId);
  if (!isLoadedAudience(loaded)) sendError(path, "That campaign could not be found.");
  const phrase = String(formData.get("confirmation") ?? "");
  if (!confirmationMatches(loaded.name, phrase)) {
    sendError(path, "Type the campaign name to confirm. Nothing was sent.");
  }
  const confirmed = await session.supabase.rpc("confirm_outreach_send_queue", {
    target_campaign: campaignId,
    target_job: jobId,
    confirmation: phrase,
  });
  if (queueFailure(confirmed.error) === "confirmation") sendError(path, "Type the campaign name to confirm. Nothing was sent.");
  if (confirmed.error || confirmed.data !== "blocked") sendError(path, "That send queue could not be confirmed. Nothing was sent.");
  revalidatePath(path);
  redirect(`${path}?notice=Confirmation%20recorded.%20No%20email%20was%20sent.`);
}

export async function updateOutreachSendLimits(formData: FormData) {
  const campaignId = String(formData.get("campaignId") ?? "");
  const path = /^[0-9a-f-]{36}$/i.test(campaignId) ? reviewPath(campaignId) : "/admin/outreach/campaigns";
  const session = await requireAdmin(path);
  await redirectIfRateLimited("outreachSend", session.user.id, path);
  const limits = readOutreachLimits(String(formData.get("dailyLimit") ?? ""), String(formData.get("perMinuteLimit") ?? ""));
  if (!limits) sendError(path, "Daily limit is 1 to 500. Per-minute limit is 1 to 30.");
  const updated = await session.supabase
    .from("outreach_send_settings")
    .update({ daily_limit: limits.dailyLimit, per_minute_limit: limits.perMinuteLimit })
    .eq("id", true)
    .select("id")
    .maybeSingle();
  if (updated.error || !updated.data) sendError(path, "The sending limits could not be saved.");
  revalidatePath(path);
  redirect(`${path}?notice=Limits%20saved.%20Sending%20stays%20off.`);
}

function queueFailure(error: { code?: string; message?: string; details?: string } | null) {
  if (!error) return "";
  const text = `${error.message} ${error.details ?? ""}`;
  if ((error.code === "23505" && text.includes("outreach_send_jobs_one_campaign")) || text.includes("Outreach send queue already exists")) return "saved";
  if (text.includes("Outreach campaign is not sendable")) return "sendable";
  if (text.includes("Outreach confirmation does not match")) return "confirmation";
  return "unavailable";
}

export async function retryOutreachSendQueue(formData: FormData) {
  const campaignId = String(formData.get("campaignId") ?? "");
  const jobId = String(formData.get("jobId") ?? "");
  const path = reviewPath(campaignId);
  const session = await requireAdmin(path);
  if (!/^[0-9a-f-]{36}$/i.test(campaignId) || !/^[0-9a-f-]{36}$/i.test(jobId)) sendError(path, "That send queue could not be retried.");
  await redirectIfRateLimited("outreachSend", session.user.id, path);
  const retried = await session.supabase.rpc("retry_outreach_send_queue", {
    target_campaign: campaignId,
    target_job: jobId,
  });
  if (retried.error || (retried.data !== "blocked" && retried.data !== "exhausted")) {
    sendError(path, "That send queue could not be retried. Nothing was sent.");
  }
  revalidatePath(path);
  redirect(`${path}?notice=${retried.data === "exhausted" ? "Retry%20limit%20reached.%20No%20email%20was%20sent." : "Retry%20recorded.%20No%20email%20was%20sent."}`);
}
