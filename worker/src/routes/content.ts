import { Hono, type Context } from "hono";
import { z } from "zod";
import { toMajor, type Currency } from "../commerce/currency";
import { commerceRules, publicSettings } from "../content/settings";
import { bannerDto, isLive, normalizePath, pageDto, redirectDto, sectionDto, seoDto, siteContent } from "../content/site";
import { notFound } from "../lib/errors";
import { ok } from "../lib/http";
import { parseJson, toIso } from "../lib/util";
import { query, slug } from "../lib/validation";
import type { AppEnv } from "../types";
import { resolverFor } from "./catalog";

function cachePublic(c: Context<AppEnv>) {
  c.header("Cache-Control", "public, max-age=30, s-maxage=60, stale-while-revalidate=120");
}

export const contentRoutes = new Hono<AppEnv>();

/** Store-wide settings the storefront renders: contact details, announcement bar, shipping rules, payment methods. */
contentRoutes.get("/site", async (c) => {
  const content = await siteContent(c.env.DB);
  const config = c.get("config");
  const rulesFor = (currency: Currency) => {
    const rules = commerceRules(content.settings, currency);
    return {
      currency,
      freeShippingThreshold: toMajor(rules.freeShippingThresholdPaise),
      standardShippingFee: toMajor(rules.standardShippingPaise),
      expressShippingFee: toMajor(rules.expressShippingPaise),
      codLimit: toMajor(rules.codLimitPaise),
      returnWindowDays: rules.returnWindowDays,
    };
  };
  cachePublic(c);
  return ok(c, {
    settings: publicSettings(content.settings),
    announcement: {
      enabled: content.settings["announcement.enabled"],
      messages: content.settings["announcement.messages"],
    },
    /** India (INR) rules; `commerceByCurrency` has the rules for each price list. */
    commerce: rulesFor("INR"),
    commerceByCurrency: { INR: rulesFor("INR"), USD: rulesFor("USD") },
    payments: { razorpay: Boolean(config.razorpay), cod: config.codEnabled },
  });
});

/** Homepage layout: active sections in order, and live banners grouped by placement. */
contentRoutes.get("/home", async (c) => {
  const content = await siteContent(c.env.DB);
  const resolve = resolverFor(c);
  const now = new Date().toISOString();
  const banners: Record<string, ReturnType<typeof bannerDto>[]> = {};
  for (const banner of content.banners.filter((entry) => isLive(entry, now))) {
    (banners[banner.placement] ??= []).push(bannerDto(banner, resolve));
  }
  c.header("Cache-Control", "public, max-age=15, s-maxage=30, stale-while-revalidate=60");
  return ok(c, { sections: content.sections.map(sectionDto), banners });
});

contentRoutes.get("/banners", async (c) => {
  const { placement } = query(c, z.object({ placement: z.string().trim().toUpperCase().max(40).optional() }));
  const content = await siteContent(c.env.DB);
  const resolve = resolverFor(c);
  const now = new Date().toISOString();
  c.header("Cache-Control", "public, max-age=15, s-maxage=30, stale-while-revalidate=60");
  return ok(
    c,
    content.banners.filter((banner) => isLive(banner, now) && (!placement || banner.placement === placement)).map((banner) => bannerDto(banner, resolve)),
  );
});

contentRoutes.get("/pages/:slug", async (c) => {
  const parsed = slug.safeParse(c.req.param("slug"));
  if (!parsed.success) throw notFound("Page");
  const content = await siteContent(c.env.DB);
  const page = content.pages.find((entry) => entry.slug === parsed.data);
  if (!page) throw notFound("Page");
  cachePublic(c);
  return ok(c, pageDto(page));
});

/** SEO override for one storefront path, or null when the page keeps its own defaults. */
contentRoutes.get("/seo", async (c) => {
  const { path } = query(c, z.object({ path: z.string().trim().min(1).max(300) }));
  const content = await siteContent(c.env.DB);
  const entry = content.seo.find((row) => row.path === normalizePath(path));
  cachePublic(c);
  return ok(c, entry ? seoDto(entry) : null);
});

interface JournalRow {
  slug: string;
  title: string;
  excerpt: string;
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
  updated_at: string;
}

function journalIsLive(row: JournalRow, now: string): boolean {
  if (row.status === "PUBLISHED") return !row.published_at || row.published_at <= now;
  if (row.status === "SCHEDULED") return Boolean(row.scheduled_at && row.scheduled_at <= now);
  return false;
}

function journalDto(row: JournalRow, resolve: (url: string | null | undefined) => string) {
  const cover = row.cover_url ? resolve(row.cover_url) : "";
  return {
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    category: row.category_slug,
    author: row.author_name,
    publishedAt: toIso(row.published_at) ?? toIso(row.scheduled_at) ?? toIso(row.updated_at),
    updatedAt: toIso(row.updated_at),
    readingMinutes: row.reading_minutes,
    cover: cover ? { url: cover, alt: row.cover_alt || row.title } : null,
    blocks: parseJson<unknown[]>(row.blocks_json, []),
    faqs: parseJson<Array<{ question?: string; answer?: string }>>(row.faqs_json, []).filter((faq) => faq.question && faq.answer),
  };
}

/** Published journal articles. Scheduled articles appear once their time has passed. */
contentRoutes.get("/posts", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.slug, p.title, p.excerpt, c.slug AS category_slug, p.author_name, p.cover_url, p.cover_alt, p.blocks_json, p.faqs_json,
            p.reading_minutes, p.status, p.published_at, p.scheduled_at, p.updated_at
       FROM blog_posts p JOIN blog_categories c ON c.id = p.category_id
      WHERE p.status IN ('PUBLISHED', 'SCHEDULED')`,
  ).all<JournalRow>();
  const now = new Date().toISOString();
  const resolve = resolverFor(c);
  cachePublic(c);
  return ok(
    c,
    results
      .filter((row) => journalIsLive(row, now) && row.cover_url)
      .map((row) => journalDto(row, resolve))
      .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")),
  );
});

contentRoutes.get("/posts/:slug", async (c) => {
  const parsed = slug.safeParse(c.req.param("slug"));
  if (!parsed.success) throw notFound("Article");
  const row = await c.env.DB.prepare(
    `SELECT p.slug, p.title, p.excerpt, c.slug AS category_slug, p.author_name, p.cover_url, p.cover_alt, p.blocks_json, p.faqs_json,
            p.reading_minutes, p.status, p.published_at, p.scheduled_at, p.updated_at
       FROM blog_posts p JOIN blog_categories c ON c.id = p.category_id
      WHERE p.slug = ?`,
  ).bind(parsed.data).first<JournalRow>();
  const now = new Date().toISOString();
  if (!row || !journalIsLive(row, now) || !row.cover_url) throw notFound("Article");
  cachePublic(c);
  return ok(c, journalDto(row, resolverFor(c)));
});

/** The Craftsmanship page: intro and the illustrated stages. */
contentRoutes.get("/craftsmanship", async (c) => {
  const [page, stages] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT eyebrow, heading, intro FROM craftsmanship_pages WHERE id = 'craftsmanship'`),
    c.env.DB.prepare(`SELECT step, heading, duration, body, image_url, image_alt FROM craftsmanship_stages ORDER BY sort_order, step`),
  ]);
  const intro = (page?.results?.[0] ?? {}) as { eyebrow?: string | null; heading?: string | null; intro?: string | null };
  const resolve = resolverFor(c);
  cachePublic(c);
  return ok(c, {
    eyebrow: intro.eyebrow ?? null,
    heading: intro.heading ?? null,
    intro: intro.intro ?? null,
    stages: ((stages?.results ?? []) as Array<{ step: string; heading: string; duration: string; body: string; image_url: string | null; image_alt: string | null }>).map((stage) => ({
      step: stage.step,
      heading: stage.heading,
      duration: stage.duration,
      body: stage.body,
      imageUrl: stage.image_url ? resolve(stage.image_url) : null,
      imageAlt: stage.image_alt,
    })),
  });
});

contentRoutes.get("/redirects", async (c) => {
  const content = await siteContent(c.env.DB);
  cachePublic(c);
  return ok(
    c,
    content.redirects.map((row) => {
      const { fromPath, toPath, statusCode } = redirectDto(row);
      return { fromPath, toPath, statusCode };
    }),
  );
});
