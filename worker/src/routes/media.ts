import { Hono } from "hono";
import { MEDIA_KEY_PATTERN } from "../media/images";
import type { AppEnv } from "../types";

/**
 * Public delivery of approved images. The R2 bucket itself stays private:
 * only objects registered in media_objects with is_public = 1 are served.
 */
export const mediaRoutes = new Hono<AppEnv>();

mediaRoutes.get("/*", async (c) => {
  const key = decodeURIComponent(new URL(c.req.url).pathname.replace(/^\/media\//, ""));
  const notFound = () => c.json({ success: false, error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  if (!MEDIA_KEY_PATTERN.test(key)) return notFound();

  const record = await c.env.DB.prepare(`SELECT content_type FROM media_objects WHERE object_key = ? AND is_public = 1`)
    .bind(key)
    .first<{ content_type: string }>();
  if (!record) return notFound();

  // Videos need byte ranges so browsers can stream and seek.
  const wantsRange = c.req.header("range")?.startsWith("bytes=") ?? false;
  let object: R2Object | R2ObjectBody | null;
  try {
    object = await c.env.MEDIA.get(key, { onlyIf: c.req.raw.headers, ...(wantsRange ? { range: c.req.raw.headers } : {}) });
  } catch {
    return new Response(null, { status: 416, headers: { "Accept-Ranges": "bytes" } });
  }
  if (!object) return notFound();

  const headers = new Headers({
    "Content-Type": record.content_type,
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: object.httpEtag,
    "Accept-Ranges": "bytes",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": "inline",
  });
  if (!("body" in object) || !object.body) return new Response(null, { status: 304, headers });
  const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (wantsRange && range) {
    const offset = range.suffix !== undefined ? Math.max(0, object.size - range.suffix) : (range.offset ?? 0);
    const length = range.suffix !== undefined ? object.size - offset : (range.length ?? object.size - offset);
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
});
