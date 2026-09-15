import type { Request } from 'express'
import { prisma } from '../../db/prisma'
import { logger } from '../../config/logger'

/**
 * Audit trail.
 *
 * Every mutating admin action is recorded with who did it, what changed and
 * the before/after state. Useful for answering "who dropped the price on this
 * shawl?" and necessary for any kind of accountability once more than one
 * person has access.
 *
 * Deliberately best-effort: a failure to write the audit row must never roll
 * back the business operation it was describing.
 */
export async function audit(
  req: Request,
  action: string,
  entityType: string,
  entityId?: string,
  before?: unknown,
  after?: unknown,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        adminUserId: req.admin?.id,
        action,
        entityType,
        entityId,
        before: (before ?? undefined) as never,
        after: (after ?? undefined) as never,
        ip: req.ip,
        userAgent: req.get('user-agent')?.slice(0, 250),
      },
    })
  } catch (error) {
    logger.warn({ err: error, action, entityType }, 'Audit log write failed')
  }
}
