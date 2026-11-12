export const RATE_LIMITS = {
  "sign-in": { max: 10, windowSeconds: 15 * 60 },
  "sign-up": { max: 5, windowSeconds: 60 * 60 },
  createBooking: { max: 10, windowSeconds: 60 * 60 },
  checkout: { max: 8, windowSeconds: 10 * 60 },
  sendQuote: { max: 20, windowSeconds: 60 * 60 },
  milestones: { max: 20, windowSeconds: 60 * 60 },
  bookingStatus: { max: 30, windowSeconds: 10 * 60 },
  completionPin: { max: 12, windowSeconds: 15 * 60 },
  completionReview: { max: 10, windowSeconds: 60 * 60 },
  connectStripe: { max: 5, windowSeconds: 60 * 60 },
  providerImage: { max: 15, windowSeconds: 60 * 60 },
  becomeProvider: { max: 5, windowSeconds: 60 * 60 },
  reschedule: { max: 20, windowSeconds: 60 * 60 },
  updateProfile: { max: 20, windowSeconds: 60 * 60 },
  providerListing: { max: 30, windowSeconds: 60 * 60 },
  providerSchedule: { max: 40, windowSeconds: 60 * 60 },
  adminReconcile: { max: 6, windowSeconds: 60 * 60 },
  outreachWrite: { max: 40, windowSeconds: 10 * 60 },
  sendMessage: { max: 30, windowSeconds: 10 * 60 },
} as const;

export type RateOperation = keyof typeof RATE_LIMITS;

export const RATE_LIMIT_MESSAGE = "Too many attempts. Wait a few minutes and try again.";
export const RATE_LIMIT_UNAVAILABLE = "We could not verify this request. Try again in a minute.";

export function advanceRateLimit(input: {
  hits: number;
  windowStartMs: number;
  nowMs: number;
  limit: number;
  windowMs: number;
}) {
  const expired = input.nowMs - input.windowStartMs >= input.windowMs;
  const windowStartMs = expired ? input.nowMs : input.windowStartMs;
  const hits = expired ? 1 : input.hits + 1;
  return { hits, windowStartMs, allowed: hits <= input.limit };
}

export function openRateLimit(nowMs: number, limit: number) {
  return { hits: 1, windowStartMs: nowMs, allowed: limit >= 1 };
}

export function rateLimitBucket(operation: string, subject: string) {
  const clean = subject.replace(/[^a-zA-Z0-9:._-]/g, "").slice(0, 160);
  return `${operation}:${clean}`.slice(0, 200);
}

function plausibleAddress(value: string) {
  if (value.length < 3 || value.length > 64) return false;
  return /^[0-9a-fA-F:.]+$/.test(value);
}

function firstPlatformAddress(value: string | null) {
  const first = value?.split(",")[0]?.trim() ?? "";
  return plausibleAddress(first) ? first : null;
}

export function trustedClientAddress(
  headerList: { get(name: string): string | null },
  platformSetsClientIp: boolean,
) {
  if (!platformSetsClientIp) return null;
  return (
    firstPlatformAddress(headerList.get("x-vercel-forwarded-for")) ??
    firstPlatformAddress(headerList.get("x-real-ip"))
  );
}

export function rejectedAttemptKeepsStoredHits(hits: number, limit: number) {
  const next = hits + 1;
  const allowed = next <= limit;
  return { storedHits: allowed ? next : hits, allowed };
}

export type RateReceipt = { id: string; actor: string; operation: string };

export function claimRateReceipt(
  receipts: RateReceipt[],
  receiptId: string | null,
  actor: string,
  operation: string,
) {
  if (!receiptId) return { claimed: false, receipts };
  const index = receipts.findIndex(
    (receipt) => receipt.id === receiptId && receipt.actor === actor && receipt.operation === operation,
  );
  if (index < 0) return { claimed: false, receipts };
  return { claimed: true, receipts: receipts.filter((_, receiptIndex) => receiptIndex !== index) };
}
