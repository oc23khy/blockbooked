import { NextResponse } from "next/server";
import { customerFacingError } from "@/lib/public-error";
import { safeNextPath } from "@/lib/session";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNextPath(url.searchParams.get("next"));

  if (!isSupabaseConfigured() || !code) {
    return NextResponse.redirect(new URL("/login?error=Could%20not%20confirm%20email", url.origin));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(customerFacingError(error.message, "The email confirmation could not be completed."))}`, url.origin),
    );
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
