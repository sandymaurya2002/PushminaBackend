import { z } from "zod";
import { toMinor, type Currency } from "../commerce/currency";
import { versioned } from "../db/versioned";
import { parseJson } from "../lib/util";

/**
 * Every editable site setting, with its validation and default. Stored rows
 * only override these, so a fresh database behaves exactly like the defaults.
 */
interface Definition<T> {
  group: string;
  label: string;
  schema: z.ZodType<T>;
  default: T;
  /** Exposed to the storefront through /content/site. */
  public: boolean;
}

const text = (max: number) => z.string().trim().max(max);
const url = z.union([z.literal(""), z.string().trim().url().max(500)]);
const rupees = (max: number) => z.number().int().min(0).max(max);
const dollars = (max: number) => z.number().min(0).max(max).multipleOf(0.01);

function define<T>(group: string, label: string, schema: z.ZodType<T>, value: T, isPublic = true): Definition<T> {
  return { group, label, schema, default: value, public: isPublic };
}

export const SETTINGS = {
  "store.name": define("Store", "Store name", text(80).min(1), "Pashmore"),
  "store.tagline": define("Store", "Tagline", text(200), "Timeless Indian craftsmanship, woven for modern luxury."),
  "store.supportEmail": define("Store", "Customer care email", z.string().trim().email().max(254), "hello@pashmore.com"),
  "store.supportPhone": define("Store", "Customer care phone", text(40), "+91 194 000 0000"),
  "store.whatsapp": define("Store", "WhatsApp number (digits with country code)", z.string().trim().regex(/^\d{0,15}$/), ""),
  "store.address": define("Store", "Workshop address", text(300), "Boulevard Road, Dal Gate, Srinagar, Jammu & Kashmir 190001"),

  "announcement.enabled": define("Announcement bar", "Show the announcement bar", z.boolean(), true),
  "announcement.messages": define(
    "Announcement bar",
    "Rotating messages (one per line, keep under ~48 characters)",
    z.array(text(80).min(1)).max(6),
    ["Complimentary Luxury Packaging on Prepaid Orders", "Complimentary Shipping in India Above ₹4,999", "Handcrafted in Kashmir, Signed by Its Weaver"],
  ),

  "commerce.freeShippingThreshold": define("Shipping & checkout", "Free standard shipping above (₹)", rupees(1_000_000), 4999),
  "commerce.standardShippingFee": define("Shipping & checkout", "Standard shipping fee (₹)", rupees(10_000), 149),
  "commerce.expressShippingFee": define("Shipping & checkout", "Express shipping fee (₹)", rupees(10_000), 399),
  "commerce.codLimit": define("Shipping & checkout", "Cash on delivery limit (₹)", rupees(1_000_000), 20000),
  "commerce.returnWindowDays": define("Shipping & checkout", "Return window after delivery (days)", z.number().int().min(0).max(90), 14),
  "commerce.paymentWindowMinutes": define(
    "Shipping & checkout",
    "Minutes an unpaid online order holds its stock",
    z.number().int().min(10).max(24 * 60),
    30,
    false,
  ),

  "commerce.usd.freeShippingThreshold": define("International shipping (USD)", "Free standard shipping above ($)", dollars(100_000), 250),
  "commerce.usd.standardShippingFee": define("International shipping (USD)", "Standard shipping fee ($)", dollars(1_000), 25),
  "commerce.usd.expressShippingFee": define("International shipping (USD)", "Express shipping fee ($)", dollars(1_000), 45),

  "seo.defaultTitle": define("SEO defaults", "Default page title", text(70), "Pashmore | Pure Pashmina & Kashmiri Craftsmanship"),
  "seo.defaultDescription": define(
    "SEO defaults",
    "Default meta description",
    text(170),
    "Discover premium Pashmina shawls, Kashmiri-inspired textiles, stoles and timeless Indian craftsmanship at Pashmore.",
  ),

  "social.instagram": define("Social", "Instagram URL", url, "https://www.instagram.com/pashmore"),
  "social.facebook": define("Social", "Facebook URL", url, "https://www.facebook.com/pashmore"),
  "social.pinterest": define("Social", "Pinterest URL", url, "https://www.pinterest.com/pashmore"),
  "social.youtube": define("Social", "YouTube URL", url, "https://www.youtube.com/@pashmore"),
} satisfies Record<string, Definition<unknown>>;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValues = { [K in SettingKey]: (typeof SETTINGS)[K]["default"] };

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key);
}

function merge(rows: Array<{ key: string; value_json: string }>): SettingValues {
  const values = Object.fromEntries(Object.entries(SETTINGS).map(([key, definition]) => [key, definition.default])) as Record<string, unknown>;
  for (const row of rows) {
    if (!isSettingKey(row.key)) continue;
    const parsed = SETTINGS[row.key].schema.safeParse(parseJson(row.value_json, null));
    if (parsed.success) values[row.key] = parsed.data;
  }
  return values as SettingValues;
}

export async function loadSettings(db: D1Database): Promise<SettingValues> {
  const { results } = await db.prepare(`SELECT key, value_json FROM site_settings`).all<{ key: string; value_json: string }>();
  return merge(results ?? []);
}

/** Cached until a setting changes. */
export function siteSettings(db: D1Database): Promise<SettingValues> {
  return versioned(db, "content", "settings", () => loadSettings(db));
}

export function publicSettings(values: SettingValues) {
  return Object.fromEntries(Object.entries(values).filter(([key]) => SETTINGS[key as SettingKey].public));
}

/** Shipping amounts are in minor units of `currency` (paise or cents) despite the field names. */
export interface CommerceRules {
  currency: Currency;
  freeShippingThresholdPaise: number;
  standardShippingPaise: number;
  expressShippingPaise: number;
  /** Cash on delivery is offered in India only; 0 for USD. */
  codLimitPaise: number;
  returnWindowDays: number;
  paymentWindowMinutes: number;
}

/** Rules for a price list; INR unless a currency is given. */
export function commerceRules(values: SettingValues, currency: Currency = "INR"): CommerceRules {
  const shared = { returnWindowDays: values["commerce.returnWindowDays"], paymentWindowMinutes: values["commerce.paymentWindowMinutes"] };
  if (currency === "USD") {
    return {
      currency,
      freeShippingThresholdPaise: toMinor(values["commerce.usd.freeShippingThreshold"]),
      standardShippingPaise: toMinor(values["commerce.usd.standardShippingFee"]),
      expressShippingPaise: toMinor(values["commerce.usd.expressShippingFee"]),
      codLimitPaise: 0,
      ...shared,
    };
  }
  return {
    currency,
    freeShippingThresholdPaise: values["commerce.freeShippingThreshold"] * 100,
    standardShippingPaise: values["commerce.standardShippingFee"] * 100,
    expressShippingPaise: values["commerce.expressShippingFee"] * 100,
    codLimitPaise: values["commerce.codLimit"] * 100,
    ...shared,
  };
}

export async function loadCommerceRules(db: D1Database, currency: Currency = "INR"): Promise<CommerceRules> {
  return commerceRules(await siteSettings(db), currency);
}
