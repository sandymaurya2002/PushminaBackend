import type { MiddlewareHandler } from "hono";
import type { Config } from "../env";
import type { AppEnv } from "../types";

/**
 * Asks the storefront to drop its cached pages for the given tags, so admin
 * edits show up straight away instead of after the storefront's cache window.
 * Does nothing unless REVALIDATE_SECRET is configured. Never throws.
 */
export async function revalidateStorefront(config: Config, tags: string[]): Promise<boolean> {
  if (!config.revalidateSecret || !tags.length) return false;
  try {
    const response = await fetch(`${config.storefrontUrl}/api/revalidate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.revalidateSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) console.warn(`[revalidate] storefront answered ${response.status} for ${tags.join(",")}`);
    return response.ok;
  } catch (error) {
    console.warn("[revalidate] storefront unreachable", (error as Error)?.message);
    return false;
  }
}

/** Admin path prefix → storefront cache tags that a successful write there invalidates. */
const TAGS_BY_PREFIX: Array<[RegExp, string[]]> = [
  [/^\/api\/v1\/admin\/(products|inventory|taxonomy|collections|content\/collections)(\/|$)/, ["catalog"]],
  [/^\/api\/v1\/admin\/orders(\/|$)/, ["catalog"]],
  [/^\/api\/v1\/admin\/(content|seo)(\/|$)/, ["content"]],
  // Customer orders reserve and release stock, so "Out of Stock" must show without waiting for the cache.
  [/^\/api\/v1\/orders\/?$/, ["products"]],
  [/^\/api\/v1\/orders\/[^/]+\/cancel$/, ["products"]],
];

export const revalidateAfterWrite: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  if (c.req.method === "GET" || c.req.method === "OPTIONS" || c.res.status >= 400) return;
  const tags = new Set<string>();
  for (const [pattern, values] of TAGS_BY_PREFIX) if (pattern.test(c.req.path)) values.forEach((tag) => tags.add(tag));
  if (tags.size) c.executionCtx.waitUntil(revalidateStorefront(c.get("config"), [...tags]));
};
