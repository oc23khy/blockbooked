"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { readCampaignDraft } from "@/lib/outreach/campaigns";
import { customerFacingError } from "@/lib/public-error";
import { redirectIfRateLimited } from "@/lib/rate-limit";
import { requireAdmin } from "@/lib/session";

function campaignError(path: string, message: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);
}

function draftFromForm(formData: FormData) {
  return readCampaignDraft({
    name: String(formData.get("name") ?? ""),
    subject: String(formData.get("subject") ?? ""),
    body: String(formData.get("body") ?? ""),
    senderName: String(formData.get("senderName") ?? ""),
    senderEmail: String(formData.get("senderEmail") ?? ""),
    physicalAddress: String(formData.get("physicalAddress") ?? ""),
    unsubscribeFooter: String(formData.get("unsubscribeFooter") ?? ""),
    leadStatus: String(formData.get("leadStatus") ?? ""),
    category: String(formData.get("category") ?? ""),
    location: String(formData.get("location") ?? ""),
    source: String(formData.get("source") ?? ""),
  });
}

function rowFromDraft(draft: ReturnType<typeof readCampaignDraft>["draft"]) {
  return {
    name: draft.name,
    subject: draft.subject,
    body: draft.body,
    sender_name: draft.senderName,
    sender_email: draft.senderEmail,
    physical_address: draft.physicalAddress,
    unsubscribe_footer: draft.unsubscribeFooter,
    filter_lead_status: draft.filters.leadStatus,
    filter_category: draft.filters.category,
    filter_location: draft.filters.location,
    filter_source: draft.filters.source,
    campaign_status: "draft",
  };
}

export async function createOutreachCampaign(formData: FormData) {
  const session = await requireAdmin("/admin/outreach/campaigns");
  await redirectIfRateLimited("outreachWrite", session.user.id, "/admin/outreach/campaigns");
  const { draft, error } = draftFromForm(formData);
  if (error) campaignError("/admin/outreach/campaigns", error);
  const inserted = await session.supabase.from("outreach_campaigns").insert(rowFromDraft(draft)).select("id").maybeSingle();
  if (inserted.error || !inserted.data) {
    campaignError("/admin/outreach/campaigns", customerFacingError(inserted.error?.message, "The campaign could not be saved."));
  }
  revalidatePath("/admin/outreach/campaigns");
  redirect(`/admin/outreach/campaigns/${inserted.data.id}?notice=Draft%20saved`);
}

export async function updateOutreachCampaign(formData: FormData) {
  const session = await requireAdmin("/admin/outreach/campaigns");
  const campaignId = String(formData.get("campaignId") ?? "");
  const path = `/admin/outreach/campaigns/${campaignId}`;
  if (!/^[0-9a-f-]{36}$/i.test(campaignId)) campaignError("/admin/outreach/campaigns", "That campaign could not be saved.");
  await redirectIfRateLimited("outreachWrite", session.user.id, path);
  const { draft, error } = draftFromForm(formData);
  if (error) campaignError(path, error);
  const updated = await session.supabase
    .from("outreach_campaigns")
    .update(rowFromDraft(draft))
    .eq("id", campaignId)
    .eq("campaign_status", "draft")
    .select("id")
    .maybeSingle();
  if (updated.error || !updated.data) campaignError(path, customerFacingError(updated.error?.message, "The campaign could not be saved."));
  revalidatePath(path);
  revalidatePath("/admin/outreach/campaigns");
  redirect(`${path}?notice=Draft%20saved`);
}

export async function deleteOutreachCampaign(formData: FormData) {
  const session = await requireAdmin("/admin/outreach/campaigns");
  await redirectIfRateLimited("outreachWrite", session.user.id, "/admin/outreach/campaigns");
  const campaignId = String(formData.get("campaignId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(campaignId)) campaignError("/admin/outreach/campaigns", "That campaign could not be deleted.");
  const removed = await session.supabase.from("outreach_campaigns").delete().eq("id", campaignId).eq("campaign_status", "draft").select("id");
  if (removed.error || !removed.data?.length) {
    campaignError("/admin/outreach/campaigns", customerFacingError(removed.error?.message, "That campaign could not be deleted."));
  }
  revalidatePath("/admin/outreach/campaigns");
  redirect("/admin/outreach/campaigns?notice=Draft%20deleted");
}
