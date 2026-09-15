import type { ErrorRequestHandler, RequestHandler } from 'express'
import { ZodError } from 'zod'
import { Prisma } from '@prisma/client'
import multer from 'multer'
import { AppError, NotFoundError } from '../utils/errors'
import { isProduction } from '../config/env'
import { logger } from '../config/logger'

/** 404 for anything that reached the end of the router stack. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.originalUrl}`))
}

interface NormalisedError {
  statusCode: number
  code: string
  message: string
  details?: unknown
}

function normalise(error: unknown): NormalisedError {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
    }
  }

  // Zod — surface which field failed and why, keyed by path for easy form binding.
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of error.issues) {
      const key = issue.path.join('.') || '_'
      if (!fieldErrors[key]) fieldErrors[key] = issue.message
    }
    return {
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      message: 'Please check the highlighted fields.',
      details: fieldErrors,
    }
  }

  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? 'That file is too large.'
        : `Upload failed: ${error.message}`
    return { statusCode: 400, code: `UPLOAD_${error.code}`, message }
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2002': {
        const target = (error.meta?.target as string[] | undefined)?.join(', ')
        return {
          statusCode: 409,
          code: 'DUPLICATE',
          message: target
            ? `A record with that ${target} already exists.`
            : 'That record already exists.',
        }
      }
      case 'P2025':
        return { statusCode: 404, code: 'NOT_FOUND', message: 'Record not found.' }
      case 'P2003':
        return {
          statusCode: 409,
          code: 'FOREIGN_KEY',
          message: 'That is still referenced by other records and cannot be removed.',
        }
      case 'P2014':
        return {
          statusCode: 409,
          code: 'RELATION_VIOLATION',
          message: 'That change would break a required relationship.',
        }
      default:
        return {
          statusCode: 400,
          code: `PRISMA_${error.code}`,
          message: 'The database rejected that request.',
        }
    }
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    return { statusCode: 400, code: 'PRISMA_VALIDATION', message: 'Malformed database query.' }
  }

  if (
    error instanceof Prisma.PrismaClientInitializationError ||
    (error as { code?: string })?.code === 'ECONNREFUSED'
  ) {
    return {
      statusCode: 503,
      code: 'DATABASE_UNAVAILABLE',
      message: 'The database is unavailable. Is PostgreSQL running?',
    }
  }

  if (error instanceof SyntaxError && 'body' in error) {
    return { statusCode: 400, code: 'MALFORMED_JSON', message: 'Request body is not valid JSON.' }
  }

  return {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: 'Something went wrong on our side.',
  }
}

/**
 * Terminal error middleware.
 *
 * Operational errors (4xx) log at warn without a stack; unexpected errors log
 * the full stack and never leak their message to the client in production.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const normalised = normalise(error)
  const isServerError = normalised.statusCode >= 500

  const context = {
    method: req.method,
    url: req.originalUrl,
    statusCode: normalised.statusCode,
    code: normalised.code,
    userId: req.user?.id,
    adminId: req.admin?.id,
  }

  if (isServerError) {
    logger.error({ ...context, err: error }, normalised.message)
  } else {
    logger.warn(context, normalised.message)
  }

  if (res.headersSent) return

  res.status(normalised.statusCode).json({
    success: false,
    error: {
      code: normalised.code,
      message:
        isServerError && isProduction
          ? 'Something went wrong on our side.'
          : normalised.message,
      ...(normalised.details ? { details: normalised.details } : {}),
      ...(isServerError && !isProduction
        ? { stack: (error as Error)?.stack?.split('\n').slice(0, 6) }
        : {}),
    },
  })
}
