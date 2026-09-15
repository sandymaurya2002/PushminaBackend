import { prisma } from '../db/prisma'
import { logger } from '../config/logger'

const STALE_AFTER_MINUTES = 60

/**
 * Closes out payment attempts that were created but never completed — the
 * customer closed the gateway, lost connection, or abandoned the tab.
 *
 * Only CREATED and PENDING rows are touched. An AUTHORIZED payment is real
 * money that has been held and must never be expired by a timer; it is
 * resolved by the webhook or by an admin.
 *
 * Stock is released so abandoned checkouts do not hold inventory hostage.
 */
export async function expireStalePayments(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MINUTES * 60 * 1000)

  const stale = await prisma.payment.findMany({
    where: { status: { in: ['CREATED', 'PENDING'] }, createdAt: { lt: cutoff } },
    select: { id: true, orderId: true },
  })

  if (stale.length === 0) return

  for (const payment of stale) {
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'CANCELLED',
          failedAt: new Date(),
          failureReason: `Abandoned — no completion within ${STALE_AFTER_MINUTES} minutes.`,
        },
      })

      const order = await tx.order.findUnique({
        where: { id: payment.orderId },
        select: {
          id: true,
          status: true,
          orderNumber: true,
          items: { select: { variantId: true, quantity: true } },
        },
      })

      // Only a still-PENDING order should be cancelled. If a webhook arrived
      // late and already confirmed it, leave it entirely alone.
      if (!order || order.status !== 'PENDING') return

      await tx.order.update({
        where: { id: order.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          adminNote: 'Automatically cancelled: payment not completed.',
        },
      })

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: 'PENDING',
          toStatus: 'CANCELLED',
          note: 'Payment abandoned — cancelled automatically.',
        },
      })

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
            reason: 'ORDER_CANCELLED',
            note: `Released from abandoned order ${order.orderNumber}`,
            referenceId: order.id,
          },
        })
      }
    })
  }

  logger.info(`Expired ${stale.length} stale payment attempt(s)`)
}
