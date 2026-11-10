import { categoryName, serviceTowns, type Provider, type ServiceTown } from "./marketplace.ts";
import { parseFixedPriceCents } from "./payments/money.ts";

export const searchPageSize = 12;
export const searchRadii = [5, 10, 25, 50, 100] as const;

export const launchZips: Record<string, ServiceTown> = {
  "60172": "Roselle",
  "60108": "Bloomingdale",
  "60173": "Schaumburg",
  "60193": "Schaumburg",
  "60194": "Schaumburg",
  "60195": "Schaumburg",
  "60143": "Itasca",
  "60133": "Hanover Park",
};

export type PricingFilter = "any" | "fixed" | "quote";
export type SearchSort =
  | "match"
  | "rating"
  | "reviews"
  | "price_asc"
  | "price_desc"
  | "nearest"
  | "soonest";

export type SearchQuery = {
  q: string;
  location: string;
  category: string;
  minPrice: number | null;
  maxPrice: number | null;
  minRating: number | null;
  pricing: PricingFilter;
  sort: SearchSort;
  page: number;
  radius: number | null;
};

export type ProviderPricing = "fixed" | "starting" | "quote";

export function providerPricing(provider: Provider): ProviderPricing {
  if (provider.services.some((service) => parseFixedPriceCents(service.price) != null)) return "fixed";
  if (provider.priceFrom > 0) return "starting";
  return "quote";
}

export function comparablePrice(provider: Provider) {
  const prices = provider.services
    .map((service) => parseFixedPriceCents(service.price))
    .filter((cents): cents is number => cents != null);
  if (prices.length > 0) return Math.min(...prices) / 100;
  return provider.priceFrom > 0 ? provider.priceFrom : null;
}

export function townForLocation(location: string) {
  const trimmed = location.trim();
  if (/^\d{5}$/.test(trimmed)) return launchZips[trimmed] ?? null;
  const match = serviceTowns.find((town) => town.toLowerCase() === trimmed.toLowerCase());
  return match ?? null;
}

export function parseSearchQuery(params: Record<string, string | string[] | undefined>): SearchQuery {
  const read = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value ?? "").trim();
  };
  const number = (key: string) => {
    const raw = read(key);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const pricing = read("pricing");
  const sort = read("sort");
  const radius = number("radius");
  const page = number("page");
  return {
    q: read("q").slice(0, 80),
    location: read("location").slice(0, 80),
    category: read("category").slice(0, 40),
    minPrice: number("min"),
    maxPrice: number("max"),
    minRating: number("rating"),
    pricing: pricing === "fixed" || pricing === "quote" ? pricing : "any",
    sort: isSort(sort) ? sort : "match",
    page: page && page >= 1 ? Math.floor(page) : 1,
    radius: radius != null && searchRadii.some((value) => value === radius) ? radius : null,
  };
}

function isSort(value: string): value is SearchSort {
  return ["match", "rating", "reviews", "price_asc", "price_desc", "nearest", "soonest"].includes(value);
}

function matchesLocation(provider: Provider, location: string) {
  if (!location) return true;
  const town = townForLocation(location);
  const place = `${provider.neighborhood} ${provider.city} ${provider.serviceAreas.join(" ")}`.toLowerCase();
  if (town) return place.includes(town.toLowerCase());
  return place.includes(location.toLowerCase());
}

function score(provider: Provider, query: string) {
  if (!query) return 0;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const fields = [
    provider.name,
    provider.specialty,
    categoryName(provider.categoryId),
    ...provider.services.map((service) => service.name),
    provider.about,
  ].map((value) => value.toLowerCase());
  return words.reduce((total, word) => total + fields.filter((field) => field.includes(word)).length, 0);
}

export function searchProviders(providers: Provider[], query: SearchQuery) {
  const approved = providers.filter((provider) => !provider.status || provider.status === "approved");
  const keyword = query.q.toLowerCase();
  const matched = approved.filter((provider) => {
    if (query.category && provider.categoryId !== query.category) return false;
    if (!matchesLocation(provider, query.location)) return false;
    const pricing = providerPricing(provider);
    if (query.pricing === "fixed" && pricing === "quote") return false;
    if (query.pricing === "quote" && pricing !== "quote") return false;
    const price = comparablePrice(provider);
    if (query.minPrice != null && (price == null || price < query.minPrice)) return false;
    if (query.maxPrice != null && (price == null || price > query.maxPrice)) return false;
    if (query.minRating != null && query.minRating > 0 && (provider.reviewCount < 1 || provider.rating < query.minRating)) {
      return false;
    }
    if (!keyword) return true;
    return score(provider, keyword) > 0;
  });

  const sorted = [...matched].sort((left, right) => compareProviders(left, right, query));
  const start = (query.page - 1) * searchPageSize;
  return {
    total: sorted.length,
    page: query.page,
    pages: Math.max(1, Math.ceil(sorted.length / searchPageSize)),
    providers: sorted.slice(start, start + searchPageSize),
    distanceAvailable: false,
    reviewsAvailable: sorted.some((provider) => provider.reviewCount > 0),
  };
}

function compareProviders(left: Provider, right: Provider, query: SearchQuery) {
  if (query.sort === "price_asc" || query.sort === "price_desc") {
    const leftPrice = comparablePrice(left);
    const rightPrice = comparablePrice(right);
    if (leftPrice == null && rightPrice == null) return left.name.localeCompare(right.name);
    if (leftPrice == null) return 1;
    if (rightPrice == null) return -1;
    const difference = query.sort === "price_asc" ? leftPrice - rightPrice : rightPrice - leftPrice;
    return difference || left.name.localeCompare(right.name);
  }
  if (query.sort === "rating") return right.rating - left.rating || right.reviewCount - left.reviewCount || left.name.localeCompare(right.name);
  if (query.sort === "reviews") return right.reviewCount - left.reviewCount || left.name.localeCompare(right.name);
  if (query.sort === "nearest") {
    const town = townForLocation(query.location);
    const leftHit = town ? left.serviceAreas.includes(town) : 0;
    const rightHit = town ? right.serviceAreas.includes(town) : 0;
    return Number(rightHit) - Number(leftHit) || left.name.localeCompare(right.name);
  }
  if (query.sort === "soonest") {
    return Number(Boolean(right.nextOpening)) - Number(Boolean(left.nextOpening)) || left.name.localeCompare(right.name);
  }
  return score(right, query.q) - score(left, query.q) || left.name.localeCompare(right.name);
}
