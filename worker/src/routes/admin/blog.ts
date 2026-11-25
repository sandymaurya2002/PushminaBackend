import { Hono } from "hono";
import { z } from "zod";
import { auditStatement } from "../../lib/audit";
import { conflict, isUniqueViolation, notFound, validationError } from "../../lib/errors";
import { created, noContent, ok, paginated } from "../../lib/http";
import { newId, nowIso, parseJson, slugify, toIso } from "../../lib/util";
import { body, pageQuery, query, slug } from "../../lib/validation";
import { can } from "../../middleware/auth";
import type { AppEnv } from "../../types";

/** Uploaded media, files shipped with the storefront, or an https URL. */
const mediaUrl = z
  .string()
  .trim()
  .max(500)
  .refine((value) => /^\/(media|images|videos)\/[^\s]+$/.test(value) || /^https:\/\/[^\s]+$/.test(value), "Choose an uploaded file or an https:// URL.");

const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => (value === "" ? null : value), schema.nullable().optional());

const isoDate = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), "Enter a valid date.")
  .transform((value) => new Date(value).toISOString());

const STATUSES = ["DRAFT", "SCHEDULED", "PUBLISHED", "ARCHIVED"] as const;

const blockSchema = z
  .object({
    type: z.enum(["paragraph", "heading", "subheading", "list", "quote", "image", "productLink", "collectionLink"]),
    text: z.string().max(8000).optional(),
    items: z.array(z.string().max(500)).max(40).optional(),
    attribution: z.string().trim().max(160).optional(),
    url: z.string().trim().max(500).optional(),
    alt: z.string().trim().max(200).optional(),
    caption: z.string().trim().max(300).optional(),
    slug: z.string().trim().max(120).optional(),
    label: z.string().trim().max(160).optional(),
  })
  .superRefine((block, ctx) => {
    if (block.type === "image") {
      if (!block.url || !mediaUrl.safeParse(block.url).success) ctx.addIssue({ code: "custom", path: ["url"], message: "Choose an uploaded image or an https:// URL." });
      if (!block.alt?.trim()) ctx.addIssue({ code: "custom", path: ["alt"], message: "Alt text is required." });
    }
    if ((block.type === "productLink" || block.type === "collectionLink") && !block.slug?.trim()) {
      ctx.addIssue({ code: "custom", path: ["slug"], message: "A slug is required." });
    }
  })
  .transform((block) => {
    if (block.type === "list") return { type: block.type, items: (block.items ?? []).map((item) => item.trim()).filter(Boolean) };
    if (block.type === "quote") return { type: block.type, text: block.text?.trim() ?? "", ...(block.attribution?.trim() ? { attribution: block.attribution.trim() } : {}) };
    if (block.type === "image") return { type: block.type, url: block.url!.trim(), alt: block.alt!.trim(), ...(block.caption?.trim() ? { caption: block.caption.trim() } : {}) };
    if (block.type === "productLink" || block.type === "collectionLink") return { type: block.type, slug: block.slug!.trim(), label: (block.label ?? "").trim() };
    return { type: block.type, text: block.text?.trim() ?? "" };
  });

const faqSchema = z.object({
  question: z.string().trim().min(1).max(300),
  answer: z.string().trim().min(1).max(3000),
});

const postSchema = z
  .object({
    title: z.string().trim().min(1, "A title is required.").max(180),
    slug: optional(slug),
    excerpt: z.string().trim().min(1, "An excerpt is required.").max(400),
    categoryId: z.string().trim().min(1, "Choose a category.").max(64),
    authorName: z.string().trim().min(1).max(80).default("Pashmore Editorial"),
    coverUrl: optional(mediaUrl),
    coverAlt: optional(z.string().trim().max(200)),
    blocks: z.array(blockSchema).max(80).default([]),
    faqs: z.array(faqSchema).max(20).optional(),
    readingMinutes: z.coerce.number().int().min(1).max(120).default(5),
    status: z.enum(STATUSES).default("DRAFT"),
    scheduledAt: optional(isoDate),
  })
  .superRefine((value, ctx) => {
    const publishing = value.status === "PUBLISHED" || value.status === "SCHEDULED";
    if (publishing && !value.coverUrl) ctx.addIssue({ code: "custom", path: ["coverUrl"], message: "A cover image is required to publish." });
    if (publishing && !value.blocks.some((block) => ("text" in block && block.text) || block.type === "image" || block.type === "list")) {
      ctx.addIssue({ code: "custom", path: ["blocks"], message: "Add some body copy before publishing." });
    }
    if (value.status === "SCHEDULED" && !value.scheduledAt) ctx.addIssue({ code: "custom", path: ["scheduledAt"], message: "Choose when the article should go live." });
    if (value.status === "SCHEDULED" && value.scheduledAt && value.scheduledAt <= new Date().toISOString()) {
      ctx.addIssue({ code: "custom", path: ["scheduledAt"], message: "The publish time must be in the future." });
    }
  });

type PostInput = z.output<typeof postSchema>;

interface PostRow {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  category_id: string;
  category_name: string;
  category_slug: string;
  author_name: string;
  cover_url: string | null;
  cover_alt: string | null;
  blocks_json: string;
  faqs_json: string;
  reading_minutes: number;
  status: string;
  published_at: string | null;
  scheduled_at: string | null;
  view_count: number;
  created_at: string;
  updated_at: string;
}

const POST_SELECT = `SELECT p.*, c.name AS category_name, c.slug AS category_slug
  FROM blog_posts p JOIN blog_categories c ON c.id = p.category_id`;

function postDto(row: PostRow) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    categoryId: row.category_id,
    category: { id: row.category_id, name: row.category_name, slug: row.category_slug },
    authorName: row.author_name,
    coverUrl: row.cover_url,
    coverAlt: row.cover_alt,
    blocks: parseJson<unknown[]>(row.blocks_json, []),
    faqs: parseJson<unknown[]>(row.faqs_json, []),
    readingMinutes: row.reading_minutes,
    status: row.status,
    publishedAt: toIso(row.published_at),
    scheduledAt: toIso(row.scheduled_at),
    viewCount: row.view_count,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function hasBody(blocks: PostInput["blocks"]): boolean {
  return blocks.some((block) => {
    if (block.type === "image" || block.type === "list" || block.type === "productLink" || block.type === "collectionLink") return true;
    return Boolean("text" in block && block.text);
  });
}

export const adminBlogRoutes = new Hono<AppEnv>();

adminBlogRoutes.get("/categories", can("blog.view"), async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT id, slug, name, description, sort_order, is_active FROM blog_categories WHERE is_active = 1 ORDER BY sort_order, name`).all<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
  }>();
  return ok(
    c,
    results.map((row) => ({ id: row.id, slug: row.slug, name: row.name, description: row.description })),
  );
});

adminBlogRoutes.get("/posts", can("blog.view"), async (c) => {
  const input = query(c, z.object({ ...pageQuery, status: z.enum(STATUSES).optional() }));
  const where = input.status ? "WHERE p.status = ?" : "";
  const binds = input.status ? [input.status] : [];
  const offset = (input.page - 1) * input.limit;
  const [rows, count] = await c.env.DB.batch([
    c.env.DB.prepare(`${POST_SELECT} ${where} ORDER BY COALESCE(p.published_at, p.updated_at) DESC LIMIT ? OFFSET ?`).bind(...binds, input.limit, offset),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM blog_posts p ${where}`).bind(...binds),
  ]);
  const total = Number((count?.results?.[0] as { total?: number } | undefined)?.total ?? 0);
  return paginated(c, ((rows?.results ?? []) as unknown as PostRow[]).map(postDto), total, input.page, input.limit);
});

adminBlogRoutes.get("/posts/:id", can("blog.view"), async (c) => {
  const row = await c.env.DB.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(c.req.param("id")).first<PostRow>();
  if (!row) throw notFound("Article");
  return ok(c, postDto(row));
});

async function categoryExists(db: D1Database, categoryId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT id FROM blog_categories WHERE id = ? AND is_active = 1`).bind(categoryId).first<{ id: string }>();
  return Boolean(row);
}

function publishedAtFor(input: PostInput, existing: string | null): string | null {
  if (input.status === "PUBLISHED") return existing ?? nowIso();
  if (input.status === "SCHEDULED") return null;
  return existing;
}

adminBlogRoutes.post("/posts", can("blog.create"), async (c) => {
  const input = await body(c, postSchema);
  if (!(await categoryExists(c.env.DB, input.categoryId))) throw validationError({ categoryId: "Choose a category." });
  const postSlug = input.slug ?? slugify(input.title);
  if (!postSlug) throw validationError({ slug: "Enter a URL slug." });
  if ((input.status === "PUBLISHED" || input.status === "SCHEDULED") && !hasBody(input.blocks)) {
    throw validationError({ blocks: "Add some body copy before publishing." });
  }
  const postId = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO blog_posts (id, slug, title, excerpt, category_id, author_name, cover_url, cover_alt, blocks_json, faqs_json, reading_minutes, status, published_at, scheduled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        postId,
        postSlug,
        input.title,
        input.excerpt,
        input.categoryId,
        input.authorName,
        input.coverUrl ?? null,
        input.coverAlt ?? null,
        JSON.stringify(input.blocks),
        JSON.stringify(input.faqs ?? []),
        input.readingMinutes,
        input.status,
        publishedAtFor(input, null),
        input.status === "SCHEDULED" ? (input.scheduledAt ?? null) : null,
      ),
      auditStatement(c, { action: "blog.create", entityType: "blog_post", targetId: postId, metadata: { slug: postSlug, status: input.status } }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("SLUG_TAKEN", "An article with that address already exists.", { slug: "Already in use." });
    throw error;
  }
  const row = await c.env.DB.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(postId).first<PostRow>();
  return created(c, postDto(row!));
});

adminBlogRoutes.put("/posts/:id", can("blog.update"), async (c) => {
  const existing = await c.env.DB.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(c.req.param("id")).first<PostRow>();
  if (!existing) throw notFound("Article");
  const input = await body(c, postSchema);
  if (!(await categoryExists(c.env.DB, input.categoryId))) throw validationError({ categoryId: "Choose a category." });
  const postSlug = input.slug ?? existing.slug;
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE blog_posts SET slug = ?, title = ?, excerpt = ?, category_id = ?, author_name = ?, cover_url = ?, cover_alt = ?, blocks_json = ?, faqs_json = ?,
                reading_minutes = ?, status = ?, published_at = ?, scheduled_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
      ).bind(
        postSlug,
        input.title,
        input.excerpt,
        input.categoryId,
        input.authorName,
        input.coverUrl ?? null,
        input.coverAlt ?? input.title,
        JSON.stringify(input.blocks),
        JSON.stringify(input.faqs ?? parseJson(existing.faqs_json, [])),
        input.readingMinutes,
        input.status,
        publishedAtFor(input, existing.published_at),
        input.status === "SCHEDULED" ? (input.scheduledAt ?? null) : null,
        existing.id,
      ),
      auditStatement(c, { action: "blog.update", entityType: "blog_post", targetId: existing.id, metadata: { slug: postSlug, status: input.status } }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("SLUG_TAKEN", "An article with that address already exists.", { slug: "Already in use." });
    throw error;
  }
  const row = await c.env.DB.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(existing.id).first<PostRow>();
  return ok(c, postDto(row!));
});

adminBlogRoutes.delete("/posts/:id", can("blog.delete"), async (c) => {
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM blog_posts WHERE id = ?`).bind(c.req.param("id")),
    auditStatement(c, { action: "blog.delete", entityType: "blog_post", targetId: c.req.param("id") }),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) throw notFound("Article");
  return noContent(c);
});
