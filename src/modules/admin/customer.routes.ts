import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../db/prisma'
import { requirePermission } from '../../middleware/authorize'
import { validateBody, validateQuery, validated } from '../../middleware/validate'
import { asyncHandler } from '../../utils/async-handler'
import { noContent, ok, paginated } from '../../utils/response'
import { ConflictError, NotFoundError } from '../../utils/errors'
import { toNumber } from '../../utils/money'
import { audit } from './audit'

export const adminCustomerRouter = Router()

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(160).optional(),
  status: z.enum(['ACTIVE', 'BLOCKED', 'DELETED']).optional(),
  sort: z.enum(['newest', 'oldest', 'name', 'spend']).default('newest'),
})

function buildWhere(query: z.infer<typeof listQuery>): Prisma.UserWhereInput {
  return {
    ...(query.status ? { status: query.status } : { status: { not: 'DELETED' } }),
    ...(query.q
      ? {
          OR: [
            { email: { contains: query.q, mode: 'insensitive' } },
            { firstName: { contains: query.q, mode: 'insensitive' } },
            { lastName: { contains: query.q, mode: 'insensitive' } },
            { phone: { contains: query.q } },
          ],
        }
      : {}),
  }
}

adminCustomerRouter.get(
  '/',
  requirePermission('customers.view'),
  validateQuery(listQuery),
  asyncHandler(async (req, res) => {
    const query = validated<z.infer<typeof listQuery>>(req)
    const where = buildWhere(query)

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy:
          query.sort === 'oldest'
            ? { createdAt: 'asc' }
            : query.sort === 'name'
              ? { firstName: 'asc' }
              : { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          status: true,
          emailVerified: true,
          acceptsMarketing: true,
          createdAt: true,
          lastLoginAt: true,
          _count: { select: { orders: true, reviews: true, wishlistItems: true } },
        },
      }),
      prisma.user.count({ where }),
    ])

    /* Lifetime spend counts captured payments only — an abandoned or failed
       checkout is not money the customer has spent. */
    const spend = await prisma.payment.groupBy({
      by: ['orderId'],
      where: {
        status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] },
        order: { userId: { in: users.map((user) => user.id) } },
      },
      _sum: { amount: true },
    })

    const orderOwners = await prisma.order.findMany({
      where: { id: { in: spend.map((entry) => entry.orderId) } },
      select: { id: true, userId: true },
    })

    const spendByUser = new Map<string, number>()
    for (const entry of spend) {
      const owner = orderOwners.find((order) => order.id === entry.orderId)?.userId
      if (!owner) continue
      spendByUser.set(owner, (spendByUser.get(owner) ?? 0) + toNumber(entry._sum.amount))
    }

    const rows = users.map((user) => ({
      ...user,
      orderCount: user._count.orders,
      reviewCount: user._count.reviews,
      wishlistCount: user._count.wishlistItems,
      lifetimeSpend: spendByUser.get(user.id) ?? 0,
    }))

    if (query.sort === 'spend') rows.sort((a, b) => b.lifetimeSpend - a.lifetimeSpend)

    return paginated(res, rows, total, query.page, query.limit)
  }),
)

adminCustomerRouter.get(
  '/:id',
  requirePermission('customers.view'),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        status: true,
        emailVerified: true,
        acceptsMarketing: true,
        createdAt: true,
        lastLoginAt: true,
        addresses: true,
        orders: {
          orderBy: { placedAt: 'desc' },
          take: 20,
          select: {
            id: true,
            orderNumber: true,
            status: true,
            total: true,
            placedAt: true,
            items: { select: { name: true, quantity: true } },
          },
        },
        reviews: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { product: { select: { slug: true, name: true } } },
        },
        wishlistItems: {
          take: 20,
          include: { product: { select: { slug: true, name: true } } },
        },
      },
    })
    if (!user) throw new NotFoundError('Customer')

    const spendAgg = await prisma.payment.aggregate({
      where: { status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] }, order: { userId: user.id } },
      _sum: { amount: true },
      _count: true,
    })

    return ok(res, {
      ...user,
      orders: user.orders.map((order) => ({ ...order, total: toNumber(order.total) })),
      stats: {
        lifetimeSpend: toNumber(spendAgg._sum.amount),
        paidOrders: spendAgg._count,
        averageOrderValue:
          spendAgg._count > 0 ? Math.round(toNumber(spendAgg._sum.amount) / spendAgg._count) : 0,
      },
    })
  }),
)

adminCustomerRouter.patch(
  '/:id',
  requirePermission('customers.update'),
  validateBody(
    z.object({
      firstName: z.string().trim().min(1).max(60).optional(),
      lastName: z.string().trim().min(1).max(60).optional(),
      phone: z.string().trim().max(20).nullable().optional(),
      acceptsMarketing: z.boolean().optional(),
      emailVerified: z.boolean().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const existing = await prisma.user.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new NotFoundError('Customer')

    const user = await prisma.user.update({ where: { id: req.params.id }, data: req.body })
    await audit(req, 'updated', 'Customer', user.id, existing, user)
    return ok(res, user)
  }),
)

/**
 * Blocking revokes every active session immediately, rather than waiting for
 * the current access token to expire.
 */
adminCustomerRouter.post(
  '/:id/block',
  requirePermission('customers.block'),
  validateBody(z.object({ blocked: z.boolean(), reason: z.string().trim().max(500).optional() })),
  asyncHandler(async (req, res) => {
    const { blocked, reason } = req.body as { blocked: boolean; reason?: string }

    const user = await prisma.$transaction(async (tx) => {
      const result = await tx.user.update({
        where: { id: req.params.id },
        data: { status: blocked ? 'BLOCKED' : 'ACTIVE' },
      })

      if (blocked) {
        await tx.userRefreshToken.updateMany({
          where: { userId: req.params.id, revokedAt: null },
          data: { revokedAt: new Date() },
        })
      }

      return result
    })

    await audit(req, blocked ? 'blocked' : 'unblocked', 'Customer', user.id, null, { reason })
    return ok(res, user)
  }),
)

/**
 * Soft delete.
 *
 * A customer with orders is anonymised rather than removed: deleting the row
 * would orphan order history and silently change every revenue report that
 * has already been run.
 */
adminCustomerRouter.delete(
  '/:id',
  requirePermission('customers.delete'),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { orders: true } } },
    })
    if (!user) throw new NotFoundError('Customer')

    if (user._count.orders > 0) {
      await prisma.$transaction([
        prisma.user.update({
          where: { id: user.id },
          data: {
            status: 'DELETED',
            email: `deleted-${user.id}@removed.invalid`,
            firstName: 'Deleted',
            lastName: 'Customer',
            phone: null,
            passwordHash: null,
            acceptsMarketing: false,
          },
        }),
        prisma.userRefreshToken.updateMany({
          where: { userId: user.id },
          data: { revokedAt: new Date() },
        }),
        prisma.address.deleteMany({ where: { userId: user.id } }),
      ])

      await audit(req, 'anonymised', 'Customer', user.id, { email: user.email }, null)
      return ok(res, {
        message: 'Customer anonymised. Order history has been preserved for accounting.',
      })
    }

    await prisma.user.delete({ where: { id: user.id } })
    await audit(req, 'deleted', 'Customer', user.id, { email: user.email }, null)
    return noContent(res)
  }),
)

adminCustomerRouter.get(
  '/export/csv',
  requirePermission('customers.export'),
  asyncHandler(async (req, res) => {
    const users = await prisma.user.findMany({
      where: { status: { not: 'DELETED' } },
      orderBy: { createdAt: 'desc' },
      take: 10_000,
      select: {
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        status: true,
        acceptsMarketing: true,
        createdAt: true,
        _count: { select: { orders: true } },
      },
    })

    const escape = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""')}"`
    const header = ['Email', 'First Name', 'Last Name', 'Phone', 'Status', 'Marketing', 'Orders', 'Joined']
    const lines = users.map((user) =>
      [
        user.email,
        user.firstName,
        user.lastName,
        user.phone ?? '',
        user.status,
        user.acceptsMarketing ? 'yes' : 'no',
        user._count.orders,
        user.createdAt.toISOString().slice(0, 10),
      ]
        .map(escape)
        .join(','),
    )

    await audit(req, 'exported', 'Customer', undefined, null, { count: users.length })

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="pushmina-customers.csv"')
    return res.send(`﻿${[header.map(escape).join(','), ...lines].join('\r\n')}`)
  }),
)

void ConflictError
