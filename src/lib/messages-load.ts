import type { SupabaseClient } from "@supabase/supabase-js";
import { bookingStatusLabel } from "@/lib/booking-status";

export type ConversationSummary = {
  bookingId: string;
  title: string;
  serviceName: string;
  when: string;
  status: string;
  statusLabel: string;
  preview: string;
  unread: number;
};

export type StoredMessage = {
  id: string;
  senderId: string;
  body: string;
  createdAt: string;
};

type SummaryRow = {
  booking_id: string;
  counterpart_name: string | null;
  service_name: string | null;
  preferred_date: string;
  time_window: string;
  status: string;
  latest_body: string | null;
  latest_at: string | null;
  unread_count: number;
  viewer_role: string;
};

export async function loadConversations(supabase: SupabaseClient, audience: "customer" | "provider") {
  const { data, error } = await supabase.rpc("booking_conversation_summaries");
  if (error) return { conversations: [] as ConversationSummary[], error: error.message };
  const conversations = ((data ?? []) as SummaryRow[])
    .filter((row) => row.viewer_role === audience)
    .map((row) => ({
    bookingId: row.booking_id,
    title: row.counterpart_name || "Booking",
    serviceName: row.service_name || "Service",
    when: `${row.preferred_date} · ${row.time_window}`,
    status: row.status,
    statusLabel: bookingStatusLabel(row.status),
    preview: row.latest_body || "No messages yet",
    unread: row.unread_count ?? 0,
  }));
  return { conversations, error: null };
}

export async function loadMessages(supabase: SupabaseClient, bookingId: string, before?: string) {
  let query = supabase
    .from("booking_messages")
    .select("id, sender_id, body, created_at")
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query;
  if (error) return { messages: [] as StoredMessage[], error: error.message };
  const messages = ((data ?? []) as { id: string; sender_id: string; body: string; created_at: string }[])
    .map((row) => ({ id: row.id, senderId: row.sender_id, body: row.body, createdAt: row.created_at }))
    .reverse();
  return { messages, error: null };
}
