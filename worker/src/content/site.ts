import { versioned } from "../db/versioned";
import type { MediaResolver } from "../catalog/model";
import { parseJson, toIso } from "../lib/util";
import { loadSettings, type SettingValues } from "./settings";

export const BANNER_PLACEMENTS = [
  "HOME_HERO",
  "HOME_FEATURED",
  "HOME_GIFT_PACKAGING",
  "HOME_GIFTING",
  "HOME_CATEGORY_CARD",
  "HOME_EDITORIAL",
  "HOME_SOCIAL",
  "COLLECTION_HEADER",
  "ANNOUNCEMENT",
  "PROMO_STRIP",
] as const;

export interface BannerRow {
  id: string;
  placement: string;
  eyebrow: string | null;
  heading: string;
  subheading: string | null;
  media_type: "IMAGE" | "VIDEO";
  image_url: string | null;
  mobile_image_url: string | null;
  image_alt: string | null;
  video_url: string | null;
  href: string | null;
  cta_label: string | null;
  secondary_href: string | null;
  secondary_cta_label: string | null;
  sort_order: number;
  is_active: number;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SectionRow {
  id: string;
  key: string;
  type: string;
  heading: string | null;
  subheading: string | null;
  href: string | null;
  link_label: string | null;
  sort_order: number;
  is_active: number;
  updated_at: string;
}

export interface PageRow {
  id: string;
  slug: string;
  title: string;
  eyebrow: string | null;
  intro: string | null;
  sections_json: string;
  faqs_json: string;
  updated_label: string | null;
  meta_title: string | null;
  meta_description: string | null;
  status: "DRAFT" | "PUBLISHED";
  is_system: number;
  created_at: string;
  updated_at: string;
}

export interface SeoRow {
  id: string;
  entity_type: string;
  entity_id: string | null;
  path: string;
  title: string | null;
  description: string | null;
  keywords_json: string;
  canonical_url: string | null;
  og_image_url: string | null;
  robots_index: number;
  robots_follow: number;
  updated_at: string;
}

export interface RedirectRow {
  id: string;
  from_path: string;
  to_path: string;
  status_code: number;
  is_active: number;
  hit_count: number;
  created_at: string;
  updated_at: string;
}

export interface SiteContent {
  settings: SettingValues;
  banners: BannerRow[];
  sections: SectionRow[];
  pages: PageRow[];
  seo: SeoRow[];
  redirects: RedirectRow[];
}

async function loadContent(db: D1Database): Promise<SiteContent> {
  const [banners, sections, pages, seo, redirects] = await db.batch([
    db.prepare(`SELECT * FROM banners WHERE is_active = 1 ORDER BY placement, sort_order, created_at`),
    db.prepare(`SELECT * FROM homepage_sections ORDER BY sort_order, key`),
    db.prepare(`SELECT * FROM content_pages WHERE status = 'PUBLISHED'`),
    db.prepare(`SELECT * FROM seo_entries`),
    db.prepare(`SELECT * FROM redirects WHERE is_active = 1`),
  ]);
  return {
    settings: await loadSettings(db),
    banners: (banners?.results ?? []) as unknown as BannerRow[],
    sections: (sections?.results ?? []) as unknown as SectionRow[],
    pages: (pages?.results ?? []) as unknown as PageRow[],
    seo: (seo?.results ?? []) as unknown as SeoRow[],
    redirects: (redirects?.results ?? []) as unknown as RedirectRow[],
  };
}

/** Everything the storefront reads, reloaded only after an admin edit. */
export function siteContent(db: D1Database): Promise<SiteContent> {
  return versioned(db, "content", "site", () => loadContent(db));
}

/** Scheduling is evaluated per request, so a banner switches on or off on time without an edit. */
export function isLive(banner: Pick<BannerRow, "is_active" | "starts_at" | "ends_at">, now = new Date().toISOString()): boolean {
  if (banner.is_active !== 1) return false;
  if (banner.starts_at && banner.starts_at > now) return false;
  if (banner.ends_at && banner.ends_at < now) return false;
  return true;
}

export function bannerDto(row: BannerRow, resolve: MediaResolver) {
  return {
    id: row.id,
    placement: row.placement,
    eyebrow: row.eyebrow,
    heading: row.heading,
    subheading: row.subheading,
    mediaType: row.media_type,
    imageUrl: row.image_url ? resolve(row.image_url) : null,
    mobileImageUrl: row.mobile_image_url ? resolve(row.mobile_image_url) : null,
    imageAlt: row.image_alt ?? row.heading,
    videoUrl: row.video_url ? resolve(row.video_url) : null,
    href: row.href,
    ctaLabel: row.cta_label,
    secondaryHref: row.secondary_href,
    secondaryCtaLabel: row.secondary_cta_label,
    sortOrder: row.sort_order,
    isActive: row.is_active === 1,
    startsAt: toIso(row.starts_at),
    endsAt: toIso(row.ends_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function sectionDto(row: SectionRow) {
  return {
    id: row.id,
    key: row.key,
    type: row.type,
    heading: row.heading,
    subheading: row.subheading,
    href: row.href,
    linkLabel: row.link_label,
    sortOrder: row.sort_order,
    isActive: row.is_active === 1,
  };
}

export interface PageSection {
  heading: string;
  body: string[];
  list?: string[];
}

export function pageDto(row: PageRow) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    eyebrow: row.eyebrow ?? "",
    intro: row.intro ?? "",
    sections: parseJson<PageSection[]>(row.sections_json, []),
    faqs: parseJson<Array<{ question: string; answer: string }>>(row.faqs_json, []),
    updatedLabel: row.updated_label ?? "",
    metaTitle: row.meta_title,
    metaDescription: row.meta_description,
    status: row.status,
    isSystem: row.is_system === 1,
    updatedAt: toIso(row.updated_at),
  };
}

export function seoDto(row: SeoRow) {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    path: row.path,
    title: row.title,
    description: row.description,
    keywords: parseJson<string[]>(row.keywords_json, []),
    canonicalUrl: row.canonical_url,
    ogImageUrl: row.og_image_url,
    robotsIndex: row.robots_index === 1,
    robotsFollow: row.robots_follow === 1,
    updatedAt: toIso(row.updated_at),
  };
}

export function redirectDto(row: RedirectRow) {
  return {
    id: row.id,
    fromPath: row.from_path,
    toPath: row.to_path,
    statusCode: row.status_code,
    isActive: row.is_active === 1,
    hitCount: row.hit_count,
    createdAt: toIso(row.created_at),
  };
}

/** Site paths are stored without a trailing slash or query, lower-cased. */
export function normalizePath(path: string): string {
  const clean = path.trim().split(/[?#]/)[0]!.replace(/\/+$/, "").toLowerCase();
  return clean.startsWith("/") ? clean || "/" : `/${clean}`;
}
