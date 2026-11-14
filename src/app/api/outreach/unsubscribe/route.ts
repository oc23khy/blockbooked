import { redeemOutreachUnsubscribe } from "@/lib/outreach/unsubscribe-store";
import { confirmUnsubscribeToken, publicUnsubscribeOutcome, unsubscribeResultProof } from "@/lib/outreach/unsubscribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function empty(status: number) {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
  });
}

export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > 2048) return empty(413);
  const body = await request.text();
  const token = confirmUnsubscribeToken(request.headers.get("content-type") ?? "", body);
  if (!token) return empty(400);
  const outcome = await redeemOutreachUnsubscribe(token);
  const proof = unsubscribeResultProof(
    publicUnsubscribeOutcome(outcome),
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    Date.now(),
  );
  const location = proof ? `/outreach/unsubscribe/result?proof=${encodeURIComponent(proof)}` : "/outreach/unsubscribe/result";
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      Location: location,
    },
  });
}
