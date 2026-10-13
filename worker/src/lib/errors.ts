import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends Error {
  headers?: Record<string, string>;

  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (message: string, details?: Record<string, string>) =>
  new ApiError(400, "BAD_REQUEST", message, details);
export const validationError = (details: Record<string, string>, message = "Please check the highlighted fields.") =>
  new ApiError(422, "VALIDATION_ERROR", message, details);
export const unauthorized = (message = "Please sign in to continue.") => new ApiError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "You do not have permission to do that.") => new ApiError(403, "FORBIDDEN", message);
export const notFound = (what = "Resource") => new ApiError(404, "NOT_FOUND", `${what} not found.`);
export const conflict = (code: string, message: string, details?: Record<string, string>) =>
  new ApiError(409, code, message, details);
export function tooManyRequests(retryAfterSeconds: number, code = "RATE_LIMITED", message?: string): ApiError {
  const error = new ApiError(429, code, message ?? `Too many requests. Try again in ${retryAfterSeconds} seconds.`);
  error.headers = { "Retry-After": String(retryAfterSeconds) };
  return error;
}
export const notImplemented = (message: string) => new ApiError(501, "NOT_IMPLEMENTED", message);
export const serviceUnavailable = (code: string, message: string) => new ApiError(503, code, message);

/** SQLite constraint failures surface as plain Errors whose message we classify. */
export function isUniqueViolation(error: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String((error as Error)?.message ?? error));
}

export function isStockViolation(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  return /Insufficient stock/i.test(message) || /CHECK constraint failed: .*stock/i.test(message) || /CHECK constraint failed: stock/i.test(message);
}

export function isForeignKeyViolation(error: unknown): boolean {
  return /FOREIGN KEY constraint failed/i.test(String((error as Error)?.message ?? error));
}
