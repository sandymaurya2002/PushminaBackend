/**
 * Verifies at runtime that the bound D1 database has every table, column and
 * trigger this Worker relies on (i.e. migrations 0001 + 0002 are applied).
 */
export const REQUIRED_COLUMNS: Record<string, string[]> = {
  users: ["id", "email", "name", "password_hash", "password_salt", "role", "phone", "active", "first_name", "last_name", "accepts_marketing", "admin_role", "last_login_at", "deleted_at"],
  sessions: ["id", "user_id", "access_hash", "refresh_hash", "expires_at", "refresh_expires_at", "revoked_at", "kind", "family_id", "rotated_at"],
  products: ["id", "slug", "name", "status", "price_paise", "stock", "product_json", "category_id", "compare_at_price_paise", "cost_price_paise", "published_at", "low_stock_threshold", "popularity", "sold_count"],
  product_variants: ["id", "product_id", "sku", "color_id", "size_id", "price_paise", "stock", "is_active"],
  product_images: ["id", "product_id", "media_id", "url", "alt", "is_primary", "sort_order"],
  product_collections: ["product_id", "collection_id", "sort_order"],
  categories: ["id", "slug", "name", "sort_order", "is_active"],
  taxonomy_terms: ["id", "kind", "slug", "name", "hex", "measurement"],
  collections: ["id", "slug", "name", "collection_json", "is_active", "sort_order"],
  media_objects: ["id", "object_key", "content_type", "size_bytes", "is_public", "folder", "alt", "width", "height"],
  inventory_movements: ["id", "product_id", "variant_id", "delta", "reason"],
  cart_items: ["user_id", "product_id", "variant_id", "quantity"],
  wishlist_items: ["user_id", "product_id"],
  addresses: ["id", "user_id", "label", "full_name", "phone", "line1", "postal_code", "is_default"],
  orders: ["id", "order_number", "user_id", "status", "payment_status", "payment_method", "idempotency_key", "status_note", "status_changed_by", "tax_paise", "shipping_method"],
  order_items: ["id", "order_id", "product_id", "variant_id", "quantity", "unit_price_paise", "sku", "image_url"],
  order_status_history: ["id", "order_id", "from_status", "to_status"],
  audit_events: ["id", "user_id", "action", "target_id", "metadata_json", "entity_type", "ip"],
  login_attempts: ["login_key", "attempts", "locked_until"],
  rate_limits: ["bucket", "count", "reset_at"],
};

export const REQUIRED_TRIGGERS = [
  "products_stock_nonnegative",
  "product_variants_stock_insert",
  "product_variants_stock_update",
  "product_variants_stock_delete",
  "orders_status_history",
  "orders_cancel_restock",
];

export interface SchemaReport {
  ok: boolean;
  missingTables: string[];
  missingColumns: string[];
  missingTriggers: string[];
}

export async function inspectSchema(db: D1Database): Promise<SchemaReport> {
  const tables = Object.keys(REQUIRED_COLUMNS);
  const [columns, triggers] = await db.batch<{ tbl?: string; col?: string; name?: string }>([
    db.prepare(
      `SELECT m.name AS tbl, p.name AS col FROM sqlite_master m JOIN pragma_table_info(m.name) p
        WHERE m.type = 'table' AND m.name IN (${tables.map(() => "?").join(",")})`,
    ).bind(...tables),
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`),
  ]);

  const present = new Map<string, Set<string>>();
  for (const row of columns?.results ?? []) {
    if (!row.tbl || !row.col) continue;
    if (!present.has(row.tbl)) present.set(row.tbl, new Set());
    present.get(row.tbl)!.add(row.col);
  }
  const triggerNames = new Set((triggers?.results ?? []).map((row) => row.name));

  const missingTables = tables.filter((table) => !present.has(table));
  const missingColumns = tables.flatMap((table) =>
    present.has(table) ? REQUIRED_COLUMNS[table]!.filter((column) => !present.get(table)!.has(column)).map((column) => `${table}.${column}`) : [],
  );
  const missingTriggers = REQUIRED_TRIGGERS.filter((name) => !triggerNames.has(name));
  return {
    ok: !missingTables.length && !missingColumns.length && !missingTriggers.length,
    missingTables,
    missingColumns,
    missingTriggers,
  };
}

let cached: { at: number; report: SchemaReport } | undefined;
const OK_TTL_MS = 10 * 60 * 1000;
const FAIL_TTL_MS = 15 * 1000;

/** Cached per isolate; a failing result is re-checked quickly so a fresh migration is picked up. */
export async function ensureSchema(db: D1Database): Promise<SchemaReport> {
  const now = Date.now();
  if (cached && now - cached.at < (cached.report.ok ? OK_TTL_MS : FAIL_TTL_MS)) return cached.report;
  const report = await inspectSchema(db);
  cached = { at: now, report };
  return report;
}

export function resetSchemaCache(): void {
  cached = undefined;
}
