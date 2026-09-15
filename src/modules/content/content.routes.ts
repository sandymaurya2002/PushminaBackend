import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../db/prisma'
import { validateBody, validateQuery, validated } from '../../middleware/validate'
import { publicWriteLimiter } from '../../middleware/rate-limit'
import { asyncHandler } from '../../utils/async-handler'
import { created, ok } from '../../utils/response'
import { NotFoundError } from '../../utils/errors'
import { notifyAdmins } from '../notifications/notification.service'
import { sendMail } from '../email/mailer'
import { templates } from '../email/templates'
import { generateToken } from '../../utils/tokens'
import { env } from '../../config/env'
import { getFeatured, getNewArrivals, getTrending, getBestSellers } from '../catalog/product.service'

export const contentRouter = Router()

/* ------------------------------------------------------------------ *
 * Site settings — header, footer, announcements, commerce rules
 * ------------------------------------------------------------------ */

/**
 * Everything the storefront shell needs, in one request.
 *
 * The announcement bar, trust signals, contact details, social links and the
 * commerce rules (free-shipping threshold, GST rate, COD limit) all become
 * admin-editable rows rather than constants compiled into the bundle.
 */
contentRouter.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.siteSetting.findMany()
    const settings = rows.reduce<Record<string, unknown>>((acc, row) => {
      acc[row.key] = row.value
      return acc
    }, {})

    return ok(res, settings)
  }),
)

/* ------------------------------------------------------------------ *
 * Navigation — header mega menu and footer columns
 * ------------------------------------------------------------------ */

contentRouter.get(
  '/navigation',
  asyncHandler(async (_req, res) => {
    const items = await prisma.navigationItem.findMany({
      where: { isActive: true, parentId: null },
      orderBy: { sortOrder: 'asc' },
      include: {
        children: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
      },
    })

    const header = items
      .filter((item) => item.group === 'HEADER')
      .map((item) => {
        // Children carry their column title, so the mega menu's columns are
        // reconstructed by grouping rather than stored as a rigid structure.
        const columns = new Map<string, Array<{ label: string; href: string; highlight?: boolean }>>()
        for (const child of item.children) {
          const key = child.columnTitle ?? 'Links'
          if (!columns.has(key)) columns.set(key, [])
          columns.get(key)!.push({
            label: child.label,
            href: child.href,
            ...(child.isHighlighted ? { highlight: true } : {}),
          })
        }

        return {
          label: item.label,
          href: item.href,
          columns: Array.from(columns.entries()).map(([title, links]) => ({ title, links })),
          feature: item.imageUrl
            ? {
                eyebrow: item.eyebrow ?? '',
                heading: item.heading ?? '',
                href: item.href,
                ctaLabel: item.ctaLabel ?? 'Explore',
                image: { url: item.imageUrl, alt: item.imageAlt ?? '', width: 600, height: 760 },
              }
            : undefined,
        }
      })

    const footer = items
      .filter((item) => item.group === 'FOOTER')
      .map((item) => ({
        title: item.columnTitle ?? item.label,
        links: item.children.map((child) => ({ label: child.label, href: child.href })),
      }))

    return ok(res, { header, footer })
  }),
)

/* ------------------------------------------------------------------ *
 * Banners
 * ------------------------------------------------------------------ */

contentRouter.get(
  '/banners',
  validateQuery(z.object({ placement: z.string().optional() })),
  asyncHandler(async (req, res) => {
    const { placement } = validated<{ placement?: string }>(req)
    const now = new Date()

    const banners = await prisma.banner.findMany({
      where: {
        isActive: true,
        ...(placement ? { placement: placement.toUpperCase() as never } : {}),
        // A scheduled banner appears and disappears on its own.
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        ],
      },
      orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }],
    })

    return ok(
      res,
      banners.map((banner) => ({
        id: banner.id,
        placement: banner.placement.toLowerCase(),
        eyebrow: banner.eyebrow,
        heading: banner.heading,
        subheading: banner.subheading,
        body: banner.body,
        image: banner.imageUrl
          ? { url: banner.imageUrl, alt: banner.imageAlt ?? banner.heading }
          : null,
        href: banner.href,
        ctaLabel: banner.ctaLabel,
        secondaryHref: banner.secondaryHref,
        secondaryCtaLabel: banner.secondaryCtaLabel,
      })),
    )
  }),
)

/* ------------------------------------------------------------------ *
 * Homepage — one request for the whole page
 * ------------------------------------------------------------------ */

/**
 * Returns the ordered section list plus the product rails each one needs.
 *
 * Collapsing this into a single round trip matters: the homepage is the most
 * requested page on the site, and six sequential fetches would be six times
 * the latency for no benefit.
 */
contentRouter.get(
  '/homepage',
  asyncHandler(async (_req, res) => {
    const now = new Date()

    const [sections, banners, trending, newArrivals, featured, bestSellers] = await Promise.all([
      prisma.homepageSection.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
      }),
      prisma.banner.findMany({
        where: {
          isActive: true,
          AND: [
            { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
            { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
          ],
        },
        orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }],
      }),
      getTrending(8),
      getNewArrivals(8),
      getFeatured(8),
      getBestSellers(8),
    ])

    const byPlacement = banners.reduce<Record<string, unknown[]>>((acc, banner) => {
      const key = banner.placement.toLowerCase()
      if (!acc[key]) acc[key] = []
      acc[key].push({
        id: banner.id,
        eyebrow: banner.eyebrow,
        heading: banner.heading,
        subheading: banner.subheading,
        image: banner.imageUrl
          ? { url: banner.imageUrl, alt: banner.imageAlt ?? banner.heading }
          : null,
        href: banner.href,
        ctaLabel: banner.ctaLabel,
        secondaryHref: banner.secondaryHref,
        secondaryCtaLabel: banner.secondaryCtaLabel,
      })
      return acc
    }, {})

    return ok(res, {
      sections: sections.map((section) => ({
        key: section.key,
        type: section.type,
        heading: section.heading,
        subheading: section.subheading,
        href: section.href,
        linkLabel: section.linkLabel,
        config: section.config,
      })),
      banners: byPlacement,
      rails: { trending, newArrivals, featured, bestSellers },
    })
  }),
)

/* ------------------------------------------------------------------ *
 * Pages — about, craftsmanship, contact, policies, FAQs
 * ------------------------------------------------------------------ */

contentRouter.get(
  '/pages/:slug',
  asyncHandler(async (req, res) => {
    const page = await prisma.page.findFirst({
      where: { slug: req.params.slug, status: 'PUBLISHED' },
    })
    if (!page) throw new NotFoundError('Page')

    return ok(res, {
      slug: page.slug,
      title: page.title,
      eyebrow: page.eyebrow,
      intro: page.intro,
      hero: page.heroUrl ? { url: page.heroUrl, alt: page.heroAlt ?? page.title } : null,
      sections: page.sections,
      faqs: page.faqs,
      updatedLabel: page.updatedLabel,
    })
  }),
)

/* ------------------------------------------------------------------ *
 * Landing pages
 * ------------------------------------------------------------------ */

contentRouter.get(
  '/landing',
  asyncHandler(async (_req, res) => {
    const pages = await prisma.landingPage.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { slug: true, h1: true, eyebrow: true },
    })
    return ok(res, pages)
  }),
)

contentRouter.get(
  '/landing/:slug',
  asyncHandler(async (req, res) => {
    const page = await prisma.landingPage.findFirst({
      where: { slug: req.params.slug, isActive: true },
      include: { collection: { select: { slug: true, name: true } } },
    })
    if (!page) throw new NotFoundError('Landing page')

    return ok(res, {
      slug: page.slug,
      h1: page.h1,
      eyebrow: page.eyebrow,
      intro: page.intro,
      collectionSlug: page.collection?.slug ?? null,
      productHeading: page.productHeading,
      sections: page.sections,
      faqs: page.faqs,
      internalLinks: page.internalLinks,
      banner: {
        url: page.bannerUrl ?? '',
        alt: page.bannerAlt ?? page.h1,
        width: 1800,
        height: 620,
      },
    })
  }),
)

/* ------------------------------------------------------------------ *
 * Contact form
 * ------------------------------------------------------------------ */

const contactSchema = z.object({
  name: z.string().trim().min(2, 'Please enter your name.').max(120),
  email: z.string().trim().toLowerCase().email('Please enter a valid email address.'),
  phone: z.string().trim().max(20).optional(),
  subject: z.string().trim().min(3, 'Please give your message a subject.').max(160),
  message: z
    .string()
    .trim()
    .min(20, 'Please give us a little more detail — at least 20 characters.')
    .max(4000),
})

contentRouter.post(
  '/contact',
  publicWriteLimiter,
  validateBody(contactSchema),
  asyncHandler(async (req, res) => {
    const submission = await prisma.contactSubmission.create({
      data: { ...req.body, ip: req.ip },
    })

    await notifyAdmins({
      type: 'ADMIN_CONTACT_SUBMISSION',
      title: 'New contact enquiry',
      body: `${submission.name} — ${submission.subject}`,
      link: `/contact/${submission.id}`,
      data: { submissionId: submission.id },
      permission: 'contact.view',
    })

    // Acknowledgement to the sender; failure here must not fail the submission.
    await sendMail({
      to: submission.email,
      template: 'contact-received',
      ...templates.contactReceived({ name: submission.name, subject: submission.subject }),
    }).catch(() => undefined)

    return created(res, {
      id: submission.id,
      message: 'Thank you. Our care team in Srinagar will reply within one working day.',
    })
  }),
)

/* ------------------------------------------------------------------ *
 * Newsletter
 * ------------------------------------------------------------------ */

contentRouter.post(
  '/newsletter/subscribe',
  publicWriteLimiter,
  validateBody(
    z.object({
      email: z.string().trim().toLowerCase().email('Please enter a valid email address.'),
      source: z.string().trim().max(40).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { email, source } = req.body as { email: string; source?: string }

    const existing = await prisma.newsletterSubscriber.findUnique({ where: { email } })

    // Re-subscribing after unsubscribing must work, and subscribing twice must
    // not error — it simply confirms.
    if (existing) {
      if (existing.status === 'UNSUBSCRIBED') {
        await prisma.newsletterSubscriber.update({
          where: { email },
          data: { status: 'SUBSCRIBED', subscribedAt: new Date(), unsubscribedAt: null },
        })
      }
      return ok(res, { message: 'Subscribed.' })
    }

    const token = generateToken(24)
    await prisma.newsletterSubscriber.create({
      data: { email, source: source ?? 'footer', unsubscribeToken: token },
    })

    await notifyAdmins({
      type: 'ADMIN_NEWSLETTER_SUBSCRIPTION',
      title: 'New newsletter subscriber',
      body: email,
      link: '/newsletter',
      permission: 'newsletter.view',
    })

    await sendMail({
      to: email,
      template: 'newsletter-welcome',
      ...templates.newsletterWelcome(`${env.STOREFRONT_URL}/newsletter/unsubscribe?token=${token}`),
    }).catch(() => undefined)

    return created(res, { message: 'Subscribed.' })
  }),
)

contentRouter.get(
  '/newsletter/unsubscribe',
  validateQuery(z.object({ token: z.string().min(8) })),
  asyncHandler(async (req, res) => {
    const { token } = validated<{ token: string }>(req)

    const result = await prisma.newsletterSubscriber.updateMany({
      where: { unsubscribeToken: token },
      data: { status: 'UNSUBSCRIBED', unsubscribedAt: new Date() },
    })

    if (result.count === 0) throw new NotFoundError('Subscription')
    return ok(res, { message: 'You have been unsubscribed.' })
  }),
)
