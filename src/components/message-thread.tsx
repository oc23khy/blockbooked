"use client";

import { useEffect, useRef, useState } from "react";
import { markMessagesRead, sendMessage } from "@/app/actions/messages";
import { mergeMessages } from "@/lib/messages";
import { createClient } from "@/lib/supabase/client";

type ThreadMessage = { id: string; senderId: string; body: string; createdAt: string };

export function MessageThread({
  bookingId,
  viewerId,
  counterpartName,
  initialMessages,
  canSend,
  error,
}: {
  bookingId: string;
  viewerId: string;
  counterpartName: string;
  initialMessages: ThreadMessage[];
  canSend: boolean;
  error?: string | null;
}) {
  const [messages, setMessages] = useState(initialMessages);
  const clientId = useRef(crypto.randomUUID());
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [connection, setConnection] = useState("Connecting");

  useEffect(() => {
    setMessages((current) => mergeMessages(current, initialMessages));
  }, [initialMessages]);

  useEffect(() => {
    void markMessagesRead(bookingId);
    const supabase = createClient();
    let active = true;
    const refresh = async () => {
      const { data } = await supabase
        .from("booking_messages")
        .select("id, sender_id, body, created_at")
        .eq("booking_id", bookingId)
        .order("created_at", { ascending: true })
        .limit(50);
      if (!active || !data) return;
      const incoming = data.map((row) => ({
        id: String(row.id),
        senderId: String(row.sender_id),
        body: String(row.body),
        createdAt: String(row.created_at),
      }));
      setMessages((current) => mergeMessages(current, incoming));
    };
    const channel = supabase
      .channel(`booking-messages:${bookingId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "booking_messages", filter: `booking_id=eq.${bookingId}` },
        (payload) => {
          const row = payload.new as { id?: string; sender_id?: string; body?: string; created_at?: string };
          if (!row.id || !row.sender_id || !row.created_at) return;
          setMessages((current) =>
            mergeMessages(current, [{ id: row.id!, senderId: row.sender_id!, body: row.body ?? "", createdAt: row.created_at! }]),
          );
          if (row.sender_id !== viewerId) void markMessagesRead(bookingId);
        },
      )
      .subscribe((status) => {
        setConnection(status === "SUBSCRIBED" ? "Live" : status === "CHANNEL_ERROR" ? "Reconnecting" : "Connecting");
        if (status === "SUBSCRIBED") void refresh();
      });
    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [bookingId, viewerId]);

  async function loadOlder() {
    const oldest = messages[0]?.createdAt;
    if (!oldest) return;
    setLoadingOlder(true);
    const supabase = createClient();
    const { data } = await supabase
      .from("booking_messages")
      .select("id, sender_id, body, created_at")
      .eq("booking_id", bookingId)
      .lt("created_at", oldest)
      .order("created_at", { ascending: false })
      .limit(50);
    const older = (data ?? []).map((row) => ({
      id: String(row.id),
      senderId: String(row.sender_id),
      body: String(row.body),
      createdAt: String(row.created_at),
    }));
    setMessages((current) => mergeMessages(older, current));
    setLoadingOlder(false);
  }

  return (
    <div className="flex min-h-[28rem] flex-col rounded-3xl border border-line bg-card">
      <div className="flex items-center justify-between border-b border-line px-4 py-3 text-xs font-semibold uppercase tracking-wide text-ink/50">
        <span>Conversation</span>
        <span>{connection}</span>
      </div>
      <div className="flex flex-1 flex-col gap-3 px-4 py-4">
        {messages.length >= 50 ? (
          <button type="button" onClick={() => void loadOlder()} className="self-center text-sm font-semibold text-accent-dark" disabled={loadingOlder}>
            {loadingOlder ? "Loading…" : "Load earlier messages"}
          </button>
        ) : null}
        {messages.length === 0 ? <p className="text-sm text-ink/70">No messages yet.</p> : null}
        {messages.map((message) => {
          const mine = message.senderId === viewerId;
          const sent = new Date(message.createdAt);
          const label = Number.isNaN(sent.getTime())
            ? ""
            : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(sent);
          return (
            <div key={message.id} className={mine ? "ml-auto max-w-[85%]" : "mr-auto max-w-[85%]"}>
              <p className={`whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-6 ${mine ? "bg-accent text-white" : "bg-sand text-ink"}`}>
                {message.body}
              </p>
              <p className="mt-1 text-xs text-ink/50">{mine ? "You" : counterpartName} · {label}</p>
            </div>
          );
        })}
      </div>
      {error ? <p className="px-4 text-sm font-medium text-accent-dark">{error}</p> : null}
      {canSend ? (
        <form
          action={sendMessage}
          className="grid gap-2 border-t border-line p-4"
          onSubmit={(event) => {
            const form = event.currentTarget;
            const field = form.elements.namedItem("clientId");
            if (field instanceof HTMLInputElement) field.value = clientId.current;
            queueMicrotask(() => {
              clientId.current = crypto.randomUUID();
            });
          }}
        >
          <input type="hidden" name="bookingId" value={bookingId} />
          <input type="hidden" name="clientId" value={clientId.current} />
          <textarea
            name="body"
            required
            maxLength={2000}
            rows={3}
            placeholder="Write a message"
            className="w-full rounded-xl border border-line bg-sand px-3 py-2.5 text-sm outline-none focus:border-ink"
          />
          <button type="submit" className="w-fit rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white">
            Send
          </button>
        </form>
      ) : (
        <p className="border-t border-line px-4 py-3 text-sm text-ink/70">This booking is closed. The conversation stays here, and new messages are turned off.</p>
      )}
    </div>
  );
}
