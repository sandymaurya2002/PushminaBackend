import type { NextFunction, Request, Response } from 'express'
import { ForbiddenError, UnauthorizedError } from '../utils/errors'
import { SYSTEM_ROLES } from '../config/permissions'

/**
 * Permission guard. Super Admin bypasses the check by design, so a permission
 * added later can never lock the owner out of their own store.
 */
export function requirePermission(...required: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const admin = req.admin
    if (!admin) return next(new UnauthorizedError('Admin authentication required.'))

    if (admin.roleSlug === SYSTEM_ROLES.SUPER_ADMIN) return next()

    const missing = required.filter((key) => !admin.permissions.includes(key))
    if (missing.length > 0) {
      return next(
        new ForbiddenError(
          `Your role does not allow this action. Missing: ${missing.join(', ')}.`,
        ),
      )
    }

    next()
  }
}

/** Passes if the admin holds ANY one of the listed permissions. */
export function requireAnyPermission(...accepted: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const admin = req.admin
    if (!admin) return next(new UnauthorizedError('Admin authentication required.'))
    if (admin.roleSlug === SYSTEM_ROLES.SUPER_ADMIN) return next()

    if (!accepted.some((key) => admin.permissions.includes(key))) {
      return next(new ForbiddenError('Your role does not allow this action.'))
    }

    next()
  }
}

export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.admin) return next(new UnauthorizedError('Admin authentication required.'))
  if (req.admin.roleSlug !== SYSTEM_ROLES.SUPER_ADMIN) {
    return next(new ForbiddenError('Only a Super Admin can do that.'))
  }
  next()
}
