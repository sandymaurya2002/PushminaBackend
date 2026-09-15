import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../db/prisma'
import { requirePermission } from '../../middleware/authorize'
import { validateQuery, validated } from '../../middleware/validate'
import { asyncHandler } from '../../utils/async-handler'
import { ok } from '../../utils/response'
import { toNumber } from '../../utils/money'
import { productInclude, toProductCardDto, type ProductWithRelations } from '../catalog/catalog.dto'

export const dashboardRouter = Router()

const rangeQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
})

/**
 * Dashboard metrics.
 *
 * Revenue counts only CAPTURED payments, net of completed refunds — an order
 * that was placed but never paid, or later refunded, is not revenue, and a
 * dashboard that says otherwise is worse than no dashboard.
 */
dashboardRouter.get(
  '/',
  requirePermission('dashboard.view'),
  validateQuery(rangeQuery),
  asyncHandler(async (req, res) => {
    const { days } = validated<{ days: number }>(req)
    const since = new Date(Date.now() - days * 86_400_000)
    const previousSince = new Date(Date.now() - days * 2 * 86_400_000)

    const [
      totalUsers,
      newUsers,
      totalProducts,
      publishedProducts,
      totalOrders,
      ordersInRange,
      ordersPrevious,
      capturedAgg,
      capturedPreviousAgg,
      refundedAgg,
      paymentCounts,
      pendingPaymentsAgg,
      lowStockCount,
      outOfStockCount,
      pendingReviews,
      newContact,
      subscribers,
    ] = await Promise.all([
      prisma.user.count({ where: { status: 'ACTIVE' } }),
      prisma.user.count({ where: { createdAt: { gte: since } } }),
      prisma.product.count(),
      prisma.product.count({ where: { status: 'PUBLISHED' } }),
      prisma.order.count(),
      prisma.order.count({ where: { placedAt: { gte: since } } }),
      prisma.order.count({ where: { placedAt: { gte: previousSince, lt: since } } }),
      prisma.payment.aggregate({
        where: { status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] }, capturedAt: { gte: since } },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.payment.aggregate({
        where: {
          status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] },
          capturedAt: { gte: previousSince, lt: since },
        },
        _sum: { amount: true },
      }),
      prisma.refund.aggregate({
        where: { status: 'COMPLETED', completedAt: { gte: since } },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.payment.groupBy({ by: ['status'], _count: true }),
      prisma.payment.aggregate({
        where: { status: { in: ['CREATED', 'PENDING', 'AUTHORIZED'] } },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.product.count({
        where: { status: 'PUBLISHED', variants: { every: { inventory: { lte: 6 } } } },
      }),
      prisma.product.count({
        where: { status: 'PUBLISHED', variants: { every: { inventory: 0 } } },
      }),
      prisma.review.count({ where: { status: 'PENDING' } }),
      prisma.contactSubmission.count({ where: { status: 'NEW' } }),
      prisma.newsletterSubscriber.count({ where: { status: 'SUBSCRIBED' } }),
    ])

    const grossRevenue = toNumber(capturedAgg._sum.amount)
    const refundedTotal = toNumber(refundedAgg._sum.amount)
    const netRevenue = Math.max(0, grossRevenue - refundedTotal)
    const previousRevenue = toNumber(capturedPreviousAgg._sum.amount)

    const percentChange = (current: number, previous: number): number | null =>
      previous === 0 ? null : Math.round(((current - previous) / previous) * 100)

    const statusCount = (status: string) =>
      paymentCounts.find((entry) => entry.status === status)?._count ?? 0

    /* Revenue by day, for the chart. Built from captured payments rather than
       orders so it reflects money actually received. */
    const dailyRows = await prisma.$queryRaw<Array<{ day: Date; total: number; orders: bigint }>>`
      SELECT DATE_TRUNC('day', "capturedAt") AS day,
             SUM("amount")::float8          AS total,
             COUNT(DISTINCT "orderId")      AS orders
      FROM payments
      WHERE "status" IN ('CAPTURED', 'PARTIALLY_REFUNDED')
        AND "capturedAt" >= ${since}
      GROUP BY 1
      ORDER BY 1 ASC
    `

    const [recentOrders, recentNotifications, trending, topProducts] = await Promise.all([
      prisma.order.findMany({
        orderBy: { placedAt: 'desc' },
        take: 8,
        select: {
          id: true,
          orderNumber: true,
          email: true,
          status: true,
          total: true,
          placedAt: true,
          items: { select: { name: true, quantity: true }, take: 3 },
        },
      }),
      prisma.notification.findMany({
        where: { audience: 'ADMIN', adminUserId: req.admin!.id },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
      prisma.product.findMany({
        where: { status: 'PUBLISHED', isTrending: true },
        include: productInclude,
        orderBy: { trendingOrder: 'asc' },
        take: 6,
      }),
      prisma.orderItem.groupBy({
        by: ['productId', 'name'],
        where: { order: { placedAt: { gte: since }, status: { not: 'CANCELLED' } } },
        _sum: { quantity: true, lineTotal: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 8,
      }),
    ])

    return ok(res, {
      range: { days, since: since.toISOString() },

      totals: {
        users: totalUsers,
        newUsers,
        products: totalProducts,
        publishedProducts,
        orders: totalOrders,
        ordersInRange,
        subscribers,
      },

      revenue: {
        gross: grossRevenue,
        refunded: refundedTotal,
        net: netRevenue,
        currency: 'INR',
        changePercent: percentChange(grossRevenue, previousRevenue),
        averageOrderValue:
          capturedAgg._count > 0 ? Math.round(grossRevenue / capturedAgg._count) : 0,
        ordersChangePercent: percentChange(ordersInRange, ordersPrevious),
      },

      payments: {
        successful: statusCount('CAPTURED'),
        pending: statusCount('PENDING') + statusCount('CREATED') + statusCount('AUTHORIZED'),
        pendingAmount: toNumber(pendingPaymentsAgg._sum.amount),
        failed: statusCount('FAILED'),
        refunded: statusCount('REFUNDED') + statusCount('PARTIALLY_REFUNDED'),
        refundCount: refundedAgg._count,
        refundAmount: refundedTotal,
      },

      alerts: {
        lowStock: lowStockCount,
        outOfStock: outOfStockCount,
        pendingReviews,
        newContactSubmissions: newContact,
      },

      chart: dailyRows.map((row) => ({
        date: row.day.toISOString().slice(0, 10),
        revenue: Number(row.total ?? 0),
        orders: Number(row.orders ?? 0),
      })),

      recentOrders: recentOrders.map((order) => ({
        ...order,
        total: toNumber(order.total),
      })),

      recentNotifications,

      trendingProducts: (trending as ProductWithRelations[]).map(toProductCardDto),

      topProducts: topProducts.map((entry) => ({
        productId: entry.productId,
        name: entry.name,
        unitsSold: entry._sum.quantity ?? 0,
        revenue: toNumber(entry._sum.lineTotal),
      })),
    })
  }),
)

/** Order counts by status, for the orders page filter chips. */
dashboardRouter.get(
  '/order-stats',
  requirePermission('orders.view'),
  asyncHandler(async (_req, res) => {
    const grouped = await prisma.order.groupBy({ by: ['status'], _count: true })
    return ok(
      res,
      grouped.reduce<Record<string, number>>((acc, entry) => {
        acc[entry.status] = entry._count
        return acc
      }, {}),
    )
  }),
)
