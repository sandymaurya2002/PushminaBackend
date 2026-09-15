import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../db/prisma'
import { requirePermission } from '../../middleware/authorize'
import { validateBody, validateQuery, validated } from '../../middleware/validate'
import { asyncHandler } from '../../utils/async-handler'
import { created, ok, paginated } from '../../utils/response'
import { NotFoundError } from '../../utils/errors'
import { toNumber } from '../../utils/money'
import { audit } from './audit'
import * as paymentService from '../payments/payment.service'

export const adminPaymentRouter = Router()

const PAYMENT_STATUSES = [
  'CREATED',
  'PENDING',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Matches transaction id, gateway order id, order number or customer email. */
  q: z.string().trim().max(160).optional(),
  status: z.enum(PAYMENT_STATUSES).optional(),
  method: z.enum(['UPI', 'CARD', 'NETBANKING', 'WALLET', 'COD', 'OTHER']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})

function buildWhere(query: z.infer<typeof listQuery>): Prisma.PaymentWhereInput {
  return {
    ...(query.status ? { status: query.status } : {}),
    ...(query.method ? { method: query.method } : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: query.from } : {}),
            ...(query.to ? { lte: new Date(query.to.getTime() + 86_399_999) } : {}),
          },
        }
      : {}),
    ...(query.q
      ? {
          OR: [
            { providerPaymentId: { contains: query.q, mode: 'insensitive' } },
            { providerOrderId: { contains: query.q, mode: 'insensitive' } },
            { order: { orderNumber: { contains: query.q, mode: 'insensitive' } } },
            { order: { email: { contains: query.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  }
}

/* ---------------- Payments ---------------- */

adminPaymentRouter.get(
  '/',
  requirePermission('payments.view'),
  validateQuery(listQuery),
  asyncHandler(async (req, res) => {
    const query = validated<z.infer<typeof listQuery>>(req)
    const where = buildWhere(query)

    const [payments, total, totals, byStatus] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          order: {
            select: {
              id: true,
              orderNumber: true,
              email: true,
              status: true,
              user: { select: { id: true, firstName: true, lastName: true } },
            },
          },
          refunds: { select: { id: true, amount: true, status: true } },
        },
      }),
      prisma.payment.count({ where }),
      prisma.payment.aggregate({ where, _sum: { amount: true, amountRefunded: true } }),
      prisma.payment.groupBy({ by: ['status'], where, _count: true, _sum: { amount: true } }),
    ])

    return paginated(
      res,
      payments.map((payment) => ({
        ...payment,
        amount: toNumber(payment.amount),
        amountRefunded: toNumber(payment.amountRefunded),
        refunds: payment.refunds.map((refund) => ({
          ...refund,
          amount: toNumber(refund.amount),
        })),
      })),
      total,
      query.page,
      query.limit,
      {
        sumAmount: toNumber(totals._sum.amount),
        sumRefunded: toNumber(totals._sum.amountRefunded),
        byStatus: byStatus.map((entry) => ({
          status: entry.status,
          count: entry._count,
          amount: toNumber(entry._sum.amount),
        })),
      },
    )
  }),
)

adminPaymentRouter.get(
  '/:id',
  requirePermission('payments.view'),
  asyncHandler(async (req, res) => {
    const payment = await prisma.payment.findUnique({
      where: { id: req.params.id },
      include: {
        order: {
          include: {
            items: true,
            user: { select: { id: true, firstName: true, lastName: true, email: true } },
          },
        },
        refunds: { include: { processedBy: { select: { id: true, name: true } } } },
      },
    })
    if (!payment) throw new NotFoundError('Payment')

    return ok(res, {
      ...payment,
      amount: toNumber(payment.amount),
      amountRefunded: toNumber(payment.amountRefunded),
    })
  }),
)

/** Gateway webhook log — the audit trail for every delivery received. */
adminPaymentRouter.get(
  '/webhooks/events',
  requirePermission('payments.view'),
  validateQuery(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      status: z.enum(['RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED', 'DUPLICATE']).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const query = validated<{ page: number; limit: number; status?: string }>(req)
    const where = query.status ? { status: query.status as never } : {}

    const [events, total] = await Promise.all([
      prisma.paymentWebhookEvent.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.paymentWebhookEvent.count({ where }),
    ])

    return paginated(res, events, total, query.page, query.limit)
  }),
)

/* ---------------- Refunds ---------------- */

adminPaymentRouter.get(
  '/refunds/all',
  requirePermission('refunds.view'),
  validateQuery(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      status: z
        .enum(['REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'COMPLETED', 'FAILED'])
        .optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const query = validated<{ page: number; limit: number; status?: string }>(req)
    const where = query.status ? { status: query.status as never } : {}

    const [refunds, total, pending] = await Promise.all([
      prisma.refund.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          order: { select: { id: true, orderNumber: true, email: true } },
          requestedBy: { select: { id: true, firstName: true, lastName: true } },
          processedBy: { select: { id: true, name: true } },
        },
      }),
      prisma.refund.count({ where }),
      prisma.refund.count({ where: { status: 'REQUESTED' } }),
    ])

    return paginated(
      res,
      refunds.map((refund) => ({ ...refund, amount: toNumber(refund.amount) })),
      total,
      query.page,
      query.limit,
      { pendingCount: pending },
    )
  }),
)

/** Admin-initiated refund, e.g. a goodwill gesture or a returned parcel. */
adminPaymentRouter.post(
  '/refunds',
  requirePermission('refunds.create'),
  validateBody(
    z.object({
      orderId: z.string().min(1),
      amount: z.coerce.number().positive().optional(),
      reason: z.string().trim().min(3, 'Give a reason.').max(500),
    }),
  ),
  asyncHandler(async (req, res) => {
    const refund = await paymentService.requestRefund({
      orderId: req.body.orderId,
      amount: req.body.amount,
      reason: req.body.reason,
    })
    await audit(req, 'requested', 'Refund', refund.id, null, refund)
    return created(res, { ...refund, amount: toNumber(refund.amount) })
  }),
)

adminPaymentRouter.post(
  '/refunds/:id/approve',
  requirePermission('refunds.approve'),
  asyncHandler(async (req, res) => {
    const refund = await paymentService.approveRefund(req.params.id, req.admin!.id)
    await audit(req, 'approved', 'Refund', req.params.id, null, refund)
    return ok(res, { ...refund, amount: toNumber(refund.amount) })
  }),
)

adminPaymentRouter.post(
  '/refunds/:id/reject',
  requirePermission('refunds.reject'),
  validateBody(z.object({ reason: z.string().trim().min(3, 'Give a reason.').max(500) })),
  asyncHandler(async (req, res) => {
    const refund = await paymentService.rejectRefund(
      req.params.id,
      req.admin!.id,
      req.body.reason,
    )
    await audit(req, 'rejected', 'Refund', req.params.id, null, refund)
    return ok(res, { ...refund, amount: toNumber(refund.amount) })
  }),
)

/* ---------------- Export ---------------- */

adminPaymentRouter.get(
  '/export/csv',
  requirePermission('payments.export'),
  validateQuery(listQuery),
  asyncHandler(async (req, res) => {
    const query = validated<z.infer<typeof listQuery>>(req)

    const payments = await prisma.payment.findMany({
      where: buildWhere(query),
      orderBy: { createdAt: 'desc' },
      take: 5000,
      include: { order: { select: { orderNumber: true, email: true } } },
    })

    const escape = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""')}"`

    const header = [
      'Transaction ID',
      'Gateway Order ID',
      'Order Number',
      'Customer Email',
      'Status',
      'Method',
      'Amount',
      'Refunded',
      'Currency',
      'Created At',
      'Captured At',
      'Failure Reason',
    ]

    const lines = payments.map((payment) =>
      [
        payment.providerPaymentId ?? '',
        payment.providerOrderId ?? '',
        payment.order.orderNumber,
        payment.order.email,
        payment.status,
        payment.method,
        toNumber(payment.amount),
        toNumber(payment.amountRefunded),
        payment.currency,
        payment.createdAt.toISOString(),
        payment.capturedAt?.toISOString() ?? '',
        payment.failureReason ?? '',
      ]
        .map(escape)
        .join(','),
    )

    const csv = [header.map(escape).join(','), ...lines].join('\r\n')
    await audit(req, 'exported', 'Payment', undefined, null, { count: payments.length })

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="pushmina-payments-${new Date().toISOString().slice(0, 10)}.csv"`,
    )
    return res.send(`﻿${csv}`)
  }),
)
