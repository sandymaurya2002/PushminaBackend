import slugify from 'slugify'

export function toSlug(input: string): string {
  return slugify(input, { lower: true, strict: true, trim: true })
}

/**
 * Produces a slug that does not collide with an existing row.
 *
 * `exists` is supplied by the caller so this stays storage-agnostic and can be
 * reused for products, categories, collections, blog posts and pages alike.
 */
export async function uniqueSlug(
  base: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const root = toSlug(base) || 'item'
  let candidate = root
  let suffix = 1

  // Bounded so a pathological `exists` implementation cannot spin forever.
  while (suffix < 500 && (await exists(candidate))) {
    suffix += 1
    candidate = `${root}-${suffix}`
  }

  return candidate
}
