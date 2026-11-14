import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { confirmOutreachSendQueue, retryOutreachSendQueue, saveOutreachSendQueue, updateOutreachSendLimits } from "@/app/actions/outreach-sending";
import { readAllPages } from "@/lib/admin/read-all";
import { campaignCompliance, type AudienceProspect, type CampaignDraft } from "@/lib/outreach/campaigns";
import { isLeadStatus } from "@/lib/outreach/prospects";
import {
  buildSendPlan,
  DEFAULT_OUTREACH_DAILY_LIMIT,
  DEFAULT_OUTREACH_PER_MINUTE_LIMIT,
  outreachSendingEnabled,
} from "@/lib/outreach/sending";
import { shownError } from "@/lib/public-error";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Review campaign send · BlockBooked" };
export const dynamic = "force-dynamic";

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
};

type JobRow = {
  id: string;
  status: string;
  recipient_count: number;
  suppressed_count: number;
  invalid_count: number;
  duplicate_count: number;
  allowed_count: number;
  block_reason: string;
};

function draftFromRow(row: CampaignRow): CampaignDraft {
  const status = row.filter_lead_status === "suppressed" || !isLeadStatus(row.filter_lead_status) ? "" : row.filter_lead_status;
  return {
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
}

export default async function ReviewOutreachSendPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { supabase } = await requireAdmin(`/admin/outreach/campaigns/${id}/review`);
  const campaign = await supabase.from("outreach_campaigns").select("*").eq("id", id).eq("campaign_status", "draft").maybeSingle();
  if (campaign.error) {
    return <main><p className="text-sm font-medium text-accent-dark">{shownError(campaign.error.message)}</p></main>;
  }
  if (!campaign.data) notFound();
  const row = campaign.data as CampaignRow;
  const draft = draftFromRow(row);
  const [prospects, suppressions, settings, job] = await Promise.all([
    readAllPages<{ id: string; business_name: string; category: string; location: string; contact_email: string; source: string; lead_status: string }>((from, to) =>
      supabase.from("outreach_prospects").select("id, business_name, category, location, contact_email, source, lead_status").order("id", { ascending: true }).range(from, to),
    ),
    readAllPages<{ id: string; normalized_email: string }>((from, to) =>
      supabase.from("outreach_suppressions").select("id, normalized_email").order("id", { ascending: true }).range(from, to),
    ),
    supabase.from("outreach_send_settings").select("daily_limit, per_minute_limit, sending_enabled").eq("id", true).maybeSingle(),
    supabase.from("outreach_send_jobs").select("id, status, recipient_count, suppressed_count, invalid_count, duplicate_count, allowed_count, block_reason").eq("campaign_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
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
  const dailyLimit = settings.data?.daily_limit ?? DEFAULT_OUTREACH_DAILY_LIMIT;
  const perMinuteLimit = settings.data?.per_minute_limit ?? DEFAULT_OUTREACH_PER_MINUTE_LIMIT;
  const plan = prospects.error || suppressions.error
    ? null
    : buildSendPlan({
        campaignId: id,
        campaign: draft,
        prospects: audience,
        suppressedEmails: suppressions.rows.map((item) => item.normalized_email),
        sentToday: 0,
        sentThisMinute: 0,
        dailyLimit,
        perMinuteLimit,
      });
  const missing = campaignCompliance(draft);
  const sendingOn = outreachSendingEnabled(process.env.OUTREACH_SENDING_ENABLED, settings.data?.sending_enabled === true);
  const saved = (job.data ?? null) as JobRow | null;

  return (
    <main>
      <p className="text-sm font-semibold text-ink/60">
        <Link href={`/admin/outreach/campaigns/${id}`} className="underline decoration-line underline-offset-2">Back to draft</Link>
      </p>
      <h1 className="mt-2 font-serif text-4xl tracking-tight text-ink">Review send queue</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-ink/70">
        {row.name}. Sending is {sendingOn ? "on" : "off"}. This screen does not send email.
      </p>
      {query.notice ? <p className="mt-4 text-sm font-medium text-ink">{query.notice}</p> : null}
      {shownError(query.error || prospects.error || suppressions.error || settings.error?.message || job.error?.message) ? (
        <p className="mt-4 text-sm font-medium text-accent-dark">{shownError(query.error || prospects.error || suppressions.error || settings.error?.message || job.error?.message)}</p>
      ) : null}
      {missing.length > 0 ? <p className="mt-4 text-sm text-accent-dark">Required before a queue can be saved: {missing.join(", ")}.</p> : null}
      {plan ? (
        <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-2xl border border-line bg-card p-3"><dt className="text-xs text-ink/60">Would queue</dt><dd className="font-serif text-3xl text-ink">{plan.queued.length}</dd></div>
          <div className="rounded-2xl border border-line bg-card p-3"><dt className="text-xs text-ink/60">Allowed now</dt><dd className="font-serif text-3xl text-ink">{plan.allowedNow}</dd></div>
          <div className="rounded-2xl border border-line bg-card p-3"><dt className="text-xs text-ink/60">Suppressed</dt><dd className="font-serif text-3xl text-ink">{plan.suppressed}</dd></div>
          <div className="rounded-2xl border border-line bg-card p-3"><dt className="text-xs text-ink/60">Invalid or duplicate</dt><dd className="font-serif text-3xl text-ink">{plan.invalid + plan.duplicates}</dd></div>
        </dl>
      ) : null}
      {plan && plan.queued.length > 0 ? (
        <ul className="mt-4 divide-y divide-line rounded-2xl border border-line bg-card">
          {plan.queued.slice(0, 40).map((recipient) => (
            <li key={recipient.idempotencyKey} className="px-3 py-2 text-sm text-ink">
              <span className="font-semibold">{recipient.subject}</span>
              <span className="mt-1 block text-ink/70">{recipient.email}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <form action={updateOutreachSendLimits} className="mt-6 flex flex-wrap items-end gap-3">
        <input type="hidden" name="campaignId" value={id} />
        <label className="text-sm font-medium text-ink">Daily limit
          <input name="dailyLimit" type="number" min={1} max={500} defaultValue={dailyLimit} className="mt-1 block w-28 rounded-xl border border-line bg-sand px-3 py-2" />
        </label>
        <label className="text-sm font-medium text-ink">Per minute
          <input name="perMinuteLimit" type="number" min={1} max={30} defaultValue={perMinuteLimit} className="mt-1 block w-28 rounded-xl border border-line bg-sand px-3 py-2" />
        </label>
        <button type="submit" className="rounded-full border border-ink px-4 py-2 text-sm font-semibold text-ink">Save limits</button>
      </form>
      {plan?.sendable && !saved ? (
        <form action={saveOutreachSendQueue} className="mt-4">
          <input type="hidden" name="campaignId" value={id} />
          <button type="submit" className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">Save queue</button>
        </form>
      ) : null}
      {saved && saved.status === "review" ? (
        <form action={confirmOutreachSendQueue} className="mt-4 max-w-md">
          <input type="hidden" name="campaignId" value={id} />
          <input type="hidden" name="jobId" value={saved.id} />
          <label className="block text-sm font-medium text-ink">Type “{row.name}” to confirm. This still will not send.
            <input name="confirmation" className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2" />
          </label>
          <button type="submit" className="mt-3 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">Confirm queue</button>
        </form>
      ) : null}
      {saved && saved.status !== "review" && saved.status !== "blocked" ? (
        <p className="mt-4 text-sm text-ink/70">Queue {saved.status}. {saved.recipient_count} saved recipients.</p>
      ) : null}
      {saved && saved.status === "blocked" ? (
        <div className="mt-4">
          <p className="text-sm text-ink/70">Queue {saved.status}. {saved.recipient_count} saved recipients. {saved.block_reason ? `Stopped: ${saved.block_reason}.` : ""}</p>
          <form action={retryOutreachSendQueue} className="mt-3">
            <input type="hidden" name="campaignId" value={id} />
            <input type="hidden" name="jobId" value={saved.id} />
            <button type="submit" className="rounded-full border border-ink px-4 py-2 text-sm font-semibold text-ink">Record a blocked retry</button>
          </form>
        </div>
      ) : null}
    </main>
  );
}
