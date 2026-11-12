import Link from "next/link";
import type { ConversationSummary } from "@/lib/messages-load";
import { messagePath } from "@/lib/messages";

export function ConversationList({
  audience,
  conversations,
  activeId,
}: {
  audience: "customer" | "provider";
  conversations: ConversationSummary[];
  activeId?: string;
}) {
  return (
    <ul className="grid gap-2">
      {conversations.length === 0 ? (
        <li className="rounded-3xl border border-dashed border-line bg-card px-4 py-8 text-sm text-ink/70">
          No conversations yet. A conversation opens when a booking request is created.
        </li>
      ) : null}
      {conversations.map((conversation) => (
        <li key={conversation.bookingId}>
          <Link
            href={messagePath(audience, conversation.bookingId)}
            className={`block rounded-2xl border px-4 py-3 ${activeId === conversation.bookingId ? "border-ink bg-card" : "border-line bg-card hover:border-ink/40"}`}
          >
            <span className="flex items-start justify-between gap-3">
              <span>
                <span className="block font-semibold text-ink">{conversation.title}</span>
                <span className="mt-1 block text-sm text-ink/70">
                  {conversation.serviceName} · {conversation.when} · {conversation.statusLabel}
                </span>
              </span>
              {conversation.unread > 0 ? (
                <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-white">{conversation.unread}</span>
              ) : null}
            </span>
            <span className="mt-2 block truncate text-sm text-ink/80">{conversation.preview}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
