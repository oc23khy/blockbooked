import { isOpenBooking } from "./booking-status.ts";

export const MESSAGE_MAX_LENGTH = 2000;

export function prepareMessage(input: string) {
  const text = input.replace(/\r\n/g, "\n").trim();
  if (!text) return { ok: false as const, error: "Enter a message." };
  if ([...text].length > MESSAGE_MAX_LENGTH) {
    return { ok: false as const, error: "Messages can be up to 2,000 characters." };
  }
  return { ok: true as const, text };
}

export function canMessageBooking(status: string) {
  return isOpenBooking(status);
}

export function isBookingParticipant(input: { userId: string; customerId: string; providerOwnerId: string }) {
  return input.userId === input.customerId || input.userId === input.providerOwnerId;
}

export function unreadCount(
  messages: { senderId: string; createdAt: string }[],
  viewerId: string,
  readAt: string | null,
) {
  const cursor = readAt ? Date.parse(readAt) : Number.NEGATIVE_INFINITY;
  return messages.filter((message) => message.senderId !== viewerId && Date.parse(message.createdAt) > cursor).length;
}

export function mergeMessages<T extends { id: string; createdAt: string }>(current: T[], incoming: T[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function messagePath(audience: "customer" | "provider", bookingId: string) {
  return audience === "customer" ? `/account/messages/${bookingId}` : `/dashboard/messages/${bookingId}`;
}
