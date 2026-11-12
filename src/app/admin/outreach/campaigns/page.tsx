import type { Metadata } from "next";
import Link from "next/link";
import { createOutreachCampaign } from "@/app/actions/outreach-campaigns";
import { CampaignFields } from "@/components/campaign-fields";
import { shownError } from "@/lib/public-error";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Outreach campaigns · BlockBooked" };

type CampaignRow = {
  id: string;
  name: string;
  subject: string;
  updated_at: string;
};

export default async function OutreachCampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const query = await searchParams;
  const { supabase } = await requireAdmin("/admin/outreach/campaigns");
  const listed = await supabase
    .from("outreach_campaigns")
    .select("id, name, subject, updated_at")
    .eq("campaign_status", "draft")
    .order("updated_at", { ascending: false })
    .limit(100);

  const rows = (listed.data ?? []) as CampaignRow[];

  return (
    <main>
      <p className="text-sm font-semibold text-ink/60">
        <Link href="/admin/outreach" className="underline decoration-line underline-offset-2">Outreach</Link>
      </p>
      <h1 className="mt-2 font-serif text-4xl tracking-tight text-ink">Campaign drafts</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-ink/70">
        Prepare a message and choose who would receive it. Sending is not available. Suppressed and invalid addresses stay out of the recipient count.
      </p>
      {query.notice ? <p className="mt-4 text-sm font-medium text-ink">{query.notice}</p> : null}
      {shownError(query.error || listed.error?.message) ? (
        <p className="mt-4 text-sm font-medium text-accent-dark">{shownError(query.error || listed.error?.message)}</p>
      ) : null}
      <ul className="mt-6 grid gap-2">
        {rows.length === 0 ? <li className="text-sm text-ink/70">No drafts yet.</li> : null}
        {rows.map((row) => (
          <li key={row.id} className="rounded-2xl border border-line bg-card px-4 py-3">
            <Link href={`/admin/outreach/campaigns/${row.id}`} className="font-semibold text-ink underline decoration-line underline-offset-2">
              {row.name}
            </Link>
            <p className="text-sm text-ink/60">{row.subject}</p>
          </li>
        ))}
      </ul>
      <form action={createOutreachCampaign} className="mt-8 rounded-3xl border border-line bg-card p-4">
        <h2 className="font-serif text-2xl text-ink">New draft</h2>
        <div className="mt-3">
          <CampaignFields
            values={{
              name: "",
              subject: "",
              body: "",
              senderName: "",
              senderEmail: "",
              physicalAddress: "",
              unsubscribeFooter: "",
              leadStatus: "",
              category: "",
              location: "",
              source: "",
            }}
          />
        </div>
        <button type="submit" className="mt-4 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">Save draft</button>
      </form>
    </main>
  );
}
