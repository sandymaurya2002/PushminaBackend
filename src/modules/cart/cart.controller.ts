import type { Request, Response } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../../utils/async-handler'
import { ok } from '../../utils/response'
import * as service from './cart.service'

/**
 * Cart identity: a signed-in customer is keyed by user id, everyone else by the
 * httpOnly guest session cookie. A guest cart is carried onto the account
 * automatically at sign-in.
 */
function identity(req: Request): service.CartIdentity {
  return req.user?.id ? { userId: req.user.id } : { sessionId: req.sessionId }
}

export const addItemSchema = z.object({
  variantId: z.string().min(1, 'Choose a colour and size.'),
  quantity: z.coerce.number().int().min(1).max(10).default(1),
})

export const updateItemSchema = z.object({
  quantity: z.coerce.number().int().min(0).max(10),
})

export const couponSchema = z.object({
  code: z.string().trim().min(1, 'Enter a discount code.').max(40),
})

export const getCart = asyncHandler(async (req: Request, res: Response) => {
  return ok(res, await service.getCart(identity(req)))
})

export const addItem = asyncHandler(async (req: Request, res: Response) => {
  const cart = await service.addItem(identity(req), req.body)
  return ok(res, cart)
})

export const updateItem = asyncHandler(async (req: Request, res: Response) => {
  const cart = await service.updateItem(identity(req), req.params.itemId, req.body.quantity)
  return ok(res, cart)
})

export const removeItem = asyncHandler(async (req: Request, res: Response) => {
  return ok(res, await service.removeItem(identity(req), req.params.itemId))
})

export const clearCart = asyncHandler(async (req: Request, res: Response) => {
  return ok(res, await service.clearCart(identity(req)))
})

export const applyCoupon = asyncHandler(async (req: Request, res: Response) => {
  const result = await service.applyCoupon(identity(req), req.body.code)
  return ok(res, result.cart, { message: result.message })
})

export const removeCoupon = asyncHandler(async (req: Request, res: Response) => {
  return ok(res, await service.removeCoupon(identity(req)))
})

/** Called immediately before checkout so stock problems surface early. */
export const validateCart = asyncHandler(async (req: Request, res: Response) => {
  return ok(res, await service.validateCart(identity(req)))
})
