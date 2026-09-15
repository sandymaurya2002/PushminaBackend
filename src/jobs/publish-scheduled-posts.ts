import { prisma } from '../db/prisma'
import { logger } from '../config/logger'
import { notifyAdmins } from '../modules/notifications/notification.service'

/**
 * Promotes SCHEDULED blog posts whose time has come.
 *
 * Idempotent: the WHERE clause only matches posts still in SCHEDULED, so a
 * second run immediately afterwards does nothing.
 */
export async function publishScheduledPosts(): Promise<void> {
  const now = new Date()

  const due = await prisma.blogPost.findMany({
    where: { status: 'SCHEDULED', scheduledAt: { lte: now } },
    select: { id: true, title: true, slug: true },
  })

  if (due.length === 0) return

  await prisma.blogPost.updateMany({
    where: { id: { in: due.map((post) => post.id) } },
    data: { status: 'PUBLISHED', publishedAt: now },
  })

  logger.info(`Published ${due.length} scheduled blog post(s)`)

  for (const post of due) {
    await notifyAdmins({
      type: 'ADMIN_SYSTEM_ALERT',
      title: 'Scheduled post published',
      body: `"${post.title}" is now live.`,
      link: `/blog/posts/${post.id}`,
      permission: 'blog.view',
    })
  }
}
