import type { Metadata } from "next";
import Link from "next/link";
import { ConversationList } from "@/components/conversation-list";
import { loadConversations } from "@/lib/messages-load";
import { shownError } from "@/lib/public-error";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Messages · BlockBooked" };
export const dynamic = "force-dynamic";

export default async function CustomerMessagesPage() {
  const { supabase } = await requireSession("/account/messages");
  const loaded = await loadConversations(supabase, "customer");
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link href="/account" className="text-sm font-semibold text-accent-dark">Back to account</Link>
      <h1 className="mt-3 font-serif text-5xl tracking-tight text-ink">Messages</h1>
      <p className="mt-3 text-ink/70">Conversations stay with each booking, including after it is completed or cancelled.</p>
      {shownError(loaded.error, "Messages could not be loaded.") ? (
        <p className="mt-4 text-sm font-medium text-accent-dark">{shownError(loaded.error, "Messages could not be loaded.")}</p>
      ) : null}
      <div className="mt-6">
        <ConversationList audience="customer" conversations={loaded.conversations} />
      </div>
    </main>
  );
}
