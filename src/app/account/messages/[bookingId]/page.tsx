import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConversationList } from "@/components/conversation-list";
import { MessageThread } from "@/components/message-thread";
import { canMessageBooking, isUuid } from "@/lib/messages";
import { loadConversations, loadMessages } from "@/lib/messages-load";
import { shownError } from "@/lib/public-error";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Conversation · BlockBooked" };
export const dynamic = "force-dynamic";

export default async function CustomerConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ bookingId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { bookingId } = await params;
  if (!isUuid(bookingId)) notFound();
  const query = await searchParams;
  const { supabase, user } = await requireSession(`/account/messages/${bookingId}`);
  const booking = await supabase
    .from("booking_requests")
    .select("id, status, service_name, preferred_date, time_window, customer_id, providers(business_name)")
    .eq("id", bookingId)
    .eq("customer_id", user.id)
    .maybeSingle();
  if (!booking.data) notFound();
  const [loaded, history] = await Promise.all([
    loadMessages(supabase, bookingId),
    loadConversations(supabase, "customer"),
  ]);
  const provider = Array.isArray(booking.data.providers) ? booking.data.providers[0] : booking.data.providers;
  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-4 py-10 sm:px-6 lg:grid-cols-[20rem_1fr]">
      <div className="hidden lg:block">
        <ConversationList audience="customer" conversations={history.conversations} activeId={bookingId} />
      </div>
      <section>
        <Link href="/account/messages" className="text-sm font-semibold text-accent-dark lg:hidden">All messages</Link>
        <h1 className="mt-2 font-serif text-4xl tracking-tight text-ink">{provider?.business_name || "Provider"}</h1>
        <p className="mt-2 text-sm text-ink/70">
          {booking.data.service_name || "Service"} · {booking.data.preferred_date} · {booking.data.time_window}
        </p>
        {shownError(loaded.error, "Messages could not be loaded.") ? (
          <p className="mt-4 text-sm font-medium text-accent-dark">{shownError(loaded.error, "Messages could not be loaded.")}</p>
        ) : null}
        <div className="mt-4">
          <MessageThread
            bookingId={bookingId}
            viewerId={user.id}
            counterpartName={provider?.business_name || "Provider"}
            initialMessages={loaded.messages}
            canSend={canMessageBooking(booking.data.status)}
            error={shownError(query.error)}
          />
        </div>
      </section>
    </main>
  );
}
