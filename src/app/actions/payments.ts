"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { invokeRetiredAdminAction } from "@/lib/admin/retired-actions";
import { parseFixedPriceCents } from "@/lib/payments/money";
import {
  readCommissionBps,
  offerQuote,
  payOutstanding,
  proposeMilestones,
  startProviderOnboarding,
} from "@/lib/payments/service";
import { stripeTestKeyConfigured } from "@/lib/payments/stripe-server";
import { isServiceRoleConfigured } from "@/lib/supabase/admin";
import { requireSession } from "@/lib/session";

export async function connectStripeAccount() {
  const session = await requireSession("/dashboard");
  if (!stripeTestKeyConfigured() || !isServiceRoleConfigured()) {
    redirect("/dashboard?error=Stripe%20test%20payments%20are%20not%20configured.");
  }
  const { data: provider } = await session.supabase
    .from("providers")
    .select("id, status")
    .eq("owner_id", session.user.id)
    .maybeSingle();
  if (!provider || provider.status !== "approved") {
    redirect("/dashboard?error=Only%20an%20approved%20provider%20can%20connect%20Stripe.");
  }
  const url = await startProviderOnboarding(provider.id, session.profile.email);
  redirect(url);
}

export async function payForBooking(formData: FormData) {
  const session = await requireSession("/account");
  const bookingId = String(formData.get("bookingId") ?? "");
  if (!stripeTestKeyConfigured() || !isServiceRoleConfigured()) {
    redirect("/account?error=Stripe%20test%20payments%20are%20not%20configured.");
  }
  let url: string | null;
  try {
    url = await payOutstanding(bookingId, session.user.id, session.profile.email);
  } catch (error) {
    if (error instanceof Error && error.message === "unauthorized") {
      redirect("/account?error=You%20cannot%20pay%20for%20that%20booking.");
    }
    throw error;
  }
  if (!url) redirect("/account?notice=This%20booking%20is%20already%20paid.");
  redirect(url);
}

export async function updateCommission(_formData: FormData): Promise<never> {
  invokeRetiredAdminAction("updateCommission", "admin");
}

export async function adminRefund(_formData: FormData): Promise<never> {
  invokeRetiredAdminAction("adminRefund", "admin");
}

export async function sendQuote(formData: FormData) {
  const session = await requireSession("/dashboard");
  const bookingId = String(formData.get("bookingId") ?? "");
  const amountCents = parseFixedPriceCents(String(formData.get("amount") ?? ""));
  if (!amountCents) redirect("/dashboard?error=Enter%20a%20fixed%20dollar%20quote.");
  try {
    await offerQuote({
      bookingId,
      providerOwnerId: session.user.id,
      amountCents,
      note: String(formData.get("note") ?? ""),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The quote could not be saved.";
    redirect(`/dashboard?error=${encodeURIComponent(message === "unauthorized" ? "You cannot quote this booking." : message)}`);
  }
  revalidatePath("/dashboard");
  revalidatePath("/account");
  redirect("/dashboard?notice=Quote%20sent");
}

export async function saveMilestones(formData: FormData) {
  const session = await requireSession("/dashboard");
  const bookingId = String(formData.get("bookingId") ?? "");
  const parts = [1, 2, 3]
    .map((index) => ({
      label: String(formData.get(`label${index}`) ?? ""),
      amountCents: parseFixedPriceCents(String(formData.get(`amount${index}`) ?? "")) ?? 0,
    }))
    .filter((part) => part.label.trim() || part.amountCents);
  try {
    await proposeMilestones({ bookingId, providerOwnerId: session.user.id, parts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The milestones could not be saved.";
    redirect(`/dashboard?error=${encodeURIComponent(message === "unauthorized" ? "You cannot edit this booking." : message)}`);
  }
  revalidatePath("/dashboard");
  revalidatePath("/account");
  redirect("/dashboard?notice=Milestones%20saved");
}

export async function retryProviderTransfer(_formData: FormData): Promise<never> {
  invokeRetiredAdminAction("retryProviderTransfer", "admin");
}

export async function currentCommissionPercent() {
  const bps = await readCommissionBps();
  return bps / 100;
}
