import type { Request, Response } from 'express'
import { prisma } from '../../db/prisma'
import { asyncHandler } from '../../utils/async-handler'
import { created, noContent, ok } from '../../utils/response'
import { BadRequestError, NotFoundError, UnauthorizedError } from '../../utils/errors'
import * as service from './auth.service'
import type { AddressInput } from './auth.schema'

/**
 * The refresh token is returned in the body *and* set as an httpOnly cookie.
 *
 * The cookie is the secure default for the browser storefront; the body value
 * exists so a future mobile client, which has no cookie jar, can use the same
 * endpoints unchanged.
 */
const REFRESH_COOKIE = 'pushmina_rt'
const ADMIN_REFRESH_COOKIE = 'pushmina_art'

function setRefreshCookie(res: Response, name: string, token: string): void {
  res.cookie(name, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30,
    path: '/',
  })
}

function readRefreshToken(req: Request, cookieName: string): string {
  const fromBody = (req.body as { refreshToken?: string })?.refreshToken
  const fromCookie = req.cookies?.[cookieName] as string | undefined
  const token = fromBody ?? fromCookie
  if (!token) throw new UnauthorizedError('No session to refresh.')
  return token
}

/* ------------------------------------------------------------------ *
 * Customer authentication
 * ------------------------------------------------------------------ */

export const register = asyncHandler(async (req: Request, res: Response) => {
  const result = await service.register(req.body, req)
  setRefreshCookie(res, REFRESH_COOKIE, result.tokens.refreshToken)
  return created(res, result)
})

export const login = asyncHandler(async (req: Request, res: Response) => {
  const result = await service.login(req.body, req)
  setRefreshCookie(res, REFRESH_COOKIE, result.tokens.refreshToken)
  return ok(res, result)
})

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const tokens = await service.refresh(readRefreshToken(req, REFRESH_COOKIE), 'customer', req)
  setRefreshCookie(res, REFRESH_COOKIE, tokens.refreshToken)
  return ok(res, { tokens })
})

export const logout = asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.[REFRESH_COOKIE] ?? (req.body as { refreshToken?: string })?.refreshToken
  if (token) await service.logout(token, 'customer')
  res.clearCookie(REFRESH_COOKIE, { path: '/' })
  return ok(res, { message: 'Signed out.' })
})

export const logoutEverywhere = asyncHandler(async (req: Request, res: Response) => {
  await service.logoutEverywhere(req.user!.id, 'customer')
  res.clearCookie(REFRESH_COOKIE, { path: '/' })
  return ok(res, { message: 'Signed out on every device.' })
})

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  await service.requestPasswordReset(req.body.email)
  // Always the same answer, so this cannot be used to discover which addresses
  // have accounts.
  return ok(res, {
    message: 'If an account exists for that address, a reset link is on its way.',
  })
})

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  await service.resetPassword(req.body.token, req.body.password)
  return ok(res, { message: 'Your password has been reset. Please sign in.' })
})

export const changePassword = asyncHandler(async (req: Request, res: Response) => {
  await service.changePassword(req.user!.id, req.body.currentPassword, req.body.newPassword)
  res.clearCookie(REFRESH_COOKIE, { path: '/' })
  return ok(res, { message: 'Password changed. Please sign in again.' })
})

/* ------------------------------------------------------------------ *
 * Profile
 * ------------------------------------------------------------------ */

export const me = asyncHandler(async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      emailVerified: true,
      acceptsMarketing: true,
      createdAt: true,
      _count: { select: { orders: true, wishlistItems: true } },
    },
  })
  if (!user) throw new NotFoundError('Account')
  return ok(res, user)
})

export const updateProfile = asyncHandler(async (req: Request, res: Response) => {
  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data: req.body,
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      acceptsMarketing: true,
    },
  })
  return ok(res, user)
})

/* ------------------------------------------------------------------ *
 * Addresses
 * ------------------------------------------------------------------ */

export const listAddresses = asyncHandler(async (req: Request, res: Response) => {
  const addresses = await prisma.address.findMany({
    where: { userId: req.user!.id },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  })
  return ok(res, addresses)
})

export const createAddress = asyncHandler(async (req: Request, res: Response) => {
  const input = req.body as AddressInput
  const userId = req.user!.id

  const count = await prisma.address.count({ where: { userId } })
  // The first address a customer saves is their default, whatever they ticked.
  const isDefault = input.isDefault || count === 0

  const address = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.address.updateMany({ where: { userId }, data: { isDefault: false } })
    }
    return tx.address.create({ data: { ...input, userId, isDefault } })
  })

  return created(res, address)
})

export const updateAddress = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id
  const { id } = req.params

  const existing = await prisma.address.findFirst({ where: { id, userId }, select: { id: true } })
  if (!existing) throw new NotFoundError('Address')

  const input = req.body as Partial<AddressInput>

  const address = await prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.address.updateMany({ where: { userId }, data: { isDefault: false } })
    }
    return tx.address.update({ where: { id }, data: input })
  })

  return ok(res, address)
})

export const deleteAddress = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id
  const { id } = req.params

  const address = await prisma.address.findFirst({ where: { id, userId } })
  if (!address) throw new NotFoundError('Address')

  await prisma.address.delete({ where: { id } })

  // Never leave an account with addresses but no default.
  if (address.isDefault) {
    const next = await prisma.address.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (next) await prisma.address.update({ where: { id: next.id }, data: { isDefault: true } })
  }

  return noContent(res)
})

export const setDefaultAddress = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id
  const { id } = req.params

  const existing = await prisma.address.findFirst({ where: { id, userId }, select: { id: true } })
  if (!existing) throw new NotFoundError('Address')

  await prisma.$transaction([
    prisma.address.updateMany({ where: { userId }, data: { isDefault: false } }),
    prisma.address.update({ where: { id }, data: { isDefault: true } }),
  ])

  return ok(res, { message: 'Default address updated.' })
})

/* ------------------------------------------------------------------ *
 * Admin authentication
 * ------------------------------------------------------------------ */

export const adminLogin = asyncHandler(async (req: Request, res: Response) => {
  const result = await service.adminLogin(req.body, req)
  setRefreshCookie(res, ADMIN_REFRESH_COOKIE, result.tokens.refreshToken)
  return ok(res, result)
})

export const adminRefresh = asyncHandler(async (req: Request, res: Response) => {
  const tokens = await service.refresh(readRefreshToken(req, ADMIN_REFRESH_COOKIE), 'admin', req)
  setRefreshCookie(res, ADMIN_REFRESH_COOKIE, tokens.refreshToken)
  return ok(res, { tokens })
})

export const adminLogout = asyncHandler(async (req: Request, res: Response) => {
  const token =
    req.cookies?.[ADMIN_REFRESH_COOKIE] ?? (req.body as { refreshToken?: string })?.refreshToken
  if (token) await service.logout(token, 'admin')
  res.clearCookie(ADMIN_REFRESH_COOKIE, { path: '/' })
  return ok(res, { message: 'Signed out.' })
})

export const adminMe = asyncHandler(async (req: Request, res: Response) => {
  return ok(res, await service.getAdminProfile(req.admin!.id))
})

export const adminChangePassword = asyncHandler(async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body as {
    currentPassword: string
    newPassword: string
  }

  const admin = await prisma.adminUser.findUnique({
    where: { id: req.admin!.id },
    select: { passwordHash: true },
  })
  if (!admin) throw new NotFoundError('Admin')

  const { verifyPassword, hashPassword } = await import('./password')
  if (!(await verifyPassword(currentPassword, admin.passwordHash))) {
    throw new BadRequestError('Your current password is incorrect.')
  }

  await prisma.$transaction([
    prisma.adminUser.update({
      where: { id: req.admin!.id },
      data: { passwordHash: await hashPassword(newPassword) },
    }),
    prisma.adminRefreshToken.updateMany({
      where: { adminUserId: req.admin!.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ])

  res.clearCookie(ADMIN_REFRESH_COOKIE, { path: '/' })
  return ok(res, { message: 'Password changed. Please sign in again.' })
})
