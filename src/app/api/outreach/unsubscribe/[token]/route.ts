import { redeemOutreachUnsubscribe } from "@/lib/outreach/unsubscribe-store";
import { isOneClickUnsubscribe, publicUnsubscribeOutcome } from "@/lib/outreach/unsubscribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function empty(status: number) {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
  });
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > 2048) return empty(413);
  const body = await request.text();
  if (!isOneClickUnsubscribe(request.headers.get("content-type") ?? "", body)) return empty(400);
  const outcome = await redeemOutreachUnsubscribe(token);
  if (outcome === "limited") return empty(429);
  if (outcome === "unavailable") return empty(503);
  if (publicUnsubscribeOutcome(outcome) !== "done") return empty(400);
  return empty(200);
}
