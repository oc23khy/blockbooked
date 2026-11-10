"use client";

import { useState } from "react";
import { saveProviderListing } from "@/app/actions/providers";
import { categories, serviceTowns, type ServiceOffering } from "@/lib/marketplace";
import type { ProviderRow } from "@/lib/providers";

export function ProviderEditor({ provider }: { provider: ProviderRow | null }) {
  const [services, setServices] = useState<ServiceOffering[]>(
    provider?.services?.length ? provider.services : [{ name: "", detail: "", price: "" }],
  );
  const selected = new Set(provider?.service_areas ?? []);

  function updateService(index: number, field: keyof ServiceOffering, value: string) {
    setServices((current) =>
      current.map((service, serviceIndex) =>
        serviceIndex === index ? { ...service, [field]: value } : service,
      ),
    );
  }

  return (
    <form action={saveProviderListing} className="rounded-3xl border border-line bg-card p-6">
      <h2 className="font-serif text-3xl text-ink">Business profile</h2>
      <p className="mt-2 text-sm leading-6 text-ink/70">
        Prices are starting points. Customers pay BlockBooked securely through Stripe. BlockBooked retains an 8% commission, and your share is transferred after verified completion.
      </p>
      <div className="mt-5 grid gap-3">
        <Field label="Business name" name="businessName" defaultValue={provider?.business_name} required />
        <label className="block text-sm font-medium text-ink">
          Category
          <select
            name="categoryId"
            defaultValue={provider?.category_id ?? "cleaners"}
            className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5 outline-none focus:border-ink"
          >
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <Field label="Specialty" name="specialty" defaultValue={provider?.specialty} />
        <label className="block text-sm font-medium text-ink">
          About
          <textarea
            name="about"
            defaultValue={provider?.about}
            rows={4}
            className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5 outline-none focus:border-ink"
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="Starting price"
            name="priceFrom"
            type="number"
            min="0"
            step="1"
            defaultValue={provider ? String(provider.price_from) : "0"}
            required
          />
          <Field label="Price unit" name="priceUnit" defaultValue={provider?.price_unit ?? "visit"} required />
          <Field
            label="Years of experience"
            name="years"
            type="number"
            min="0"
            step="1"
            defaultValue={provider ? String(provider.years) : "0"}
            required
          />
        </div>
        <label className="block text-sm font-medium text-ink">
          Time zone
          <select name="timezone" defaultValue={provider?.timezone ?? "America/Chicago"} className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5 outline-none focus:border-ink">
            <option value="America/Chicago">Central (America/Chicago)</option>
            <option value="America/New_York">Eastern (America/New_York)</option>
            <option value="America/Denver">Mountain (America/Denver)</option>
            <option value="America/Phoenix">Arizona (America/Phoenix)</option>
            <option value="America/Los_Angeles">Pacific (America/Los_Angeles)</option>
          </select>
        </label>
        <Field label="Languages" name="languages" defaultValue={provider?.languages?.join(", ") ?? ""} placeholder="English, Spanish" />
        <Field label="Travel radius in miles" name="travelRadius" type="number" min="0" max="150" defaultValue={provider?.travel_radius_miles == null ? "" : String(provider.travel_radius_miles)} />
        <Field label="Availability note" name="availability" defaultValue={provider?.availability} placeholder="Optional note. Open times come from the schedule below." />
        <Field label="Typical response time" name="responseTime" defaultValue={provider?.response_time} />
        <fieldset>
          <legend className="text-sm font-medium text-ink">Service areas</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {serviceTowns.map((town) => (
              <label key={town} className="flex items-center gap-2 rounded-xl border border-line bg-sand px-3 py-2 text-sm">
                <input type="checkbox" name="serviceAreas" value={town} defaultChecked={selected.has(town)} />
                {town}, Illinois
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-ink">Services and prices</p>
            <button
              type="button"
              className="text-sm font-semibold text-accent-dark"
              onClick={() => setServices((current) => [...current, { name: "", detail: "", price: "" }])}
            >
              Add service
            </button>
          </div>
          <div className="mt-2 grid gap-2">
            {services.map((service, index) => (
              <div key={index} className="grid gap-2 rounded-2xl border border-line p-3 sm:grid-cols-3">
                <input
                  name="serviceName"
                  value={service.name}
                  onChange={(event) => updateService(index, "name", event.target.value)}
                  placeholder="Service name"
                  className="rounded-xl border border-line bg-sand px-3 py-2 text-sm outline-none focus:border-ink"
                />
                <input
                  name="serviceDetail"
                  value={service.detail}
                  onChange={(event) => updateService(index, "detail", event.target.value)}
                  placeholder="What is included"
                  className="rounded-xl border border-line bg-sand px-3 py-2 text-sm outline-none focus:border-ink"
                />
                <input
                  name="servicePrice"
                  value={service.price}
                  onChange={(event) => updateService(index, "price", event.target.value)}
                  placeholder="From $80"
                  className="rounded-xl border border-line bg-sand px-3 py-2 text-sm outline-none focus:border-ink"
                />
              </div>
            ))}
          </div>
        </div>
        {provider?.status === "rejected" ? (
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" name="resubmit" value="yes" defaultChecked />
            Resubmit this application for review
          </label>
        ) : null}
      </div>
      <button
        type="submit"
        className="mt-5 rounded-full bg-accent px-4 py-3 text-sm font-semibold text-white hover:bg-accent-dark"
      >
        {provider ? "Save business profile" : "Submit application"}
      </button>
    </form>
  );
}

function Field({
  label,
  name,
  defaultValue,
  type = "text",
  required = false,
  placeholder,
  min,
  max,
  step,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  min?: string;
  max?: string;
  step?: string;
}) {
  return (
    <label className="block text-sm font-medium text-ink">
      {label}
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5 outline-none focus:border-ink"
      />
    </label>
  );
}
