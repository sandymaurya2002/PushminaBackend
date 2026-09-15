import type { Request, Response } from 'express'

/**
 * Retains the exact bytes of the request body on webhook routes.
 *
 * A payment gateway signs the literal payload it transmitted. Re-serialising
 * the parsed object would change key order, spacing or unicode escaping, and
 * the HMAC would never match — so signature verification must run against
 * these original bytes, not against `JSON.stringify(req.body)`.
 */
export function rawBodySaver(
  req: Request,
  _res: Response,
  buffer: Buffer,
  encoding: string,
): void {
  if (!buffer?.length) return
  if (!req.originalUrl.includes('/webhook')) return

  ;(req as Request & { rawBody?: string }).rawBody = buffer.toString(
    (encoding as BufferEncoding) || 'utf8',
  )
}

export function getRawBody(req: Request): string | undefined {
  return (req as Request & { rawBody?: string }).rawBody
}
