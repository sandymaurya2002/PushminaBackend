import { prisma } from '../../db/prisma'
import { productInclude, toProductCardDto, type ProductWithRelations } from '../catalog/catalog.dto'
import { NotFoundError } from '../../utils/errors'

/**
 * Wishlist.
 *
 * Signed-out visitors keep their wishlist in localStorage on the storefront —
 * no account required, exactly as today. These endpoints back the signed-in
 * case, where it follows the customer across devices.
 */

export async function listWishlist(userId: string) {
  const entries = await prisma.wishlistItem.findMany({
    where: { userId, product: { status: 'PUBLISHED' } },
    orderBy: { createdAt: 'desc' },
    include: { product: { include: productInclude } },
  })

  return entries.map((entry) => ({
    addedAt: entry.createdAt.toISOString(),
    product: toProductCardDto(entry.product as unknown as ProductWithRelations),
  }))
}

export async function listSlugs(userId: string): Promise<string[]> {
  const entries = await prisma.wishlistItem.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { product: { select: { slug: true } } },
  })
  return entries.map((entry) => entry.product.slug)
}

export async function toggle(userId: string, slug: string): Promise<{ added: boolean }> {
  const product = await prisma.product.findUnique({
    where: { slug },
    select: { id: true },
  })
  if (!product) throw new NotFoundError('Product')

  const existing = await prisma.wishlistItem.findUnique({
    where: { userId_productId: { userId, productId: product.id } },
    select: { id: true },
  })

  if (existing) {
    await prisma.wishlistItem.delete({ where: { id: existing.id } })
    return { added: false }
  }

  await prisma.wishlistItem.create({ data: { userId, productId: product.id } })
  return { added: true }
}

export async function remove(userId: string, slug: string): Promise<void> {
  const product = await prisma.product.findUnique({ where: { slug }, select: { id: true } })
  if (!product) throw new NotFoundError('Product')
  await prisma.wishlistItem.deleteMany({ where: { userId, productId: product.id } })
}

export async function clear(userId: string): Promise<void> {
  await prisma.wishlistItem.deleteMany({ where: { userId } })
}

/**
 * Merges a guest's localStorage wishlist into the account on sign-in, so the
 * hearts a visitor tapped before registering are not silently lost.
 */
export async function merge(userId: string, slugs: string[]): Promise<number> {
  if (slugs.length === 0) return 0

  const products = await prisma.product.findMany({
    where: { slug: { in: slugs.slice(0, 200) } },
    select: { id: true },
  })

  const result = await prisma.wishlistItem.createMany({
    data: products.map((product) => ({ userId, productId: product.id })),
    skipDuplicates: true,
  })

  return result.count
}
