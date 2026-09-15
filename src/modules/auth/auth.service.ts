import type { Request } from 'express'
import { prisma } from '../../db/prisma'
import { env } from '../../config/env'
import { signAccessToken, type TokenAudience } from './jwt'
import { fakeVerify, hashPassword, verifyPassword } from './password'
import { addDuration, generateToken, hashToken } from '../../utils/tokens'
import { ConflictError, UnauthorizedError, NotFoundError, BadRequestError } from '../../utils/errors'
import { notifyAdmins, notifyCustomer } from '../notifications/notification.service'
import { templates } from '../email/templates'
import { sendMail } from '../email/mailer'
import { mergeGuestCart } from '../cart/cart.service'

/**
 * Authentication.
 *
 * Access tokens are short-lived JWTs. Refresh tokens are opaque random strings
 * stored only as a SHA-256 hash, which makes them revocable — sign-out and
 * "sign out everywhere" actually invalidate a session, which a bare JWT cannot.
 */

export interface AuthTokens {
  accessToken: string
  refreshToken: string
  expiresIn: string
}

async function issueTokens(
  subject: { id: string; email: string },
  audience: TokenAudience,
  req: Request,
): Promise<AuthTokens> {
  const accessToken = signAccessToken({ sub: subject.id, aud: audience, email: subject.email })
  const refreshToken = generateToken(48)
  const expiresAt = addDuration(new Date(), env.JWT_REFRESH_TTL)

  const record = {
    tokenHash: hashToken(refreshToken),
    expiresAt,
    userAgent: req.get('user-agent')?.slice(0, 250),
    ip: req.ip,
  }

  if (audience === 'admin') {
    await prisma.adminRefreshToken.create({ data: { ...record, adminUserId: subject.id } })
  } else {
    await prisma.userRefreshToken.create({ data: { ...record, userId: subject.id } })
  }

  return { accessToken, refreshToken, expiresIn: env.JWT_ACCESS_TTL }
}

/* ------------------------------------------------------------------ *
 * Customer
 * ------------------------------------------------------------------ */

export async function register(input: {
  firstName: string
  lastName: string
  email: string
  password: string
  phone?: string
  acceptsMarketing: boolean
}, req: Request) {
  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  })
  if (existing) {
    throw new ConflictError('An account with that email already exists. Try signing in.')
  }

  const user = await prisma.user.create({
    data: {
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      acceptsMarketing: input.acceptsMarketing,
      passwordHash: await hashPassword(input.password),
    },
    select: { id: true, email: true, firstName: true, lastName: true, phone: true, createdAt: true },
  })

  // A guest who filled a bag before registering keeps it.
  if (req.sessionId) await mergeGuestCart(req.sessionId, user.id)

  await notifyCustomer({
    userId: user.id,
    type: 'WELCOME',
    title: 'Welcome to Pushmina',
    body: 'Your account is ready. Track orders, save addresses and keep your wishlist across devices.',
    link: '/account',
    email: { to: user.email, template: 'welcome', ...templates.welcome(user.firstName) },
  })

  await notifyAdmins({
    type: 'ADMIN_NEW_CUSTOMER',
    title: 'New customer registered',
    body: `${user.firstName} ${user.lastName} (${user.email})`,
    link: `/customers/${user.id}`,
    data: { userId: user.id },
    permission: 'customers.view',
  })

  const tokens = await issueTokens(user, 'customer', req)
  return { user, tokens }
}

export async function login(input: { email: string; password: string }, req: Request) {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      status: true,
      passwordHash: true,
    },
  })

  // Burn the same time whether or not the address exists, so response timing
  // cannot be used to discover which emails have accounts.
  if (!user?.passwordHash) {
    await fakeVerify()
    throw new UnauthorizedError('Email or password is incorrect.')
  }

  const valid = await verifyPassword(input.password, user.passwordHash)
  if (!valid) throw new UnauthorizedError('Email or password is incorrect.')

  if (user.status === 'BLOCKED') {
    throw new UnauthorizedError('This account has been suspended. Contact care@pushmina.com.')
  }
  if (user.status === 'DELETED') {
    throw new UnauthorizedError('Email or password is incorrect.')
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })

  if (req.sessionId) await mergeGuestCart(req.sessionId, user.id)

  const tokens = await issueTokens(user, 'customer', req)
  const { passwordHash: _hash, status: _status, ...safe } = user
  return { user: safe, tokens }
}

export async function refresh(refreshToken: string, audience: TokenAudience, req: Request) {
  const tokenHash = hashToken(refreshToken)

  if (audience === 'admin') {
    const record = await prisma.adminRefreshToken.findUnique({
      where: { tokenHash },
      include: { adminUser: { select: { id: true, email: true, isActive: true } } },
    })

    if (!record || record.revokedAt || record.expiresAt < new Date() || !record.adminUser.isActive) {
      throw new UnauthorizedError('Session expired. Please sign in again.')
    }

    // Single-use: the presented token is revoked as a new one is issued, so a
    // stolen refresh token is usable at most once.
    await prisma.adminRefreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    })

    return issueTokens(record.adminUser, 'admin', req)
  }

  const record = await prisma.userRefreshToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, email: true, status: true } } },
  })

  if (!record || record.revokedAt || record.expiresAt < new Date()) {
    throw new UnauthorizedError('Session expired. Please sign in again.')
  }
  if (record.user.status !== 'ACTIVE') {
    throw new UnauthorizedError('This account is no longer active.')
  }

  await prisma.userRefreshToken.update({
    where: { id: record.id },
    data: { revokedAt: new Date() },
  })

  return issueTokens(record.user, 'customer', req)
}

export async function logout(refreshToken: string, audience: TokenAudience): Promise<void> {
  const tokenHash = hashToken(refreshToken)
  const data = { revokedAt: new Date() }

  if (audience === 'admin') {
    await prisma.adminRefreshToken.updateMany({ where: { tokenHash }, data })
  } else {
    await prisma.userRefreshToken.updateMany({ where: { tokenHash }, data })
  }
}

export async function logoutEverywhere(userId: string, audience: TokenAudience): Promise<void> {
  const data = { revokedAt: new Date() }
  if (audience === 'admin') {
    await prisma.adminRefreshToken.updateMany({
      where: { adminUserId: userId, revokedAt: null },
      data,
    })
  } else {
    await prisma.userRefreshToken.updateMany({ where: { userId, revokedAt: null }, data })
  }
}

/* ------------------------------------------------------------------ *
 * Password reset
 * ------------------------------------------------------------------ */

/**
 * Always reports success, whether or not the address exists. Confirming which
 * emails have accounts is a free gift to an attacker.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, firstName: true },
  })
  if (!user) return

  const token = generateToken(32)

  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: addDuration(new Date(), '1h'),
    },
  })

  const resetUrl = `${env.STOREFRONT_URL}/reset-password?token=${token}`
  await sendMail({
    to: user.email,
    template: 'password-reset',
    ...templates.passwordReset({ firstName: user.firstName, resetUrl }),
  })
}

export async function resetPassword(token: string, password: string): Promise<void> {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, userId: true, expiresAt: true, usedAt: true },
  })

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw new BadRequestError('That reset link is invalid or has expired. Please request another.')
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash: await hashPassword(password) },
    }),
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
    // Changing a password must end every existing session.
    prisma.userRefreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ])
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  })
  if (!user?.passwordHash) throw new NotFoundError('Account')

  const valid = await verifyPassword(currentPassword, user.passwordHash)
  if (!valid) throw new UnauthorizedError('Your current password is incorrect.')

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(newPassword) },
    }),
    prisma.userRefreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ])
}

/* ------------------------------------------------------------------ *
 * Admin
 * ------------------------------------------------------------------ */

export async function adminLogin(input: { email: string; password: string }, req: Request) {
  const admin = await prisma.adminUser.findUnique({
    where: { email: input.email },
    select: {
      id: true,
      email: true,
      name: true,
      avatarUrl: true,
      isActive: true,
      passwordHash: true,
      role: {
        select: {
          id: true,
          name: true,
          slug: true,
          permissions: { select: { permission: { select: { key: true } } } },
        },
      },
    },
  })

  if (!admin) {
    await fakeVerify()
    throw new UnauthorizedError('Email or password is incorrect.')
  }

  const valid = await verifyPassword(input.password, admin.passwordHash)
  if (!valid) throw new UnauthorizedError('Email or password is incorrect.')
  if (!admin.isActive) throw new UnauthorizedError('This admin account has been deactivated.')

  await prisma.adminUser.update({
    where: { id: admin.id },
    data: { lastLoginAt: new Date() },
  })

  const tokens = await issueTokens(admin, 'admin', req)

  return {
    admin: {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      avatarUrl: admin.avatarUrl,
      role: {
        id: admin.role.id,
        name: admin.role.name,
        slug: admin.role.slug,
      },
      permissions: admin.role.permissions.map((entry) => entry.permission.key),
    },
    tokens,
  }
}

export async function getAdminProfile(adminId: string) {
  const admin = await prisma.adminUser.findUnique({
    where: { id: adminId },
    select: {
      id: true,
      email: true,
      name: true,
      avatarUrl: true,
      phone: true,
      lastLoginAt: true,
      createdAt: true,
      role: {
        select: {
          id: true,
          name: true,
          slug: true,
          permissions: { select: { permission: { select: { key: true } } } },
        },
      },
    },
  })
  if (!admin) throw new NotFoundError('Admin')

  return {
    ...admin,
    permissions: admin.role.permissions.map((entry) => entry.permission.key),
  }
}
