import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../db/prisma'
import { optionalAuth, requireAuth } from '../../middleware/authenticate'
import { validateBody, validateQuery, validated } from '../../middleware/validate'
import { publicWriteLimiter } from '../../middleware/rate-limit'
import { asyncHandler } from '../../utils/async-handler'
import { created, ok, paginated } from '../../utils/response'
import { BadRequestError, NotFoundError } from '../../utils/errors'
import { notifyAdmins } from '../notifications/notification.service'

export const reviewRouter = Router()

/**
 * Recomputes a product's rating from its approved reviews.
 *
 * The storefront gates both the visible star rating and the AggregateRating
 * JSON-LD on this data, so when the last approved review is removed the count
 * returns to zero and both disappear — rather than leaving a stale score that
 * no longer has any reviews behind it.
 */
async function recomputeRating(productId: string): Promise<void> {
  const result = await prisma.review.aggregate({
    where: { productId, status: 'APPROVED' },
    _avg: { rating: true },
    _count: true,
  })

  await prisma.product.update({
    where: { id: productId },
    data: {
      ratingAverage: result._count > 0 ? (result._avg.rating ?? 0) : null,
      ratingCount: result._count,
    },
  })
}

export { recomputeRating }

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  sort: z.enum(['newest', 'highest', 'lowest']).default('newest'),
})

/* Public: approved reviews for a product ---------------------------- */
reviewRouter.get(
  '/product/:slug',
  validateQuery(listQuery),
  asyncHandler(async (req, res) => {
    const query = validated<z.infer<typeof listQuery>>(req)

    const product = await prisma.product.findUnique({
      where: { slug: req.params.slug },
      select: { id: true, ratingAverage: true, ratingCount: true },
    })
    if (!product) throw new NotFoundError('Product')

    const where = { productId: product.id, status: 'APPROVED' as const }
    const orderBy =
      query.sort === 'highest'
        ? { rating: 'desc' as const }
        : query.sort === 'lowest'
          ? { rating: 'asc' as const }
          : { createdAt: 'desc' as const }

    const [reviews, total, breakdown] = await Promise.all([
      prisma.review.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          authorName: true,
          rating: true,
          title: true,
          body: true,
          isVerifiedPurchase: true,
          adminReply: true,
          createdAt: true,
        },
      }),
      prisma.review.count({ where }),
      prisma.review.groupBy({ by: ['rating'], where, _count: true }),
    ])

    return paginated(res, reviews, total, query.page, query.limit, {
      summary: {
        average: product.ratingAverage ? Number(product.ratingAverage) : null,
        count: product.ratingCount,
        breakdown: [5, 4, 3, 2, 1].map((star) => ({
          rating: star,
          count: breakdown.find((entry) => entry.rating === star)?._count ?? 0,
        })),
      },
    })
  }),
)

/* Submit a review --------------------------------------------------- */
const createSchema = z.object({
  slug: z.string().min(1),
  rating: z.coerce.number().int().min(1, 'Choose a rating.').max(5),
  title: z.string().trim().min(3, 'Please add a short title.').max(120),
  body: z.string().trim().min(10, 'Please tell us a little more.').max(3000),
  authorName: z.string().trim().min(2).max(80).optional(),
  authorEmail: z.string().trim().toLowerCase().email().optional(),
})

reviewRouter.post(
  '/',
  optionalAuth,
  publicWriteLimiter,
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof createSchema>

    const product = await prisma.product.findUnique({
      where: { slug: input.slug },
      select: { id: true, name: true },
    })
    if (!product) throw new NotFoundError('Product')

    if (!req.user && !input.authorName) {
      throw new BadRequestError('Please tell us your name.')
    }

    // One review per customer per product.
    if (req.user) {
      const existing = await prisma.review.findFirst({
        where: { productId: product.id, userId: req.user.id },
        select: { id: true },
      })
      if (existing) {
        throw new BadRequestError('You have already reviewed this piece.')
      }
    }

    /* A "verified purchase" badge is only awarded when the account genuinely
       has a delivered order containing this product — never on the customer's
       say-so. */
    let isVerifiedPurchase = false
    if (req.user) {
      const purchased = await prisma.orderItem.findFirst({
        where: {
          productId: product.id,
          order: { userId: req.user.id, status: { in: ['DELIVERED', 'SHIPPED'] } },
        },
        select: { id: true },
      })
      isVerifiedPurchase = Boolean(purchased)
    }

    const review = await prisma.review.create({
      data: {
        productId: product.id,
        userId: req.user?.id,
        authorName: req.user ? `${req.user.firstName} ${req.user.lastName}` : input.authorName!,
        authorEmail: req.user?.email ?? input.authorEmail,
        rating: input.rating,
        title: input.title,
        body: input.body,
        isVerifiedPurchase,
        // Held for moderation: published reviews are visible to everyone and
        // feed structured data, so they are approved by a human first.
        status: 'PENDING',
      },
    })

    await notifyAdmins({
      type: 'ADMIN_NEW_REVIEW',
      title: 'New review awaiting moderation',
      body: `${review.rating}★ on ${product.name} — "${review.title}"`,
      link: `/reviews/${review.id}`,
      data: { reviewId: review.id, productId: product.id },
      permission: 'reviews.moderate',
    })

    return created(res, {
      id: review.id,
      message: 'Thank you. Your review will appear once it has been checked.',
    })
  }),
)

/* A customer's own reviews ------------------------------------------ */
reviewRouter.get(
  '/mine',
  requireAuth,
  asyncHandler(async (req, res) => {
    const reviews = await prisma.review.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      include: { product: { select: { slug: true, name: true } } },
    })
    return ok(res, reviews)
  }),
)
