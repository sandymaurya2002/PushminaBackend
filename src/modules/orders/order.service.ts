import type { OrderStatus, Prisma } from '@prisma/client'
import { prisma } from '../../db/prisma'
import { env } from '../../config/env'
import { toNumber, round2 } from '../../utils/money'
import { generateOrderNumber, generateInvoiceNumber } from '../../utils/tokens'
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InsufficientStockError,
  NotFoundError,
} from '../../utils/errors'
import { computeTotals } from '../cart/cart.service'
import { notifyAdmins, notifyCustomer, notifyGuest } from '../notifications/notification.service'
import { templates } from '../email/templates'
import { logger } from '../../config/logger'

/**
 * Orders.
 *
 * Stock is reserved when the order is created, not when payment succeeds:
 * otherwise two customers could both reach the payment screen for the last
 * shawl and one would be disappointed after paying. Reservation is released
 * automatically if payment is abandoned (see jobs/expire-stale-payments.ts).
 */

export const orderInclude = {
  items: true,
  payments: { orderBy: { createdAt: 'desc' as const } },
  refunds: { orderBy: { createdAt: 'desc' as const } },
  statusHistory: { orderBy: { createdAt: 'asc' as const } },
  invoice: true,
} satisfies Prisma.OrderInclude

/**
 * Which status may follow which.
 *
 * Encoded as data rather than scattered `if` statements so an illegal jump —
 * DELIVERED back to PENDING, or anything at all out of CANCELLED — is
 * impossible from any call site, including the admin panel.
 */
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['PLACED', 'CONFIRMED', 'CANCELLED'],
  PLACED: ['CONFIRMED', 'PROCESSING', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'SHIPPED', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED', 'RETURNED'],
  DELIVERED: ['RETURNED'],
  CANCELLED: [],
  RETURNED: [],
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

export interface ShippingAddressInput {
  fullName: string
  email: string
  phone: string
  line1: string
  line2?: string | null
  city: string
  state: string
  postalCode: string
  country?: string
}

export interface CreateOrderInput {
  userId?: string
  sessionId?: string
  address: ShippingAddressInput
  billingAddress?: ShippingAddressInput | null
  shippingMethod: 'standard' | 'express'
  paymentMethod: 'UPI' | 'CARD' | 'NETBANKING' | 'WALLET' | 'COD'
  giftMessage?: string
  customerNote?: string
}

/* ------------------------------------------------------------------ *
 * Creation
 * ------------------------------------------------------------------ */

/** Order numbers are random, so a collision is possible though very unlikely. */
async function reserveOrderNumber(tx: Prisma.TransactionClient): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = generateOrderNumber()
    const clash = await tx.order.findUnique({
      where: { orderNumber: candidate },
      select: { id: true },
    })
    if (!clash) return candidate
  }
  throw new ConflictError('Could not allocate an order number. Please try again.')
}

export async function createOrder(input: CreateOrderInput) {
  const cart = await prisma.cart.findFirst({
    where: input.userId ? { userId: input.userId } : { sessionId: input.sessionId },
    include: {
      coupon: true,
      items: {
        include: {
          product: {
            select: {
              id: true,
              slug: true,
              name: true,
              status: true,
              images: { orderBy: { sortOrder: 'asc' }, take: 1 },
            },
          },
          variant: {
            include: {
              color: { select: { name: true } },
              size: { select: { name: true } },
            },
          },
        },
      },
    },
  })

  if (!cart || cart.items.length === 0) {
    throw new BadRequestError('Your bag is empty.')
  }

  const unavailable = cart.items.filter((item) => item.product.status !== 'PUBLISHED')
  if (unavailable.length > 0) {
    throw new BadRequestError(
      `${unavailable.map((item) => item.product.name).join(', ')} is no longer available.`,
    )
  }

  // Re-priced from the database, never from the client.
  const lines = cart.items.map((item) => ({
    unitPrice: toNumber(item.variant.price),
    quantity: item.quantity,
  }))
  const totals = computeTotals(lines, cart.coupon)

  const expressSurcharge = input.shippingMethod === 'express' ? env.EXPRESS_SHIPPING_FEE : 0
  const shippingFee = round2(totals.shipping + expressSurcharge)
  const grandTotal = round2(totals.subtotal - totals.discount + shippingFee)

  if (input.paymentMethod === 'COD' && grandTotal > env.COD_LIMIT) {
    throw new BadRequestError(
      `Cash on delivery is not available above ₹${env.COD_LIMIT.toLocaleString('en-IN')}.`,
    )
  }

  const order = await prisma.$transaction(
    async (tx) => {
      /* --- Reserve stock ------------------------------------------------
         A conditional updateMany is the compare-and-set: it only matches
         while enough stock remains, and the affected-row count tells us
         whether we won the race. A read-then-write here would oversell under
         concurrency. */
      for (const item of cart.items) {
        const reserved = await tx.productVariant.updateMany({
          where: { id: item.variantId, inventory: { gte: item.quantity } },
          data: { inventory: { decrement: item.quantity } },
        })

        if (reserved.count === 0) {
          const current = await tx.productVariant.findUnique({
            where: { id: item.variantId },
            select: { inventory: true },
          })
          throw new InsufficientStockError(item.product.name, current?.inventory ?? 0)
        }
      }

      const orderNumber = await reserveOrderNumber(tx)

      const created = await tx.order.create({
        data: {
          orderNumber,
          userId: input.userId ?? null,
          email: input.address.email,
          phone: input.address.phone,
          status: 'PENDING',
          subtotal: totals.subtotal,
          discount: totals.discount,
          shippingFee,
          taxAmount: totals.tax,
          total: grandTotal,
          couponCode: cart.coupon?.code ?? null,
          shippingAddress: input.address as unknown as Prisma.InputJsonValue,
          billingAddress: (input.billingAddress ?? input.address) as unknown as Prisma.InputJsonValue,
          shippingMethod: input.shippingMethod === 'express' ? 'Express' : 'Standard',
          giftMessage: input.giftMessage ?? null,
          customerNote: input.customerNote ?? null,
          estimatedDelivery: new Date(
            Date.now() + (input.shippingMethod === 'express' ? 2 : 6) * 86_400_000,
          ),
          items: {
            create: cart.items.map((item) => {
              const unitPrice = toNumber(item.variant.price)
              const image = item.product.images[0]
              return {
                productId: item.product.id,
                variantId: item.variantId,
                // Snapshotted so an order stays readable after a product is
                // renamed, repriced or deleted.
                name: item.product.name,
                slug: item.product.slug,
                imageUrl: image?.url ?? null,
                imageAlt: image?.alt ?? null,
                sku: item.variant.sku,
                colorName: item.variant.color?.name ?? null,
                sizeName: item.variant.size?.name ?? null,
                unitPrice,
                quantity: item.quantity,
                lineTotal: round2(unitPrice * item.quantity),
              }
            }),
          },
          statusHistory: {
            create: { toStatus: 'PENDING', note: 'Order created, awaiting payment.' },
          },
        },
        include: orderInclude,
      })

      for (const item of cart.items) {
        const variant = await tx.productVariant.findUnique({
          where: { id: item.variantId },
          select: { inventory: true },
        })
        await tx.inventoryLog.create({
          data: {
            variantId: item.variantId,
            change: -item.quantity,
            resulting: variant?.inventory ?? 0,
            reason: 'ORDER_PLACED',
            note: `Reserved for order ${orderNumber}`,
            referenceId: created.id,
          },
        })
      }

      if (cart.coupon) {
        await tx.coupon.update({
          where: { id: cart.coupon.id },
          data: { usageCount: { increment: 1 } },
        })
        await tx.couponUsage.create({
          data: {
            couponId: cart.coupon.id,
            userId: input.userId ?? null,
            orderId: created.id,
            amount: totals.discount,
          },
        })
      }

      // The bag is emptied only once the order exists.
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } })
      await tx.cart.update({ where: { id: cart.id }, data: { couponId: null } })

      return created
    },
    { timeout: 20_000 },
  )

  logger.info({ orderId: order.id, orderNumber: order.orderNumber }, 'Order created')
  return order
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

const STATUS_TIMESTAMP: Partial<Record<OrderStatus, keyof Prisma.OrderUpdateInput>> = {
  CONFIRMED: 'confirmedAt',
  SHIPPED: 'shippedAt',
  DELIVERED: 'deliveredAt',
  CANCELLED: 'cancelledAt',
}

export async function updateStatus(
  orderId: string,
  to: OrderStatus,
  options: { note?: string; adminId?: string; trackingNumber?: string; carrier?: string } = {},
) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  })
  if (!order) throw new NotFoundError('Order')

  if (order.status === to) {
    throw new BadRequestError(`Order is already ${to.toLowerCase()}.`)
  }
  if (!canTransition(order.status, to)) {
    throw new BadRequestError(
      `Cannot move an order from ${order.status.toLowerCase()} to ${to.toLowerCase()}.`,
    )
  }

  const updated = await prisma.$transaction(async (tx) => {
    const timestampField = STATUS_TIMESTAMP[to]

    const result = await tx.order.update({
      where: { id: orderId },
      data: {
        status: to,
        ...(timestampField ? { [timestampField]: new Date() } : {}),
        ...(options.trackingNumber ? { trackingNumber: options.trackingNumber } : {}),
        ...(options.carrier ? { carrier: options.carrier } : {}),
      },
      include: orderInclude,
    })

    await tx.orderStatusHistory.create({
      data: {
        orderId,
        fromStatus: order.status,
        toStatus: to,
        note: options.note,
        changedById: options.adminId,
      },
    })

    // Cancelling or returning puts the stock back.
    if (to === 'CANCELLED' || to === 'RETURNED') {
      for (const item of order.items) {
        if (!item.variantId) continue
        const variant = await tx.productVariant.update({
          where: { id: item.variantId },
          data: { inventory: { increment: item.quantity } },
          select: { inventory: true },
        })
        await tx.inventoryLog.create({
          data: {
            variantId: item.variantId,
            change: item.quantity,
            resulting: variant.inventory,
            reason: to === 'CANCELLED' ? 'ORDER_CANCELLED' : 'ORDER_RETURNED',
            note: `Order ${order.orderNumber} ${to.toLowerCase()}`,
            referenceId: orderId,
            createdById: options.adminId,
          },
        })
      }
    }

    return result
  })

  await dispatchStatusNotification(updated, to)
  return updated
}

async function dispatchStatusNotification(
  order: Prisma.OrderGetPayload<{ include: typeof orderInclude }>,
  status: OrderStatus,
): Promise<void> {
  const messages: Partial<
    Record<OrderStatus, { type: 'ORDER_CONFIRMED' | 'ORDER_SHIPPED' | 'ORDER_DELIVERED' | 'ORDER_CANCELLED'; title: string; body: string }>
  > = {
    CONFIRMED: {
      type: 'ORDER_CONFIRMED',
      title: 'Order confirmed',
      body: `Order ${order.orderNumber} is confirmed and being prepared.`,
    },
    SHIPPED: {
      type: 'ORDER_SHIPPED',
      title: 'Order shipped',
      body: `Order ${order.orderNumber} has left our workshop.`,
    },
    DELIVERED: {
      type: 'ORDER_DELIVERED',
      title: 'Order delivered',
      body: `Order ${order.orderNumber} has been delivered.`,
    },
    CANCELLED: {
      type: 'ORDER_CANCELLED',
      title: 'Order cancelled',
      body: `Order ${order.orderNumber} has been cancelled.`,
    },
  }

  const message = messages[status]
  if (!message) return

  const email =
    status === 'SHIPPED'
      ? templates.orderShipped({
          orderNumber: order.orderNumber,
          trackingNumber: order.trackingNumber,
          carrier: order.carrier,
        })
      : status === 'DELIVERED'
        ? templates.orderDelivered({ orderNumber: order.orderNumber })
        : status === 'CANCELLED'
          ? templates.orderCancelled({ orderNumber: order.orderNumber })
          : null

  if (order.userId) {
    await notifyCustomer({
      userId: order.userId,
      type: message.type,
      title: message.title,
      body: message.body,
      link: `/account/orders/${order.id}`,
      data: { orderId: order.id, orderNumber: order.orderNumber },
      ...(email ? { email: { to: order.email, template: status.toLowerCase(), ...email } } : {}),
    })
  } else if (email) {
    await notifyGuest({ to: order.email, template: status.toLowerCase(), ...email })
  }
}

/** Fired once payment is confirmed, not at order creation. */
export async function onOrderPaid(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  })
  if (!order) return

  const emailItems = order.items.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    unitPrice: toNumber(item.unitPrice),
    colorName: item.colorName,
    sizeName: item.sizeName,
  }))

  const totals = {
    subtotal: toNumber(order.subtotal),
    discount: toNumber(order.discount),
    shippingFee: toNumber(order.shippingFee),
    total: toNumber(order.total),
  }

  const address = order.shippingAddress as unknown as ShippingAddressInput
  const email = templates.orderPlaced({
    firstName: address.fullName?.split(' ')[0] ?? 'there',
    orderNumber: order.orderNumber,
    items: emailItems,
    totals,
  })

  if (order.userId) {
    await notifyCustomer({
      userId: order.userId,
      type: 'ORDER_PLACED',
      title: 'Order placed',
      body: `Order ${order.orderNumber} has been placed.`,
      link: `/account/orders/${order.id}`,
      data: { orderId: order.id, orderNumber: order.orderNumber },
      email: { to: order.email, template: 'order-placed', ...email },
    })
  } else {
    await notifyGuest({ to: order.email, template: 'order-placed', ...email })
  }

  await notifyAdmins({
    type: 'ADMIN_NEW_ORDER',
    title: 'New order received',
    body: `${order.orderNumber} — ₹${totals.total.toLocaleString('en-IN')} from ${order.email}`,
    link: `/orders/${order.id}`,
    data: { orderId: order.id, orderNumber: order.orderNumber, total: totals.total },
    permission: 'orders.view',
  })

  await ensureInvoice(orderId)
}

export async function ensureInvoice(orderId: string): Promise<void> {
  const existing = await prisma.invoice.findUnique({ where: { orderId }, select: { id: true } })
  if (existing) return

  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order) return

  const sequence = await prisma.invoice.count()

  await prisma.invoice.create({
    data: {
      orderId,
      invoiceNumber: generateInvoiceNumber(sequence + 1),
      totals: {
        subtotal: toNumber(order.subtotal),
        discount: toNumber(order.discount),
        shippingFee: toNumber(order.shippingFee),
        taxAmount: toNumber(order.taxAmount),
        total: toNumber(order.total),
        currency: order.currency,
      },
    },
  })
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export async function getOrderForCustomer(orderId: string, userId: string) {
  const order = await prisma.order.findFirst({
    where: {
      OR: [{ id: orderId }, { orderNumber: orderId }],
      userId,
    },
    include: orderInclude,
  })
  if (!order) throw new NotFoundError('Order')
  return order
}

export async function listOrdersForCustomer(
  userId: string,
  options: { page: number; limit: number; status?: OrderStatus },
) {
  const where: Prisma.OrderWhereInput = {
    userId,
    ...(options.status ? { status: options.status } : {}),
  }

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: orderInclude,
      orderBy: { placedAt: 'desc' },
      skip: (options.page - 1) * options.limit,
      take: options.limit,
    }),
    prisma.order.count({ where }),
  ])

  return { orders, total }
}

/**
 * Guest order tracking.
 *
 * Requires the order number *and* the email it was placed with, so knowing a
 * sequential-looking order number alone reveals nothing.
 */
export async function trackOrder(orderNumber: string, email: string) {
  const order = await prisma.order.findFirst({
    where: {
      orderNumber: { equals: orderNumber.trim(), mode: 'insensitive' },
      email: { equals: email.trim(), mode: 'insensitive' },
    },
    include: orderInclude,
  })
  if (!order) {
    throw new NotFoundError('No order matches that number and email address')
  }
  return order
}

export async function cancelOwnOrder(orderId: string, userId: string, reason?: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: { id: true, status: true },
  })
  if (!order) throw new NotFoundError('Order')

  // Once a parcel is with the courier it is a return, not a cancellation.
  if (!['PENDING', 'PLACED', 'CONFIRMED'].includes(order.status)) {
    throw new ForbiddenError(
      'This order has already been prepared for dispatch and can no longer be cancelled. Contact care@pushmina.com.',
    )
  }

  return updateStatus(orderId, 'CANCELLED', {
    note: reason ? `Cancelled by customer: ${reason}` : 'Cancelled by customer',
  })
}
