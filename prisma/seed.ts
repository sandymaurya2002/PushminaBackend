/**
 * Database seed.
 *
 * Loads the storefront's existing catalogue — the same 30 products, 32
 * collections, 8 journal articles, landing pages and policies the website
 * already ships — into PostgreSQL, so switching the site over to the API is a
 * change of data source and nothing visibly changes for a customer.
 *
 * Idempotent: every write is an upsert keyed on a natural unique field, so it
 * is safe to re-run after a schema change without duplicating anything.
 *
 *   npm run db:seed
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import {
  PrismaClient,
  type BannerPlacement,
  type CollectionGroup,
  type Gender,
  type NavGroup,
  type ProductBadge,
} from '@prisma/client'
import {
  ALL_PERMISSIONS,
  ROLE_DEFINITIONS,
  groupForPermission,
  permissionLabel,
} from '../src/config/permissions'

const prisma = new PrismaClient()

/* ------------------------------------------------------------------ *
 * Source data
 * ------------------------------------------------------------------ */

interface SeedData {
  taxonomy: {
    colors: Array<{ name: string; slug: string; hex: string }>
    sizes: Array<{ name: string; slug: string; measurement?: string }>
    materials: Array<{ name: string; slug: string }>
    patterns: Array<{ name: string; slug: string }>
    categories: Array<{ slug: string; name: string; gender?: string; description: string }>
  }
  collections: Array<{
    slug: string
    name: string
    heading?: string
    description: string
    seoContent?: string[]
    group: string
    bannerImage: { url: string; alt: string; width: number; height: number }
    includeCategorySlugs?: string[]
    relatedSlugs: string[]
    faqs?: Array<{ question: string; answer: string }>
    hidden?: boolean
    featured?: boolean
  }>
  products: Array<{
    slug: string
    name: string
    tagline: string
    description: string
    story: string[]
    gender: string
    categorySlug: string
    collectionSlugs: string[]
    material: string
    materialSlug: string
    pattern: string
    patternSlug: string
    craft: string
    price: number
    compareAtPrice?: number
    currency: string
    images: Array<{ url: string; alt: string; width: number; height: number; isPrimary?: boolean }>
    colors: Array<{ slug: string }>
    sizes: Array<{ slug: string }>
    variants: Array<{
      id: string
      sku: string
      colorSlug?: string
      sizeSlug?: string
      price: number
      compareAtPrice?: number
      inventory: number
    }>
    inventory: number
    badges: string[]
    specifications: Array<{ label: string; value: string }>
    careInstructions: string[]
    countryOfOrigin: string
    publishedAt: string
    popularity: number
    faqs?: Array<{ question: string; answer: string }>
    rating?: { average: number; count: number }
    relatedSlugs?: string[]
  }>
  blog: {
    categories: Array<{ slug: string; name: string; description: string }>
    posts: Array<{
      slug: string
      title: string
      excerpt: string
      category: string
      author: string
      publishedAt: string
      updatedAt?: string
      readingMinutes: number
      cover: { url: string; alt: string; width: number; height: number }
      blocks: unknown[]
      faqs?: Array<{ question: string; answer: string }>
      relatedProductSlugs?: string[]
      relatedCollectionSlugs?: string[]
    }>
  }
  landingPages: Array<{
    slug: string
    h1: string
    metaTitle: string
    metaDescription: string
    eyebrow: string
    intro: string[]
    collectionSlug: string
    productHeading: string
    sections: unknown[]
    faqs: Array<{ question: string; answer: string }>
    internalLinks: Array<{ label: string; href: string }>
    banner: { url: string; alt: string; width: number; height: number }
  }>
  policies: Array<{
    slug: string
    title: string
    metaTitle: string
    metaDescription: string
    eyebrow: string
    intro: string
    updated: string
    sections: unknown[]
    faqs?: Array<{ question: string; answer: string }>
  }>
  generalFaqs: Array<{ heading: string; items: Array<{ question: string; answer: string }> }>
  navigation: {
    primaryNav: Array<{
      label: string
      href: string
      columns?: Array<{ title: string; links: Array<{ label: string; href: string; highlight?: boolean }> }>
      feature?: {
        eyebrow: string
        heading: string
        href: string
        ctaLabel: string
        image: { url: string; alt: string }
      }
    }>
    footerColumns: Array<{ title: string; links: Array<{ label: string; href: string }> }>
    popularSearches: string[]
  }
  site: Record<string, unknown> & {
    announcements: string[]
    trustSignals: Array<{ icon: string; label: string }>
  }
}

const data: SeedData = JSON.parse(
  readFileSync(join(__dirname, 'seed-data.json'), 'utf8'),
) as SeedData

/* ------------------------------------------------------------------ *
 * Enum mapping — storefront lowercase → database uppercase
 * ------------------------------------------------------------------ */

const toGender = (value?: string): Gender =>
  (value ? value.toUpperCase() : 'UNISEX') as Gender

const toGroup = (value: string): CollectionGroup => value.toUpperCase() as CollectionGroup

const toBadge = (value: string): ProductBadge => value.toUpperCase() as ProductBadge

const BADGE_WEIGHT: Record<string, number> = {
  EXCLUSIVE: 24,
  LIMITED: 16,
  BESTSELLER: 12,
  NEW: 8,
  HANDCRAFTED: 0,
}

function step(message: string): void {
  console.log(`  ${message}`)
}

/**
 * SKU generation.
 *
 * The storefront's demo data builds SKUs from `slug.slice(0, 6)`, which makes
 * every product beginning "ivory-" share the stem PSH-IVORY- and collide.
 * That was invisible without a uniqueness constraint; the database has one.
 *
 * Here the stem is built from the first three characters of the first three
 * slug words, which is both far more distinctive and more readable on a
 * picking list. A running set guarantees uniqueness even so.
 */
const usedSkus = new Set<string>()

function buildSku(slug: string, colorSlug: string | undefined, index: number): string {
  const stem =
    slug
      .split('-')
      .slice(0, 3)
      .map((word) => word.slice(0, 3).toUpperCase())
      .join('') || 'PRD'

  const colorCode = (colorSlug ?? 'std').slice(0, 3).toUpperCase()
  const base = `PSH-${stem}-${colorCode}-${String(index).padStart(2, '0')}`

  if (!usedSkus.has(base)) {
    usedSkus.add(base)
    return base
  }

  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!usedSkus.has(candidate)) {
      usedSkus.add(candidate)
      return candidate
    }
  }

  throw new Error(`Could not allocate a unique SKU for ${slug}`)
}

/* ================================================================== *
 * 1. Permissions, roles and the first admin
 * ================================================================== */

async function seedAccessControl(): Promise<void> {
  console.log('\nAccess control')

  for (const key of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key },
      update: { label: permissionLabel(key), group: groupForPermission(key) },
      create: { key, label: permissionLabel(key), group: groupForPermission(key) },
    })
  }
  step(`${ALL_PERMISSIONS.length} permissions`)

  for (const definition of ROLE_DEFINITIONS) {
    const role = await prisma.role.upsert({
      where: { slug: definition.slug },
      update: { name: definition.name, description: definition.description },
      create: {
        name: definition.name,
        slug: definition.slug,
        description: definition.description,
        isSystem: true,
      },
    })

    // Replace rather than merge, so removing a permission from a role
    // definition actually revokes it on re-seed.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })

    const permissions = await prisma.permission.findMany({
      where: { key: { in: definition.permissions } },
      select: { id: true },
    })

    await prisma.rolePermission.createMany({
      data: permissions.map((permission) => ({
        roleId: role.id,
        permissionId: permission.id,
      })),
      skipDuplicates: true,
    })
  }
  step(`${ROLE_DEFINITIONS.length} roles`)

  const superAdmin = await prisma.role.findUniqueOrThrow({ where: { slug: 'super-admin' } })

  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@pushmina.com'
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'Admin@12345'
  const name = process.env.SEED_ADMIN_NAME ?? 'Pushmina Administrator'

  await prisma.adminUser.upsert({
    where: { email },
    // An existing admin's password is never reset by a re-seed.
    update: { name, roleId: superAdmin.id, isActive: true },
    create: {
      email,
      name,
      passwordHash: await bcrypt.hash(password, 12),
      roleId: superAdmin.id,
    },
  })
  step(`admin account → ${email}`)
}

/* ================================================================== *
 * 2. Taxonomy — the admin-managed filter vocabulary
 * ================================================================== */

async function seedTaxonomy(): Promise<void> {
  console.log('\nTaxonomy')

  await Promise.all(
    data.taxonomy.colors.map((color, index) =>
      prisma.color.upsert({
        where: { slug: color.slug },
        update: { name: color.name, hex: color.hex, sortOrder: index },
        create: { name: color.name, slug: color.slug, hex: color.hex, sortOrder: index },
      }),
    ),
  )
  step(`${data.taxonomy.colors.length} colours`)

  await Promise.all(
    data.taxonomy.sizes.map((size, index) =>
      prisma.size.upsert({
        where: { slug: size.slug },
        update: { name: size.name, measurement: size.measurement ?? null, sortOrder: index },
        create: {
          name: size.name,
          slug: size.slug,
          measurement: size.measurement ?? null,
          sortOrder: index,
        },
      }),
    ),
  )
  step(`${data.taxonomy.sizes.length} sizes`)

  await Promise.all(
    data.taxonomy.materials.map((material, index) =>
      prisma.material.upsert({
        where: { slug: material.slug },
        update: { name: material.name, sortOrder: index },
        create: { name: material.name, slug: material.slug, sortOrder: index },
      }),
    ),
  )
  step(`${data.taxonomy.materials.length} materials`)

  await Promise.all(
    data.taxonomy.patterns.map((pattern, index) =>
      prisma.pattern.upsert({
        where: { slug: pattern.slug },
        update: { name: pattern.name, sortOrder: index },
        create: { name: pattern.name, slug: pattern.slug, sortOrder: index },
      }),
    ),
  )
  step(`${data.taxonomy.patterns.length} patterns`)

  await Promise.all(
    data.taxonomy.categories.map((category, index) =>
      prisma.category.upsert({
        where: { slug: category.slug },
        update: {
          name: category.name,
          description: category.description,
          gender: category.gender ? toGender(category.gender) : null,
          sortOrder: index,
        },
        create: {
          name: category.name,
          slug: category.slug,
          description: category.description,
          gender: category.gender ? toGender(category.gender) : null,
          sortOrder: index,
        },
      }),
    ),
  )
  step(`${data.taxonomy.categories.length} categories`)
}

/* ================================================================== *
 * 3. Collections
 * ================================================================== */

async function seedCollections(): Promise<void> {
  console.log('\nCollections')

  for (const [index, collection] of data.collections.entries()) {
    await prisma.collection.upsert({
      where: { slug: collection.slug },
      update: {
        name: collection.name,
        heading: collection.heading ?? null,
        description: collection.description,
        seoContent: collection.seoContent ?? [],
        group: toGroup(collection.group),
        bannerUrl: collection.bannerImage.url,
        bannerAlt: collection.bannerImage.alt,
        isHidden: collection.hidden ?? false,
        isFeatured: collection.featured ?? false,
        sortOrder: index,
      },
      create: {
        slug: collection.slug,
        name: collection.name,
        heading: collection.heading ?? null,
        description: collection.description,
        seoContent: collection.seoContent ?? [],
        group: toGroup(collection.group),
        bannerUrl: collection.bannerImage.url,
        bannerAlt: collection.bannerImage.alt,
        isHidden: collection.hidden ?? false,
        isFeatured: collection.featured ?? false,
        sortOrder: index,
      },
    })
  }

  // Relations resolved in a second pass, once every collection row exists.
  for (const collection of data.collections) {
    const record = await prisma.collection.findUniqueOrThrow({
      where: { slug: collection.slug },
      select: { id: true },
    })

    await prisma.collectionCategory.deleteMany({ where: { collectionId: record.id } })
    if (collection.includeCategorySlugs?.length) {
      const categories = await prisma.category.findMany({
        where: { slug: { in: collection.includeCategorySlugs } },
        select: { id: true },
      })
      await prisma.collectionCategory.createMany({
        data: categories.map((category) => ({
          collectionId: record.id,
          categoryId: category.id,
        })),
        skipDuplicates: true,
      })
    }

    await prisma.collectionRelation.deleteMany({ where: { sourceId: record.id } })
    if (collection.relatedSlugs.length) {
      const targets = await prisma.collection.findMany({
        where: { slug: { in: collection.relatedSlugs } },
        select: { id: true, slug: true },
      })
      await prisma.collectionRelation.createMany({
        data: targets.map((target) => ({
          sourceId: record.id,
          targetId: target.id,
          sortOrder: collection.relatedSlugs.indexOf(target.slug),
        })),
        skipDuplicates: true,
      })
    }

    await prisma.collectionFaq.deleteMany({ where: { collectionId: record.id } })
    if (collection.faqs?.length) {
      await prisma.collectionFaq.createMany({
        data: collection.faqs.map((faq, index) => ({
          collectionId: record.id,
          question: faq.question,
          answer: faq.answer,
          sortOrder: index,
        })),
      })
    }
  }

  step(`${data.collections.length} collections with relations, categories and FAQs`)
}

/* ================================================================== *
 * 4. Products
 * ================================================================== */

async function seedProducts(): Promise<void> {
  console.log('\nProducts')

  const [colors, sizes, materials, patterns, categories, collections] = await Promise.all([
    prisma.color.findMany({ select: { id: true, slug: true } }),
    prisma.size.findMany({ select: { id: true, slug: true } }),
    prisma.material.findMany({ select: { id: true, slug: true } }),
    prisma.pattern.findMany({ select: { id: true, slug: true } }),
    prisma.category.findMany({ select: { id: true, slug: true } }),
    prisma.collection.findMany({ select: { id: true, slug: true } }),
  ])

  const colorId = new Map(colors.map((c) => [c.slug, c.id]))
  const sizeId = new Map(sizes.map((s) => [s.slug, s.id]))
  const materialId = new Map(materials.map((m) => [m.slug, m.id]))
  const patternId = new Map(patterns.map((p) => [p.slug, p.id]))
  const categoryId = new Map(categories.map((c) => [c.slug, c.id]))
  const collectionId = new Map(collections.map((c) => [c.slug, c.id]))

  for (const source of data.products) {
    const category = categoryId.get(source.categorySlug)
    const material = materialId.get(source.materialSlug)
    const pattern = patternId.get(source.patternSlug)

    if (!category || !material || !pattern) {
      console.warn(`  ! skipped ${source.slug} — missing taxonomy reference`)
      continue
    }

    const badges = source.badges.map(toBadge)
    const featuredScore = badges.reduce(
      (total, badge) => total + (BADGE_WEIGHT[badge] ?? 0),
      source.popularity,
    )

    const weight = source.specifications.find((s) => s.label === 'Weight')?.value
    const finish = source.specifications.find((s) => s.label === 'Finish')?.value

    const base = {
      name: source.name,
      tagline: source.tagline,
      description: source.description,
      story: source.story,
      gender: toGender(source.gender),
      categoryId: category,
      materialId: material,
      patternId: pattern,
      craft: source.craft,
      countryOfOrigin: source.countryOfOrigin,
      weight: weight ?? null,
      finish: finish ?? null,
      price: source.price,
      compareAtPrice: source.compareAtPrice ?? null,
      currency: source.currency,
      status: 'PUBLISHED' as const,
      popularity: source.popularity,
      featuredScore,
      ratingAverage: source.rating?.average ?? null,
      ratingCount: source.rating?.count ?? 0,
      careInstructions: source.careInstructions,
      publishedAt: new Date(source.publishedAt),
      isTrending: badges.includes('BESTSELLER'),
      isFeatured: badges.includes('EXCLUSIVE') || badges.includes('LIMITED'),
      isNewArrival: badges.includes('NEW'),
    }

    const product = await prisma.product.upsert({
      where: { slug: source.slug },
      update: base,
      create: { slug: source.slug, ...base },
      select: { id: true },
    })

    /* Children are replaced wholesale — simpler and safer than diffing, and
       these tables are small. */

    await prisma.productImage.deleteMany({ where: { productId: product.id } })
    await prisma.productImage.createMany({
      data: source.images.map((image, index) => ({
        productId: product.id,
        url: image.url,
        alt: image.alt,
        width: image.width,
        height: image.height,
        isPrimary: image.isPrimary ?? index === 0,
        sortOrder: index,
      })),
    })

    await prisma.productColor.deleteMany({ where: { productId: product.id } })
    await prisma.productColor.createMany({
      data: source.colors
        .map((color, index) => ({
          productId: product.id,
          colorId: colorId.get(color.slug)!,
          sortOrder: index,
        }))
        .filter((entry) => Boolean(entry.colorId)),
      skipDuplicates: true,
    })

    await prisma.productSize.deleteMany({ where: { productId: product.id } })
    await prisma.productSize.createMany({
      data: source.sizes
        .map((size, index) => ({
          productId: product.id,
          sizeId: sizeId.get(size.slug)!,
          sortOrder: index,
        }))
        .filter((entry) => Boolean(entry.sizeId)),
      skipDuplicates: true,
    })

    await prisma.productVariant.deleteMany({ where: { productId: product.id } })
    for (const [variantIndex, variant] of source.variants.entries()) {
      await prisma.productVariant.create({
        data: {
          productId: product.id,
          sku: buildSku(source.slug, variant.colorSlug, variantIndex + 1),
          colorId: variant.colorSlug ? (colorId.get(variant.colorSlug) ?? null) : null,
          sizeId: variant.sizeSlug ? (sizeId.get(variant.sizeSlug) ?? null) : null,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice ?? null,
          inventory: variant.inventory,
        },
      })
    }

    await prisma.productSpecification.deleteMany({ where: { productId: product.id } })
    await prisma.productSpecification.createMany({
      data: source.specifications.map((spec, index) => ({
        productId: product.id,
        label: spec.label,
        value: spec.value,
        sortOrder: index,
      })),
    })

    await prisma.productFaq.deleteMany({ where: { productId: product.id } })
    if (source.faqs?.length) {
      await prisma.productFaq.createMany({
        data: source.faqs.map((faq, index) => ({
          productId: product.id,
          question: faq.question,
          answer: faq.answer,
          sortOrder: index,
        })),
      })
    }

    await prisma.productBadgeLink.deleteMany({ where: { productId: product.id } })
    await prisma.productBadgeLink.createMany({
      data: badges.map((badge) => ({ productId: product.id, badge })),
      skipDuplicates: true,
    })

    await prisma.productCollection.deleteMany({ where: { productId: product.id } })
    await prisma.productCollection.createMany({
      data: source.collectionSlugs
        .map((slug, index) => ({
          productId: product.id,
          collectionId: collectionId.get(slug)!,
          sortOrder: index,
        }))
        .filter((entry) => Boolean(entry.collectionId)),
      skipDuplicates: true,
    })
  }

  // Cross-product links, once every product exists.
  for (const source of data.products) {
    if (!source.relatedSlugs?.length) continue

    const product = await prisma.product.findUnique({
      where: { slug: source.slug },
      select: { id: true },
    })
    if (!product) continue

    const targets = await prisma.product.findMany({
      where: { slug: { in: source.relatedSlugs } },
      select: { id: true, slug: true },
    })

    await prisma.productRelation.deleteMany({ where: { sourceId: product.id } })
    await prisma.productRelation.createMany({
      data: targets.map((target) => ({
        sourceId: product.id,
        targetId: target.id,
        sortOrder: source.relatedSlugs!.indexOf(target.slug),
      })),
      skipDuplicates: true,
    })
  }

  step(`${data.products.length} products with images, variants, specs and FAQs`)
}

/* ================================================================== *
 * 5. Blog
 * ================================================================== */

async function seedBlog(): Promise<void> {
  console.log('\nJournal')

  for (const [index, category] of data.blog.categories.entries()) {
    await prisma.blogCategory.upsert({
      where: { slug: category.slug },
      update: { name: category.name, description: category.description, sortOrder: index },
      create: {
        slug: category.slug,
        name: category.name,
        description: category.description,
        sortOrder: index,
      },
    })
  }
  step(`${data.blog.categories.length} journal categories`)

  const admin = await prisma.adminUser.findFirst({ select: { id: true } })

  for (const post of data.blog.posts) {
    const category = await prisma.blogCategory.findUnique({
      where: { slug: post.category },
      select: { id: true },
    })
    if (!category) continue

    const base = {
      title: post.title,
      excerpt: post.excerpt,
      categoryId: category.id,
      authorId: admin?.id ?? null,
      authorName: post.author,
      coverUrl: post.cover.url,
      coverAlt: post.cover.alt,
      blocks: post.blocks as never,
      readingMinutes: post.readingMinutes,
      status: 'PUBLISHED' as const,
      publishedAt: new Date(post.publishedAt),
      updatedAt: post.updatedAt ? new Date(post.updatedAt) : undefined,
    }

    const record = await prisma.blogPost.upsert({
      where: { slug: post.slug },
      update: base,
      create: { slug: post.slug, ...base },
      select: { id: true },
    })

    await prisma.blogFaq.deleteMany({ where: { postId: record.id } })
    if (post.faqs?.length) {
      await prisma.blogFaq.createMany({
        data: post.faqs.map((faq, index) => ({
          postId: record.id,
          question: faq.question,
          answer: faq.answer,
          sortOrder: index,
        })),
      })
    }

    await prisma.blogPostProduct.deleteMany({ where: { postId: record.id } })
    if (post.relatedProductSlugs?.length) {
      const products = await prisma.product.findMany({
        where: { slug: { in: post.relatedProductSlugs } },
        select: { id: true, slug: true },
      })
      await prisma.blogPostProduct.createMany({
        data: products.map((product) => ({
          postId: record.id,
          productId: product.id,
          sortOrder: post.relatedProductSlugs!.indexOf(product.slug),
        })),
        skipDuplicates: true,
      })
    }

    await prisma.blogPostCollection.deleteMany({ where: { postId: record.id } })
    if (post.relatedCollectionSlugs?.length) {
      const collections = await prisma.collection.findMany({
        where: { slug: { in: post.relatedCollectionSlugs } },
        select: { id: true, slug: true },
      })
      await prisma.blogPostCollection.createMany({
        data: collections.map((collection) => ({
          postId: record.id,
          collectionId: collection.id,
          sortOrder: post.relatedCollectionSlugs!.indexOf(collection.slug),
        })),
        skipDuplicates: true,
      })
    }
  }
  step(`${data.blog.posts.length} journal articles`)
}

/* ================================================================== *
 * 6. Landing pages, policy pages and FAQs
 * ================================================================== */

async function seedContentPages(): Promise<void> {
  console.log('\nContent')

  for (const [index, page] of data.landingPages.entries()) {
    const collection = await prisma.collection.findUnique({
      where: { slug: page.collectionSlug },
      select: { id: true },
    })

    const base = {
      h1: page.h1,
      eyebrow: page.eyebrow,
      intro: page.intro,
      collectionId: collection?.id ?? null,
      productHeading: page.productHeading,
      sections: page.sections as never,
      faqs: page.faqs as never,
      internalLinks: page.internalLinks as never,
      bannerUrl: page.banner.url,
      bannerAlt: page.banner.alt,
      sortOrder: index,
      isActive: true,
    }

    await prisma.landingPage.upsert({
      where: { slug: page.slug },
      update: base,
      create: { slug: page.slug, ...base },
    })

    await upsertSeo('LANDING', page.slug, {
      title: page.metaTitle,
      description: page.metaDescription,
      priority: 0.8,
    })
  }
  step(`${data.landingPages.length} landing pages`)

  for (const policy of data.policies) {
    const base = {
      title: policy.title,
      eyebrow: policy.eyebrow,
      intro: policy.intro,
      sections: policy.sections as never,
      faqs: (policy.faqs ?? []) as never,
      updatedLabel: `Last updated ${policy.updated}`,
      status: 'PUBLISHED' as const,
      isSystem: true,
    }

    await prisma.page.upsert({
      where: { slug: policy.slug },
      update: base,
      create: { slug: policy.slug, ...base },
    })

    await upsertSeo('PAGE', policy.slug, {
      title: policy.metaTitle,
      description: policy.metaDescription,
      priority: 0.3,
    })
  }
  step(`${data.policies.length} policy pages`)

  // The FAQs page, assembled from the storefront's grouped general FAQs.
  await prisma.page.upsert({
    where: { slug: 'faqs' },
    update: {
      title: 'Frequently Asked Questions',
      sections: data.generalFaqs.map((group) => ({
        heading: group.heading,
        body: [],
        faqs: group.items,
      })) as never,
    },
    create: {
      slug: 'faqs',
      title: 'Frequently Asked Questions',
      eyebrow: 'Customer Care',
      intro:
        'Answers to the questions we are asked most — authenticity, delivery, returns, care and gifting.',
      sections: data.generalFaqs.map((group) => ({
        heading: group.heading,
        body: [],
        faqs: group.items,
      })) as never,
      status: 'PUBLISHED',
      isSystem: true,
    },
  })

  // Editorial pages whose copy lives in the components today; creating the rows
  // means the admin can edit them without touching the frontend.
  const editorialPages = [
    {
      slug: 'about',
      title: 'Our Story',
      eyebrow: 'Since 1978',
      intro:
        'Pushmina has woven Pashmina and Kashmiri textiles in Srinagar since 1978. Our story, our workshop and the families who make every piece.',
    },
    {
      slug: 'craftsmanship',
      title: 'Craftsmanship',
      eyebrow: 'Craftsmanship',
      intro:
        'How a Pushmina piece is made: hand-combing pashm in Ladakh, charkha spinning, handloom weaving, sozni and kani work, natural dyeing and certification.',
    },
    {
      slug: 'contact',
      title: 'Contact',
      eyebrow: 'Get in touch',
      intro:
        'Our care team is in Srinagar and answers within one working day. For commissions and corporate volumes, tell us your timeline in the message.',
    },
  ]

  for (const page of editorialPages) {
    await prisma.page.upsert({
      where: { slug: page.slug },
      update: {},
      create: { ...page, sections: [] as never, status: 'PUBLISHED', isSystem: true },
    })
  }
  step(`${editorialPages.length + 1} editorial pages`)
}

/* ================================================================== *
 * 7. Navigation, banners, homepage composition
 * ================================================================== */

async function seedNavigation(): Promise<void> {
  console.log('\nNavigation & merchandising')

  await prisma.navigationItem.deleteMany({})

  for (const [index, item] of data.navigation.primaryNav.entries()) {
    const parent = await prisma.navigationItem.create({
      data: {
        group: 'HEADER' as NavGroup,
        label: item.label,
        href: item.href,
        sortOrder: index,
        eyebrow: item.feature?.eyebrow ?? null,
        heading: item.feature?.heading ?? null,
        ctaLabel: item.feature?.ctaLabel ?? null,
        imageUrl: item.feature?.image.url ?? null,
        imageAlt: item.feature?.image.alt ?? null,
      },
    })

    let order = 0
    for (const column of item.columns ?? []) {
      for (const link of column.links) {
        await prisma.navigationItem.create({
          data: {
            group: 'HEADER' as NavGroup,
            parentId: parent.id,
            columnTitle: column.title,
            label: link.label,
            href: link.href,
            isHighlighted: link.highlight ?? false,
            sortOrder: order++,
          },
        })
      }
    }
  }

  for (const [index, column] of data.navigation.footerColumns.entries()) {
    const parent = await prisma.navigationItem.create({
      data: {
        group: 'FOOTER' as NavGroup,
        label: column.title,
        href: '#',
        columnTitle: column.title,
        sortOrder: index,
      },
    })

    for (const [linkIndex, link] of column.links.entries()) {
      await prisma.navigationItem.create({
        data: {
          group: 'FOOTER' as NavGroup,
          parentId: parent.id,
          columnTitle: column.title,
          label: link.label,
          href: link.href,
          sortOrder: linkIndex,
        },
      })
    }
  }
  step('header mega menu and footer columns')

  const banners: Array<{
    placement: BannerPlacement
    eyebrow?: string
    heading: string
    subheading?: string
    imageUrl: string
    imageAlt: string
    href: string
    ctaLabel: string
    secondaryHref?: string
    secondaryCtaLabel?: string
  }> = [
    {
      placement: 'HOME_HERO',
      heading: 'Where Heritage Meets Modern Luxury',
      imageUrl: '/images/editorial/hero-heritage.png',
      imageAlt:
        'A woman wearing an ivory Kashmiri Pashmina shawl in a heritage courtyard at dawn',
      href: '/collections/pure-pashmina',
      ctaLabel: 'Explore Collection',
      secondaryHref: '/craftsmanship',
      secondaryCtaLabel: 'Discover Our Craft',
    },
    {
      placement: 'HOME_FEATURED',
      eyebrow: 'Crafted for Generations',
      heading: 'Pure Pashmina',
      subheading:
        'Hand-combed at 4,500 metres, charkha-spun, and woven on a wooden handloom by weavers whose names are recorded on every certificate.',
      imageUrl: '/images/editorial/featured-pure-pashmina.png',
      imageAlt: 'A length of pure Pashmina cloth catching low light across its full drape',
      href: '/collections/pure-pashmina',
      ctaLabel: 'Discover the collection',
    },
    {
      placement: 'HOME_GIFTING',
      eyebrow: 'Gifting',
      heading: 'The Art of Gifting',
      subheading:
        'Thoughtfully crafted pieces for moments worth remembering, presented in a hand-bound box from a Srinagar bookbinder.',
      imageUrl: '/images/editorial/gifting-box.png',
      imageAlt: 'A Pushmina lacquered presentation box, muslin sleeve and craft certificate',
      href: '/collections/gifting',
      ctaLabel: 'Shop Gifts',
      secondaryHref: '/corporate-gifts',
      secondaryCtaLabel: 'Corporate Gifting',
    },
  ]

  for (const [index, banner] of banners.entries()) {
    const existing = await prisma.banner.findFirst({
      where: { placement: banner.placement },
      select: { id: true },
    })
    if (existing) {
      await prisma.banner.update({ where: { id: existing.id }, data: { ...banner, sortOrder: index } })
    } else {
      await prisma.banner.create({ data: { ...banner, sortOrder: index } })
    }
  }

  const categoryCards = [
    { label: 'Men', heading: 'Cut to hang, not to wrap', href: '/collections/mens-shawls', image: 'category-men' },
    { label: 'Women', heading: 'Six weeks on a single loom', href: '/collections/womens-shawls', image: 'category-women' },
    { label: 'Pashmina', heading: 'Nothing blended, nothing substituted', href: '/collections/pure-pashmina', image: 'category-pashmina' },
    { label: 'Gifting', heading: 'Presented in hand-bound boxes', href: '/collections/gifting', image: 'category-gifting' },
  ]

  await prisma.banner.deleteMany({ where: { placement: 'HOME_CATEGORY_CARD' } })
  await prisma.banner.createMany({
    data: categoryCards.map((card, index) => ({
      placement: 'HOME_CATEGORY_CARD' as BannerPlacement,
      eyebrow: card.label,
      heading: card.heading,
      imageUrl: `/images/categories/${card.image}.png`,
      imageAlt: `Pushmina ${card.label.toLowerCase()} collection`,
      href: card.href,
      ctaLabel: 'Explore',
      sortOrder: index,
    })),
  })
  step(`${banners.length + categoryCards.length} banners`)

  const sections = [
    { key: 'hero', type: 'hero' },
    { key: 'intro', type: 'intro', heading: 'The Art of Indian Craft' },
    { key: 'categories', type: 'categories' },
    { key: 'new-arrivals', type: 'carousel', heading: 'New Arrivals', subheading: 'Fresh expressions of timeless craftsmanship.', href: '/collections/new-arrivals', linkLabel: 'View all new arrivals' },
    { key: 'featured', type: 'featured' },
    { key: 'heritage', type: 'heritage', heading: 'The Soul of Pushmina' },
    { key: 'trending', type: 'grid', heading: 'Trending Now', subheading: 'The pieces moving fastest this season.', href: '/collections/best-sellers', linkLabel: 'View all' },
    { key: 'best-sellers', type: 'grid', heading: 'Most Loved', subheading: 'The pieces our customers return to, ranked by what actually sells.', href: '/collections/best-sellers', linkLabel: 'View all' },
    { key: 'gifting', type: 'gifting' },
    { key: 'trust', type: 'trust' },
    { key: 'recently-viewed', type: 'recently-viewed' },
    { key: 'social', type: 'social', heading: 'Follow the World of Pushmina' },
    { key: 'newsletter', type: 'newsletter', heading: 'Enter the World of Pushmina' },
  ]

  for (const [index, section] of sections.entries()) {
    await prisma.homepageSection.upsert({
      where: { key: section.key },
      update: { sortOrder: index },
      create: {
        key: section.key,
        type: section.type,
        heading: section.heading ?? null,
        subheading: section.subheading ?? null,
        href: section.href ?? null,
        linkLabel: section.linkLabel ?? null,
        sortOrder: index,
      },
    })
  }
  step(`${sections.length} homepage sections`)
}

/* ================================================================== *
 * 8. Settings, SEO, coupons
 * ================================================================== */

async function upsertSeo(
  entityType: 'HOME' | 'PAGE' | 'LANDING' | 'BLOG_INDEX',
  entityId: string | null,
  values: { title: string; description: string; priority?: number },
): Promise<void> {
  const existing = await prisma.seoMeta.findFirst({ where: { entityType, entityId } })
  const payload = {
    title: values.title,
    description: values.description,
    priority: values.priority ?? 0.7,
  }

  if (existing) {
    await prisma.seoMeta.update({ where: { id: existing.id }, data: payload })
  } else {
    await prisma.seoMeta.create({ data: { entityType, entityId, ...payload } })
  }
}

async function seedSettingsAndSeo(): Promise<void> {
  console.log('\nSettings & SEO')

  const site = data.site
  const settings: Array<{ key: string; value: unknown; group: string; label: string }> = [
    { key: 'site.name', value: site.name, group: 'general', label: 'Site name' },
    { key: 'site.legalName', value: site.legalName, group: 'general', label: 'Legal name' },
    { key: 'site.tagline', value: site.tagline, group: 'general', label: 'Tagline' },
    { key: 'site.description', value: site.description, group: 'general', label: 'Description' },
    { key: 'site.email', value: site.email, group: 'contact', label: 'Support email' },
    { key: 'site.phone', value: site.phone, group: 'contact', label: 'Telephone' },
    { key: 'site.address', value: site.address, group: 'contact', label: 'Workshop address' },
    { key: 'site.founded', value: site.founded, group: 'general', label: 'Founded' },
    { key: 'site.social', value: site.social, group: 'social', label: 'Social profiles' },
    { key: 'site.announcements', value: site.announcements, group: 'marketing', label: 'Announcement bar' },
    { key: 'site.trustSignals', value: site.trustSignals, group: 'marketing', label: 'Trust signals' },
    { key: 'site.popularSearches', value: data.navigation.popularSearches, group: 'marketing', label: 'Popular searches' },
    { key: 'commerce.freeShippingThreshold', value: 4999, group: 'commerce', label: 'Free shipping above' },
    { key: 'commerce.standardShippingFee', value: 149, group: 'commerce', label: 'Standard shipping fee' },
    { key: 'commerce.expressShippingFee', value: 399, group: 'commerce', label: 'Express shipping fee' },
    { key: 'commerce.gstRate', value: 0.05, group: 'commerce', label: 'GST rate (included in price)' },
    { key: 'commerce.codLimit', value: 20000, group: 'commerce', label: 'Cash on delivery limit' },
    { key: 'commerce.returnWindowDays', value: 14, group: 'commerce', label: 'Returns window (days)' },
    { key: 'commerce.currency', value: 'INR', group: 'commerce', label: 'Currency' },
  ]

  for (const setting of settings) {
    await prisma.siteSetting.upsert({
      where: { key: setting.key },
      update: { value: setting.value as never, group: setting.group, label: setting.label },
      create: {
        key: setting.key,
        value: setting.value as never,
        group: setting.group,
        label: setting.label,
      },
    })
  }
  step(`${settings.length} site settings`)

  await upsertSeo('HOME', null, {
    title: 'Pushmina | Luxury Pashmina, Shawls & Indian Craftsmanship',
    description: String(site.description),
    priority: 1,
  })
  await upsertSeo('BLOG_INDEX', null, {
    title: 'Journal — Pashmina Guides & Kashmiri Craft | Pushmina',
    description:
      'The Pushmina Journal — guides to Pashmina, Kashmiri craft and Indian textiles, written by the people who make them.',
    priority: 0.8,
  })
  step('SEO defaults for home, journal, landing and policy pages')

  const coupons = [
    {
      code: 'HERITAGE10',
      label: '10% off your order',
      type: 'PERCENT' as const,
      value: 10,
      minimumSubtotal: null,
    },
    {
      code: 'WELCOME500',
      label: '₹500 off orders above ₹5,000',
      type: 'FIXED' as const,
      value: 500,
      minimumSubtotal: 5000,
    },
  ]

  for (const coupon of coupons) {
    await prisma.coupon.upsert({
      where: { code: coupon.code },
      update: { label: coupon.label, type: coupon.type, value: coupon.value },
      create: coupon,
    })
  }
  step(`${coupons.length} coupons`)
}

/* ================================================================== *
 * 9. A demo customer, so the account area has something to show
 * ================================================================== */

async function seedDemoCustomer(): Promise<void> {
  console.log('\nDemo customer')

  const user = await prisma.user.upsert({
    where: { email: 'ananya@example.com' },
    update: {},
    create: {
      email: 'ananya@example.com',
      passwordHash: await bcrypt.hash('Customer@12345', 12),
      firstName: 'Ananya',
      lastName: 'Raghunathan',
      phone: '+91 98100 00000',
      emailVerified: true,
      acceptsMarketing: true,
    },
    select: { id: true },
  })

  const existingAddresses = await prisma.address.count({ where: { userId: user.id } })
  if (existingAddresses === 0) {
    await prisma.address.createMany({
      data: [
        {
          userId: user.id,
          label: 'Home',
          fullName: 'Ananya Raghunathan',
          line1: '14 Rani Jhansi Marg, Flat 302',
          line2: 'Civil Lines',
          city: 'New Delhi',
          state: 'Delhi',
          postalCode: '110054',
          country: 'India',
          phone: '+91 98100 00000',
          isDefault: true,
        },
        {
          userId: user.id,
          label: 'Office',
          fullName: 'Ananya Raghunathan',
          line1: 'Prestige Tower, 9th Floor',
          line2: 'Residency Road',
          city: 'Bengaluru',
          state: 'Karnataka',
          postalCode: '560025',
          country: 'India',
          phone: '+91 98100 00000',
        },
      ],
    })
  }

  step('ananya@example.com / Customer@12345')
}

/* ================================================================== */

async function main(): Promise<void> {
  console.log('\n─────────────────────────────────────────────')
  console.log(' Seeding Pushmina database')
  console.log('─────────────────────────────────────────────')

  await seedAccessControl()
  await seedTaxonomy()
  await seedCollections()
  await seedProducts()
  await seedBlog()
  await seedContentPages()
  await seedNavigation()
  await seedSettingsAndSeo()
  await seedDemoCustomer()

  const counts = {
    products: await prisma.product.count(),
    variants: await prisma.productVariant.count(),
    collections: await prisma.collection.count(),
    colors: await prisma.color.count(),
    posts: await prisma.blogPost.count(),
    pages: await prisma.page.count(),
    landingPages: await prisma.landingPage.count(),
    admins: await prisma.adminUser.count(),
  }

  console.log('\n─────────────────────────────────────────────')
  console.log(' Seed complete')
  console.log('─────────────────────────────────────────────')
  for (const [key, value] of Object.entries(counts)) {
    console.log(`  ${key.padEnd(14)} ${value}`)
  }
  console.log(
    `\n  Admin login → ${process.env.SEED_ADMIN_EMAIL ?? 'admin@pushmina.com'}` +
      ` / ${process.env.SEED_ADMIN_PASSWORD ?? 'Admin@12345'}`,
  )
  console.log('  Change that password after first sign-in.\n')
}

main()
  .catch((error) => {
    console.error('\nSeed failed:\n', error)
    process.exit(1)
  })
  .finally(() => void prisma.$disconnect())

// Keeps `crypto` imported for future token seeding without an unused warning.
void crypto
