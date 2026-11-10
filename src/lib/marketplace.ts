export type Category = {
  id: string;
  name: string;
  blurb: string;
};

export type ServiceOffering = {
  name: string;
  detail: string;
  price: string;
};

export type Provider = {
  id: string;
  name: string;
  categoryId: string;
  specialty: string;
  neighborhood: string;
  city: string;
  demo: boolean;
  rating: number;
  reviewCount: number;
  priceFrom: number;
  priceUnit: string;
  responseTime: string;
  years: number;
  about: string;
  services: ServiceOffering[];
  tags: string[];
  nextOpening: string;
  initials: string;
  tone: string;
  serviceAreas: string[];
  status?: "pending" | "approved" | "rejected";
  ownerId?: string;
};

export const serviceTowns = [
  "Roselle",
  "Bloomingdale",
  "Schaumburg",
  "Itasca",
  "Hanover Park",
] as const;

export type ServiceTown = (typeof serviceTowns)[number];

export const serviceAreaSummary =
  "Roselle, Bloomingdale, Schaumburg, Itasca, and Hanover Park, Illinois";

export const categories: Category[] = [
  {
    id: "cleaners",
    name: "House Cleaning",
    blurb: "Homes, apartments, and move-out resets",
  },
  {
    id: "barbers",
    name: "Barbering",
    blurb: "Cuts, fades, and beard work nearby",
  },
  {
    id: "movers",
    name: "Moving",
    blurb: "Apartments, furniture, and local hauls",
  },
  {
    id: "detailing",
    name: "Car Detailing",
    blurb: "Washes, interiors, and paint care",
  },
  {
    id: "handyman",
    name: "Handyman",
    blurb: "Repairs, mounting, and small jobs",
  },
  {
    id: "lawn",
    name: "Lawn Care",
    blurb: "Mowing, edging, and seasonal cleanup",
  },
  {
    id: "pets",
    name: "Pet Services",
    blurb: "Walks, drop-ins, and sitting",
  },
  {
    id: "plumbing",
    name: "Plumbing",
    blurb: "Leaks, clogs, and fixture installs",
  },
];

const tones = ["#1f6f6a", "#c45c26", "#1d3d73", "#6b3f2a", "#355c3a", "#0f4c81", "#9a4318", "#7a3e66"];

export function getCategory(id: string) {
  return categories.find((category) => category.id === id);
}

export function categoryName(id: string) {
  return getCategory(id)?.name ?? "Service";
}

export function isServiceTown(value: string): value is ServiceTown {
  return serviceTowns.some((town) => town === value);
}

export function initialsFor(name: string) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "");
  return letters.join("") || "Bb";
}

export function toneFor(id: string) {
  let hash = 0;
  for (const character of id) hash = (hash + character.charCodeAt(0)) % tones.length;
  return tones[hash] ?? tones[0];
}

export function filterProviders(
  providers: Provider[],
  options: { query: string; location: string; categoryId: string },
) {
  const query = options.query.trim().toLowerCase();
  const location = options.location.trim().toLowerCase();

  return providers.filter((provider) => {
    if (options.categoryId && provider.categoryId !== options.categoryId) return false;

    if (location) {
      const place = `${provider.neighborhood} ${provider.city} ${provider.serviceAreas.join(" ")}`.toLowerCase();
      if (!place.includes(location)) return false;
    }

    if (!query) return true;

    const haystack = [
      provider.name,
      provider.specialty,
      provider.neighborhood,
      provider.city,
      categoryName(provider.categoryId),
      ...provider.tags,
      ...provider.serviceAreas,
      ...provider.services.map((service) => service.name),
    ]
      .join(" ")
      .toLowerCase();

    return query.split(/\s+/).every((word) => haystack.includes(word));
  });
}
