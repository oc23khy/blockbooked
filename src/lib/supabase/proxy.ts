import { createServerClient } from "@supabase/ssr";
import type { User } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { isSupabaseConfigured, supabaseEnv } from "@/lib/supabase/env";

function withUnsubscribeHeaders(response: NextResponse, path: string) {
  if (path.startsWith("/outreach/unsubscribe") || path.startsWith("/api/outreach/unsubscribe")) {
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
}

export async function updateSession(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const finish = (response: NextResponse) => withUnsubscribeHeaders(response, path);
  if (!isSupabaseConfigured()) {
    return finish(NextResponse.next({ request }));
  }

  const { url, anonKey } = supabaseEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  let user: User | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch {
    return finish(response);
  }

  const isPrivate =
    path.startsWith("/account") || path.startsWith("/dashboard") || path.startsWith("/admin");

  if (!user && isPrivate) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.searchParams.set("next", path);
    return NextResponse.redirect(login);
  }

  if (user && (path.startsWith("/dashboard") || path.startsWith("/admin"))) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    const role = profile?.role;

    if (path.startsWith("/admin") && role !== "admin") {
      const home = request.nextUrl.clone();
      home.pathname = "/";
      home.search = "";
      return NextResponse.redirect(home);
    }

    if (path.startsWith("/dashboard") && role !== "provider" && role !== "admin") {
      const listing = request.nextUrl.clone();
      listing.pathname = "/list-your-business";
      listing.search = "";
      return NextResponse.redirect(listing);
    }
  }

  return finish(response);
}
