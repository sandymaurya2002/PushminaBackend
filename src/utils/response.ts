import type { Response } from 'express'

/**
 * One response envelope for the whole API.
 *
 * Every success is `{ success: true, data, meta? }` and every failure is
 * `{ success: false, error: { code, message, details? } }`, so the storefront
 * and the admin panel can each write exactly one response handler.
 */

export interface PaginationMeta {
  page: number
  limit: number
  total: number
  totalPages: number
  hasNext: boolean
  hasPrev: boolean
}

export interface ApiMeta extends Partial<PaginationMeta> {
  [key: string]: unknown
}

export function ok<T>(res: Response, data: T, meta?: ApiMeta, status = 200): Response {
  return res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) })
}

export function created<T>(res: Response, data: T, meta?: ApiMeta): Response {
  return ok(res, data, meta, 201)
}

export function noContent(res: Response): Response {
  return res.status(204).send()
}

export function paginated<T>(
  res: Response,
  items: T[],
  total: number,
  page: number,
  limit: number,
  extra?: Record<string, unknown>,
): Response {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0
  return ok(res, items, {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
    ...extra,
  })
}

export function buildPaginationMeta(
  total: number,
  page: number,
  limit: number,
): PaginationMeta {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  }
}
