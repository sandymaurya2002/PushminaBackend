import type { NotificationType, Prisma } from '@prisma/client'
import { prisma } from '../../db/prisma'
import { logger } from '../../config/logger'
import { sendMail } from '../email/mailer'

/**
 * Notification dispatch.
 *
 * One call fans out to every channel the recipient has enabled. Delivery is
 * best-effort and never allowed to fail the business operation that triggered
 * it — an order must not roll back because an SMTP server was slow.
 */

export interface NotifyCustomerInput {
  userId: string
  type: NotificationType
  title: string
  body: string
  link?: string
  data?: Prisma.InputJsonValue
  email?: { to: string; subject: string; html: string; template: string }
}

export interface NotifyAdminsInput {
  type: NotificationType
  title: string
  body: string
  link?: string
  data?: Prisma.InputJsonValue
  /** Restrict to admins holding this permission; omit to notify all active admins. */
  permission?: string
}

/** True unless the customer has explicitly switched this channel off. */
async function channelEnabled(
  userId: string,
  type: NotificationType,
  channel: 'IN_APP' | 'EMAIL' | 'PUSH',
): Promise<boolean> {
  const preference = await prisma.notificationPreference.findUnique({
    where: { userId_channel_type: { userId, channel, type } },
    select: { enabled: true },
  })
  return preference?.enabled ?? true
}

export async function notifyCustomer(input: NotifyCustomerInput): Promise<void> {
  try {
    if (await channelEnabled(input.userId, input.type, 'IN_APP')) {
      await prisma.notification.create({
        data: {
          audience: 'CUSTOMER',
          userId: input.userId,
          type: input.type,
          title: input.title,
          body: input.body,
          link: input.link,
          data: input.data,
        },
      })
    }

    if (input.email && (await channelEnabled(input.userId, input.type, 'EMAIL'))) {
      await sendMail(input.email)
    }
  } catch (error) {
    logger.error({ err: error, type: input.type }, 'Customer notification failed')
  }
}

/**
 * Sends to a guest (no account) — email only, since there is no inbox to
 * write an in-app notification into.
 */
export async function notifyGuest(email: {
  to: string
  subject: string
  html: string
  template: string
}): Promise<void> {
  try {
    await sendMail(email)
  } catch (error) {
    logger.error({ err: error }, 'Guest notification failed')
  }
}

export async function notifyAdmins(input: NotifyAdminsInput): Promise<void> {
  try {
    const admins = await prisma.adminUser.findMany({
      where: {
        isActive: true,
        ...(input.permission
          ? {
              role: {
                OR: [
                  { slug: 'super-admin' },
                  { permissions: { some: { permission: { key: input.permission } } } },
                ],
              },
            }
          : {}),
      },
      select: { id: true },
    })

    if (admins.length === 0) return

    await prisma.notification.createMany({
      data: admins.map((admin) => ({
        audience: 'ADMIN' as const,
        adminUserId: admin.id,
        type: input.type,
        title: input.title,
        body: input.body,
        link: input.link,
        data: input.data,
      })),
    })
  } catch (error) {
    logger.error({ err: error, type: input.type }, 'Admin notification failed')
  }
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

export async function listForCustomer(
  userId: string,
  options: { page: number; limit: number; unreadOnly?: boolean },
) {
  const where: Prisma.NotificationWhereInput = {
    userId,
    audience: 'CUSTOMER',
    ...(options.unreadOnly ? { isRead: false } : {}),
  }

  const [items, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (options.page - 1) * options.limit,
      take: options.limit,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, audience: 'CUSTOMER', isRead: false } }),
  ])

  return { items, total, unreadCount }
}

export async function listForAdmin(
  adminUserId: string,
  options: { page: number; limit: number; unreadOnly?: boolean },
) {
  const where: Prisma.NotificationWhereInput = {
    adminUserId,
    audience: 'ADMIN',
    ...(options.unreadOnly ? { isRead: false } : {}),
  }

  const [items, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (options.page - 1) * options.limit,
      take: options.limit,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { adminUserId, audience: 'ADMIN', isRead: false } }),
  ])

  return { items, total, unreadCount }
}

/**
 * Ownership is part of the WHERE clause rather than a separate lookup, so one
 * customer can never mark another customer's notification as read.
 */
export async function markRead(
  notificationId: string,
  owner: { userId?: string; adminUserId?: string },
): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { id: notificationId, ...owner },
    data: { isRead: true, readAt: new Date() },
  })
  return result.count
}

export async function markAllRead(owner: {
  userId?: string
  adminUserId?: string
}): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { ...owner, isRead: false },
    data: { isRead: true, readAt: new Date() },
  })
  return result.count
}

export async function remove(
  notificationId: string,
  owner: { userId?: string; adminUserId?: string },
): Promise<number> {
  const result = await prisma.notification.deleteMany({
    where: { id: notificationId, ...owner },
  })
  return result.count
}

export async function unreadCount(owner: {
  userId?: string
  adminUserId?: string
}): Promise<number> {
  return prisma.notification.count({ where: { ...owner, isRead: false } })
}
