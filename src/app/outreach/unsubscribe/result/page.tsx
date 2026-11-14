import type { Metadata } from "next";
import { readUnsubscribeResultProof, unsubscribePageCopy, type UnsubscribeOutcome } from "@/lib/outreach/unsubscribe";

export const metadata: Metadata = {
  title: "Unsubscribe · BlockBooked",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

function shownOutcome(value: string | undefined): UnsubscribeOutcome {
  const outcome = readUnsubscribeResultProof(value ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", Date.now());
  if (outcome === "done") return "unsubscribed";
  if (outcome === "limited" || outcome === "unavailable") return outcome;
  return "invalid";
}

export default async function OutreachUnsubscribeResultPage({
  searchParams,
}: {
  searchParams: Promise<{ proof?: string }>;
}) {
  const query = await searchParams;
  const copy = unsubscribePageCopy(shownOutcome(query.proof));

  return (
    <main className="mx-auto max-w-lg px-4 py-14 sm:px-6">
      <h1 className="font-serif text-5xl tracking-tight text-ink">{copy.title}</h1>
      <p className="mt-3 text-sm leading-6 text-ink/70">{copy.body}</p>
    </main>
  );
}
