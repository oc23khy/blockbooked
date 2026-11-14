import type { Metadata } from "next";
import { isUnsubscribeToken, unsubscribePageCopy } from "@/lib/outreach/unsubscribe";

export const metadata: Metadata = {
  title: "Unsubscribe · BlockBooked",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

export default async function OutreachUnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const valid = isUnsubscribeToken(token);
  const copy = unsubscribePageCopy(valid ? "ready" : "invalid");

  return (
    <main className="mx-auto max-w-lg px-4 py-14 sm:px-6">
      <h1 className="font-serif text-5xl tracking-tight text-ink">{copy.title}</h1>
      <p className="mt-3 text-sm leading-6 text-ink/70">{copy.body}</p>
      {valid ? (
        <form method="post" action="/api/outreach/unsubscribe" className="mt-6">
          <input type="hidden" name="confirm" value="1" />
          <input type="hidden" name="token" value={token} />
          <button type="submit" className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">
            Unsubscribe
          </button>
        </form>
      ) : null}
    </main>
  );
}
