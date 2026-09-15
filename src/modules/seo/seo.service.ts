import type { SeoEntityType } from '@prisma/client'
import { prisma } from '../../db/prisma'
import { env } from '../../config/env'

/**
 * SEO resolution.
 *
 * Admin-authored metadata wins; anything not filled in falls back to the
 * entity's own content. That means a product is never left without a title or
 * description just because nobody visited the SEO tab, while an admin who does
 * fill it in always overrides the default.
 */

export interface ResolvedSeo {
  title: string
  description: string
  keywords: string[]
  canonicalUrl: string
  ogTitle: string
  ogDescription: string
  ogImageUrl: string | null
  ogType: string
  twitterCard: string
  robots: { index: boolean; follow: boolean }
  structuredData: unknown | null
}

async function findMeta(entityType: SeoEntityType, entityId: string | null) {
  return prisma.seoMeta.findFirst({ where: { entityType, entityId } })
}

function absolute(path: string): string {
  if (path.startsWith('http')) return path
  return `${env.STOREFRONT_URL}${path.startsWith('/') ? path : `/${path}`}`
}

function compose(
  override: Awaited<ReturnType<typeof findMeta>>,
  fallback: {
    title: string
    description: string
    path: string
    image?: string | null
    type?: string
  },
): ResolvedSeo {
  const title = override?.title || fallback.title
  const description = override?.description || fallback.description
  const image = override?.ogImageUrl || fallback.image || null

  return {
    title,
    description,
    keywords: override?.keywords ?? [],
    canonicalUrl: override?.canonicalUrl || absolute(fallback.path),
    ogTitle: override?.ogTitle || title,
    ogDescription: override?.ogDescription || description,
    ogImageUrl: image ? absolute(image) : null,
    ogType: override?.ogType || fallback.type || 'website',
    twitterCard: override?.twitterCard || 'summary_large_image',
    robots: {
      index: override?.robotsIndex ?? true,
      follow: override?.robotsFollow ?? true,
    },
    structuredData: override?.structuredData ?? null,
  }
}

export async function resolveForHome(): Promise<ResolvedSeo> {
  const [override, settings] = await Promise.all([
    findMeta('HOME', null),
    prisma.siteSetting.findMany({ where: { key: { in: ['site.name', 'site.description'] } } }),
  ])

  const map = Object.fromEntries(settings.map((row) => [row.key, row.value]))

  return compose(override, {
    title: `${String(map['site.name'] ?? 'Pushmina')} | Luxury Pashmina, Shawls & Indian Craftsmanship`,
    description: String(map['site.description'] ?? ''),
    path: '/',
    image: '/images/editorial/og-default.png',
  })
}

export async function resolveForProduct(slug: string): Promise<ResolvedSeo | null> {
  const product = await prisma.product.findFirst({
    where: { slug, status: 'PUBLISHED' },
    select: {
      id: true,
      name: true,
      tagline: true,
      description: true,
      images: { where: { isPrimary: true }, take: 1, select: { url: true } },
    },
  })
  if (!product) return null

  const override = await findMeta('PRODUCT', product.id)

  return compose(override, {
    title: `${product.name} | Pushmina`,
    description: `${product.tagline} ${product.description}`.slice(0, 158),
    path: `/products/${slug}`,
    image: product.images[0]?.url,
    type: 'product',
  })
}

export async function resolveForCollection(slug: string): Promise<ResolvedSeo | null> {
  const collection = await prisma.collection.findUnique({
    where: { slug },
    select: { id: true, name: true, heading: true, description: true, bannerUrl: true },
  })
  if (!collection) return null

  const override = await findMeta('COLLECTION', collection.id)

  return compose(override, {
    title: `${collection.heading ?? collection.name} | Pushmina`,
    description: collection.description.slice(0, 158),
    path: `/collections/${slug}`,
    image: collection.bannerUrl,
  })
}

export async function resolveForPost(slug: string): Promise<ResolvedSeo | null> {
  const post = await prisma.blogPost.findFirst({
    where: { slug, status: 'PUBLISHED' },
    select: { id: true, title: true, excerpt: true, coverUrl: true },
  })
  if (!post) return null

  const override = await findMeta('BLOG_POST', post.id)

  return compose(override, {
    title: `${post.title} | Pushmina`,
    description: post.excerpt.slice(0, 158),
    path: `/blog/${slug}`,
    image: post.coverUrl,
    type: 'article',
  })
}

export async function resolveForPage(slug: string): Promise<ResolvedSeo | null> {
  const page = await prisma.page.findFirst({
    where: { slug, status: 'PUBLISHED' },
    select: { title: true, intro: true },
  })
  if (!page) return null

  const override = await findMeta('PAGE', slug)

  return compose(override, {
    title: `${page.title} | Pushmina`,
    description: (page.intro ?? '').slice(0, 158),
    path: `/${slug}`,
  })
}

export async function resolveForLanding(slug: string): Promise<ResolvedSeo | null> {
  const page = await prisma.landingPage.findFirst({
    where: { slug, isActive: true },
    select: { h1: true, intro: true, bannerUrl: true },
  })
  if (!page) return null

  const override = await findMeta('LANDING', slug)

  return compose(override, {
    title: `${page.h1} | Pushmina`,
    description: (page.intro[0] ?? '').slice(0, 158),
    path: `/${slug}`,
    image: page.bannerUrl,
  })
}

/* ------------------------------------------------------------------ *
 * Sitemap
 * ------------------------------------------------------------------ */

export interface SitemapEntry {
  url: string
  lastModified: string
  changeFrequency: string
  priority: number
}

/**
 * Public, indexable pages only.
 *
 * Cart, checkout, account, wishlist and internal search are deliberately
 * absent — they are transactional surfaces with nothing to index, and the
 * storefront's robots.txt disallows them too.
 */
export async function buildSitemap(): Promise<SitemapEntry[]> {
  const [products, collections, posts, blogCategories, pages, landingPages] = await Promise.all([
    prisma.product.findMany({
      where: { status: 'PUBLISHED' },
      select: { slug: true, updatedAt: true, publishedAt: true },
    }),
    prisma.collection.findMany({
      where: { isHidden: false },
      select: { slug: true, updatedAt: true, isFeatured: true },
    }),
    prisma.blogPost.findMany({
      where: { status: 'PUBLISHED' },
      select: { slug: true, updatedAt: true },
    }),
    prisma.blogCategory.findMany({ where: { isActive: true }, select: { slug: true } }),
    prisma.page.findMany({ where: { status: 'PUBLISHED' }, select: { slug: true, updatedAt: true } }),
    prisma.landingPage.findMany({
      where: { isActive: true },
      select: { slug: true, updatedAt: true },
    }),
  ])

  const now = new Date().toISOString()
  const entries: SitemapEntry[] = [
    { url: '/', lastModified: now, changeFrequency: 'daily', priority: 1 },
    { url: '/collections', lastModified: now, changeFrequency: 'weekly', priority: 0.9 },
    { url: '/blog', lastModified: now, changeFrequency: 'weekly', priority: 0.8 },
  ]

  for (const product of products) {
    entries.push({
      url: `/products/${product.slug}`,
      lastModified: (product.publishedAt ?? product.updatedAt).toISOString(),
      changeFrequency: 'weekly',
      priority: 0.8,
    })
  }

  for (const collection of collections) {
    entries.push({
      url: `/collections/${collection.slug}`,
      lastModified: collection.updatedAt.toISOString(),
      changeFrequency: 'weekly',
      priority: collection.isFeatured ? 0.9 : 0.7,
    })
  }

  for (const page of landingPages) {
    entries.push({
      url: `/${page.slug}`,
      lastModified: page.updatedAt.toISOString(),
      changeFrequency: 'weekly',
      priority: 0.8,
    })
  }

  for (const post of posts) {
    entries.push({
      url: `/blog/${post.slug}`,
      lastModified: post.updatedAt.toISOString(),
      changeFrequency: 'monthly',
      priority: 0.6,
    })
  }

  for (const category of blogCategories) {
    entries.push({
      url: `/blog/category/${category.slug}`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.5,
    })
  }

  for (const page of pages) {
    entries.push({
      url: `/${page.slug}`,
      lastModified: page.updatedAt.toISOString(),
      changeFrequency: 'yearly',
      priority: 0.3,
    })
  }

  return entries
}

/** Removes orphaned SEO rows when the entity they described is deleted. */
export async function deleteSeoFor(
  entityType: SeoEntityType,
  entityId: string,
): Promise<void> {
  await prisma.seoMeta.deleteMany({ where: { entityType, entityId } })
}
