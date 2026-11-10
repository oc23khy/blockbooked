"use client";

import { useActionState } from "react";
import { saveCatalogServices } from "@/app/actions/schedule";
import { catalogDraftsFromServices, type CatalogFormState } from "@/lib/scheduling/catalog";

type ServiceRow = {
  id: string;
  name: string;
  description: string;
  pricing_type: string;
  price_cents: number | null;
  duration_minutes: number | null;
  active: boolean;
};

export function CatalogServicesForm({ services }: { services: ServiceRow[] }) {
  const initialState: CatalogFormState = {
    error: null,
    drafts: catalogDraftsFromServices(services),
    attempt: 0,
  };
  const [state, formAction, pending] = useActionState(saveCatalogServices, initialState);

  return (
    <form action={formAction} className="rounded-3xl border border-line bg-card p-6">
      <h2 className="font-serif text-3xl text-ink">Services customers can book</h2>
      <p className="mt-2 text-sm leading-6 text-ink/70">
        This is the only form that creates bookable services. Enter a name, a price, and a duration from 15 to 480 minutes, then click Save services. A service without a duration is listed, but it cannot be booked at an exact time.
      </p>
      {state.error ? <p className="mt-3 text-sm font-medium text-accent-dark">{state.error}</p> : null}
      <div className="mt-4 grid gap-4">
        {state.drafts.map((service, index) => (
          <div key={`${state.attempt}-${service.id || index}`} className="grid gap-2 rounded-2xl border border-line p-3">
            <input type="hidden" name={`id-${index}`} defaultValue={service.id} />
            <div className="grid gap-2 sm:grid-cols-2">
              <input name={`name-${index}`} defaultValue={service.name} placeholder="Service name" className="rounded-xl border border-line bg-sand px-3 py-2.5 text-sm" />
              <select name={`pricing-${index}`} defaultValue={service.pricing} className="rounded-xl border border-line bg-sand px-3 py-2.5 text-sm">
                <option value="fixed">Fixed price</option>
                <option value="starting">Starting price</option>
                <option value="quote">Quote</option>
              </select>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <input name={`price-${index}`} defaultValue={service.price} placeholder="Price in dollars, such as 50 or $50" className="rounded-xl border border-line bg-sand px-3 py-2.5 text-sm" />
              <input name={`duration-${index}`} defaultValue={service.duration} placeholder="Duration in minutes, 15 to 480" className="rounded-xl border border-line bg-sand px-3 py-2.5 text-sm" />
              <select name={`active-${index}`} defaultValue={service.active} className="rounded-xl border border-line bg-sand px-3 py-2.5 text-sm">
                <option value="yes">Shown</option>
                <option value="no">Hidden</option>
              </select>
            </div>
            <input name={`detail-${index}`} defaultValue={service.detail} placeholder="What is included" className="rounded-xl border border-line bg-sand px-3 py-2.5 text-sm" />
          </div>
        ))}
      </div>
      <button type="submit" disabled={pending} className="mt-4 rounded-full bg-accent px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">
        {pending ? "Saving services..." : "Save services"}
      </button>
    </form>
  );
}
