import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../db/prisma'
import { validateQuery, validated } from '../../middleware/validate'
import { asyncHandler } from '../../utils/async-handler'
import { ok, paginated } from '../../utils/response'
import { NotFoundError } from '../../utils/errors'
import { productInclude, toProductCardDto, type ProductWithRelations } from '../catalog/catalog.dto'

export const blogRouter = Router()

/**
 * Only published posts are ever exposed. A post scheduled for the future stays
 * invisible until the scheduler promotes it (jobs/publish-scheduled-posts.ts).
 */
const PUBLISHED = {
  status: 'PUBLISHED' as const,
  publishedAt: { lte: new Date() },
}

function toPostDto(post: {
  slug: string
  title: string
  excerpt: string
  authorName: string
  publishedAt: Date | null
  updatedAt: Date
  readingMinutes: number
  coverUrl: string | null
  coverAlt: string | null
  blocks: unknown
  viewCount: number
  category: { slug: string; name: string }
  tags?: Array<{ tag: { slug: string; name: string } }>
  faqs?: Array<{ question: string; answer: string }>
}) {
  return {
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    category: post.category.slug,
    categoryName: post.category.name,
    author: post.authorName,
    publishedAt: (post.publishedAt ?? new Date()).toISOString().slice(0, 10),
    updatedAt: post.updatedAt.toISOString().slice(0, 10),
    readingMinutes: post.readingMinutes,
    cover: {
      url: post.coverUrl ?? '',
      alt: post.coverAlt ?? post.title,
      width: 1200,
      height: 750,
    },
    blocks: post.blocks,
    tags: post.tags?.map((entry) => entry.tag) ?? [],
    faqs: post.faqs?.map((faq) => ({ question: faq.question, answer: faq.answer })) ?? [],
    viewCount: post.viewCount,
  }
}

const listQuery = z.object({
  category: z.string().optional(),
  tag: z.string().optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
})

/* Categories -------------------------------------------------------- */
blogRouter.get(
  '/categories',
  asyncHandler(async (_req, res) => {
    const categories = await prisma.blogCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { posts: { where: PUBLISHED } } } },
    })
    return ok(
      res,
      categories.map((category) => ({
        slug: category.slug,
        name: category.name,
        description: category.description ?? '',
        postCount: category._count.posts,
      })),
    )
  }),
)

/* Post list --------------------------------------------------------- */
blogRouter.get(
  '/',
  validateQuery(listQuery),
  asyncHandler(async (req, res) => {
    const query = validated<z.infer<typeof listQuery>>(req)

    const where = {
      ...PUBLISHED,
      ...(query.category ? { category: { slug: query.category } } : {}),
      ...(query.tag ? { tags: { some: { tag: { slug: query.tag } } } } : {}),
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
        include: { category: true, tags: { include: { tag: true } } },
        orderBy: { publishedAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.blogPost.count({ where }),
    ])

    return paginated(res, posts.map(toPostDto), total, query.page, query.limit)
  }),
)

/* Single post ------------------------------------------------------- */
blogRouter.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const post = await prisma.blogPost.findFirst({
      where: { slug: req.params.slug, ...PUBLISHED },
      include: {
        category: true,
        tags: { include: { tag: true } },
        faqs: { orderBy: { sortOrder: 'asc' } },
        products: {
          orderBy: { sortOrder: 'asc' },
          include: { product: { include: productInclude } },
        },
        collections: {
          orderBy: { sortOrder: 'asc' },
          include: { collection: { select: { slug: true, name: true } } },
        },
      },
    })
    if (!post) throw new NotFoundError('Article')

    // Fire-and-forget: a view counter must never delay or fail the response.
    void prisma.blogPost
      .update({ where: { id: post.id }, data: { viewCount: { increment: 1 } } })
      .catch(() => undefined)

    const related = await prisma.blogPost.findMany({
      where: { ...PUBLISHED, id: { not: post.id } },
      include: { category: true },
      orderBy: [{ categoryId: post.categoryId === undefined ? 'asc' : 'asc' }, { publishedAt: 'desc' }],
      take: 3,
    })

    return ok(res, {
      ...toPostDto(post),
      relatedProducts: post.products.map((entry) =>
        toProductCardDto(entry.product as unknown as ProductWithRelations),
      ),
      relatedCollections: post.collections.map((entry) => entry.collection),
      relatedPosts: related.map(toPostDto),
    })
  }),
)
