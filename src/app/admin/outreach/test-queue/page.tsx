import type { Metadata } from "next";
import Link from "next/link";
import {
  confirmOutreachTestQueue,
  retryOutreachTestQueue,
  saveOutreachTestQueue,
  suppressOutreachTestRecipient,
} from "@/app/actions/outreach-test-queue";
import { buildTestQueuePlan, TEST_QUEUE_CAMPAIGN_ID, TEST_QUEUE_CAMPAIGN_NAME, type TestFixture } from "@/lib/outreach/test-queue";
import { shownError } from "@/lib/public-error";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Test outreach queue · BlockBooked" };
export const dynamic = "force-dynamic";

type JobRow = {
  id: string;
  status: string;
  recipient_count: number;
  suppressed_count: number;
  duplicate_count: number;
  block_reason: string;
};

export default async function OutreachTestQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const query = await searchParams;
  const { supabase } = await requireAdmin("/admin/outreach/test-queue");
  const [campaign, fixtures, suppressions, job] = await Promise.all([
    supabase.from("outreach_test_campaigns").select("id, name, subject, body").eq("name", TEST_QUEUE_CAMPAIGN_NAME).maybeSingle(),
    supabase.from("outreach_test_recipients_fixture").select("id, business_name, city, contact_email").order("business_name", { ascending: true }),
    supabase.from("outreach_test_suppressions").select("normalized_email"),
    supabase.from("outreach_test_jobs").select("id, status, recipient_count, suppressed_count, duplicate_count, block_reason").eq("test_campaign_id", TEST_QUEUE_CAMPAIGN_ID).limit(1).maybeSingle(),
  ]);
  const unavailable = campaign.error || fixtures.error || suppressions.error || job.error || !campaign.data;
  const rows: TestFixture[] = ((fixtures.data ?? []) as { id: string; business_name: string; city: string; contact_email: string }[]).map((row) => ({
    id: row.id,
    businessName: row.business_name,
    city: row.city,
    contactEmail: row.contact_email,
  }));
  const suppressed = new Set((suppressions.data ?? []).map((row) => row.normalized_email));
  const plan = campaign.data
    ? buildTestQueuePlan({
        campaignId: campaign.data.id,
        subject: campaign.data.subject,
        body: campaign.data.body,
        fixtures: rows,
        suppressedEmails: (suppressions.data ?? []).map((row) => row.normalized_email),
      })
    : null;
  const saved = (job.data ?? null) as JobRow | null;

  return (
    <main>
      <p className="text-sm font-semibold text-ink/60">
        <Link href="/admin/outreach" className="underline decoration-line underline-offset-2">Outreach</Link>
      </p>
      <h1 className="mt-2 font-serif text-4xl tracking-tight text-ink">Test queue</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-ink/70">
        This simulation uses only @example.com fixtures. It does not send email, and it does not read or change live prospects, suppressions, or campaign queues.
      </p>
      {query.notice ? <p className="mt-4 text-sm font-medium text-ink">{query.notice}</p> : null}
      {shownError(query.error || campaign.error?.message || fixtures.error?.message || suppressions.error?.message || job.error?.message) ? (
        <p className="mt-4 text-sm font-medium text-accent-dark">{shownError(query.error || campaign.error?.message || fixtures.error?.message || suppressions.error?.message || job.error?.message)}</p>
      ) : null}
      {unavailable ? <p className="mt-4 text-sm text-ink/70">The test queue is not available yet.</p> : null}
      {plan ? (
        <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-2xl border border-line bg-card p-3"><dt className="text-xs text-ink/60">Would queue</dt><dd className="font-serif text-3xl text-ink">{plan.queued.length}</dd></div>
          <div className="rounded-2xl border border-line bg-card p-3"><dt className="text-xs text-ink/60">Suppressed</dt><dd className="font-serif text-3xl text-ink">{plan.suppressed}</dd></div>
          <div className="rounded-2xl border border-line bg-card p-3"><dt className="text-xs text-ink/60">Duplicates</dt><dd className="font-serif text-3xl text-ink">{plan.duplicates}</dd></div>
          <div className="rounded-2xl border border-line bg-card p-3"><dt className="text-xs text-ink/60">Invalid</dt><dd className="font-serif text-3xl text-ink">{plan.invalid}</dd></div>
        </dl>
      ) : null}
      <ul className="mt-4 divide-y divide-line rounded-2xl border border-line bg-card">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm text-ink">
            <span>
              <span className="font-semibold">{row.businessName}</span>
              <span className="mt-1 block text-ink/70">{row.contactEmail}{suppressed.has(row.contactEmail) ? " · suppressed" : ""}</span>
            </span>
            {suppressed.has(row.contactEmail) ? null : (
              <form action={suppressOutreachTestRecipient}>
                <input type="hidden" name="fixtureId" value={row.id} />
                <button type="submit" className="rounded-full border border-ink px-3 py-1 text-xs font-semibold text-ink">Suppress fixture</button>
              </form>
            )}
          </li>
        ))}
      </ul>
      {plan && plan.queued.length > 0 && !saved ? (
        <form action={saveOutreachTestQueue} className="mt-4">
          <button type="submit" className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">Save test queue</button>
        </form>
      ) : null}
      {saved?.status === "review" && campaign.data ? (
        <form action={confirmOutreachTestQueue} className="mt-4 max-w-md">
          <input type="hidden" name="jobId" value={saved.id} />
          <label className="block text-sm font-medium text-ink">Type “{campaign.data.name}” to confirm. This still will not send.
            <input name="confirmation" className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2" />
          </label>
          <button type="submit" className="mt-3 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">Confirm test queue</button>
        </form>
      ) : null}
      {saved?.status === "blocked" ? (
        <div className="mt-4">
          <p className="text-sm text-ink/70">Simulation {saved.status}. {saved.recipient_count} synthetic recipients. Stopped: {saved.block_reason}.</p>
          <form action={retryOutreachTestQueue} className="mt-3">
            <input type="hidden" name="jobId" value={saved.id} />
            <button type="submit" className="rounded-full border border-ink px-4 py-2 text-sm font-semibold text-ink">Record a blocked test retry</button>
          </form>
        </div>
      ) : null}
    </main>
  );
}
