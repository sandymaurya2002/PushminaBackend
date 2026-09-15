import { Router } from 'express'
import { z } from 'zod'
import multer from 'multer'
import { prisma } from '../../db/prisma'
import { env } from '../../config/env'
import { requirePermission, requireSuperAdmin } from '../../middleware/authorize'
import { validateBody, validateQuery, validated } from '../../middleware/validate'
import { uploadLimiter } from '../../middleware/rate-limit'
import { asyncHandler } from '../../utils/async-handler'
import { created, noContent, ok, paginated } from '../../utils/response'
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/errors'
import { toNumber } from '../../utils/money'
import { audit } from './audit'
import { deleteFile, storeFile, MEDIA_FOLDERS } from '../media/storage'
import { recomputeRating } from '../reviews/review.routes'
import * as notificationService from '../notifications/notification.service'
import { hashPassword, passwordSchema } from '../auth/password'
import { ALL_PERMISSIONS } from '../../config/permissions'

export const adminMiscRouter = Router()

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

/* ================================================================== *
 * Media library
 * ================================================================== */

const ALLOWED_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
]

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      // Rejecting by MIME type keeps executables and HTML out of a directory
      // that is served publicly.
      callback(new BadRequestError(`Unsupported file type: ${file.mimetype}`))
      return
    }
    callback(null, true)
  },
})

adminMiscRouter.get(
  '/media',
  requirePermission('media.view'),
  validateQuery(pageQuery.extend({ folder: z.string().optional(), q: z.string().optional() })),
  asyncHandler(async (req, res) => {
    const query = validated<{ page: number; limit: number; folder?: string; q?: string }>(req)

    const where = {
      ...(query.folder ? { folder: query.folder } : {}),
      ...(query.q
        ? {
            OR: [
              { originalName: { contains: query.q, mode: 'insensitive' as const } },
              { alt: { contains: query.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    }

    const [assets, total] = await Promise.all([
      prisma.mediaAsset.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { uploadedBy: { select: { id: true, name: true } } },
      }),
      prisma.mediaAsset.count({ where }),
    ])

    return paginated(res, assets, total, query.page, query.limit, { folders: MEDIA_FOLDERS })
  }),
)

adminMiscRouter.post(
  '/media',
  requirePermission('media.upload'),
  uploadLimiter,
  upload.array('files', 10),
  asyncHandler(async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? []
    if (files.length === 0) throw new BadRequestError('No files were uploaded.')

    const folder = (req.body as { folder?: string }).folder ?? 'general'
    const alt = (req.body as { alt?: string }).alt

    const assets = []
    for (const file of files) {
      const stored = await storeFile(file.buffer, file.originalname, file.mimetype, folder)

      const asset = await prisma.mediaAsset.create({
        data: {
          filename: stored.filename,
          originalName: file.originalname.slice(0, 250),
          mimeType: stored.mimeType,
          size: stored.size,
          width: stored.width,
          height: stored.height,
          url: stored.url,
          thumbnailUrl: stored.thumbnailUrl,
          folder: stored.folder,
          alt: alt ?? null,
          uploadedById: req.admin!.id,
        },
      })

      assets.push(asset)
    }

    await audit(req, 'uploaded', 'MediaAsset', undefined, null, { count: assets.length, folder })
    return created(res, assets)
  }),
)

adminMiscRouter.patch(
  '/media/:id',
  requirePermission('media.upload'),
  validateBody(z.object({ alt: z.string().trim().max(300).nullable() })),
  asyncHandler(async (req, res) => {
    const asset = await prisma.mediaAsset.update({
      where: { id: req.params.id },
      data: { alt: req.body.alt },
    })
    return ok(res, asset)
  }),
)

adminMiscRouter.delete(
  '/media/:id',
  requirePermission('media.delete'),
  asyncHandler(async (req, res) => {
    const asset = await prisma.mediaAsset.findUnique({ where: { id: req.params.id } })
    if (!asset) throw new NotFoundError('Media asset')

    // Refuse if the file is still referenced anywhere visible.
    const [productImages, banners, posts] = await Promise.all([
      prisma.productImage.count({ where: { url: asset.url } }),
      prisma.banner.count({ where: { imageUrl: asset.url } }),
      prisma.blogPost.count({ where: { coverUrl: asset.url } }),
    ])

    const usage = productImages + banners + posts
    if (usage > 0) {
      throw new ConflictError(
        `This file is used in ${usage} place(s) on the site. Replace it there before deleting.`,
      )
    }

    await prisma.mediaAsset.delete({ where: { id: req.params.id } })
    await deleteFile(asset.url)
    if (asset.thumbnailUrl) await deleteFile(asset.thumbnailUrl)

    await audit(req, 'deleted', 'MediaAsset', req.params.id, asset, null)
    return noContent(res)
  }),
)

/* ================================================================== *
 * Reviews moderation
 * ================================================================== */

adminMiscRouter.get(
  '/reviews',
  requirePermission('reviews.view'),
  validateQuery(
    pageQuery.extend({
      status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
      productId: z.string().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const query = validated<{ page: number; limit: number; status?: string; productId?: string }>(req)

    const where = {
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
    }

    const [reviews, total, pending] = await Promise.all([
      prisma.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          product: { select: { id: true, slug: true, name: true } },
          user: { select: { id: true, email: true } },
        },
      }),
      prisma.review.count({ where }),
      prisma.review.count({ where: { status: 'PENDING' } }),
    ])

    return paginated(res, reviews, total, query.page, query.limit, { pendingCount: pending })
  }),
)

adminMiscRouter.patch(
  '/reviews/:id',
  requirePermission('reviews.moderate'),
  validateBody(
    z.object({
      status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
      adminReply: z.string().trim().max(2000).nullable().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const existing = await prisma.review.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new NotFoundError('Review')

    const review = await prisma.review.update({ where: { id: req.params.id }, data: req.body })

    // Approving or rejecting changes the product's public score.
    if (req.body.status && req.body.status !== existing.status) {
      await recomputeRating(review.productId)
    }

    await audit(req, 'moderated', 'Review', review.id, existing, review)
    return ok(res, review)
  }),
)

adminMiscRouter.delete(
  '/reviews/:id',
  requirePermission('reviews.delete'),
  asyncHandler(async (req, res) => {
    const review = await prisma.review.findUnique({ where: { id: req.params.id } })
    if (!review) throw new NotFoundError('Review')

    await prisma.review.delete({ where: { id: req.params.id } })
    await recomputeRating(review.productId)
    await audit(req, 'deleted', 'Review', req.params.id, review, null)

    return noContent(res)
  }),
)

/* ================================================================== *
 * Contact submissions
 * ================================================================== */

adminMiscRouter.get(
  '/contact',
  requirePermission('contact.view'),
  validateQuery(
    pageQuery.extend({ status: z.enum(['NEW', 'READ', 'REPLIED', 'CLOSED']).optional() }),
  ),
  asyncHandler(async (req, res) => {
    const query = validated<{ page: number; limit: number; status?: string }>(req)
    const where = query.status ? { status: query.status as never } : {}

    const [submissions, total, unread] = await Promise.all([
      prisma.contactSubmission.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.contactSubmission.count({ where }),
      prisma.contactSubmission.count({ where: { status: 'NEW' } }),
    ])

    return paginated(res, submissions, total, query.page, query.limit, { newCount: unread })
  }),
)

adminMiscRouter.patch(
  '/contact/:id',
  requirePermission('contact.update'),
  validateBody(
    z.object({
      status: z.enum(['NEW', 'READ', 'REPLIED', 'CLOSED']).optional(),
      adminNotes: z.string().trim().max(4000).nullable().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const submission = await prisma.contactSubmission.update({
      where: { id: req.params.id },
      data: {
        ...req.body,
        ...(req.body.status === 'REPLIED' ? { repliedAt: new Date() } : {}),
      },
    })
    return ok(res, submission)
  }),
)

adminMiscRouter.delete(
  '/contact/:id',
  requirePermission('contact.delete'),
  asyncHandler(async (req, res) => {
    await prisma.contactSubmission.delete({ where: { id: req.params.id } })
    await audit(req, 'deleted', 'ContactSubmission', req.params.id)
    return noContent(res)
  }),
)

/* ================================================================== *
 * Newsletter
 * ================================================================== */

adminMiscRouter.get(
  '/newsletter',
  requirePermission('newsletter.view'),
  validateQuery(
    pageQuery.extend({
      status: z.enum(['SUBSCRIBED', 'UNSUBSCRIBED']).optional(),
      q: z.string().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const query = validated<{ page: number; limit: number; status?: string; q?: string }>(req)

    const where = {
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.q ? { email: { contains: query.q, mode: 'insensitive' as const } } : {}),
    }

    const [subscribers, total, active] = await Promise.all([
      prisma.newsletterSubscriber.findMany({
        where,
        orderBy: { subscribedAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.newsletterSubscriber.count({ where }),
      prisma.newsletterSubscriber.count({ where: { status: 'SUBSCRIBED' } }),
    ])

    return paginated(res, subscribers, total, query.page, query.limit, { activeCount: active })
  }),
)

adminMiscRouter.get(
  '/newsletter/export/csv',
  requirePermission('newsletter.export'),
  asyncHandler(async (req, res) => {
    const subscribers = await prisma.newsletterSubscriber.findMany({
      where: { status: 'SUBSCRIBED' },
      orderBy: { subscribedAt: 'desc' },
      select: { email: true, source: true, subscribedAt: true },
    })

    const escape = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""')}"`
    const csv = [
      ['Email', 'Source', 'Subscribed At'].map(escape).join(','),
      ...subscribers.map((s) =>
        [s.email, s.source ?? '', s.subscribedAt.toISOString()].map(escape).join(','),
      ),
    ].join('\r\n')

    await audit(req, 'exported', 'NewsletterSubscriber', undefined, null, {
      count: subscribers.length,
    })

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="pushmina-newsletter.csv"')
    return res.send(`﻿${csv}`)
  }),
)

adminMiscRouter.delete(
  '/newsletter/:id',
  requirePermission('newsletter.delete'),
  asyncHandler(async (req, res) => {
    await prisma.newsletterSubscriber.delete({ where: { id: req.params.id } })
    return noContent(res)
  }),
)

/* ================================================================== *
 * Coupons
 * ================================================================== */

const couponBody = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(3, 'Codes need at least 3 characters.')
    .max(40)
    .regex(/^[A-Z0-9_-]+$/, 'Use letters, numbers, hyphens and underscores only.'),
  label: z.string().trim().min(1, 'Describe what the code does.').max(160),
  description: z.string().trim().max(500).nullable().optional(),
  type: z.enum(['PERCENT', 'FIXED']),
  value: z.coerce.number().positive('The value must be greater than zero.'),
  minimumSubtotal: z.coerce.number().nonnegative().nullable().optional(),
  maxDiscount: z.coerce.number().positive().nullable().optional(),
  usageLimit: z.coerce.number().int().positive().nullable().optional(),
  perUserLimit: z.coerce.number().int().positive().nullable().optional(),
  startsAt: z.coerce.date().nullable().optional(),
  endsAt: z.coerce.date().nullable().optional(),
  isActive: z.boolean().default(true),
})

adminMiscRouter.get(
  '/coupons',
  requirePermission('discounts.view'),
  asyncHandler(async (_req, res) => {
    const coupons = await prisma.coupon.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { usages: true } } },
    })
    return ok(
      res,
      coupons.map((coupon) => ({
        ...coupon,
        value: toNumber(coupon.value),
        minimumSubtotal: coupon.minimumSubtotal ? toNumber(coupon.minimumSubtotal) : null,
        maxDiscount: coupon.maxDiscount ? toNumber(coupon.maxDiscount) : null,
      })),
    )
  }),
)

adminMiscRouter.post(
  '/coupons',
  requirePermission('discounts.create'),
  validateBody(couponBody),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof couponBody>

    if (input.type === 'PERCENT' && input.value > 100) {
      throw new BadRequestError('A percentage discount cannot exceed 100%.')
    }
    if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) {
      throw new BadRequestError('The end date must be after the start date.')
    }

    const coupon = await prisma.coupon.create({ data: input })
    await audit(req, 'created', 'Coupon', coupon.id, null, coupon)
    return created(res, coupon)
  }),
)

adminMiscRouter.patch(
  '/coupons/:id',
  requirePermission('discounts.update'),
  validateBody(couponBody.partial()),
  asyncHandler(async (req, res) => {
    const existing = await prisma.coupon.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new NotFoundError('Coupon')

    const coupon = await prisma.coupon.update({ where: { id: req.params.id }, data: req.body })
    await audit(req, 'updated', 'Coupon', coupon.id, existing, coupon)
    return ok(res, coupon)
  }),
)

adminMiscRouter.delete(
  '/coupons/:id',
  requirePermission('discounts.delete'),
  asyncHandler(async (req, res) => {
    const coupon = await prisma.coupon.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { usages: true } } },
    })
    if (!coupon) throw new NotFoundError('Coupon')

    // A redeemed coupon is part of order history and is deactivated, not erased.
    if (coupon._count.usages > 0) {
      const updated = await prisma.coupon.update({
        where: { id: req.params.id },
        data: { isActive: false },
      })
      return ok(res, {
        ...updated,
        message: 'This code has been used on real orders, so it was deactivated rather than deleted.',
      })
    }

    await prisma.coupon.delete({ where: { id: req.params.id } })
    await audit(req, 'deleted', 'Coupon', req.params.id, coupon, null)
    return noContent(res)
  }),
)

/* ================================================================== *
 * Admin notifications
 * ================================================================== */

adminMiscRouter.get(
  '/notifications',
  requirePermission('notifications.view'),
  validateQuery(
    pageQuery.extend({
      unreadOnly: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((value) => value === 'true' || value === true),
    }),
  ),
  asyncHandler(async (req, res) => {
    const query = validated<{ page: number; limit: number; unreadOnly: boolean }>(req)
    const result = await notificationService.listForAdmin(req.admin!.id, query)
    return paginated(res, result.items, result.total, query.page, query.limit, {
      unreadCount: result.unreadCount,
    })
  }),
)

adminMiscRouter.get(
  '/notifications/unread-count',
  requirePermission('notifications.view'),
  asyncHandler(async (req, res) =>
    ok(res, { count: await notificationService.unreadCount({ adminUserId: req.admin!.id }) }),
  ),
)

adminMiscRouter.post(
  '/notifications/:id/read',
  requirePermission('notifications.view'),
  asyncHandler(async (req, res) => {
    const count = await notificationService.markRead(req.params.id, {
      adminUserId: req.admin!.id,
    })
    if (count === 0) throw new NotFoundError('Notification')
    return ok(res, { message: 'Marked as read.' })
  }),
)

adminMiscRouter.post(
  '/notifications/read-all',
  requirePermission('notifications.view'),
  asyncHandler(async (req, res) =>
    ok(res, { marked: await notificationService.markAllRead({ adminUserId: req.admin!.id }) }),
  ),
)

adminMiscRouter.delete(
  '/notifications/:id',
  requirePermission('notifications.delete'),
  asyncHandler(async (req, res) => {
    const count = await notificationService.remove(req.params.id, {
      adminUserId: req.admin!.id,
    })
    if (count === 0) throw new NotFoundError('Notification')
    return noContent(res)
  }),
)

/** Broadcast a promotional notification to customers. */
adminMiscRouter.post(
  '/notifications/broadcast',
  requirePermission('notifications.send'),
  validateBody(
    z.object({
      title: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(1000),
      link: z.string().trim().max(500).optional(),
      audience: z.enum(['all', 'marketing-opted-in']).default('marketing-opted-in'),
    }),
  ),
  asyncHandler(async (req, res) => {
    const input = req.body as {
      title: string
      body: string
      link?: string
      audience: 'all' | 'marketing-opted-in'
    }

    const users = await prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        ...(input.audience === 'marketing-opted-in' ? { acceptsMarketing: true } : {}),
      },
      select: { id: true },
    })

    if (users.length === 0) {
      return ok(res, { sent: 0, message: 'No customers matched that audience.' })
    }

    await prisma.notification.createMany({
      data: users.map((user) => ({
        audience: 'CUSTOMER' as const,
        userId: user.id,
        type: 'PROMOTIONAL' as const,
        title: input.title,
        body: input.body,
        link: input.link,
      })),
    })

    await audit(req, 'broadcast', 'Notification', undefined, null, {
      recipients: users.length,
      title: input.title,
    })

    return ok(res, { sent: users.length })
  }),
)

/* ================================================================== *
 * Admin users & roles
 * ================================================================== */

adminMiscRouter.get(
  '/admins',
  requirePermission('admins.view'),
  asyncHandler(async (_req, res) => {
    const admins = await prisma.adminUser.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        avatarUrl: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        role: { select: { id: true, name: true, slug: true } },
      },
    })
    return ok(res, admins)
  }),
)

adminMiscRouter.post(
  '/admins',
  requirePermission('admins.create'),
  validateBody(
    z.object({
      email: z.string().trim().toLowerCase().email(),
      name: z.string().trim().min(2).max(120),
      password: passwordSchema,
      roleId: z.string().min(1),
      phone: z.string().trim().max(20).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const input = req.body as {
      email: string
      name: string
      password: string
      roleId: string
      phone?: string
    }

    const existing = await prisma.adminUser.findUnique({ where: { email: input.email } })
    if (existing) throw new ConflictError('An admin with that email already exists.')

    const admin = await prisma.adminUser.create({
      data: {
        email: input.email,
        name: input.name,
        phone: input.phone,
        roleId: input.roleId,
        passwordHash: await hashPassword(input.password),
      },
      select: { id: true, email: true, name: true, role: { select: { name: true } } },
    })

    await audit(req, 'created', 'AdminUser', admin.id, null, { email: admin.email })
    return created(res, admin)
  }),
)

adminMiscRouter.patch(
  '/admins/:id',
  requirePermission('admins.update'),
  validateBody(
    z.object({
      name: z.string().trim().min(2).max(120).optional(),
      phone: z.string().trim().max(20).nullable().optional(),
      roleId: z.string().optional(),
      isActive: z.boolean().optional(),
      password: passwordSchema.optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const input = req.body as Record<string, unknown> & { password?: string }

    // An admin must not be able to deactivate or demote themselves and lock
    // the team out of the panel.
    if (req.params.id === req.admin!.id && (input.isActive === false || input.roleId)) {
      throw new BadRequestError('You cannot change your own role or deactivate yourself.')
    }

    const data: Record<string, unknown> = { ...input }
    if (input.password) {
      data.passwordHash = await hashPassword(input.password)
      delete data.password
      // Changing someone's password ends their sessions.
      await prisma.adminRefreshToken.updateMany({
        where: { adminUserId: req.params.id, revokedAt: null },
        data: { revokedAt: new Date() },
      })
    }

    const admin = await prisma.adminUser.update({
      where: { id: req.params.id },
      data,
      select: { id: true, email: true, name: true, isActive: true },
    })

    await audit(req, 'updated', 'AdminUser', admin.id, null, { fields: Object.keys(input) })
    return ok(res, admin)
  }),
)

adminMiscRouter.delete(
  '/admins/:id',
  requirePermission('admins.delete'),
  asyncHandler(async (req, res) => {
    if (req.params.id === req.admin!.id) {
      throw new BadRequestError('You cannot delete your own account.')
    }

    const admin = await prisma.adminUser.findUnique({
      where: { id: req.params.id },
      include: { role: true },
    })
    if (!admin) throw new NotFoundError('Admin')

    // Never leave the store without a Super Admin.
    if (admin.role.slug === 'super-admin') {
      const remaining = await prisma.adminUser.count({
        where: { role: { slug: 'super-admin' }, isActive: true, NOT: { id: admin.id } },
      })
      if (remaining === 0) {
        throw new ConflictError(
          'This is the last active Super Admin. Promote another admin before removing this one.',
        )
      }
    }

    await prisma.adminUser.delete({ where: { id: req.params.id } })
    await audit(req, 'deleted', 'AdminUser', req.params.id, { email: admin.email }, null)
    return noContent(res)
  }),
)

adminMiscRouter.get(
  '/roles',
  requirePermission('roles.view'),
  asyncHandler(async (_req, res) => {
    const [roles, permissions] = await Promise.all([
      prisma.role.findMany({
        orderBy: { name: 'asc' },
        include: {
          permissions: { select: { permission: { select: { key: true } } } },
          _count: { select: { adminUsers: true } },
        },
      }),
      prisma.permission.findMany({ orderBy: [{ group: 'asc' }, { key: 'asc' }] }),
    ])

    return ok(res, {
      roles: roles.map((role) => ({
        id: role.id,
        name: role.name,
        slug: role.slug,
        description: role.description,
        isSystem: role.isSystem,
        adminCount: role._count.adminUsers,
        permissions: role.permissions.map((entry) => entry.permission.key),
      })),
      allPermissions: permissions,
    })
  }),
)

adminMiscRouter.put(
  '/roles/:id/permissions',
  requireSuperAdmin,
  validateBody(z.object({ permissions: z.array(z.string()).max(ALL_PERMISSIONS.length + 10) })),
  asyncHandler(async (req, res) => {
    const role = await prisma.role.findUnique({ where: { id: req.params.id } })
    if (!role) throw new NotFoundError('Role')

    if (role.slug === 'super-admin') {
      throw new ConflictError('The Super Admin role always holds every permission.')
    }

    const { permissions } = req.body as { permissions: string[] }

    const records = await prisma.permission.findMany({
      where: { key: { in: permissions } },
      select: { id: true },
    })

    await prisma.$transaction([
      prisma.rolePermission.deleteMany({ where: { roleId: role.id } }),
      prisma.rolePermission.createMany({
        data: records.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
        skipDuplicates: true,
      }),
    ])

    await audit(req, 'updated-permissions', 'Role', role.id, null, { permissions })
    return ok(res, { updated: records.length })
  }),
)

/* ================================================================== *
 * Audit log
 * ================================================================== */

adminMiscRouter.get(
  '/audit',
  requirePermission('audit.view'),
  validateQuery(
    pageQuery.extend({ entityType: z.string().optional(), adminUserId: z.string().optional() }),
  ),
  asyncHandler(async (req, res) => {
    const query = validated<{
      page: number
      limit: number
      entityType?: string
      adminUserId?: string
    }>(req)

    const where = {
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.adminUserId ? { adminUserId: query.adminUserId } : {}),
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { adminUser: { select: { id: true, name: true, email: true } } },
      }),
      prisma.auditLog.count({ where }),
    ])

    return paginated(res, logs, total, query.page, query.limit)
  }),
)
