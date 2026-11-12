import { cronAuthorized, expireDueBookings } from "@/lib/bookings/expire";
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
  if (result.error && result.expired.length === 0) {
    return Response.json(result, { status: 500 });
  }
  return Response.json(result);
}

export function GET(request: Request) {
  return run(request);
}

export function POST(request: Request) {
  return run(request);
}
