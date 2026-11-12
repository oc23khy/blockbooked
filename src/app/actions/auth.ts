"use server";

import { redirect } from "next/navigation";
import { siteUrl } from "@/lib/payments/stripe-server";
import { redirectIfIpRateLimited, redirectIfRateLimited } from "@/lib/rate-limit";
import { safeNextPath } from "@/lib/session";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

function configuredOrRedirect() {
  if (!isSupabaseConfigured()) redirect("/login?error=Supabase%20is%20not%20configured");
}

export async function signIn(formData: FormData) {
  configuredOrRedirect();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeNextPath(String(formData.get("next") ?? ""));
  await redirectIfIpRateLimited("sign-in", `/login?next=${encodeURIComponent(next)}`);
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}&next=${encodeURIComponent(next)}`);
  }

  redirect(next);
}

export async function signUp(formData: FormData) {
  configuredOrRedirect();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const fullName = String(formData.get("fullName") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const accountType = formData.get("accountType") === "provider" ? "provider" : "customer";
  const next = accountType === "provider" ? "/dashboard" : "/account";

  if (password.length < 8) {
    redirect("/signup?error=Use%20at%20least%208%20characters");
  }

  await redirectIfIpRateLimited("sign-up", "/signup");
  const supabase = await createClient();
  const origin = siteUrl();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
      data: { full_name: fullName, phone, account_type: accountType },
    },
  });

  if (error) redirect(`/signup?error=${encodeURIComponent(error.message)}`);
  if (!data.session) {
    redirect(`/login?notice=${encodeURIComponent("Confirm your email, then log in.")}`);
  }

  redirect(next);
}

export async function signOut() {
  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  redirect("/");
}

export async function updateProfile(formData: FormData) {
  configuredOrRedirect();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/account");
  await redirectIfRateLimited("updateProfile", user.id, "/account");

  const fullName = String(formData.get("fullName") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const { error } = await supabase
    .from("profiles")
    .update({ full_name: fullName, phone })
    .eq("id", user.id);

  if (error) redirect(`/account?error=${encodeURIComponent(error.message)}`);
  redirect("/account?notice=Profile%20saved");
}

export async function becomeProvider() {
  configuredOrRedirect();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/list-your-business");
  await redirectIfRateLimited("becomeProvider", user.id, "/list-your-business");
  const { error } = await supabase.rpc("become_provider");
  if (error) redirect(`/list-your-business?error=${encodeURIComponent(error.message)}`);
  redirect("/dashboard");
}
