import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ConversationList } from "@/components/conversation-list";
import { MessageThread } from "@/components/message-thread";
import { canMessageBooking, isUuid } from "@/lib/messages";
import { loadConversations, loadMessages } from "@/lib/messages-load";
import { shownError } from "@/lib/public-error";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Customer conversation · BlockBooked" };
export const dynamic = "force-dynamic";

export default async function ProviderConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ bookingId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { bookingId } = await params;
  if (!isUuid(bookingId)) notFound();
  const query = await searchParams;
  const session = await requireSession(`/dashboard/messages/${bookingId}`);
  if (session.profile.role !== "provider" && session.profile.role !== "admin") redirect("/list-your-business");
  const owned = await session.supabase.from("providers").select("id").eq("owner_id", session.user.id).maybeSingle();
  if (!owned.data) notFound();
  const booking = await session.supabase
    .from("booking_requests")
    .select("id, status, service_name, preferred_date, time_window, provider_id, customer_id, profiles(full_name)")
    .eq("id", bookingId)
    .eq("provider_id", owned.data.id)
    .maybeSingle();
  if (!booking.data) notFound();
  const [loaded, history] = await Promise.all([
    loadMessages(session.supabase, bookingId),
    loadConversations(session.supabase, "provider"),
  ]);
  const customer = Array.isArray(booking.data.profiles) ? booking.data.profiles[0] : booking.data.profiles;
  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-4 py-10 sm:px-6 lg:grid-cols-[20rem_1fr]">
      <div className="hidden lg:block">
        <ConversationList audience="provider" conversations={history.conversations} activeId={bookingId} />
      </div>
      <section>
        <Link href="/dashboard/messages" className="text-sm font-semibold text-accent-dark lg:hidden">All messages</Link>
        <h1 className="mt-2 font-serif text-4xl tracking-tight text-ink">{customer?.full_name || "Customer"}</h1>
        <p className="mt-2 text-sm text-ink/70">
          {booking.data.service_name || "Service"} · {booking.data.preferred_date} · {booking.data.time_window}
        </p>
        {shownError(loaded.error, "Messages could not be loaded.") ? (
          <p className="mt-4 text-sm font-medium text-accent-dark">{shownError(loaded.error, "Messages could not be loaded.")}</p>
        ) : null}
        <div className="mt-4">
          <MessageThread
            bookingId={bookingId}
            viewerId={session.user.id}
            counterpartName={customer?.full_name || "Customer"}
            initialMessages={loaded.messages}
            canSend={canMessageBooking(booking.data.status)}
            error={shownError(query.error)}
          />
        </div>
      </section>
    </main>
  );
}
