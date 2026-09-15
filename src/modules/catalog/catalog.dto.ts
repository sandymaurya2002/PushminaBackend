import type {
  Category,
  Collection,
  Color,
  Gender,
  Material,
  Pattern,
  Prisma,
  ProductBadge,
  Size,
} from '@prisma/client'
import { toNumber } from '../../utils/money'

/**
 * Database → storefront mapping.
 *
 * The output of these functions matches the `Product`, `Collection` and
 * `Category` interfaces already declared in the website's src/types/index.ts,
 * field for field. That is deliberate: the existing TSX components keep working
 * untouched, and swapping the bundled demo catalogue for these endpoints is a
 * change of data source, not a redesign.
 */

/* ------------------------------------------------------------------ *
 * Enum mapping — the database shouts, the storefront whispers.
 * ------------------------------------------------------------------ */

export function genderToApi(gender: Gender): 'women' | 'men' | 'unisex' {
  return gender.toLowerCase() as 'women' | 'men' | 'unisex'
}

export function badgeToApi(badge: ProductBadge): string {
  return badge.toLowerCase()
}

export function groupToApi(group: string): string {
  return group.toLowerCase()
}

/* ------------------------------------------------------------------ *
 * Prisma query shape
 * ------------------------------------------------------------------ */

export const productInclude = {
  category: true,
  material: true,
  pattern: true,
  images: { orderBy: { sortOrder: 'asc' } },
  videos: { orderBy: { sortOrder: 'asc' } },
  colors: { include: { color: true }, orderBy: { sortOrder: 'asc' } },
  sizes: { include: { size: true }, orderBy: { sortOrder: 'asc' } },
  variants: { where: { isActive: true } },
  specifications: { orderBy: { sortOrder: 'asc' } },
  faqs: { orderBy: { sortOrder: 'asc' } },
  badges: true,
  collections: { include: { collection: { select: { slug: true } } } },
  relatedFrom: {
    include: { target: { select: { slug: true } } },
    orderBy: { sortOrder: 'asc' },
  },
} satisfies Prisma.ProductInclude

export type ProductWithRelations = Prisma.ProductGetPayload<{
  include: typeof productInclude
}>

/* ------------------------------------------------------------------ *
 * Product
 * ------------------------------------------------------------------ */

export function toProductDto(product: ProductWithRelations) {
  const inventory = product.variants.reduce((sum, variant) => sum + variant.inventory, 0)

  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    tagline: product.tagline,
    description: product.description,
    story: product.story,
    gender: genderToApi(product.gender),

    categorySlug: product.category.slug,
    categoryName: product.category.name,
    collectionSlugs: product.collections.map((entry) => entry.collection.slug),

    material: product.material.name,
    materialSlug: product.material.slug,
    pattern: product.pattern.name,
    patternSlug: product.pattern.slug,
    craft: product.craft,

    price: toNumber(product.price),
    compareAtPrice: product.compareAtPrice ? toNumber(product.compareAtPrice) : undefined,
    currency: product.currency,

    images: product.images.map((image) => ({
      url: image.url,
      alt: image.alt,
      width: image.width,
      height: image.height,
      ...(image.isPrimary ? { isPrimary: true } : {}),
    })),

    videos: product.videos.map((video) => ({
      url: video.url,
      title: video.title,
      posterUrl: video.posterUrl,
    })),

    colors: product.colors.map((entry) => ({
      name: entry.color.name,
      slug: entry.color.slug,
      hex: entry.color.hex,
    })),

    sizes: product.sizes.map((entry) => ({
      name: entry.size.name,
      slug: entry.size.slug,
      ...(entry.size.measurement ? { measurement: entry.size.measurement } : {}),
    })),

    variants: product.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      colorSlug: product.colors.find((c) => c.colorId === variant.colorId)?.color.slug,
      sizeSlug: product.sizes.find((s) => s.sizeId === variant.sizeId)?.size.slug,
      price: toNumber(variant.price),
      compareAtPrice: variant.compareAtPrice ? toNumber(variant.compareAtPrice) : undefined,
      inventory: variant.inventory,
    })),

    inventory,
    badges: product.badges.map((entry) => badgeToApi(entry.badge)),

    specifications: product.specifications.map((spec) => ({
      label: spec.label,
      value: spec.value,
    })),

    careInstructions: product.careInstructions,
    countryOfOrigin: product.countryOfOrigin,

    publishedAt: (product.publishedAt ?? product.createdAt).toISOString().slice(0, 10),
    popularity: product.popularity,

    faqs: product.faqs.map((faq) => ({ question: faq.question, answer: faq.answer })),

    // Emitted only when genuine review data exists. The storefront gates both
    // the visible star rating and the AggregateRating JSON-LD on this field, so
    // an absent value correctly removes both rather than inventing a score.
    ...(product.ratingCount > 0 && product.ratingAverage
      ? {
          rating: {
            average: toNumber(product.ratingAverage),
            count: product.ratingCount,
          },
        }
      : {}),

    relatedSlugs: product.relatedFrom.map((entry) => entry.target.slug),

    isFeatured: product.isFeatured,
    isTrending: product.isTrending,
    isNewArrival: product.isNewArrival,
  }
}

export type ProductDto = ReturnType<typeof toProductDto>

/**
 * Trimmed payload for grids, carousels and search results.
 *
 * A collection page renders 24 cards; sending full story text, specifications
 * and FAQs for each would be an order of magnitude more bytes than the card
 * actually displays.
 */
export function toProductCardDto(product: ProductWithRelations) {
  const inventory = product.variants.reduce((sum, variant) => sum + variant.inventory, 0)
  const primary = product.images.find((image) => image.isPrimary) ?? product.images[0]

  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    tagline: product.tagline,
    gender: genderToApi(product.gender),
    categorySlug: product.category.slug,
    collectionSlugs: product.collections.map((entry) => entry.collection.slug),
    material: product.material.name,
    materialSlug: product.material.slug,
    pattern: product.pattern.name,
    patternSlug: product.pattern.slug,
    price: toNumber(product.price),
    compareAtPrice: product.compareAtPrice ? toNumber(product.compareAtPrice) : undefined,
    currency: product.currency,
    images: product.images.slice(0, 2).map((image) => ({
      url: image.url,
      alt: image.alt,
      width: image.width,
      height: image.height,
      ...(image.isPrimary ? { isPrimary: true } : {}),
    })),
    primaryImage: primary
      ? { url: primary.url, alt: primary.alt, width: primary.width, height: primary.height }
      : null,
    colors: product.colors.map((entry) => ({
      name: entry.color.name,
      slug: entry.color.slug,
      hex: entry.color.hex,
    })),
    sizes: product.sizes.map((entry) => ({
      name: entry.size.name,
      slug: entry.size.slug,
      ...(entry.size.measurement ? { measurement: entry.size.measurement } : {}),
    })),
    variants: product.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      colorSlug: product.colors.find((c) => c.colorId === variant.colorId)?.color.slug,
      sizeSlug: product.sizes.find((s) => s.sizeId === variant.sizeId)?.size.slug,
      price: toNumber(variant.price),
      compareAtPrice: variant.compareAtPrice ? toNumber(variant.compareAtPrice) : undefined,
      inventory: variant.inventory,
    })),
    inventory,
    badges: product.badges.map((entry) => badgeToApi(entry.badge)),
    publishedAt: (product.publishedAt ?? product.createdAt).toISOString().slice(0, 10),
    popularity: product.popularity,
    ...(product.ratingCount > 0 && product.ratingAverage
      ? { rating: { average: toNumber(product.ratingAverage), count: product.ratingCount } }
      : {}),
  }
}

export type ProductCardDto = ReturnType<typeof toProductCardDto>

/* ------------------------------------------------------------------ *
 * Taxonomy & collections
 * ------------------------------------------------------------------ */

export function toCategoryDto(
  category: Category & { _count?: { products: number } },
) {
  return {
    slug: category.slug,
    name: category.name,
    description: category.description ?? '',
    gender: category.gender ? genderToApi(category.gender) : undefined,
    image: category.imageUrl
      ? { url: category.imageUrl, alt: category.imageAlt ?? category.name }
      : null,
    sortOrder: category.sortOrder,
    ...(category._count ? { productCount: category._count.products } : {}),
  }
}

export interface CollectionWithRelations extends Collection {
  includeCategories?: Array<{ category: { slug: string } }>
  relatedFrom?: Array<{ target: { slug: string } }>
  faqs?: Array<{ question: string; answer: string }>
  _count?: { products: number }
}

export function toCollectionDto(collection: CollectionWithRelations) {
  return {
    slug: collection.slug,
    name: collection.name,
    heading: collection.heading ?? undefined,
    description: collection.description,
    seoContent: collection.seoContent,
    group: groupToApi(collection.group),
    bannerImage: {
      url: collection.bannerUrl ?? '',
      alt: collection.bannerAlt ?? `${collection.name} collection`,
      width: 1800,
      height: 620,
    },
    includeCategorySlugs: collection.includeCategories?.map((entry) => entry.category.slug) ?? [],
    relatedSlugs: collection.relatedFrom?.map((entry) => entry.target.slug) ?? [],
    faqs:
      collection.faqs?.map((faq) => ({ question: faq.question, answer: faq.answer })) ?? [],
    hidden: collection.isHidden,
    featured: collection.isFeatured,
    ...(collection._count ? { productCount: collection._count.products } : {}),
  }
}

export function toColorDto(color: Color) {
  return { name: color.name, slug: color.slug, hex: color.hex, sortOrder: color.sortOrder }
}

export function toSizeDto(size: Size) {
  return {
    name: size.name,
    slug: size.slug,
    ...(size.measurement ? { measurement: size.measurement } : {}),
    sortOrder: size.sortOrder,
  }
}

export function toTermDto(term: Material | Pattern) {
  return { name: term.name, slug: term.slug, sortOrder: term.sortOrder }
}
