/**
 * Application error taxonomy.
 *
 * Anything thrown as an `AppError` is considered operational — an expected
 * failure mode with a safe, user-facing message. Anything else is a bug, and
 * the error handler hides its details from the client in production.
 */
export class AppError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly details?: unknown
  readonly isOperational = true

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR', details?: unknown) {
    super(message)
    this.name = new.target.name
    this.statusCode = statusCode
    this.code = code
    this.details = details
    Error.captureStackTrace(this, new.target)
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: unknown) {
    super(message, 400, 'BAD_REQUEST', details)
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: unknown) {
    super(message, 422, 'VALIDATION_ERROR', details)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'UNAUTHORIZED')
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(message, 403, 'FORBIDDEN')
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND')
  }
}

export class ConflictError extends AppError {
  constructor(message = 'That conflicts with something that already exists') {
    super(message, 409, 'CONFLICT')
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests. Please slow down.') {
    super(message, 429, 'TOO_MANY_REQUESTS')
  }
}

export class PaymentError extends AppError {
  constructor(message = 'Payment could not be processed', details?: unknown) {
    super(message, 402, 'PAYMENT_ERROR', details)
  }
}

export class InsufficientStockError extends AppError {
  constructor(productName: string, available: number) {
    super(
      available > 0
        ? `Only ${available} left of ${productName}.`
        : `${productName} is out of stock.`,
      409,
      'INSUFFICIENT_STOCK',
      { productName, available },
    )
  }
}
