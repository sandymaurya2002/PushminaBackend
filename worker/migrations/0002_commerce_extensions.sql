-- Additive only: new tables, new nullable/defaulted columns, indexes and
-- triggers. Nothing here drops, renames or rewrites an existing object.

-- ---------- Catalogue ------------------------------------------------------
-- (Line comments only: the remote D1 /query endpoint rejects /* */ blocks.)

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  gender TEXT CHECK (gender IS NULL OR gender IN ('WOMEN','MEN','UNISEX')),
  image_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS taxonomy_terms (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('color','size','material','pattern')),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  hex TEXT,
  measurement TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (kind, slug)
);

ALTER TABLE products ADD COLUMN category_id TEXT REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE products ADD COLUMN compare_at_price_paise INTEGER CHECK (compare_at_price_paise IS NULL OR compare_at_price_paise >= 0);
ALTER TABLE products ADD COLUMN cost_price_paise INTEGER CHECK (cost_price_paise IS NULL OR cost_price_paise >= 0);
ALTER TABLE products ADD COLUMN published_at TEXT;
ALTER TABLE products ADD COLUMN low_stock_threshold INTEGER NOT NULL DEFAULT 6 CHECK (low_stock_threshold >= 0);
ALTER TABLE products ADD COLUMN popularity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN sold_count INTEGER NOT NULL DEFAULT 0 CHECK (sold_count >= 0);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);

CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color_id TEXT REFERENCES taxonomy_terms(id) ON DELETE SET NULL,
  size_id TEXT REFERENCES taxonomy_terms(id) ON DELETE SET NULL,
  price_paise INTEGER CHECK (price_paise IS NULL OR price_paise >= 0),
  compare_at_price_paise INTEGER CHECK (compare_at_price_paise IS NULL OR compare_at_price_paise >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id, sort_order);

-- products.stock is the sum of its variants' stock whenever variants exist.
CREATE TRIGGER IF NOT EXISTS product_variants_stock_insert AFTER INSERT ON product_variants
BEGIN
  UPDATE products SET stock = stock + NEW.stock WHERE id = NEW.product_id;
END;

CREATE TRIGGER IF NOT EXISTS product_variants_stock_update AFTER UPDATE OF stock, product_id ON product_variants
BEGIN
  UPDATE products SET stock = stock - OLD.stock WHERE id = OLD.product_id;
  UPDATE products SET stock = stock + NEW.stock WHERE id = NEW.product_id;
END;

CREATE TRIGGER IF NOT EXISTS product_variants_stock_delete AFTER DELETE ON product_variants
BEGIN
  UPDATE products SET stock = stock - OLD.stock WHERE id = OLD.product_id;
END;

ALTER TABLE media_objects ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0,1));
ALTER TABLE media_objects ADD COLUMN folder TEXT NOT NULL DEFAULT 'products';
ALTER TABLE media_objects ADD COLUMN alt TEXT;
ALTER TABLE media_objects ADD COLUMN original_name TEXT;
ALTER TABLE media_objects ADD COLUMN width INTEGER;
ALTER TABLE media_objects ADD COLUMN height INTEGER;
ALTER TABLE media_objects ADD COLUMN uploaded_by TEXT;
CREATE INDEX IF NOT EXISTS idx_media_folder_created ON media_objects(folder, created_at DESC);

CREATE TABLE IF NOT EXISTS product_images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  media_id TEXT REFERENCES media_objects(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  alt TEXT NOT NULL DEFAULT '',
  width INTEGER,
  height INTEGER,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_product_images_media ON product_images(media_id);

ALTER TABLE collections ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS product_collections (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, collection_id)
);
CREATE INDEX IF NOT EXISTS idx_product_collections_collection ON product_collections(collection_id, sort_order);

-- ---------- Inventory ------------------------------------------------------

CREATE TABLE IF NOT EXISTS inventory_movements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  variant_id TEXT,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('INITIAL','ADJUSTMENT','RESTOCK','DAMAGE','CORRECTION','RETURN','ORDER','CANCEL')),
  reference_id TEXT,
  note TEXT,
  actor_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_product ON inventory_movements(product_id, created_at DESC);

-- ---------- Accounts & sessions --------------------------------------------

ALTER TABLE users ADD COLUMN first_name TEXT;
ALTER TABLE users ADD COLUMN last_name TEXT;
ALTER TABLE users ADD COLUMN accepts_marketing INTEGER NOT NULL DEFAULT 0 CHECK (accepts_marketing IN (0,1));
ALTER TABLE users ADD COLUMN admin_role TEXT CHECK (admin_role IS NULL OR admin_role IN ('SUPER_ADMIN','ADMIN','MANAGER','EDITOR','SUPPORT'));
ALTER TABLE users ADD COLUMN last_login_at TEXT;
ALTER TABLE users ADD COLUMN deleted_at TEXT;

ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'CUSTOMER' CHECK (kind IN ('CUSTOMER','ADMIN'));
ALTER TABLE sessions ADD COLUMN family_id TEXT;
ALTER TABLE sessions ADD COLUMN rotated_at INTEGER;
ALTER TABLE sessions ADD COLUMN ip TEXT;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_family ON sessions(family_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(refresh_expires_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits(reset_at);

ALTER TABLE audit_events ADD COLUMN entity_type TEXT;
ALTER TABLE audit_events ADD COLUMN ip TEXT;
ALTER TABLE audit_events ADD COLUMN user_agent TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, target_id);

-- ---------- Orders ---------------------------------------------------------

ALTER TABLE orders ADD COLUMN idempotency_key TEXT;
ALTER TABLE orders ADD COLUMN shipping_method TEXT NOT NULL DEFAULT 'standard' CHECK (shipping_method IN ('standard','express'));
ALTER TABLE orders ADD COLUMN tax_paise INTEGER NOT NULL DEFAULT 0 CHECK (tax_paise >= 0);
ALTER TABLE orders ADD COLUMN customer_note TEXT;
ALTER TABLE orders ADD COLUMN admin_note TEXT;
ALTER TABLE orders ADD COLUMN tracking_number TEXT;
ALTER TABLE orders ADD COLUMN carrier TEXT;
ALTER TABLE orders ADD COLUMN status_note TEXT;
ALTER TABLE orders ADD COLUMN status_changed_by TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency ON orders(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC);

ALTER TABLE order_items ADD COLUMN sku TEXT;
ALTER TABLE order_items ADD COLUMN variant_label TEXT;
ALTER TABLE order_items ADD COLUMN color_name TEXT;
ALTER TABLE order_items ADD COLUMN size_name TEXT;
ALTER TABLE order_items ADD COLUMN image_url TEXT;

CREATE TABLE IF NOT EXISTS order_status_history (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  changed_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_order_status_history_order ON order_status_history(order_id, created_at);

-- History is written by the database so it can never be skipped by a caller.
CREATE TRIGGER IF NOT EXISTS orders_status_history AFTER UPDATE OF status ON orders
WHEN NEW.status <> OLD.status
BEGIN
  INSERT INTO order_status_history (id, order_id, from_status, to_status, note, changed_by)
  VALUES (lower(hex(randomblob(16))), NEW.id, OLD.status, NEW.status, NEW.status_note, NEW.status_changed_by);
END;

-- Restock fires only on the transition into CANCELLED, so a cancel that loses a
-- race (status already changed) restocks nothing, and nothing restocks twice.
CREATE TRIGGER IF NOT EXISTS orders_cancel_restock AFTER UPDATE OF status ON orders
WHEN NEW.status = 'CANCELLED' AND OLD.status <> 'CANCELLED'
BEGIN
  UPDATE product_variants
     SET stock = stock + (SELECT SUM(oi.quantity) FROM order_items oi
                           WHERE oi.order_id = NEW.id AND oi.variant_id = product_variants.id)
   WHERE id IN (SELECT variant_id FROM order_items WHERE order_id = NEW.id AND variant_id <> '');
  UPDATE products
     SET stock = stock + (SELECT SUM(oi.quantity) FROM order_items oi
                           WHERE oi.order_id = NEW.id AND oi.variant_id = '' AND oi.product_id = products.id)
   WHERE id IN (SELECT product_id FROM order_items WHERE order_id = NEW.id AND variant_id = '');
  UPDATE products
     SET sold_count = MAX(0, sold_count - (SELECT SUM(oi.quantity) FROM order_items oi
                                            WHERE oi.order_id = NEW.id AND oi.product_id = products.id))
   WHERE id IN (SELECT product_id FROM order_items WHERE order_id = NEW.id);
  INSERT INTO inventory_movements (id, product_id, variant_id, delta, reason, reference_id, actor_id)
  SELECT lower(hex(randomblob(16))), oi.product_id, NULLIF(oi.variant_id, ''), oi.quantity, 'CANCEL', NEW.id, NEW.status_changed_by
    FROM order_items oi WHERE oi.order_id = NEW.id;
END;
