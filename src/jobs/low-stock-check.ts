import { prisma } from '../db/prisma'
import { logger } from '../config/logger'
import { notifyAdmins } from '../modules/notifications/notification.service'

/**
 * Low and out-of-stock alerts.
 *
 * Re-alerting every 30 minutes for the same product would be noise, so a
 * product is skipped if an alert of the same kind already exists for it within
 * the last 24 hours.
 */
export async function checkLowStock(): Promise<void> {
  const products = await prisma.product.findMany({
    where: { status: 'PUBLISHED' },
    select: {
      id: true,
      name: true,
      lowStockThreshold: true,
      variants: { where: { isActive: true }, select: { inventory: true } },
    },
  })

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

  for (const product of products) {
    const total = product.variants.reduce((sum, variant) => sum + variant.inventory, 0)
    const isOut = total <= 0
    const isLow = !isOut && total <= product.lowStockThreshold

    if (!isOut && !isLow) continue

    const type = isOut ? 'ADMIN_OUT_OF_STOCK' : 'ADMIN_LOW_STOCK'

    const alreadyAlerted = await prisma.notification.findFirst({
      where: {
        type,
        audience: 'ADMIN',
        createdAt: { gte: dayAgo },
        data: { path: ['productId'], equals: product.id },
      },
      select: { id: true },
    })

    if (alreadyAlerted) continue

    await notifyAdmins({
      type,
      title: isOut ? 'Out of stock' : 'Low stock',
      body: isOut
        ? `${product.name} has sold out.`
        : `${product.name} is down to ${total} unit${total === 1 ? '' : 's'}.`,
      link: `/products/${product.id}`,
      data: { productId: product.id, inventory: total },
      permission: 'inventory.view',
    })

    logger.info({ productId: product.id, inventory: total }, `Stock alert: ${product.name}`)
  }
}
