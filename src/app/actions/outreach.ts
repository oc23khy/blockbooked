"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { readAllPages } from "@/lib/admin/read-all";
import {
  classifyProspectCsv,
  classifyProspects,
  duplicateKeys,
  isLeadStatus,
  normalizeEmail,
  plainField,
  type ClassifiedProspect,
  type LeadStatus,
} from "@/lib/outreach/prospects";
import { customerFacingError } from "@/lib/public-error";
import { redirectIfRateLimited } from "@/lib/rate-limit";
import { requireAdmin } from "@/lib/session";

export type OutreachPreviewState = {
  message: string;
  rows: ClassifiedProspect[];
};

type ExistingProspect = {
  id: string;
  normalized_email: string;
  normalized_website: string;
  normalized_name: string;
  normalized_location: string;
};

function outreachError(path: string, message: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);
}

async function existingKeys(supabase: Awaited<ReturnType<typeof requireAdmin>>["supabase"]) {
  const [prospects, suppressions] = await Promise.all([
    readAllPages<ExistingProspect>((from, to) =>
      supabase
        .from("outreach_prospects")
        .select("id, normalized_email, normalized_website, normalized_name, normalized_location")
        .order("id", { ascending: true })
        .range(from, to),
    ),
    readAllPages<{ id: string; normalized_email: string }>((from, to) =>
      supabase.from("outreach_suppressions").select("id, normalized_email").order("id", { ascending: true }).range(from, to),
    ),
  ]);
  if (prospects.error || suppressions.error) return { error: "The current prospect list could not be checked.", keys: [] as string[], suppressed: [] as string[] };
  return {
    error: "",
    keys: prospects.rows.flatMap((row) =>
      duplicateKeys({
        email: row.normalized_email,
        website: row.normalized_website,
        name: row.normalized_name,
        location: row.normalized_location,
      }),
    ),
    suppressed: suppressions.rows.map((row) => row.normalized_email),
  };
}

export async function reviewOutreachImport(_current: OutreachPreviewState, formData: FormData): Promise<OutreachPreviewState> {
  const session = await requireAdmin("/admin/outreach");
  await redirectIfRateLimited("outreachWrite", session.user.id, "/admin/outreach");
  const csv = String(formData.get("csv") ?? "");
  const intent = String(formData.get("intent") ?? "preview");
  const known = await existingKeys(session.supabase);
  if (known.error) return { message: known.error, rows: [] };
  const classified = classifyProspectCsv({ csv, existingKeys: known.keys, suppressedEmails: known.suppressed });
  if (classified.error) return { message: classified.error, rows: [] };
  if (intent !== "import") return { message: "", rows: classified.rows };

  const ready = classified.rows.filter((row) => row.outcome === "ready");
  if (ready.length === 0) return { message: "No new prospects are ready to import.", rows: classified.rows };
  let imported = 0;
  let failure = "";
  for (const row of ready) {
    const inserted = await session.supabase.from("outreach_prospects").insert({
      business_name: row.businessName,
      category: row.category,
      location: row.location,
      website: row.normalizedWebsite,
      contact_email: row.normalizedEmail,
      source: row.source,
      lead_status: row.leadStatus,
    });
    if (inserted.error) failure = customerFacingError(inserted.error.message, "A ready prospect could not be saved.");
    else imported += 1;
  }
  revalidatePath("/admin/outreach");
  if (imported === 0) redirect(`/admin/outreach?error=${encodeURIComponent(failure || "A ready prospect could not be saved.")}`);
  redirect(`/admin/outreach?notice=${encodeURIComponent(`Imported ${imported} of ${ready.length} ready prospects.`)}`);
}

export async function addOutreachProspect(formData: FormData) {
  const session = await requireAdmin("/admin/outreach");
  await redirectIfRateLimited("outreachWrite", session.user.id, "/admin/outreach");
  const status = plainField(String(formData.get("leadStatus") ?? "new"), 40).toLowerCase();
  const known = await existingKeys(session.supabase);
  if (known.error) outreachError("/admin/outreach", known.error);
  const [row] = classifyProspects({
    drafts: [
      {
        line: 1,
        businessName: plainField(String(formData.get("businessName") ?? ""), 120),
        category: plainField(String(formData.get("category") ?? ""), 80),
        location: plainField(String(formData.get("location") ?? ""), 120),
        website: plainField(String(formData.get("website") ?? ""), 200),
        contactEmail: plainField(String(formData.get("contactEmail") ?? ""), 320),
        source: plainField(String(formData.get("source") ?? ""), 80),
        leadStatus: isLeadStatus(status) ? status : "new",
        invalidStatus: Boolean(status) && !isLeadStatus(status),
      },
    ],
    existingKeys: known.keys,
    suppressedEmails: known.suppressed,
  });
  if (!row || row.outcome !== "ready") {
    outreachError("/admin/outreach", row?.reason || "That prospect could not be added.");
  }
  const inserted = await session.supabase.from("outreach_prospects").insert({
    business_name: row.businessName,
    category: row.category,
    location: row.location,
    website: row.normalizedWebsite,
    contact_email: row.normalizedEmail,
    source: row.source,
    lead_status: row.leadStatus,
  });
  if (inserted.error) outreachError("/admin/outreach", customerFacingError(inserted.error.message, "That prospect could not be added."));
  revalidatePath("/admin/outreach");
  redirect("/admin/outreach?notice=Prospect%20added");
}

export async function updateOutreachStatus(formData: FormData) {
  const session = await requireAdmin("/admin/outreach");
  await redirectIfRateLimited("outreachWrite", session.user.id, "/admin/outreach");
  const prospectId = String(formData.get("prospectId") ?? "");
  const leadStatus = String(formData.get("leadStatus") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(prospectId) || !isLeadStatus(leadStatus)) {
    outreachError("/admin/outreach", "That status could not be saved.");
  }
  const current = await session.supabase.from("outreach_prospects").select("normalized_email").eq("id", prospectId).maybeSingle();
  if (current.error || !current.data) outreachError("/admin/outreach", "That prospect could not be updated.");
  const email = String(current.data.normalized_email ?? "");
  if (email && leadStatus !== "suppressed") {
    const blocked = await session.supabase.from("outreach_suppressions").select("id").eq("normalized_email", email).maybeSingle();
    if (blocked.data) outreachError("/admin/outreach", "That email is opted out. Remove the suppression before changing its status.");
  }
  const updated = await session.supabase.from("outreach_prospects").update({ lead_status: leadStatus satisfies LeadStatus }).eq("id", prospectId);
  if (updated.error) outreachError("/admin/outreach", customerFacingError(updated.error.message, "That status could not be saved."));
  revalidatePath("/admin/outreach");
  redirect("/admin/outreach?notice=Status%20updated");
}

export async function addOutreachSuppression(formData: FormData) {
  const session = await requireAdmin("/admin/outreach");
  await redirectIfRateLimited("outreachWrite", session.user.id, "/admin/outreach");
  const email = normalizeEmail(String(formData.get("email") ?? ""));
  const reason = plainField(String(formData.get("reason") ?? "opt_out"), 160) || "opt_out";
  if (!email) outreachError("/admin/outreach", "Enter the email address that opted out.");
  const inserted = await session.supabase.from("outreach_suppressions").insert({ normalized_email: email, reason });
  if (inserted.error) outreachError("/admin/outreach", customerFacingError(inserted.error.message, "That suppression could not be saved."));
  revalidatePath("/admin/outreach");
  redirect("/admin/outreach?notice=Suppression%20saved");
}

export async function removeOutreachSuppression(formData: FormData) {
  const session = await requireAdmin("/admin/outreach");
  await redirectIfRateLimited("outreachWrite", session.user.id, "/admin/outreach");
  const suppressionId = String(formData.get("suppressionId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(suppressionId)) outreachError("/admin/outreach", "That suppression could not be removed.");
  const removed = await session.supabase.from("outreach_suppressions").delete().eq("id", suppressionId);
  if (removed.error) outreachError("/admin/outreach", customerFacingError(removed.error.message, "That suppression could not be removed."));
  revalidatePath("/admin/outreach");
  redirect("/admin/outreach?notice=Suppression%20removed.%20Matching%20prospects%20stay%20suppressed%20until%20you%20change%20them.");
}
