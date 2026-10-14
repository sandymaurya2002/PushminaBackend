import type { Context } from "hono";
import type { AppEnv } from "../types";

/**
 * Two price lists: India pays in INR, every other country in USD. Both prices
 * are entered by an admin; nothing is ever converted between them.
 *
 * Amounts are integers in the currency's minor unit (paise, cents).
 */
export const CURRENCIES = ["INR", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const HOME_COUNTRY = "IN";
export const DEFAULT_CURRENCY: Currency = "INR";

/** Cloudflare's placeholders for "unknown" (XX) and Tor (T1) are not countries. */
const NOT_A_COUNTRY = new Set(["XX", "T1"]);

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

/** A two-letter ISO 3166 code, upper-cased, or null. */
export function normalizeCountry(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase();
  return code && /^[A-Z]{2}$/.test(code) && !NOT_A_COUNTRY.has(code) ? code : null;
}

/** India → INR; any other known country → USD; unknown keeps the store's home currency. */
export function currencyForCountry(country: string | null | undefined): Currency {
  const code = normalizeCountry(country);
  if (!code) return DEFAULT_CURRENCY;
  return code === HOME_COUNTRY ? "INR" : "USD";
}

const INDIA_NAMES = new Set(["india", "in", "ind", "bharat", "republic of india"]);

/** Addresses store the country as free text ("India", "United States", "IN"). */
export function isIndia(country: string | null | undefined): boolean {
  return INDIA_NAMES.has((country ?? "").trim().toLowerCase());
}

/** The currency an order delivered to this address must be paid in. */
export function currencyForDestination(country: string | null | undefined): Currency {
  return isIndia(country) ? "INR" : "USD";
}

/**
 * Where the shopper is pricing from, in priority order:
 *  1. `?currency=` on public catalogue reads (the storefront keys its cache on it),
 *  2. `X-Client-Country`, which the storefront sends: the customer's chosen
 *     shopping region, otherwise its own server-side geolocation of the shopper,
 *  3. Cloudflare's geolocation of the connecting client,
 *  4. the home currency.
 * The shopper may choose either region, so this is a preference, not a trust
 * boundary: what is enforced is that an order's currency matches its delivery
 * country (see createOrder).
 */
export function resolvePricing(c: Context<AppEnv>): { currency: Currency; country: string | null } {
  const forwarded = normalizeCountry(c.req.header("x-client-country"));
  const edge = normalizeCountry((c.req.raw as { cf?: { country?: string } }).cf?.country ?? c.req.header("cf-ipcountry"));
  const country = forwarded ?? edge;
  const requested = c.req.query("currency")?.trim().toUpperCase();
  return { currency: isCurrency(requested) ? requested : currencyForCountry(country), country };
}

export function toMajor(minor: number | null | undefined): number {
  return Math.round(Number(minor ?? 0)) / 100;
}

export function toMinor(major: number): number {
  return Math.round(major * 100);
}

const SYMBOL: Record<Currency, string> = { INR: "₹", USD: "$" };

/** "₹8,999" / "$249.50": whole amounts drop the decimals. */
export function formatMoney(minor: number, currency: Currency): string {
  const major = toMajor(minor);
  const locale = currency === "INR" ? "en-IN" : "en-US";
  const digits = Number.isInteger(major) ? 0 : 2;
  return `${SYMBOL[currency]}${major.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: 2 })}`;
}

export const currencyOf = (value: unknown): Currency => (isCurrency(value) ? value : DEFAULT_CURRENCY);
