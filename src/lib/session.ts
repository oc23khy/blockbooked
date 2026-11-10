import { redirect } from "next/navigation";
import { canAccessAdminCenter } from "@/lib/admin/access";
import type { ProfileRow } from "@/lib/providers";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export async function getSession() {
  if (!isSupabaseConfigured()) return null;

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const { data: profile } = await supabase
      .from("profiles")
      .select("id, role, full_name, phone, email")
      .eq("id", user.id)
      .maybeSingle();

    if (!profile) return null;
    return { supabase, user, profile: profile as ProfileRow };
  } catch {
    return null;
  }
}

export async function requireAdmin(nextPath = "/admin") {
  const session = await requireSession(nextPath);
  if (!canAccessAdminCenter(session.profile.role)) redirect("/");
  return session;
}

export async function requireSession(nextPath = "/account") {
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(safeNextPath(nextPath))}`);
  return session;
}

export function safeNextPath(value: string | null | undefined, fallback = "/account") {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}
