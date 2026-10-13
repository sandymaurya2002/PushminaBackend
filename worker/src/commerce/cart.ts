import { loadCatalog, viewProduct, type Catalog, type MediaResolver, type ProductView, type VariantRow } from "../catalog/model";
import { toRupees } from "../lib/util";

export const FREE_SHIPPING_THRESHOLD_PAISE = 4999_00;
export const SHIPPING_FEE_PAISE = { standard: 149_00, express: 399_00 } as const;
export const GST_RATE = 0.05;
export const MAX_LINE_QUANTITY = 10;
export const MAX_CART_LINES = 50;
export const COD_LIMIT_PAISE = 20_000_00;

export type ShippingMethod = keyof typeof SHIPPING_FEE_PAISE;

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
  unitPricePaise: number;
  compareAtPaise: number | null;
  quantity: number;
  stock: number;
  available: boolean;
  issue: "UNAVAILABLE" | "INSUFFICIENT_STOCK" | null;
}

export function resolveLine(catalog: Catalog, item: Pick<CartItemRow, "product_id" | "variant_id" | "quantity">): CartLine | null {
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
  const issue = !usable ? "UNAVAILABLE" : stock < item.quantity ? "INSUFFICIENT_STOCK" : null;
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
    unitPricePaise: variant?.price_paise ?? row.price_paise,
    compareAtPaise: variant?.compare_at_price_paise ?? row.compare_at_price_paise,
    quantity: item.quantity,
    stock,
    available: usable,
    issue,
  };
}

export function computeTotals(lines: CartLine[], method: ShippingMethod = "standard") {
  const billable = lines.filter((line) => line.available);
  const subtotal = billable.reduce((sum, line) => sum + line.unitPricePaise * line.quantity, 0);
  const shipping = subtotal === 0 ? 0 : method === "express" ? SHIPPING_FEE_PAISE.express : subtotal >= FREE_SHIPPING_THRESHOLD_PAISE ? 0 : SHIPPING_FEE_PAISE.standard;
  // Prices are GST-inclusive; tax is the included component, shown for the invoice.
  const tax = Math.round(subtotal - subtotal / (1 + GST_RATE));
  return { subtotal, shipping, tax, discount: 0, total: subtotal + shipping, itemCount: billable.reduce((sum, line) => sum + line.quantity, 0) };
}

export function cartDto(lines: CartLine[], resolve: MediaResolver) {
  const totals = computeTotals(lines);
  return {
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
      unitPrice: toRupees(line.unitPricePaise),
      compareAtPrice: line.compareAtPaise && line.compareAtPaise > line.unitPricePaise ? toRupees(line.compareAtPaise) : undefined,
      quantity: line.quantity,
      maxQuantity: Math.max(1, Math.min(MAX_LINE_QUANTITY, line.stock)),
      inStock: line.available && line.stock >= line.quantity,
      available: line.available,
      issue: line.issue,
      lineTotal: toRupees(line.unitPricePaise * line.quantity),
    })),
    totals: {
      subtotal: toRupees(totals.subtotal),
      discount: 0,
      shipping: toRupees(totals.shipping),
      tax: toRupees(totals.tax),
      total: toRupees(totals.total),
      itemCount: totals.itemCount,
    },
    coupon: null,
    freeShippingThreshold: toRupees(FREE_SHIPPING_THRESHOLD_PAISE),
    remainingForFreeShipping: toRupees(Math.max(0, FREE_SHIPPING_THRESHOLD_PAISE - totals.subtotal)),
  };
}

export async function loadCartLines(db: D1Database, userId: string): Promise<CartLine[]> {
  const { results } = await db.prepare(`SELECT product_id, variant_id, quantity, created_at FROM cart_items WHERE user_id = ? ORDER BY created_at`).bind(userId).all<CartItemRow>();
  if (!results.length) return [];
  const catalog = await loadCatalog(db, { productIds: [...new Set(results.map((row) => row.product_id))] });
  return results.map((row) => resolveLine(catalog, row)).filter((line): line is CartLine => Boolean(line));
}

/** Resolves a storefront variant id (or a product id for variant-less products) to a purchasable target. */
export async function resolveTarget(db: D1Database, variantOrProductId: string) {
  const variant = await db
    .prepare(
      `SELECT v.id AS variant_id, v.product_id, v.stock, v.is_active, p.status FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`,
    )
    .bind(variantOrProductId)
    .first<{ variant_id: string; product_id: string; stock: number; is_active: number; status: string }>();
  if (variant) {
    return { productId: variant.product_id, variantId: variant.variant_id, stock: variant.stock, purchasable: variant.is_active === 1 && variant.status === "PUBLISHED" };
  }
  const product = await db
    .prepare(`SELECT id, stock, status, (SELECT COUNT(*) FROM product_variants WHERE product_id = products.id) AS variants FROM products WHERE id = ?`)
    .bind(variantOrProductId)
    .first<{ id: string; stock: number; status: string; variants: number }>();
  if (product && product.variants === 0) {
    return { productId: product.id, variantId: "", stock: product.stock, purchasable: product.status === "PUBLISHED" };
  }
  return null;
}
