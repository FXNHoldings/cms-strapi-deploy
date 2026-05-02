/**
 * Canonical list of the 6 main site sections shown on the homepage AND used
 * as a fallback by /category/[slug] when a matching Strapi Category record
 * doesn't exist yet.
 *
 * Keep slugs in sync with the Strapi Category collection.
 */
export type SectionLayout = 'atlas' | 'departure' | 'wirecutter' | 'directory' | 'masonry' | 'grid';

export type Section = {
  slug: string;
  title: string;
  tagline: string;
  description: string;
  layout: SectionLayout;
};

export const SECTIONS: Section[] = [
  {
    slug: 'destinations',
    title: 'Destinations',
    tagline: 'Places that change you',
    description: 'City guides, country itineraries, and under-the-radar places worth the flight.',
    layout: 'atlas',
  },
  {
    slug: 'flights',
    title: 'Flights',
    tagline: 'Pay less, fly more',
    description: 'Cheap flights, error fares, booking hacks, and the tools we use to never pay retail.',
    layout: 'departure',
  },
  {
    slug: 'hotels',
    title: 'Hotels',
    tagline: 'Beds worth booking twice',
    description: 'Boutique stays, loyalty hacks, and honest reviews of hotels we actually slept in.',
    layout: 'wirecutter',
  },
  {
    slug: 'car-rental',
    title: 'Car Rental',
    tagline: 'Wheels without the markup',
    description: 'Airport vs city pickup, the hidden fees to dodge, and how to find a fair daily rate every time.',
    layout: 'wirecutter',
  },
  {
    slug: 'travel-tips',
    title: 'Travel Tips',
    tagline: 'Shortcuts from the road',
    description: 'How-tos, pitfalls to avoid, the gear we trust, and the small moves that make travel dramatically easier.',
    layout: 'masonry',
  },
];

export function findSection(slug: string): Section | undefined {
  return SECTIONS.find((s) => s.slug === slug);
}
