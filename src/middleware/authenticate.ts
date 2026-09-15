import type { NextFunction, Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import { prisma } from '../db/prisma'
import { extractBearer, verifyAccessToken } from '../modules/auth/jwt'
import { ForbiddenError, UnauthorizedError } from '../utils/errors'
import { asyncHandler } from '../utils/async-handler'

export const GUEST_COOKIE = 'pushmina_sid'

/**
 * Gives every request a guest identity so a signed-out visitor still gets a
 * server-side cart. httpOnly and sameSite=lax: it is never read by scripts and
 * survives the redirect back from a payment gateway.
 */
export function guestSession(req: Request, res: Response, next: NextFunction): void {
  let sessionId = req.cookies?.[GUEST_COOKIE] as string | undefined

  if (!sessionId) {
    sessionId = randomUUID()
    res.cookie(GUEST_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 90,
      path: '/',
    })
  }

  req.sessionId = sessionId
  next()
}

/** Attaches `req.user` when a valid customer token is present. Never throws. */
export const optionalAuth = asyncHandler(async (req, _res, next) => {
  const token = extractBearer(req.headers.authorization)
  if (!token) return next()

  try {
    const payload = verifyAccessToken(token)
    if (payload.aud !== 'customer') return next()

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, firstName: true, lastName: true, status: true },
    })

    if (user && user.status === 'ACTIVE') req.user = user
  } catch {
    // An invalid token on an optional route is simply an anonymous visitor.
  }

  next()
})

/** Requires a signed-in, active customer. */
export const requireAuth = asyncHandler(async (req, _res, next) => {
  const token = extractBearer(req.headers.authorization)
  if (!token) throw new UnauthorizedError('Please sign in to continue.')

  const payload = verifyAccessToken(token)
  if (payload.aud !== 'customer') {
    throw new UnauthorizedError('This endpoint requires a customer account.')
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, email: true, firstName: true, lastName: true, status: true },
  })

  if (!user) throw new UnauthorizedError('Account no longer exists.')
  if (user.status === 'BLOCKED') throw new ForbiddenError('This account has been suspended.')
  if (user.status === 'DELETED') throw new UnauthorizedError('Account no longer exists.')

  req.user = user
  next()
})

/**
 * Requires a signed-in admin.
 *
 * Permissions are read from the database on every request rather than baked
 * into the token, so revoking a role takes effect immediately instead of when
 * the access token happens to expire.
 */
export const requireAdmin = asyncHandler(async (req, _res, next) => {
  const token = extractBearer(req.headers.authorization)
  if (!token) throw new UnauthorizedError('Admin authentication required.')

  const payload = verifyAccessToken(token)
  if (payload.aud !== 'admin') {
    throw new UnauthorizedError('This endpoint requires an admin account.')
  }

  const admin = await prisma.adminUser.findUnique({
    where: { id: payload.sub },
    select: {
      id: true,
      email: true,
      name: true,
      isActive: true,
      roleId: true,
      role: {
        select: {
          slug: true,
          permissions: { select: { permission: { select: { key: true } } } },
        },
      },
    },
  })

  if (!admin) throw new UnauthorizedError('Admin account no longer exists.')
  if (!admin.isActive) throw new ForbiddenError('This admin account has been deactivated.')

  req.admin = {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    roleId: admin.roleId,
    roleSlug: admin.role.slug,
    permissions: admin.role.permissions.map((entry) => entry.permission.key),
  }

  next()
})
