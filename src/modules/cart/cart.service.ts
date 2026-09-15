import type { Coupon, Prisma } from '@prisma/client'
import { prisma } from '../../db/prisma'
import { env } from '../../config/env'
import { toNumber, round2 } from '../../utils/money'
import {
  BadRequestError,
  InsufficientStockError,
  NotFoundError,
} from '../../utils/errors'
import { logger } from '../../config/logger'

/**
 * Cart.
 *
 * Prices are never taken from the client. Every line is re-priced from the
 * variant row on read, so a tampered request body cannot buy a ₹90,000 kani
 * shawl for ₹1 — and a price change in the admin panel is reflected in an
 * existing cart immediately.
 */

export interface CartTotals {
  subtotal: number
  discount: number
  shipping: number
  tax: number
  total: number
  itemCount: number
}

const cartInclude = {
  coupon: true,
  items: {
    orderBy: { createdAt: 'asc' as const },
    include: {
      product: {
        select: {
          id: true,
          slug: true,
          name: true,
          status: true,
          images: { orderBy: { sortOrder: 'asc' as const }, take: 1 },
        },
      },
      variant: {
        include: {
          color: { select: { name: true, slug: true } },
          size: { select: { name: true, slug: true } },
        },
      },
    },
  },
}

type CartWithItems = Prisma.CartGetPayload<{ include: typeof cartInclude }>

/**
 * Mirrors the storefront's computeTotals() exactly, including the Indian
 * retail convention that GST is *included* in the displayed price — so tax is
 * shown as a component of the total rather than added on top.
 */
export function computeTotals(
  lines: Array<{ unitPrice: number; quantity: number }>,
  coupon: Coupon | null,
): CartTotals {
  const subtotal = round2(
    lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0),
  )
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0)

  let discount = 0
  if (coupon) {
    const minimum = coupon.minimumSubtotal ? toNumber(coupon.minimumSubtotal) : 0
    if (subtotal >= minimum) {
      discount =
        coupon.type === 'PERCENT'
          ? Math.round((subtotal * toNumber(coupon.value)) / 100)
          : Math.min(toNumber(coupon.value), subtotal)

      if (coupon.maxDiscount) discount = Math.min(discount, toNumber(coupon.maxDiscount))
    }
  }

  const payable = Math.max(0, round2(subtotal - discount))
  const shipping =
    payable === 0 || payable >= env.FREE_SHIPPING_THRESHOLD ? 0 : env.STANDARD_SHIPPING_FEE
  const tax = Math.round(payable - payable / (1 + env.GST_RATE))

  return {
    subtotal,
    discount,
    shipping,
    tax,
    total: round2(payable + shipping),
    itemCount,
  }
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

export interface CartIdentity {
  userId?: string
  sessionId?: string
}

async function findOrCreateCart(identity: CartIdentity): Promise<CartWithItems> {
  if (!identity.userId && !identity.sessionId) {
    throw new BadRequestError('No cart identity — cookies may be disabled.')
  }

  const where: Prisma.CartWhereInput = identity.userId
    ? { userId: identity.userId }
    : { sessionId: identity.sessionId }

  const existing = await prisma.cart.findFirst({ where, include: cartInclude })
  if (existing) return existing

  return prisma.cart.create({
    data: identity.userId ? { userId: identity.userId } : { sessionId: identity.sessionId },
    include: cartInclude,
  })
}

/**
 * Moves a guest cart onto a user account at sign-in or registration.
 *
 * Quantities are summed where both carts hold the same variant, and capped at
 * available stock so the merge can never produce an unfulfillable line.
 */
export async function mergeGuestCart(sessionId: string, userId: string): Promise<void> {
  try {
    const guestCart = await prisma.cart.findFirst({
      where: { sessionId },
      include: { items: true },
    })
    if (!guestCart || guestCart.items.length === 0) {
      if (guestCart) await prisma.cart.delete({ where: { id: guestCart.id } })
      return
    }

    const userCart = await prisma.cart.findFirst({ where: { userId } })

    if (!userCart) {
      // No existing cart: simply re-own the guest one.
      await prisma.cart.update({
        where: { id: guestCart.id },
        data: { userId, sessionId: null },
      })
      return
    }

    for (const item of guestCart.items) {
      const variant = await prisma.productVariant.findUnique({
        where: { id: item.variantId },
        select: { inventory: true },
      })
      if (!variant) continue

      const existing = await prisma.cartItem.findUnique({
        where: { cartId_variantId: { cartId: userCart.id, variantId: item.variantId } },
      })

      const desired = (existing?.quantity ?? 0) + item.quantity
      const quantity = Math.max(1, Math.min(desired, variant.inventory, 10))

      if (existing) {
        await prisma.cartItem.update({ where: { id: existing.id }, data: { quantity } })
      } else {
        await prisma.cartItem.create({
          data: {
            cartId: userCart.id,
            productId: item.productId,
            variantId: item.variantId,
            quantity,
          },
        })
      }
    }

    await prisma.cart.delete({ where: { id: guestCart.id } })
  } catch (error) {
    // A failed merge must never block someone from signing in.
    logger.error({ err: error, userId }, 'Guest cart merge failed')
  }
}

/* ------------------------------------------------------------------ *
 * Serialisation
 * ------------------------------------------------------------------ */

/**
 * Shapes the cart to match the storefront's CartItem interface, so the existing
 * cart drawer, cart page and checkout render it without modification.
 */
function serialise(cart: CartWithItems) {
  const items = cart.items
    // A line whose product was archived or deleted is dropped rather than
    // rendered as a broken row.
    .filter((item) => item.product.status === 'PUBLISHED')
    .map((item) => {
      const image = item.product.images[0]
      const unitPrice = toNumber(item.variant.price)
      const maxQuantity = Math.max(1, Math.min(item.variant.inventory, 10))

      return {
        key: item.id,
        id: item.id,
        productSlug: item.product.slug,
        productId: item.product.id,
        variantId: item.variantId,
        name: item.product.name,
        image: image
          ? { url: image.url, alt: image.alt, width: image.width, height: image.height }
          : { url: '', alt: item.product.name, width: 800, height: 1000 },
        color: item.variant.color?.name,
        size: item.variant.size?.name,
        colorSlug: item.variant.color?.slug,
        sizeSlug: item.variant.size?.slug,
        sku: item.variant.sku,
        unitPrice,
        compareAtPrice: item.variant.compareAtPrice
          ? toNumber(item.variant.compareAtPrice)
          : undefined,
        quantity: Math.min(item.quantity, maxQuantity),
        maxQuantity,
        inStock: item.variant.inventory > 0,
        lineTotal: round2(unitPrice * Math.min(item.quantity, maxQuantity)),
      }
    })

  const totals = computeTotals(items, cart.coupon)

  return {
    id: cart.id,
    items,
    totals,
    coupon: cart.coupon
      ? {
          code: cart.coupon.code,
          label: cart.coupon.label,
          type: cart.coupon.type.toLowerCase(),
          value: toNumber(cart.coupon.value),
        }
      : null,
    freeShippingThreshold: env.FREE_SHIPPING_THRESHOLD,
    remainingForFreeShipping: Math.max(0, env.FREE_SHIPPING_THRESHOLD - totals.subtotal),
  }
}

export type SerialisedCart = ReturnType<typeof serialise>

/* ------------------------------------------------------------------ *
 * Operations
 * ------------------------------------------------------------------ */

export async function getCart(identity: CartIdentity): Promise<SerialisedCart> {
  return serialise(await findOrCreateCart(identity))
}

export async function addItem(
  identity: CartIdentity,
  input: { variantId: string; quantity: number },
): Promise<SerialisedCart> {
  const variant = await prisma.productVariant.findUnique({
    where: { id: input.variantId },
    include: { product: { select: { id: true, name: true, status: true } } },
  })

  if (!variant || !variant.isActive) throw new NotFoundError('Product variant')
  if (variant.product.status !== 'PUBLISHED') {
    throw new BadRequestError('That piece is not currently available.')
  }
  if (variant.inventory <= 0) {
    throw new InsufficientStockError(variant.product.name, 0)
  }

  const cart = await findOrCreateCart(identity)

  const existing = await prisma.cartItem.findUnique({
    where: { cartId_variantId: { cartId: cart.id, variantId: input.variantId } },
  })

  const desired = (existing?.quantity ?? 0) + input.quantity
  if (desired > variant.inventory) {
    throw new InsufficientStockError(variant.product.name, variant.inventory)
  }

  const quantity = Math.min(desired, 10)

  if (existing) {
    await prisma.cartItem.update({ where: { id: existing.id }, data: { quantity } })
  } else {
    await prisma.cartItem.create({
      data: {
        cartId: cart.id,
        productId: variant.product.id,
        variantId: input.variantId,
        quantity,
      },
    })
  }

  return serialise(await findOrCreateCart(identity))
}

export async function updateItem(
  identity: CartIdentity,
  itemId: string,
  quantity: number,
): Promise<SerialisedCart> {
  const cart = await findOrCreateCart(identity)

  // Ownership is enforced through cartId, so one visitor cannot edit another's.
  const item = await prisma.cartItem.findFirst({
    where: { id: itemId, cartId: cart.id },
    include: { variant: { include: { product: { select: { name: true } } } } },
  })
  if (!item) throw new NotFoundError('Cart item')

  if (quantity <= 0) {
    await prisma.cartItem.delete({ where: { id: item.id } })
    return serialise(await findOrCreateCart(identity))
  }

  if (quantity > item.variant.inventory) {
    throw new InsufficientStockError(item.variant.product.name, item.variant.inventory)
  }

  await prisma.cartItem.update({
    where: { id: item.id },
    data: { quantity: Math.min(quantity, 10) },
  })

  return serialise(await findOrCreateCart(identity))
}

export async function removeItem(
  identity: CartIdentity,
  itemId: string,
): Promise<SerialisedCart> {
  const cart = await findOrCreateCart(identity)
  await prisma.cartItem.deleteMany({ where: { id: itemId, cartId: cart.id } })
  return serialise(await findOrCreateCart(identity))
}

export async function clearCart(identity: CartIdentity): Promise<SerialisedCart> {
  const cart = await findOrCreateCart(identity)
  await prisma.cartItem.deleteMany({ where: { cartId: cart.id } })
  await prisma.cart.update({ where: { id: cart.id }, data: { couponId: null } })
  return serialise(await findOrCreateCart(identity))
}

export async function applyCoupon(
  identity: CartIdentity,
  code: string,
): Promise<{ cart: SerialisedCart; message: string }> {
  const coupon = await prisma.coupon.findFirst({
    where: { code: { equals: code.trim(), mode: 'insensitive' } },
  })

  if (!coupon || !coupon.isActive) {
    throw new BadRequestError('That code is not recognised.')
  }

  const now = new Date()
  if (coupon.startsAt && coupon.startsAt > now) {
    throw new BadRequestError('That code is not active yet.')
  }
  if (coupon.endsAt && coupon.endsAt < now) {
    throw new BadRequestError('That code has expired.')
  }
  if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) {
    throw new BadRequestError('That code has reached its usage limit.')
  }

  if (coupon.perUserLimit && identity.userId) {
    const used = await prisma.couponUsage.count({
      where: { couponId: coupon.id, userId: identity.userId },
    })
    if (used >= coupon.perUserLimit) {
      throw new BadRequestError('You have already used that code.')
    }
  }

  const cart = await findOrCreateCart(identity)
  const current = serialise(cart)

  if (coupon.minimumSubtotal && current.totals.subtotal < toNumber(coupon.minimumSubtotal)) {
    throw new BadRequestError(
      `This code applies to orders above ₹${toNumber(coupon.minimumSubtotal).toLocaleString('en-IN')}.`,
    )
  }

  await prisma.cart.update({ where: { id: cart.id }, data: { couponId: coupon.id } })

  return {
    cart: serialise(await findOrCreateCart(identity)),
    message: coupon.label,
  }
}

export async function removeCoupon(identity: CartIdentity): Promise<SerialisedCart> {
  const cart = await findOrCreateCart(identity)
  await prisma.cart.update({ where: { id: cart.id }, data: { couponId: null } })
  return serialise(await findOrCreateCart(identity))
}

/**
 * Pre-checkout validation: re-checks availability and stock for every line and
 * reports what changed, rather than failing the whole order on the first issue.
 */
export async function validateCart(identity: CartIdentity): Promise<{
  valid: boolean
  issues: Array<{ itemId: string; name: string; reason: string; available: number }>
  cart: SerialisedCart
}> {
  const cart = await findOrCreateCart(identity)
  const issues: Array<{ itemId: string; name: string; reason: string; available: number }> = []

  for (const item of cart.items) {
    if (item.product.status !== 'PUBLISHED') {
      issues.push({
        itemId: item.id,
        name: item.product.name,
        reason: 'No longer available',
        available: 0,
      })
      continue
    }
    if (item.variant.inventory <= 0) {
      issues.push({
        itemId: item.id,
        name: item.product.name,
        reason: 'Out of stock',
        available: 0,
      })
      continue
    }
    if (item.quantity > item.variant.inventory) {
      issues.push({
        itemId: item.id,
        name: item.product.name,
        reason: `Only ${item.variant.inventory} left`,
        available: item.variant.inventory,
      })
    }
  }

  const serialised = serialise(cart)

  return {
    valid: issues.length === 0 && serialised.items.length > 0,
    issues,
    cart: serialised,
  }
}
