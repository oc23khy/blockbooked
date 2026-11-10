import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Provider } from "../src/lib/marketplace.ts";
import { parseSearchQuery, searchProviders, townForLocation } from "../src/lib/search.ts";

function listing(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "p1",
    name: "Northside Cleaners",
    categoryId: "cleaners",
    specialty: "Homes",
    neighborhood: "Roselle",
    city: "Illinois",
    demo: false,
    rating: 0,
    reviewCount: 0,
    priceFrom: 120,
    priceUnit: "visit",
    responseTime: "",
    years: 3,
    about: "Weekly home cleaning",
    services: [{ name: "Standard clean", detail: "Whole home", price: "$120.00" }],
    tags: ["Roselle"],
    nextOpening: "",
    initials: "NC",
    tone: "#000",
    serviceAreas: ["Roselle"],
    status: "approved",
    ...overrides,
  };
}

describe("provider search", () => {
  const pending = listing({ id: "pending", name: "Hidden", status: "pending" });
  const quote = listing({
    id: "quote",
    name: "Quote Plumbing",
    categoryId: "plumbing",
    neighborhood: "Schaumburg",
    priceFrom: 0,
    serviceAreas: ["Schaumburg"],
    services: [{ name: "Leak", detail: "Inspect", price: "Quote" }],
  });
  const cheap = listing({
    id: "cheap",
    name: "Budget Clean",
    priceFrom: 40,
    services: [{ name: "Touch up", detail: "One room", price: "$40.00" }],
  });

  it("shows only approved providers and matches a launch ZIP to its town", () => {
    const results = searchProviders([pending, listing(), quote], parseSearchQuery({ location: "60172" }));
    assert.deepEqual(results.providers.map((provider) => provider.id), ["p1"]);
    assert.equal(townForLocation("60193"), "Schaumburg");
    assert.equal(results.distanceAvailable, false);
  });

  it("filters fixed prices and sorts quote-only listings after priced ones", () => {
    const priced = searchProviders([quote, cheap], parseSearchQuery({ pricing: "fixed", sort: "price_asc" }));
    assert.deepEqual(priced.providers.map((provider) => provider.id), ["cheap"]);
    const ordered = searchProviders([quote, listing(), cheap], parseSearchQuery({ sort: "price_asc" }));
    assert.deepEqual(ordered.providers.map((provider) => provider.id), ["cheap", "p1", "quote"]);
  });

  it("does not invent reviews when a minimum rating is requested", () => {
    const results = searchProviders([listing()], parseSearchQuery({ rating: "4" }));
    assert.equal(results.total, 0);
    assert.equal(results.reviewsAvailable, false);
  });

  it("paginates bookmarkable results", () => {
    const many = Array.from({ length: 13 }, (_, index) => listing({ id: `p${index}`, name: `Pro ${String(index).padStart(2, "0")}` }));
    const first = searchProviders(many, parseSearchQuery({}));
    const second = searchProviders(many, parseSearchQuery({ page: "2" }));
    assert.equal(first.providers.length, 12);
    assert.equal(second.providers.length, 1);
    assert.equal(second.page, 2);
  });
});
