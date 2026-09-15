import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../db/prisma'
import { requirePermission } from '../../middleware/authorize'
import { validateBody, validateQuery, validated } from '../../middleware/validate'
import { asyncHandler } from '../../utils/async-handler'
import { ok, paginated } from '../../utils/response'
import { NotFoundError } from '../../utils/errors'
import { toNumber } from '../../utils/money'
import { audit } from './audit'
import { orderInclude, updateStatus } from '../orders/order.service'

export const adminOrderRouter = Router()

const ORDER_STATUSES = [
  'PENDING',
  'PLACED',
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'RETURNED',
] as const

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(160).optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  paymentStatus: z
    .enum(['CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'])
    .optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z.enum(['newest', 'oldest', 'total-high', 'total-low']).default('newest'),
})

function buildWhere(query: z.infer<typeof listQuery>): Prisma.OrderWhereInput {
  return {
    ...(query.status ? { status: query.status } : {}),
    ...(query.paymentStatus ? { payments: { some: { status: query.paymentStatus } } } : {}),
    ...(query.from || query.to
      ? {
          placedAt: {
            ...(query.from ? { gte: query.from } : {}),
            // `to` is inclusive of the whole day the admin picked.
            ...(query.to ? { lte: new Date(query.to.getTime() + 86_399_999) } : {}),
          },
        }
      : {}),
    ...(query.q
      ? {
          OR: [
            { orderNumber: { contains: query.q, mode: 'insensitive' } },
            { email: { contains: query.q, mode: 'insensitive' } },
            { phone: { contains: query.q } },
            { trackingNumber: { contains: query.q, mode: 'insensitive' } },
            { items: { some: { name: { contains: query.q, mode: 'insensitive' } } } },
          ],
        }
      : {}),
  }
}

/* ---------------- List ---------------- */
adminOrderRouter.get(
  '/',
  requirePermission('orders.view'),
  validateQuery(listQuery),
  asyncHandler(async (req, res) => {
    const query = validated<z.infer<typeof listQuery>>(req)
    const where = buildWhere(query)

    const orderBy: Prisma.OrderOrderByWithRelationInput =
      query.sort === 'oldest'
        ? { placedAt: 'asc' }
        : query.sort === 'total-high'
          ? { total: 'desc' }
          : query.sort === 'total-low'
            ? { total: 'asc' }
            : { placedAt: 'desc' }

    const [orders, total, revenueAgg] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          orderNumber: true,
          email: true,
          phone: true,
          status: true,
          total: true,
          placedAt: true,
          trackingNumber: true,
          shippingMethod: true,
          user: { select: { id: true, firstName: true, lastName: true } },
          items: { select: { id: true, name: true, quantity: true, imageUrl: true } },
          payments: { select: { status: true, method: true }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
      }),
      prisma.order.count({ where }),
      prisma.order.aggregate({ where, _sum: { total: true } }),
    ])

    return paginated(
      res,
      orders.map((order) => ({
        ...order,
        total: toNumber(order.total),
        itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
        paymentStatus: order.payments[0]?.status ?? null,
        paymentMethod: order.payments[0]?.method ?? null,
      })),
      total,
      query.page,
      query.limit,
      { sumTotal: toNumber(revenueAgg._sum.total) },
    )
  }),
)

/* ---------------- Read ---------------- */
adminOrderRouter.get(
  '/:id',
  requirePermission('orders.view'),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findFirst({
      where: { OR: [{ id: req.params.id }, { orderNumber: req.params.id }] },
      include: {
        ...orderInclude,
        user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
        statusHistory: {
          orderBy: { createdAt: 'asc' },
          include: { changedBy: { select: { id: true, name: true } } },
        },
      },
    })
    if (!order) throw new NotFoundError('Order')
    return ok(res, order)
  }),
)

/* ---------------- Status ---------------- */
adminOrderRouter.patch(
  '/:id/status',
  requirePermission('orders.update'),
  validateBody(
    z.object({
      status: z.enum(ORDER_STATUSES),
      note: z.string().trim().max(500).optional(),
      trackingNumber: z.string().trim().max(80).optional(),
      carrier: z.string().trim().max(80).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.body as {
      status: (typeof ORDER_STATUSES)[number]
      note?: string
      trackingNumber?: string
      carrier?: string
    }

    const order = await updateStatus(req.params.id, body.status, {
      note: body.note,
      adminId: req.admin!.id,
      trackingNumber: body.trackingNumber,
      carrier: body.carrier,
    })

    await audit(req, `status:${body.status}`, 'Order', order.id, null, body)
    return ok(res, order)
  }),
)

/* ---------------- Fulfilment ---------------- */
adminOrderRouter.patch(
  '/:id/fulfilment',
  requirePermission('orders.fulfil'),
  validateBody(
    z.object({
      trackingNumber: z.string().trim().max(80).nullable().optional(),
      carrier: z.string().trim().max(80).nullable().optional(),
      estimatedDelivery: z.coerce.date().nullable().optional(),
      adminNote: z.string().trim().max(2000).nullable().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const existing = await prisma.order.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new NotFoundError('Order')

    const order = await prisma.order.update({ where: { id: req.params.id }, data: req.body })
    await audit(req, 'updated-fulfilment', 'Order', order.id, existing, order)
    return ok(res, order)
  }),
)

/* ---------------- Export ---------------- */
/**
 * CSV export of the current filter selection.
 *
 * Streams as text/csv with a filename so the browser downloads rather than
 * renders it. Values are quoted and internal quotes doubled, so a product name
 * containing a comma cannot shift every subsequent column.
 */
adminOrderRouter.get(
  '/export/csv',
  requirePermission('orders.export'),
  validateQuery(listQuery),
  asyncHandler(async (req, res) => {
    const query = validated<z.infer<typeof listQuery>>(req)

    const orders = await prisma.order.findMany({
      where: buildWhere(query),
      orderBy: { placedAt: 'desc' },
      take: 5000,
      include: {
        items: { select: { name: true, quantity: true } },
        payments: { select: { status: true, method: true }, take: 1, orderBy: { createdAt: 'desc' } },
      },
    })

    const escape = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""')}"`

    const header = [
      'Order Number',
      'Placed At',
      'Status',
      'Customer Email',
      'Phone',
      'Items',
      'Subtotal',
      'Discount',
      'Shipping',
      'Tax (incl)',
      'Total',
      'Payment Status',
      'Payment Method',
      'Tracking',
    ]

    const lines = orders.map((order) =>
      [
        order.orderNumber,
        order.placedAt.toISOString(),
        order.status,
        order.email,
        order.phone,
        order.items.map((item) => `${item.name} x${item.quantity}`).join('; '),
        toNumber(order.subtotal),
        toNumber(order.discount),
        toNumber(order.shippingFee),
        toNumber(order.taxAmount),
        toNumber(order.total),
        order.payments[0]?.status ?? '',
        order.payments[0]?.method ?? '',
        order.trackingNumber ?? '',
      ]
        .map(escape)
        .join(','),
    )

    const csv = [header.map(escape).join(','), ...lines].join('\r\n')

    await audit(req, 'exported', 'Order', undefined, null, { count: orders.length })

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="pushmina-orders-${new Date().toISOString().slice(0, 10)}.csv"`,
    )
    // BOM so Excel opens UTF-8 correctly and ₹ does not become garbage.
    return res.send(`﻿${csv}`)
  }),
)
