import { z } from 'zod'

export const DEFAULT_LIMIT = 24
export const MAX_LIMIT = 100

/** Shared page/limit parsing for every list endpoint. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
})

export type PaginationInput = z.infer<typeof paginationSchema>

export function toSkipTake(input: PaginationInput): { skip: number; take: number } {
  return { skip: (input.page - 1) * input.limit, take: input.limit }
}

/**
 * Splits `?color=ivory,cream&color=sand` into a flat, de-duplicated array.
 * Mirrors the storefront's own parser in src/lib/query.ts so a filter URL
 * produced by the website is understood identically by the API.
 */
export function toArray(value: unknown): string[] {
  if (value === undefined || value === null) return []
  const raw = Array.isArray(value) ? value : [value]
  const flattened = raw
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter(Boolean)
  return Array.from(new Set(flattened))
}

/** Zod preprocessor for comma-or-repeat delimited query arrays. */
export const csvArray = z.preprocess(toArray, z.array(z.string()))
