import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../../lib/audit";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { created, noContent, ok, paginated } from "../../lib/http";
import { likePattern, newId, toIso } from "../../lib/util";
import { body, query } from "../../lib/validation";
import { MAX_DIMENSION, MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, MEDIA_FOLDERS, sniffImage, sniffVideo } from "../../media/images";
import { can, currentUser } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rate-limit";
import type { AppEnv } from "../../types";
import { resolverFor } from "../catalog";

interface MediaRow {
  id: string;
  object_key: string;
  content_type: string;
  size_bytes: number;
  is_public: number;
  folder: string;
  alt: string | null;
  original_name: string | null;
  width: number | null;
  height: number | null;
  created_at: string;
  usage?: number;
}

export const adminMediaRoutes = new Hono<AppEnv>();

/** Where a stored file is referenced: product images and banner image/video slots. */
const USAGE = `((SELECT COUNT(*) FROM product_images pi WHERE pi.media_id = m.id OR pi.url = '/media/' || m.object_key)
  + (SELECT COUNT(*) FROM banners b WHERE '/media/' || m.object_key IN (COALESCE(b.image_url, ''), COALESCE(b.mobile_image_url, ''), COALESCE(b.video_url, ''))))`;

function assetDto(row: MediaRow, resolve: (url: string) => string) {
  const path = `/media/${row.object_key}`;
  const url = resolve(path);
  return {
    id: row.id,
    key: row.object_key,
    path,
    filename: row.object_key.split("/").pop() ?? row.object_key,
    originalName: row.original_name ?? row.object_key,
    mimeType: row.content_type,
    size: row.size_bytes,
    width: row.width,
    height: row.height,
    url,
    thumbnailUrl: url,
    folder: row.folder,
    alt: row.alt,
    isPublic: row.is_public === 1,
    usage: row.usage ?? 0,
    createdAt: toIso(row.created_at),
  };
}

adminMediaRoutes.get("/", can("media.view"), async (c) => {
  const input = query(
    c,
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(36),
      folder: z.enum(MEDIA_FOLDERS).optional(),
      q: z.string().trim().max(80).optional(),
    }),
  );
  const where: string[] = [];
  const binds: unknown[] = [];
  if (input.folder) {
    where.push("folder = ?");
    binds.push(input.folder);
  }
  if (input.q) {
    where.push("(original_name LIKE ? ESCAPE '\\' OR alt LIKE ? ESCAPE '\\')");
    binds.push(likePattern(input.q), likePattern(input.q));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const db = c.env.DB;
  const [rows, total, folders] = await db.batch([
    db
      .prepare(
        `SELECT m.*, ${USAGE} AS usage FROM media_objects m ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .bind(...binds, input.limit, (input.page - 1) * input.limit),
    db.prepare(`SELECT COUNT(*) AS n FROM media_objects ${clause}`).bind(...binds),
    db.prepare(`SELECT folder, COUNT(*) AS count FROM media_objects GROUP BY folder ORDER BY folder`),
  ]);
  const resolve = resolverFor(c);
  return paginated(
    c,
    ((rows?.results ?? []) as unknown as MediaRow[]).map((row) => assetDto(row, resolve)),
    Number((total?.results[0] as { n: number })?.n ?? 0),
    input.page,
    input.limit,
    { folders: folders?.results ?? [], allowedFolders: MEDIA_FOLDERS },
  );
});

adminMediaRoutes.post("/", can("media.upload"), rateLimit({ name: "media-upload", limit: 60, windowSeconds: 600, key: (c) => c.get("auth")?.userId ?? c.get("clientIp") }), async (c) => {
  const auth = currentUser(c);
  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (contentLength > MAX_UPLOAD_BYTES * 10 + 1024 * 64) throw badRequest("Upload is too large.");
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw badRequest("Send the files as multipart/form-data.");
  }

  const folderInput = String(form.get("folder") ?? "products");
  if (!(MEDIA_FOLDERS as readonly string[]).includes(folderInput)) throw badRequest(`Folder must be one of: ${MEDIA_FOLDERS.join(", ")}.`);
  const alt = String(form.get("alt") ?? "").trim().slice(0, 300) || null;
  const isPublic = String(form.get("public") ?? "true") !== "false";

  const files = [...form.getAll("files"), ...form.getAll("file")].filter((entry): entry is File => typeof entry !== "string");
  if (!files.length) throw badRequest("Attach at least one image or video in the `files` field.");
  if (files.length > 10) throw badRequest("Upload at most 10 files at a time.");

  // Validate everything before writing anything.
  const prepared = [];
  let videos = 0;
  for (const file of files) {
    if (file.size === 0) throw badRequest(`${file.name} is empty.`);
    if (file.size > MAX_VIDEO_BYTES) throw badRequest(`${file.name} is larger than ${MAX_VIDEO_BYTES / 1024 / 1024} MB.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const image = sniffImage(bytes);
    if (image) {
      if (file.size > MAX_UPLOAD_BYTES) throw badRequest(`${file.name} is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
      if ((image.width ?? 0) > MAX_DIMENSION || (image.height ?? 0) > MAX_DIMENSION) {
        throw badRequest(`${file.name} is larger than ${MAX_DIMENSION}px on a side.`);
      }
      prepared.push({ file, bytes, sniffed: image, id: newId(), key: `${folderInput}/${crypto.randomUUID()}.${image.ext}` });
      continue;
    }
    const video = sniffVideo(bytes);
    if (!video) throw badRequest(`${file.name} is not a supported image (JPEG, PNG, WebP, AVIF, GIF) or video (MP4, WebM).`);
    if ((videos += 1) > 1) throw badRequest("Upload one video at a time.");
    const folder = folderInput === "products" || folderInput === "banners" ? folderInput : "videos";
    prepared.push({ file, bytes, sniffed: { ...video, width: null, height: null }, id: newId(), key: `${folder}/${crypto.randomUUID()}.${video.ext}` });
  }

  const uploaded: string[] = [];
  try {
    for (const entry of prepared) {
      await c.env.MEDIA.put(entry.key, entry.bytes, {
        httpMetadata: { contentType: entry.sniffed.mime, cacheControl: "public, max-age=31536000, immutable" },
        customMetadata: { uploadedBy: auth.userId, mediaId: entry.id },
      });
      uploaded.push(entry.key);
    }
    const db = c.env.DB;
    await db.batch(
      prepared.map((entry) =>
        db
          .prepare(
            `INSERT INTO media_objects (id, object_key, content_type, size_bytes, is_public, folder, alt, original_name, width, height, uploaded_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            entry.id,
            entry.key,
            entry.sniffed.mime,
            entry.bytes.byteLength,
            isPublic ? 1 : 0,
            entry.key.split("/")[0],
            alt,
            entry.file.name.replace(/[^\w.\- ()]/g, "_").slice(0, 200),
            entry.sniffed.width,
            entry.sniffed.height,
            auth.userId,
          ),
      ),
    );
  } catch (error) {
    // Do not leave orphaned objects in R2 if the database write failed.
    await Promise.allSettled(uploaded.map((key) => c.env.MEDIA.delete(key)));
    throw error;
  }

  await audit(c, { action: "media.upload", entityType: "media", metadata: { keys: prepared.map((entry) => entry.key), isPublic } });
  const rows = await c.env.DB.prepare(`SELECT * FROM media_objects WHERE id IN (${prepared.map(() => "?").join(",")}) ORDER BY created_at DESC`)
    .bind(...prepared.map((entry) => entry.id))
    .all<MediaRow>();
  const resolve = resolverFor(c);
  return created(c, rows.results.map((row) => assetDto(row, resolve)));
});

adminMediaRoutes.patch("/:id", can("media.upload"), async (c) => {
  const input = await body(c, z.object({ alt: z.string().trim().max(300).nullable().optional(), isPublic: z.boolean().optional() }));
  const db = c.env.DB;
  const row = await db.prepare(`SELECT * FROM media_objects WHERE id = ?`).bind(c.req.param("id")).first<MediaRow>();
  if (!row) throw notFound("Media");
  await db
    .prepare(`UPDATE media_objects SET alt = ?, is_public = ? WHERE id = ?`)
    .bind(input.alt === undefined ? row.alt : input.alt, input.isPublic === undefined ? row.is_public : input.isPublic ? 1 : 0, row.id)
    .run();
  await audit(c, { action: "media.update", entityType: "media", targetId: row.id, metadata: input });
  const updated = await db.prepare(`SELECT * FROM media_objects WHERE id = ?`).bind(row.id).first<MediaRow>();
  return ok(c, assetDto(updated!, resolverFor(c)));
});

adminMediaRoutes.delete("/:id", can("media.delete"), async (c) => {
  const db = c.env.DB;
  const row = await db
    .prepare(`SELECT m.*, ${USAGE} AS usage FROM media_objects m WHERE id = ?`)
    .bind(c.req.param("id"))
    .first<MediaRow>();
  if (!row) throw notFound("Media");
  if ((row.usage ?? 0) > 0) throw conflict("MEDIA_IN_USE", `This file is used in ${row.usage} place(s) (product images or banners). Remove it from those first.`);
  await db.prepare(`DELETE FROM media_objects WHERE id = ?`).bind(row.id).run();
  await c.env.MEDIA.delete(row.object_key);
  await audit(c, { action: "media.delete", entityType: "media", targetId: row.id, metadata: { key: row.object_key } });
  return noContent(c);
});
