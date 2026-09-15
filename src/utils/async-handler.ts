import type { NextFunction, Request, RequestHandler, Response } from 'express'

/**
 * Express 4 does not forward rejected promises to the error middleware, so an
 * unhandled async throw silently hangs the request. Every async route handler
 * in this codebase is wrapped in this.
 */
export function asyncHandler<
  Req extends Request = Request,
  Res extends Response = Response,
>(
  handler: (req: Req, res: Res, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req as Req, res as Res, next)).catch(next)
  }
}
