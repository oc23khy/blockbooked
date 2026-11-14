import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteOutreachCampaign, updateOutreachCampaign } from "@/app/actions/outreach-campaigns";
import { CampaignFields } from "@/components/campaign-fields";
import { readAllPages } from "@/lib/admin/read-all";
import {
  campaignCompliance,
  eligibleRecipients,
  previewCampaign,
  type AudienceProspect,
  type CampaignDraft,
} from "@/lib/outreach/campaigns";
import { isLeadStatus } from "@/lib/outreach/prospects";
import { shownError } from "@/lib/public-error";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Edit campaign · BlockBooked" };

type CampaignRow = {
  id: string;
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
  campaign_status: string;
};

type ProspectRow = {
  id: string;
  business_name: string;
  category: string;
  location: string;
  contact_email: string;
  source: string;
  lead_status: string;
};

function draftFromRow(row: CampaignRow): CampaignDraft {
  const status = row.filter_lead_status === "suppressed" || !isLeadStatus(row.filter_lead_status) ? "" : row.filter_lead_status;
  return {
    name: row.name,
    subject: row.subject,
    body: row.body,
    senderName: row.sender_name,
    senderEmail: row.sender_email,
    physicalAddress: row.physical_address,
    unsubscribeFooter: row.unsubscribe_footer,
    filters: {
      leadStatus: status as CampaignDraft["filters"]["leadStatus"],
      category: row.filter_category,
      location: row.filter_location,
      source: row.filter_source,
    },
  };
}

export default async function EditOutreachCampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string; error?: string; prospect?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { supabase } = await requireAdmin(`/admin/outreach/campaigns/${id}`);
  const campaign = await supabase.from("outreach_campaigns").select("*").eq("id", id).eq("campaign_status", "draft").maybeSingle();
  if (campaign.error) {
    return (
      <main>
        <p className="text-sm font-medium text-accent-dark">{shownError(campaign.error.message)}</p>
      </main>
    );
  }
  if (!campaign.data) notFound();
  const row = campaign.data as CampaignRow;
  const draft = draftFromRow(row);
  const [prospects, suppressions] = await Promise.all([
    readAllPages<ProspectRow>((from, to) =>
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
  const audience: AudienceProspect[] = (prospects.rows ?? []).map((prospect) => ({
    id: prospect.id,
    businessName: prospect.business_name,
    category: prospect.category,
    location: prospect.location,
    contactEmail: prospect.contact_email,
    source: prospect.source,
    leadStatus: prospect.lead_status,
  }));
  const eligible = prospects.error || suppressions.error
    ? []
    : eligibleRecipients(audience, draft.filters, suppressions.rows.map((item) => item.normalized_email));
  const selected = eligible.find((prospect) => prospect.id === query.prospect) ?? eligible[0] ?? null;
  const preview = selected ? previewCampaign(draft, selected) : null;
  const missing = campaignCompliance(draft);

  return (
    <main>
      <p className="text-sm font-semibold text-ink/60">
        <Link href="/admin/outreach/campaigns" className="underline decoration-line underline-offset-2">Campaign drafts</Link>
      </p>
      <h1 className="mt-2 font-serif text-4xl tracking-tight text-ink">{row.name}</h1>
      <p className="mt-2 text-sm text-ink/70">
        {eligible.length} eligible recipients. Sending is not available.{" "}
        <Link href={`/admin/outreach/campaigns/${row.id}/review`} className="font-semibold text-ink underline decoration-line underline-offset-2">Review the send queue</Link>
      </p>
      {query.notice ? <p className="mt-4 text-sm font-medium text-ink">{query.notice}</p> : null}
      {shownError(query.error || prospects.error || suppressions.error) ? (
        <p className="mt-4 text-sm font-medium text-accent-dark">{shownError(query.error || prospects.error || suppressions.error)}</p>
      ) : null}
      <div className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <form action={updateOutreachCampaign} className="rounded-3xl border border-line bg-card p-4">
          <input type="hidden" name="campaignId" value={row.id} />
          <CampaignFields
            values={{
              name: draft.name,
              subject: draft.subject,
              body: draft.body,
              senderName: draft.senderName,
              senderEmail: draft.senderEmail,
              physicalAddress: draft.physicalAddress,
              unsubscribeFooter: draft.unsubscribeFooter,
              leadStatus: draft.filters.leadStatus,
              category: draft.filters.category,
              location: draft.filters.location,
              source: draft.filters.source,
            }}
          />
          <button type="submit" className="mt-4 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">Save draft</button>
        </form>
        <section className="rounded-3xl border border-line bg-card p-4">
          <h2 className="font-serif text-2xl text-ink">Preview</h2>
          {eligible.length === 0 ? <p className="mt-2 text-sm text-ink/70">No eligible recipient matches these filters.</p> : null}
          {eligible.length > 0 ? (
            <form method="get" className="mt-3 flex gap-2">
              <select name="prospect" defaultValue={selected?.id ?? ""} className="min-w-0 flex-1 rounded-xl border border-line bg-sand px-3 py-2 text-sm">
                {eligible.map((prospect) => (
                  <option key={prospect.id} value={prospect.id}>{prospect.businessName}</option>
                ))}
              </select>
              <button type="submit" className="rounded-full border border-ink px-3 py-2 text-sm font-semibold text-ink">Show</button>
            </form>
          ) : null}
          {missing.length > 0 ? (
            <p className="mt-3 text-sm text-accent-dark">Add {missing.join(", ")} before this preview can include a sendable footer.</p>
          ) : null}
          {preview ? (
            <div className="mt-4 rounded-2xl border border-line bg-sand p-3 text-sm text-ink">
              <p className="font-semibold">{preview.subject}</p>
              <p className="mt-3 whitespace-pre-wrap leading-6">{preview.body}</p>
              {preview.ready ? <p className="mt-4 whitespace-pre-wrap border-t border-line pt-3 text-ink/70">{preview.footer}</p> : null}
            </div>
          ) : null}
          <form action={deleteOutreachCampaign} className="mt-4">
            <input type="hidden" name="campaignId" value={row.id} />
            <button type="submit" className="rounded-full border border-ink px-4 py-2 text-sm font-semibold text-ink">Delete draft</button>
          </form>
        </section>
      </div>
    </main>
  );
}
