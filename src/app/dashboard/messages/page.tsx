import type { Metadata } from "next";
import Link from "next/link";
import { ConversationList } from "@/components/conversation-list";
import { loadConversations } from "@/lib/messages-load";
import { shownError } from "@/lib/public-error";
import { requireSession } from "@/lib/session";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Provider messages · BlockBooked" };
export const dynamic = "force-dynamic";

export default async function ProviderMessagesPage() {
  const session = await requireSession("/dashboard/messages");
  if (session.profile.role !== "provider" && session.profile.role !== "admin") redirect("/list-your-business");
  const loaded = await loadConversations(session.supabase, "provider");
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link href="/dashboard" className="text-sm font-semibold text-accent-dark">Back to dashboard</Link>
      <h1 className="mt-3 font-serif text-5xl tracking-tight text-ink">Messages</h1>
      <p className="mt-3 text-ink/70">Each booking has its own conversation. Closed bookings stay available to read.</p>
      {shownError(loaded.error, "Messages could not be loaded.") ? (
        <p className="mt-4 text-sm font-medium text-accent-dark">{shownError(loaded.error, "Messages could not be loaded.")}</p>
      ) : null}
      <div className="mt-6">
        <ConversationList audience="provider" conversations={loaded.conversations} />
      </div>
    </main>
  );
}
