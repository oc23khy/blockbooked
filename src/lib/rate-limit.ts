import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  RATE_LIMITS,
  RATE_LIMIT_MESSAGE,
  RATE_LIMIT_UNAVAILABLE,
  rateLimitBucket,
  trustedClientAddress,
  type RateOperation,
} from "@/lib/rate-limit-decision";
import { createAdminClient } from "@/lib/supabase/admin";

export async function consumeRateLimit(operation: RateOperation, subject: string) {
  const spec = RATE_LIMITS[operation];
  const bucket = rateLimitBucket(operation, subject);
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("consume_rate_limit", {
      target_bucket: bucket,
      max_hits: spec.max,
      window_seconds: spec.windowSeconds,
    });
    if (error || typeof data !== "number" || !Number.isInteger(data)) {
      return { allowed: false, message: RATE_LIMIT_UNAVAILABLE };
    }
    if (data > spec.max) return { allowed: false, message: RATE_LIMIT_MESSAGE };
    return { allowed: true, message: "" };
  } catch {
    return { allowed: false, message: RATE_LIMIT_UNAVAILABLE };
  }
}

function redirectLimited(failurePath: string, message: string): never {
  const join = failurePath.includes("?") ? "&" : "?";
  redirect(`${failurePath}${join}error=${encodeURIComponent(message)}`);
}

export async function redirectIfRateLimited(operation: RateOperation, userId: string, failurePath: string) {
  const result = await consumeRateLimit(operation, `user:${userId}`);
  if (!result.allowed) redirectLimited(failurePath, result.message);
}

export async function reserveBookingRateLimit(
  operation: "createBooking" | "bookingStatus",
  userId: string,
  failurePath: string,
) {
  let receipt: string | null = null;
  let failed = false;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("issue_booking_rate_receipt", {
      actor: userId,
      operation,
    });
    if (error) failed = true;
    else if (typeof data === "string" && data.length >= 32) receipt = data;
  } catch {
    failed = true;
  }
  if (failed) redirectLimited(failurePath, RATE_LIMIT_UNAVAILABLE);
  if (!receipt) redirectLimited(failurePath, RATE_LIMIT_MESSAGE);
  return receipt;
}

export async function redirectIfIpRateLimited(operation: RateOperation, failurePath: string) {
  const headerList = await headers();
  const address = trustedClientAddress(headerList, process.env.VERCEL === "1");
  if (!address) return;
  const result = await consumeRateLimit(operation, `ip:${address}`);
  if (!result.allowed) redirectLimited(failurePath, result.message);
}
