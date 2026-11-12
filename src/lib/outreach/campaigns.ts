import { isLeadStatus, normalizeEmail, plainField, type LeadStatus } from "./prospects.ts";

export const campaignVariables = ["business_name", "city"] as const;

export type CampaignFilters = {
  leadStatus: "" | Exclude<LeadStatus, "suppressed">;
  category: string;
  location: string;
  source: string;
};

export type CampaignDraft = {
  name: string;
  subject: string;
  body: string;
  senderName: string;
  senderEmail: string;
  physicalAddress: string;
  unsubscribeFooter: string;
  filters: CampaignFilters;
};

export type AudienceProspect = {
  id: string;
  businessName: string;
  category: string;
  location: string;
  contactEmail: string;
  source: string;
  leadStatus: string;
};

const filterStatuses = new Set(["", "new", "contacted", "interested", "not_interested"]);

export function campaignText(value: string, max: number) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n")
    .map((line) => line.replace(/^[=+\-@\t]+/, "").trimEnd())
    .join("\n")
    .trim()
    .slice(0, max);
}

export function readCampaignFilters(input: { leadStatus?: string; category?: string; location?: string; source?: string }): CampaignFilters {
  const requested = plainField(input.leadStatus ?? "", 40).toLowerCase();
  return {
    leadStatus: filterStatuses.has(requested) && requested !== "suppressed" && (requested === "" || isLeadStatus(requested))
      ? (requested as CampaignFilters["leadStatus"])
      : "",
    category: plainField(input.category ?? "", 80),
    location: plainField(input.location ?? "", 120),
    source: plainField(input.source ?? "", 80),
  };
}

export function readCampaignDraft(input: {
  name?: string;
  subject?: string;
  body?: string;
  senderName?: string;
  senderEmail?: string;
  physicalAddress?: string;
  unsubscribeFooter?: string;
  leadStatus?: string;
  category?: string;
  location?: string;
  source?: string;
}): { draft: CampaignDraft; error: string } {
  const draft: CampaignDraft = {
    name: plainField(input.name ?? "", 120),
    subject: plainField(input.subject ?? "", 160),
    body: campaignText(input.body ?? "", 8000),
    senderName: plainField(input.senderName ?? "", 80),
    senderEmail: normalizeEmail(input.senderEmail ?? ""),
    physicalAddress: plainField(input.physicalAddress ?? "", 300),
    unsubscribeFooter: campaignText(input.unsubscribeFooter ?? "", 500),
    filters: readCampaignFilters(input),
  };
  if (!draft.name) return { draft, error: "A campaign needs a name." };
  if (!draft.subject) return { draft, error: "A campaign needs an email subject." };
  if (!draft.body) return { draft, error: "A campaign needs an email body." };
  if ((input.senderEmail ?? "").trim() && !draft.senderEmail) return { draft, error: "Sender email is not valid." };
  return { draft, error: "" };
}

export function campaignCompliance(campaign: Pick<CampaignDraft, "senderName" | "senderEmail" | "physicalAddress" | "unsubscribeFooter">) {
  const missing: string[] = [];
  if (campaign.senderName.length < 2) missing.push("sender name");
  if (!normalizeEmail(campaign.senderEmail)) missing.push("sender email");
  if (campaign.physicalAddress.length < 12 || !/\d/.test(campaign.physicalAddress)) missing.push("physical mailing address");
  if (!/unsubscribe/i.test(campaign.unsubscribeFooter)) missing.push("unsubscribe footer");
  return missing;
}

export function personalizeCampaign(template: string, prospect: Pick<AudienceProspect, "businessName" | "location">) {
  const values: Record<string, string> = {
    business_name: prospect.businessName,
    city: prospect.location,
  };
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, key: string) => (key in values ? values[key] : match));
}

export function escapeCampaignText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function previewCampaign(campaign: CampaignDraft, prospect: AudienceProspect) {
  const missing = campaignCompliance(campaign);
  const subject = personalizeCampaign(campaign.subject, prospect);
  const body = personalizeCampaign(campaign.body, prospect);
  const footer = [
    campaign.senderName,
    campaign.senderEmail,
    campaign.physicalAddress,
    campaign.unsubscribeFooter,
  ].join("\n");
  return {
    ready: missing.length === 0,
    missing,
    subject,
    body,
    footer: missing.length === 0 ? footer : "",
  };
}

function textValue(value: string | null | undefined) {
  return (value ?? "").toLowerCase();
}

export function prospectMatchesFilters(prospect: AudienceProspect, filters: CampaignFilters) {
  if (prospect.leadStatus === "suppressed") return false;
  if (filters.leadStatus && prospect.leadStatus !== filters.leadStatus) return false;
  const category = textValue(prospect.category);
  const location = textValue(prospect.location);
  const source = textValue(prospect.source);
  if (filters.category && !category.includes(filters.category.toLowerCase())) return false;
  if (filters.location && !location.includes(filters.location.toLowerCase())) return false;
  if (filters.source && !source.includes(filters.source.toLowerCase())) return false;
  return true;
}

export function eligibleRecipients(prospects: AudienceProspect[], filters: CampaignFilters, suppressedEmails: string[]) {
  const blocked = new Set(suppressedEmails.map((email) => normalizeEmail(email)).filter(Boolean));
  return prospects.filter((prospect) => {
    if (!prospectMatchesFilters(prospect, filters)) return false;
    const email = normalizeEmail(prospect.contactEmail);
    if (!email || blocked.has(email)) return false;
    return true;
  });
}
