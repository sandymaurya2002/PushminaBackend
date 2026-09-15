import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../db/prisma'
import { requirePermission } from '../../middleware/authorize'
import { validateBody, validateQuery, validated } from '../../middleware/validate'
import { asyncHandler } from '../../utils/async-handler'
import { created, noContent, ok, paginated } from '../../utils/response'
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/errors'
import { toSlug, uniqueSlug } from '../../utils/slug'
import { audit } from './audit'
import { createCrudRouter } from './crud-factory'
import { deleteSeoFor } from '../seo/seo.service'

export const adminBlogRouter = Router()

/* ------------------------------------------------------------------ *
 * Tags
 * ------------------------------------------------------------------ */

adminBlogRouter.use(
  '/tags',
  createCrudRouter({
    model: 'blogTag',
    label: 'Tag',
    permissions: {
      view: 'blog.view',
      create: 'blog.create',
      update: 'blog.update',
      delete: 'blog.delete',
    },
    countRelation: 'posts',
    searchFields: ['name', 'slug'],
    createSchema: z.object({
      name: z.string().trim().min(1, 'Give the tag a name.').max(60),
      slug: z.string().trim().max(60).optional(),
    }),
    updateSchema: z.object({
      name: z.string().trim().min(1).max(60).optional(),
      slug: z.string().trim().max(60).optional(),
    }),
  }),
)

/* ------------------------------------------------------------------ *
 * Categories
 * ------------------------------------------------------------------ */

const categoryBody = z.object({
  name: z.string().trim().min(1, 'Give the category a name.').max(80),
  slug: z.string().trim().max(80).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  sortOrder: z.coerce.number().int().default(0),
  isActive: z.boolean().default(true),
})

adminBlogRouter.get(
  '/categories',
  requirePermission('blog.view'),
  asyncHandler(async (_req, res) => {
    const categories = await prisma.blogCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { posts: true } } },
    })
    return ok(res, categories)
  }),
)

adminBlogRouter.post(
  '/categories',
  requirePermission('blog.create'),
  validateBody(categoryBody),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof categoryBody>
    const slug = await uniqueSlug(input.slug || input.name, async (candidate) =>
      Boolean(
        await prisma.blogCategory.findUnique({ where: { slug: candidate }, select: { id: true } }),
      ),
    )
    const category = await prisma.blogCategory.create({ data: { ...input, slug } })
    await audit(req, 'created', 'BlogCategory', category.id, null, category)
    return created(res, category)
  }),
)

adminBlogRouter.patch(
  '/categories/:id',
  requirePermission('blog.update'),
  validateBody(categoryBody.partial()),
  asyncHandler(async (req, res) => {
    const category = await prisma.blogCategory.update({
      where: { id: req.params.id },
      data: req.body,
    })
    await audit(req, 'updated', 'BlogCategory', category.id, null, category)
    return ok(res, category)
  }),
)

adminBlogRouter.delete(
  '/categories/:id',
  requirePermission('blog.delete'),
  asyncHandler(async (req, res) => {
    const category = await prisma.blogCategory.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { posts: true } } },
    })
    if (!category) throw new NotFoundError('Category')
    if (category._count.posts > 0) {
      throw new ConflictError(
        `${category._count.posts} article(s) are in this category. Move them first.`,
      )
    }

    await prisma.blogCategory.delete({ where: { id: req.params.id } })
    await audit(req, 'deleted', 'BlogCategory', req.params.id, category, null)
    return noContent(res)
  }),
)

/* ------------------------------------------------------------------ *
 * Posts
 * ------------------------------------------------------------------ */

/**
 * Article bodies are typed blocks, never raw HTML.
 *
 * That keeps the markup semantic, keeps the heading hierarchy from skipping a
 * level, and removes an entire class of stored-XSS risk — there is no place for
 * a `<script>` to live in the first place.
 */
const blockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), text: z.string().max(5000) }),
  z.object({ type: z.literal('heading'), text: z.string().max(300) }),
  z.object({ type: z.literal('subheading'), text: z.string().max(300) }),
  z.object({ type: z.literal('list'), items: z.array(z.string().max(1000)).max(50) }),
  z.object({
    type: z.literal('quote'),
    text: z.string().max(1000),
    attribution: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal('productLink'),
    slug: z.string().max(160),
    label: z.string().max(200),
  }),
  z.object({
    type: z.literal('collectionLink'),
    slug: z.string().max(160),
    label: z.string().max(200),
  }),
  z.object({
    type: z.literal('image'),
    url: z.string().max(500),
    alt: z.string().max(300),
    caption: z.string().max(300).optional(),
  }),
])

const postBody = z.object({
  slug: z.string().trim().max(160).optional(),
  title: z.string().trim().min(1, 'A title is required.').max(200),
  excerpt: z.string().trim().min(1, 'An excerpt is required.').max(600),
  categoryId: z.string().min(1, 'Choose a category.'),
  authorName: z.string().trim().max(120).default('Pushmina Editorial'),
  coverUrl: z.string().trim().max(500).nullable().optional(),
  coverAlt: z.string().trim().max(300).nullable().optional(),
  blocks: z.array(blockSchema).default([]),
  readingMinutes: z.coerce.number().int().min(1).max(120).default(5),
  status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']).default('DRAFT'),
  publishedAt: z.coerce.date().nullable().optional(),
  scheduledAt: z.coerce.date().nullable().optional(),
  tagIds: z.array(z.string()).default([]),
  relatedProductIds: z.array(z.string()).default([]),
  relatedCollectionIds: z.array(z.string()).default([]),
  faqs: z
    .array(z.object({ question: z.string().trim().max(300), answer: z.string().trim().max(2000) }))
    .default([]),
})

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(160).optional(),
  status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']).optional(),
  categoryId: z.string().optional(),
})

adminBlogRouter.get(
  '/posts',
  requirePermission('blog.view'),
  validateQuery(listQuery),
  asyncHandler(async (req, res) => {
    const query = validated<z.infer<typeof listQuery>>(req)

    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' as const } },
              { excerpt: { contains: query.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    }

    const [posts, total] = await Promise.all([
      prisma.blogPost.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          slug: true,
          title: true,
          excerpt: true,
          status: true,
          publishedAt: true,
          scheduledAt: true,
          coverUrl: true,
          readingMinutes: true,
          viewCount: true,
          authorName: true,
          createdAt: true,
          category: { select: { id: true, name: true } },
        },
      }),
      prisma.blogPost.count({ where }),
    ])

    return paginated(res, posts, total, query.page, query.limit)
  }),
)

adminBlogRouter.get(
  '/posts/:id',
  requirePermission('blog.view'),
  asyncHandler(async (req, res) => {
    const post = await prisma.blogPost.findUnique({
      where: { id: req.params.id },
      include: {
        tags: { select: { tagId: true } },
        faqs: { orderBy: { sortOrder: 'asc' } },
        products: { select: { productId: true }, orderBy: { sortOrder: 'asc' } },
        collections: { select: { collectionId: true }, orderBy: { sortOrder: 'asc' } },
      },
    })
    if (!post) throw new NotFoundError('Article')

    const seo = await prisma.seoMeta.findFirst({
      where: { entityType: 'BLOG_POST', entityId: post.id },
    })

    return ok(res, {
      ...post,
      tagIds: post.tags.map((entry) => entry.tagId),
      relatedProductIds: post.products.map((entry) => entry.productId),
      relatedCollectionIds: post.collections.map((entry) => entry.collectionId),
      seo,
    })
  }),
)

async function writePostRelations(
  postId: string,
  input: z.infer<typeof postBody>,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.blogPostTag.deleteMany({ where: { postId } })
    if (input.tagIds.length) {
      await tx.blogPostTag.createMany({
        data: input.tagIds.map((tagId) => ({ postId, tagId })),
        skipDuplicates: true,
      })
    }

    await tx.blogFaq.deleteMany({ where: { postId } })
    if (input.faqs.length) {
      await tx.blogFaq.createMany({
        data: input.faqs.map((faq, index) => ({ postId, ...faq, sortOrder: index })),
      })
    }

    await tx.blogPostProduct.deleteMany({ where: { postId } })
    if (input.relatedProductIds.length) {
      await tx.blogPostProduct.createMany({
        data: input.relatedProductIds.map((productId, index) => ({
          postId,
          productId,
          sortOrder: index,
        })),
        skipDuplicates: true,
      })
    }

    await tx.blogPostCollection.deleteMany({ where: { postId } })
    if (input.relatedCollectionIds.length) {
      await tx.blogPostCollection.createMany({
        data: input.relatedCollectionIds.map((collectionId, index) => ({
          postId,
          collectionId,
          sortOrder: index,
        })),
        skipDuplicates: true,
      })
    }
  })
}

/** A scheduled post must actually carry a future date, or it will never run. */
function resolvePublishDates(input: z.infer<typeof postBody>, existing?: { publishedAt: Date | null }) {
  if (input.status === 'SCHEDULED') {
    if (!input.scheduledAt) {
      throw new BadRequestError('Choose a date and time to publish this article.')
    }
    if (input.scheduledAt <= new Date()) {
      throw new BadRequestError('The scheduled time must be in the future.')
    }
    return { publishedAt: null, scheduledAt: input.scheduledAt }
  }

  if (input.status === 'PUBLISHED') {
    return {
      publishedAt: input.publishedAt ?? existing?.publishedAt ?? new Date(),
      scheduledAt: null,
    }
  }

  return { publishedAt: existing?.publishedAt ?? null, scheduledAt: null }
}

adminBlogRouter.post(
  '/posts',
  requirePermission('blog.create'),
  validateBody(postBody),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof postBody>

    const slug = await uniqueSlug(input.slug || input.title, async (candidate) =>
      Boolean(await prisma.blogPost.findUnique({ where: { slug: candidate }, select: { id: true } })),
    )

    const dates = resolvePublishDates(input)

    const post = await prisma.blogPost.create({
      data: {
        slug,
        title: input.title,
        excerpt: input.excerpt,
        categoryId: input.categoryId,
        authorId: req.admin!.id,
        authorName: input.authorName,
        coverUrl: input.coverUrl ?? null,
        coverAlt: input.coverAlt ?? null,
        blocks: input.blocks as never,
        readingMinutes: input.readingMinutes,
        status: input.status,
        ...dates,
      },
    })

    await writePostRelations(post.id, input)
    await audit(req, 'created', 'BlogPost', post.id, null, { title: post.title, slug })

    return created(res, post)
  }),
)

adminBlogRouter.put(
  '/posts/:id',
  requirePermission('blog.update'),
  validateBody(postBody),
  asyncHandler(async (req, res) => {
    const existing = await prisma.blogPost.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new NotFoundError('Article')

    const input = req.body as z.infer<typeof postBody>

    let slug = existing.slug
    if (input.slug && input.slug !== existing.slug) {
      slug = await uniqueSlug(toSlug(input.slug), async (candidate) =>
        Boolean(
          await prisma.blogPost.findFirst({
            where: { slug: candidate, NOT: { id: req.params.id } },
            select: { id: true },
          }),
        ),
      )
    }

    const dates = resolvePublishDates(input, existing)

    const post = await prisma.blogPost.update({
      where: { id: req.params.id },
      data: {
        slug,
        title: input.title,
        excerpt: input.excerpt,
        categoryId: input.categoryId,
        authorName: input.authorName,
        coverUrl: input.coverUrl ?? null,
        coverAlt: input.coverAlt ?? null,
        blocks: input.blocks as never,
        readingMinutes: input.readingMinutes,
        status: input.status,
        ...dates,
      },
    })

    await writePostRelations(post.id, input)
    await audit(req, 'updated', 'BlogPost', post.id, existing, post)

    return ok(res, post)
  }),
)

adminBlogRouter.patch(
  '/posts/:id/status',
  requirePermission('blog.publish'),
  validateBody(
    z.object({
      status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']),
      scheduledAt: z.coerce.date().nullable().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const existing = await prisma.blogPost.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new NotFoundError('Article')

    const body = req.body as { status: 'DRAFT' | 'SCHEDULED' | 'PUBLISHED' | 'ARCHIVED'; scheduledAt?: Date | null }

    if (body.status === 'SCHEDULED') {
      if (!body.scheduledAt) throw new BadRequestError('Choose a date and time to publish.')
      if (body.scheduledAt <= new Date()) {
        throw new BadRequestError('The scheduled time must be in the future.')
      }
    }

    const post = await prisma.blogPost.update({
      where: { id: req.params.id },
      data: {
        status: body.status,
        scheduledAt: body.status === 'SCHEDULED' ? body.scheduledAt : null,
        publishedAt:
          body.status === 'PUBLISHED' ? (existing.publishedAt ?? new Date()) : existing.publishedAt,
      },
    })

    await audit(req, body.status.toLowerCase(), 'BlogPost', post.id, existing, post)
    return ok(res, post)
  }),
)

adminBlogRouter.delete(
  '/posts/:id',
  requirePermission('blog.delete'),
  asyncHandler(async (req, res) => {
    const post = await prisma.blogPost.findUnique({ where: { id: req.params.id } })
    if (!post) throw new NotFoundError('Article')

    await prisma.blogPost.delete({ where: { id: req.params.id } })
    await deleteSeoFor('BLOG_POST', req.params.id)
    await audit(req, 'deleted', 'BlogPost', req.params.id, post, null)

    return noContent(res)
  }),
)
