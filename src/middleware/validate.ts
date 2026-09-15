import type { NextFunction, Request, Response } from 'express'
import type { ZodType } from 'zod'

/**
 * Schema-driven request validation.
 *
 * The parsed result is written back onto the request, so downstream handlers
 * receive coerced, trimmed, correctly-typed values rather than raw strings —
 * `?page=2` arrives as the number 2, not "2".
 */

type Source = 'body' | 'query' | 'params'

export function validate<T>(schema: ZodType<T>, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source])
    if (!result.success) {
      next(result.error)
      return
    }

    if (source === 'query') {
      // Express 5 makes req.query a getter; assigning to it throws. Storing the
      // parsed value separately keeps this forward-compatible.
      Object.defineProperty(req, 'validatedQuery', {
        value: result.data,
        writable: true,
        configurable: true,
      })
      ;(req as Request & { query: unknown }).query = result.data as never
    } else {
      req[source] = result.data as never
    }

    next()
  }
}

export const validateBody = <T>(schema: ZodType<T>) => validate(schema, 'body')
export const validateQuery = <T>(schema: ZodType<T>) => validate(schema, 'query')
export const validateParams = <T>(schema: ZodType<T>) => validate(schema, 'params')

/** Typed accessor for a validated query, avoiding casts at every call site. */
export function validated<T>(req: Request): T {
  return (req as Request & { validatedQuery?: T }).validatedQuery ?? (req.query as T)
}
