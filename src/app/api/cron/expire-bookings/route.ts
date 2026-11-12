import { cronAuthorized, expireDueBookings } from "@/lib/bookings/expire";
import { retryDueNotifications } from "@/lib/notifications/dispatch";
import { customerFacingError } from "@/lib/public-error";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function run(request: Request) {
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  }
  if (!cronAuthorized(request)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    await createAdminClient().rpc("purge_stale_rate_limits");
  } catch {
    // Expiration and refunds still run when old counters cannot be removed.
  }
  const result = await expireDueBookings();
  let notifications = { checked: 0, sent: 0, failed: 0, skipped: 0 };
  try {
    notifications = await retryDueNotifications();
  } catch {
    // Expiration stays recorded when a queued email cannot be retried.
  }
  const safe = {
    ...result,
    error: result.error ? customerFacingError(result.error, "Bookings could not be expired.") : null,
    refunds: result.refunds.map((refund) => ({
      ...refund,
      message: customerFacingError(refund.message, "The expiration refund could not be confirmed."),
    })),
    notifications,
  };
  if (safe.error && safe.expired.length === 0) {
    return Response.json(safe, { status: 500 });
  }
  return Response.json(safe);
}

export function GET(request: Request) {
  return run(request);
}

export function POST(request: Request) {
  return run(request);
}
