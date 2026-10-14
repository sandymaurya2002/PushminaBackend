import { loadCatalog, variantCompareAt, variantPrice, viewProduct, basePrice, baseCompareAt, type Catalog, type MediaResolver, type ProductView, type VariantRow } from "../catalog/model";
import type { CommerceRules } from "../content/settings";
import { couponDto, evaluateCoupon, type CouponProblem, type CouponRow } from "./coupons";
import { toMajor, type Currency } from "./currency";

export const GST_RATE = 0.05;
export const MAX_LINE_QUANTITY = 10;
export const MAX_CART_LINES = 50;
export const SHIPPING_METHODS = ["standard", "express"] as const;

export type ShippingMethod = (typeof SHIPPING_METHODS)[number];

export interface CartItemRow {
  product_id: string;
  variant_id: string;
  quantity: number;
  created_at: string;
}

export interface CartLine {
  key: string;
  productId: string;
  variantId: string;
  /** Stored variant id ('' for products without variants). */
  storedVariantId: string;
  productSlug: string;
  name: string;
  sku: string | null;
  color: string | null;
  size: string | null;
  imageUrl: string | null;
  /** Minor units of `currency`. */
  unitPricePaise: number;
  compareAtPaise: number | null;
  currency: Currency;
  quantity: number;
  stock: number;
  available: boolean;
  /** REGION_UNAVAILABLE: no price has been set for this currency, so it cannot be sold here. */
  issue: "UNAVAILABLE" | "INSUFFICIENT_STOCK" | "REGION_UNAVAILABLE" | null;
}

export function resolveLine(
  catalog: Catalog,
  item: Pick<CartItemRow, "product_id" | "variant_id" | "quantity">,
  currency: Currency = "INR",
): CartLine | null {
  const row = catalog.products.find((product) => product.id === item.product_id);
  if (!row) return null;
  const view: ProductView = viewProduct(catalog, row);
  let variant: VariantRow | undefined;
  if (item.variant_id) {
    variant = view.variants.find((entry) => entry.id === item.variant_id);
    if (!variant) return null;
  }
  const published = row.status === "PUBLISHED";
  const usable = published && (variant ? variant.is_active === 1 : view.variants.length === 0);
  const stock = variant ? variant.stock : row.stock;
  const color = variant?.color_id ? catalog.terms.get(variant.color_id)?.name ?? null : null;
  const size = variant?.size_id ? catalog.terms.get(variant.size_id)?.name ?? null : null;
  const price = variant ? variantPrice(variant, row, currency) : basePrice(row, currency);
  const priced = price !== null;
  const issue = !usable ? "UNAVAILABLE" : !priced ? "REGION_UNAVAILABLE" : stock < item.quantity ? "INSUFFICIENT_STOCK" : null;
  return {
    key: variant?.id ?? row.id,
    productId: row.id,
    variantId: variant?.id ?? row.id,
    storedVariantId: variant?.id ?? "",
    productSlug: row.slug,
    name: row.name,
    sku: variant?.sku ?? null,
    color,
    size,
    imageUrl: view.images[0]?.url ?? null,
    unitPricePaise: price ?? 0,
    compareAtPaise: variant ? variantCompareAt(variant, row, currency) : baseCompareAt(row, currency),
    currency,
    quantity: item.quantity,
    stock,
    available: usable && priced,
    issue,
  };
}

export interface Totals {
  subtotal: number;
  shipping: number;
  tax: number;
  discount: number;
  total: number;
  itemCount: number;
}

export function subtotalOf(lines: CartLine[]): number {
  return lines.filter((line) => line.available).reduce((sum, line) => sum + line.unitPricePaise * line.quantity, 0);
}

/** All amounts in minor units of the rules' currency. The free-shipping threshold applies to the subtotal before any discount. */
export function computeTotals(lines: CartLine[], rules: CommerceRules, method: ShippingMethod = "standard", discountPaise = 0): Totals {
  const billable = lines.filter((line) => line.available);
  const subtotal = subtotalOf(lines);
  const discount = Math.max(0, Math.min(discountPaise, subtotal));
  const shipping =
    subtotal === 0 ? 0 : method === "express" ? rules.expressShippingPaise : subtotal >= rules.freeShippingThresholdPaise ? 0 : rules.standardShippingPaise;
  // Prices are GST-inclusive; tax is the included component, shown for the invoice.
  const taxable = subtotal - discount;
  const tax = Math.round(taxable - taxable / (1 + GST_RATE));
  return { subtotal, shipping, tax, discount, total: taxable + shipping, itemCount: billable.reduce((sum, line) => sum + line.quantity, 0) };
}

export interface AppliedCoupon {
  coupon: CouponRow | null;
  discountPaise: number;
  problem?: { code: CouponProblem; message: string };
}

/** Re-validates a stored coupon code against the current bag; an invalid code yields no discount and a reason. */
export async function applyCoupon(
  db: D1Database,
  code: string | null | undefined,
  lines: CartLine[],
  userId?: string,
  currency: Currency = "INR",
): Promise<AppliedCoupon> {
  if (!code) return { coupon: null, discountPaise: 0 };
  const result = await evaluateCoupon(db, code, subtotalOf(lines), userId, currency);
  if (result.ok) return { coupon: result.coupon, discountPaise: result.discountPaise };
  return { coupon: null, discountPaise: 0, problem: { code: result.code, message: result.message } };
}

export function cartDto(lines: CartLine[], resolve: MediaResolver, rules: CommerceRules, applied: AppliedCoupon = { coupon: null, discountPaise: 0 }) {
  const totals = computeTotals(lines, rules, "standard", applied.discountPaise);
  return {
    currency: rules.currency,
    items: lines.map((line) => ({
      id: line.key,
      key: line.key,
      productId: line.productId,
      productSlug: line.productSlug,
      variantId: line.variantId,
      sku: line.sku,
      name: line.name,
      image: line.imageUrl ? { url: resolve(line.imageUrl), alt: line.name } : null,
      color: line.color,
      size: line.size,
      unitPrice: toMajor(line.unitPricePaise),
      compareAtPrice: line.compareAtPaise && line.compareAtPaise > line.unitPricePaise ? toMajor(line.compareAtPaise) : undefined,
      quantity: line.quantity,
      maxQuantity: Math.max(1, Math.min(MAX_LINE_QUANTITY, line.stock)),
      inStock: line.available && line.stock >= line.quantity,
      available: line.available,
      issue: line.issue,
      lineTotal: toMajor(line.unitPricePaise * line.quantity),
    })),
    totals: totalsDto(totals),
    coupon: applied.coupon ? couponDto(applied.coupon) : null,
    ...(applied.problem ? { couponError: applied.problem } : {}),
    freeShippingThreshold: toMajor(rules.freeShippingThresholdPaise),
    remainingForFreeShipping: toMajor(Math.max(0, rules.freeShippingThresholdPaise - totals.subtotal)),
    shippingOptions: {
      standard: toMajor(totals.subtotal >= rules.freeShippingThresholdPaise ? 0 : rules.standardShippingPaise),
      express: toMajor(rules.expressShippingPaise),
    },
  };
}

export function totalsDto(totals: Totals) {
  return {
    subtotal: toMajor(totals.subtotal),
    discount: toMajor(totals.discount),
    shipping: toMajor(totals.shipping),
    tax: toMajor(totals.tax),
    total: toMajor(totals.total),
    itemCount: totals.itemCount,
  };
}

export async function loadCartLines(db: D1Database, userId: string, currency: Currency = "INR"): Promise<CartLine[]> {
  const { results } = await db.prepare(`SELECT product_id, variant_id, quantity, created_at FROM cart_items WHERE user_id = ? ORDER BY created_at`).bind(userId).all<CartItemRow>();
  if (!results.length) return [];
  const catalog = await loadCatalog(db, { productIds: [...new Set(results.map((row) => row.product_id))] });
  return results.map((row) => resolveLine(catalog, row, currency)).filter((line): line is CartLine => Boolean(line));
}

/**
 * Resolves a storefront variant id (or a product id for variant-less products)
 * to a purchasable target. `priced` is false when the product has no price in
 * `currency` yet (USD prices are optional on products created before them).
 */
export async function resolveTarget(db: D1Database, variantOrProductId: string, currency: Currency = "INR") {
  const variant = await db
    .prepare(
      `SELECT v.id AS variant_id, v.product_id, v.stock, v.is_active, p.status, p.price_usd_cents FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`,
    )
    .bind(variantOrProductId)
    .first<{ variant_id: string; product_id: string; stock: number; is_active: number; status: string; price_usd_cents: number | null }>();
  const priced = (usdCents: number | null) => currency === "INR" || usdCents !== null;
  if (variant) {
    return {
      productId: variant.product_id,
      variantId: variant.variant_id,
      stock: variant.stock,
      purchasable: variant.is_active === 1 && variant.status === "PUBLISHED",
      priced: priced(variant.price_usd_cents),
    };
  }
  const product = await db
    .prepare(
      `SELECT id, stock, status, price_usd_cents, (SELECT COUNT(*) FROM product_variants WHERE product_id = products.id) AS variants FROM products WHERE id = ?`,
    )
    .bind(variantOrProductId)
    .first<{ id: string; stock: number; status: string; price_usd_cents: number | null; variants: number }>();
  if (product && product.variants === 0) {
    return { productId: product.id, variantId: "", stock: product.stock, purchasable: product.status === "PUBLISHED", priced: priced(product.price_usd_cents) };
  }
  return null;
}
