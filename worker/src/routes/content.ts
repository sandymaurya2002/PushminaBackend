import { Hono, type Context } from "hono";
import { z } from "zod";
import { toMajor, type Currency } from "../commerce/currency";
import { commerceRules, publicSettings } from "../content/settings";
import { bannerDto, isLive, normalizePath, pageDto, redirectDto, sectionDto, seoDto, siteContent } from "../content/site";
import { notFound } from "../lib/errors";
import { ok } from "../lib/http";
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
