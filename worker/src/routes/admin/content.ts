import { Hono } from "hono";
import { z } from "zod";
import { isSettingKey, loadSettings, SETTINGS } from "../../content/settings";
import { bannerDto, BANNER_PLACEMENTS, pageDto, sectionDto, type BannerRow, type PageRow, type SectionRow } from "../../content/site";
import { auditStatement } from "../../lib/audit";
import { conflict, isUniqueViolation, notFound, validationError } from "../../lib/errors";
import { created, noContent, ok } from "../../lib/http";
import { newId } from "../../lib/util";
import { body, id, slug } from "../../lib/validation";
import { can } from "../../middleware/auth";
import type { AppEnv } from "../../types";
import { resolverFor } from "../catalog";

/** Site-relative paths ("/collections/x") or absolute https links. */
const link = z
  .string()
  .trim()
  .max(500)
  .refine((value) => /^\/(?!\/)[^\s]*$/.test(value) || /^https:\/\/[^\s]+$/.test(value), "Use a path starting with / or an https:// link.");
/** Uploaded media ("/media/…"), files shipped with the storefront ("/images/…") or https URLs. */
const mediaUrl = z
  .string()
  .trim()
  .max(500)
  .refine((value) => /^\/(media|images|videos)\/[^\s]+$/.test(value) || /^https:\/\/[^\s]+$/.test(value), "Choose an uploaded file or an https:// URL.");
const isoDate = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), "Enter a valid date.")
  .transform((value) => new Date(value).toISOString());
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => (value === "" ? null : value), schema.nullable().optional());

const bannerSchema = z
  .object({
    placement: z.enum(BANNER_PLACEMENTS),
    eyebrow: optional(z.string().trim().max(80)),
    heading: z.string().trim().min(1, "A heading is required.").max(160),
    subheading: optional(z.string().trim().max(400)),
    mediaType: z.enum(["IMAGE", "VIDEO"]).default("IMAGE"),
    imageUrl: optional(mediaUrl),
    mobileImageUrl: optional(mediaUrl),
    imageAlt: optional(z.string().trim().max(200)),
    videoUrl: optional(mediaUrl),
    href: optional(link),
    ctaLabel: optional(z.string().trim().max(60)),
    secondaryHref: optional(link),
    secondaryCtaLabel: optional(z.string().trim().max(60)),
    sortOrder: z.coerce.number().int().min(0).max(10_000).default(0),
    isActive: z.boolean().default(true),
    startsAt: optional(isoDate),
    endsAt: optional(isoDate),
  })
  .superRefine((value, ctx) => {
    if (value.mediaType === "VIDEO" && !value.videoUrl) ctx.addIssue({ code: "custom", path: ["videoUrl"], message: "Choose a video for a video banner." });
    if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "The end must be after the start." });
  });

type BannerInput = z.output<typeof bannerSchema>;

function adminBanner(row: BannerRow, resolve: (url: string | null | undefined) => string) {
  return {
    ...bannerDto(row, resolve),
    imageUrl: row.image_url,
    mobileImageUrl: row.mobile_image_url,
    videoUrl: row.video_url,
    previewUrl: row.image_url ? resolve(row.image_url) : null,
    videoPreviewUrl: row.video_url ? resolve(row.video_url) : null,
  };
}

function bannerValues(input: BannerInput) {
  return [
    input.placement,
    input.eyebrow ?? null,
    input.heading,
    input.subheading ?? null,
    input.mediaType,
    input.imageUrl ?? null,
    input.mobileImageUrl ?? null,
    input.imageAlt ?? null,
    input.videoUrl ?? null,
    input.href ?? null,
    input.ctaLabel ?? null,
    input.secondaryHref ?? null,
    input.secondaryCtaLabel ?? null,
    input.sortOrder,
    input.isActive ? 1 : 0,
    input.startsAt ?? null,
    input.endsAt ?? null,
  ];
}

export const adminContentRoutes = new Hono<AppEnv>();

/* ---------- Banners ---------- */

adminContentRoutes.get("/banners", can("banners.view"), async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM banners ORDER BY placement, sort_order, created_at`).all<BannerRow>();
  const resolve = resolverFor(c);
  return ok(c, results.map((row) => adminBanner(row, resolve)));
});

adminContentRoutes.post("/banners", can("banners.create"), async (c) => {
  const input = await body(c, bannerSchema);
  const bannerId = newId();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO banners (placement, eyebrow, heading, subheading, media_type, image_url, mobile_image_url, image_alt, video_url, href, cta_label,
                            secondary_href, secondary_cta_label, sort_order, is_active, starts_at, ends_at, id, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(...bannerValues(input), bannerId, c.get("auth")!.userId),
    auditStatement(c, { action: "banner.create", entityType: "banner", targetId: bannerId, metadata: { placement: input.placement, heading: input.heading } }),
  ]);
  const row = await c.env.DB.prepare(`SELECT * FROM banners WHERE id = ?`).bind(bannerId).first<BannerRow>();
  return created(c, adminBanner(row!, resolverFor(c)));
});

adminContentRoutes.patch("/banners/:id", can("banners.update"), async (c) => {
  const existing = await c.env.DB.prepare(`SELECT * FROM banners WHERE id = ?`).bind(c.req.param("id")).first<BannerRow>();
  if (!existing) throw notFound("Banner");
  const raw = await c.req.json().catch(() => ({}));
  // A partial update (e.g. just { isActive }) is merged over the stored banner and validated as a whole.
  const merged = {
    placement: existing.placement,
    eyebrow: existing.eyebrow,
    heading: existing.heading,
    subheading: existing.subheading,
    mediaType: existing.media_type,
    imageUrl: existing.image_url,
    mobileImageUrl: existing.mobile_image_url,
    imageAlt: existing.image_alt,
    videoUrl: existing.video_url,
    href: existing.href,
    ctaLabel: existing.cta_label,
    secondaryHref: existing.secondary_href,
    secondaryCtaLabel: existing.secondary_cta_label,
    sortOrder: existing.sort_order,
    isActive: existing.is_active === 1,
    startsAt: existing.starts_at,
    endsAt: existing.ends_at,
    ...(raw && typeof raw === "object" ? raw : {}),
  };
  const parsed = bannerSchema.safeParse(merged);
  if (!parsed.success) {
    throw validationError(Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join(".") || "body", issue.message])));
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE banners SET placement = ?, eyebrow = ?, heading = ?, subheading = ?, media_type = ?, image_url = ?, mobile_image_url = ?, image_alt = ?, video_url = ?,
              href = ?, cta_label = ?, secondary_href = ?, secondary_cta_label = ?, sort_order = ?, is_active = ?, starts_at = ?, ends_at = ?,
              updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).bind(...bannerValues(parsed.data), c.get("auth")!.userId, existing.id),
    auditStatement(c, { action: "banner.update", entityType: "banner", targetId: existing.id, metadata: raw as Record<string, unknown> }),
  ]);
  const row = await c.env.DB.prepare(`SELECT * FROM banners WHERE id = ?`).bind(existing.id).first<BannerRow>();
  return ok(c, adminBanner(row!, resolverFor(c)));
});

adminContentRoutes.delete("/banners/:id", can("banners.delete"), async (c) => {
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM banners WHERE id = ?`).bind(c.req.param("id")),
    auditStatement(c, { action: "banner.delete", entityType: "banner", targetId: c.req.param("id") }),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) throw notFound("Banner");
  return noContent(c);
});

/* ---------- Homepage sections ---------- */

adminContentRoutes.get("/homepage-sections", can("content.view"), async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM homepage_sections ORDER BY sort_order, key`).all<SectionRow>();
  return ok(c, results.map(sectionDto));
});

const sectionItem = z.object({
  key: optional(z.string().trim().max(40)),
  eyebrow: optional(z.string().trim().max(80)),
  heading: optional(z.string().trim().max(160)),
  body: optional(z.string().trim().max(2000)),
  imageUrl: optional(mediaUrl),
  imageAlt: optional(z.string().trim().max(200)),
  href: optional(link),
  linkLabel: optional(z.string().trim().max(60)),
});

adminContentRoutes.patch("/homepage-sections/:id", can("content.update"), async (c) => {
  const input = await body(
    c,
    z.object({
      isActive: z.boolean().optional(),
      heading: optional(z.string().trim().max(160)),
      subheading: optional(z.string().trim().max(600)),
      eyebrow: optional(z.string().trim().max(80)),
      body: optional(z.string().trim().max(2000)),
      imageUrl: optional(mediaUrl),
      imageAlt: optional(z.string().trim().max(200)),
      href: optional(link),
      linkLabel: optional(z.string().trim().max(60)),
      secondaryHref: optional(link),
      secondaryLinkLabel: optional(z.string().trim().max(60)),
      items: z.array(sectionItem).max(12).optional(),
    }),
  );
  const existing = await c.env.DB.prepare(`SELECT * FROM homepage_sections WHERE id = ?`).bind(c.req.param("id")).first<SectionRow>();
  if (!existing) throw notFound("Section");
  const pick = <T>(value: T | undefined, current: T) => (value === undefined ? current : value);
  const items =
    input.items === undefined
      ? existing.items_json ?? "[]"
      : JSON.stringify(input.items.map((item) => Object.fromEntries(Object.entries(item).filter(([, value]) => value != null))));
  const fields = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "items"));
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE homepage_sections SET is_active = ?, heading = ?, subheading = ?, eyebrow = ?, body = ?, image_url = ?, image_alt = ?, href = ?, link_label = ?,
              secondary_href = ?, secondary_link_label = ?, items_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).bind(
      input.isActive === undefined ? existing.is_active : input.isActive ? 1 : 0,
      pick(input.heading, existing.heading),
      pick(input.subheading, existing.subheading),
      pick(input.eyebrow, existing.eyebrow),
      pick(input.body, existing.body),
      pick(input.imageUrl, existing.image_url),
      pick(input.imageAlt, existing.image_alt),
      pick(input.href, existing.href),
      pick(input.linkLabel, existing.link_label),
      pick(input.secondaryHref, existing.secondary_href),
      pick(input.secondaryLinkLabel, existing.secondary_link_label),
      items,
      existing.id,
    ),
    auditStatement(c, {
      action: "homepage.section.update",
      entityType: "homepage_section",
      targetId: existing.id,
      metadata: { key: existing.key, ...fields, ...(input.items ? { itemCount: input.items.length } : {}) },
    }),
  ]);
  const row = await c.env.DB.prepare(`SELECT * FROM homepage_sections WHERE id = ?`).bind(existing.id).first<SectionRow>();
  return ok(c, sectionDto(row!));
});

adminContentRoutes.post("/homepage-sections/reorder", can("content.update"), async (c) => {
  const { ids } = await body(c, z.object({ ids: z.array(id).min(1).max(100) }));
  const { results } = await c.env.DB.prepare(`SELECT id FROM homepage_sections`).all<{ id: string }>();
  const known = new Set(results.map((row) => row.id));
  if (ids.length !== known.size || ids.some((entry) => !known.has(entry)) || new Set(ids).size !== ids.length) {
    throw validationError({ ids: "Send every section exactly once." });
  }
  await c.env.DB.batch([
    ...ids.map((sectionId, index) =>
      c.env.DB.prepare(`UPDATE homepage_sections SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind((index + 1) * 10, sectionId),
    ),
    auditStatement(c, { action: "homepage.reorder", entityType: "homepage_section", metadata: { ids } }),
  ]);
  const { results: rows } = await c.env.DB.prepare(`SELECT * FROM homepage_sections ORDER BY sort_order, key`).all<SectionRow>();
  return ok(c, rows.map(sectionDto));
});

/* ---------- Settings ---------- */

adminContentRoutes.get("/settings", can("settings.view"), async (c) => {
  const values = await loadSettings(c.env.DB);
  return ok(
    c,
    Object.entries(SETTINGS).map(([key, definition]) => ({
      key,
      value: values[key as keyof typeof values],
      group: definition.group,
      label: definition.label,
      default: definition.default,
    })),
  );
});

adminContentRoutes.put("/settings", can("settings.update"), async (c) => {
  const { settings } = await body(c, z.object({ settings: z.array(z.object({ key: z.string().max(80), value: z.unknown() })).min(1).max(100) }));
  const errors: Record<string, string> = {};
  const statements: D1PreparedStatement[] = [];
  const userId = c.get("auth")!.userId;
  for (const entry of settings) {
    if (!isSettingKey(entry.key)) {
      errors[entry.key] = "Unknown setting.";
      continue;
    }
    const parsed = SETTINGS[entry.key].schema.safeParse(entry.value);
    if (!parsed.success) {
      errors[entry.key] = parsed.error.issues[0]?.message ?? "Invalid value.";
      continue;
    }
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO site_settings (key, value_json, updated_by) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
      ).bind(entry.key, JSON.stringify(parsed.data), userId),
    );
  }
  if (Object.keys(errors).length) throw validationError(errors);
  statements.push(auditStatement(c, { action: "settings.update", entityType: "settings", metadata: { keys: settings.map((entry) => entry.key) } }));
  await c.env.DB.batch(statements);
  const values = await loadSettings(c.env.DB);
  return ok(
    c,
    Object.entries(SETTINGS).map(([key, definition]) => ({ key, value: values[key as keyof typeof values], group: definition.group, label: definition.label, default: definition.default })),
  );
});

/* ---------- Pages ---------- */

const sectionSchema = z.object({
  heading: z.string().trim().min(1).max(160),
  body: z.array(z.string().trim().max(4000)).max(30).default([]),
  list: z.array(z.string().trim().max(500)).max(40).optional(),
});
const faqSchema = z.object({ question: z.string().trim().min(1).max(300), answer: z.string().trim().min(1).max(3000) });

const pageSchema = z.object({
  title: z.string().trim().min(1).max(160),
  eyebrow: optional(z.string().trim().max(80)),
  intro: optional(z.string().trim().max(2000)),
  sections: z.array(sectionSchema).max(40),
  faqs: z.array(faqSchema).max(40).optional(),
  updatedLabel: optional(z.string().trim().max(60)),
  metaTitle: optional(z.string().trim().max(70)),
  metaDescription: optional(z.string().trim().max(170)),
  status: z.enum(["DRAFT", "PUBLISHED"]).default("PUBLISHED"),
});

adminContentRoutes.get("/pages", can("content.view"), async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM content_pages ORDER BY is_system DESC, title`).all<PageRow>();
  return ok(c, results.map(pageDto));
});

adminContentRoutes.get("/pages/:id", can("content.view"), async (c) => {
  const row = await c.env.DB.prepare(`SELECT * FROM content_pages WHERE id = ?1 OR slug = ?1`).bind(c.req.param("id")).first<PageRow>();
  if (!row) throw notFound("Page");
  return ok(c, pageDto(row));
});

adminContentRoutes.post("/pages", can("content.update"), async (c) => {
  const input = await body(c, pageSchema.extend({ slug }));
  const pageId = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO content_pages (id, slug, title, eyebrow, intro, sections_json, faqs_json, updated_label, meta_title, meta_description, status, is_system, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      ).bind(
        pageId,
        input.slug,
        input.title,
        input.eyebrow ?? null,
        input.intro ?? null,
        JSON.stringify(input.sections),
        JSON.stringify(input.faqs ?? []),
        input.updatedLabel ?? null,
        input.metaTitle ?? null,
        input.metaDescription ?? null,
        input.status,
        c.get("auth")!.userId,
      ),
      auditStatement(c, { action: "page.create", entityType: "page", targetId: pageId, metadata: { slug: input.slug } }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("SLUG_TAKEN", "A page with that address already exists.", { slug: "Already in use." });
    throw error;
  }
  const row = await c.env.DB.prepare(`SELECT * FROM content_pages WHERE id = ?`).bind(pageId).first<PageRow>();
  return created(c, pageDto(row!));
});

adminContentRoutes.put("/pages/:id", can("content.update"), async (c) => {
  const input = await body(c, pageSchema);
  const existing = await c.env.DB.prepare(`SELECT * FROM content_pages WHERE id = ?`).bind(c.req.param("id")).first<PageRow>();
  if (!existing) throw notFound("Page");
  const updatedLabel =
    input.updatedLabel === undefined ? new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" }) : input.updatedLabel;
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE content_pages SET title = ?, eyebrow = ?, intro = ?, sections_json = ?, faqs_json = ?, updated_label = ?, meta_title = ?, meta_description = ?, status = ?,
              updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).bind(
      input.title,
      input.eyebrow ?? null,
      input.intro ?? null,
      JSON.stringify(input.sections),
      input.faqs === undefined ? existing.faqs_json : JSON.stringify(input.faqs),
      updatedLabel,
      input.metaTitle === undefined ? existing.meta_title : input.metaTitle,
      input.metaDescription === undefined ? existing.meta_description : input.metaDescription,
      input.status,
      c.get("auth")!.userId,
      existing.id,
    ),
    auditStatement(c, { action: "page.update", entityType: "page", targetId: existing.id, metadata: { slug: existing.slug, status: input.status } }),
  ]);
  const row = await c.env.DB.prepare(`SELECT * FROM content_pages WHERE id = ?`).bind(existing.id).first<PageRow>();
  return ok(c, pageDto(row!));
});

adminContentRoutes.delete("/pages/:id", can("content.update"), async (c) => {
  const existing = await c.env.DB.prepare(`SELECT * FROM content_pages WHERE id = ?`).bind(c.req.param("id")).first<PageRow>();
  if (!existing) throw notFound("Page");
  if (existing.is_system === 1) throw conflict("SYSTEM_PAGE", "Built-in pages can be unpublished but not deleted.");
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM content_pages WHERE id = ?`).bind(existing.id),
    auditStatement(c, { action: "page.delete", entityType: "page", targetId: existing.id, metadata: { slug: existing.slug } }),
  ]);
  return noContent(c);
});