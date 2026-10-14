-- Payments, refunds, returns, the full order lifecycle, CMS content, SEO,
-- password reset, login activity, enquiries, newsletter, coupons and cache
-- versioning.
--
-- Everything is additive except the orders table, which is rebuilt because
-- SQLite cannot change a CHECK constraint in place and the old one only allows
-- six statuses and COD. The rebuild copies every order row, and the order item
-- and status history rows are backed up first and restored afterwards, because
-- dropping the old table cascades to them.
-- (Line comments only: the remote D1 /query endpoint rejects /* */ blocks.)

PRAGMA defer_foreign_keys = true;

-- ---------- Orders: rebuild with the full lifecycle --------------------------

CREATE TABLE _bak_order_items AS SELECT * FROM order_items;
CREATE TABLE _bak_order_status_history AS SELECT * FROM order_status_history;

CREATE TABLE orders_next (
  id TEXT PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING','CONFIRMED','PAYMENT_PENDING','PAYMENT_FAILED','PAID','PROCESSING','PACKED','SHIPPED',
    'OUT_FOR_DELIVERY','DELIVERED','CANCELLED','RETURN_REQUESTED','RETURNED','REFUND_PENDING','REFUNDED')),
  payment_status TEXT NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN (
    'UNPAID','PENDING','PAID','FAILED','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('COD','RAZORPAY')),
  shipping_name TEXT NOT NULL,
  shipping_email TEXT NOT NULL,
  shipping_phone TEXT NOT NULL,
  shipping_address_json TEXT NOT NULL,
  subtotal_paise INTEGER NOT NULL CHECK (subtotal_paise >= 0),
  shipping_paise INTEGER NOT NULL DEFAULT 0 CHECK (shipping_paise >= 0),
  total_paise INTEGER NOT NULL CHECK (total_paise >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  idempotency_key TEXT,
  shipping_method TEXT NOT NULL DEFAULT 'standard' CHECK (shipping_method IN ('standard','express')),
  tax_paise INTEGER NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
  customer_note TEXT,
  admin_note TEXT,
  tracking_number TEXT,
  carrier TEXT,
  status_note TEXT,
  status_changed_by TEXT,
  discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  coupon_code TEXT,
  tracking_url TEXT,
  estimated_delivery TEXT,
  paid_at TEXT,
  shipped_at TEXT,
  delivered_at TEXT,
  cancelled_at TEXT,
  payment_expires_at INTEGER,
  return_reason TEXT,
  return_requested_at TEXT,
  refunded_paise INTEGER NOT NULL DEFAULT 0 CHECK (refunded_paise >= 0)
);

INSERT INTO orders_next (
  id, order_number, user_id, status, payment_status, payment_method, shipping_name, shipping_email, shipping_phone,
  shipping_address_json, subtotal_paise, shipping_paise, total_paise, created_at, updated_at, idempotency_key,
  shipping_method, tax_paise, customer_note, admin_note, tracking_number, carrier, status_note, status_changed_by)
SELECT
  id, order_number, user_id, status, payment_status, payment_method, shipping_name, shipping_email, shipping_phone,
  shipping_address_json, subtotal_paise, shipping_paise, total_paise, created_at, updated_at, idempotency_key,
  shipping_method, tax_paise, customer_note, admin_note, tracking_number, carrier, status_note, status_changed_by
FROM orders;

DROP TABLE orders;
ALTER TABLE orders_next RENAME TO orders;

INSERT OR IGNORE INTO order_items SELECT * FROM _bak_order_items;
INSERT OR IGNORE INTO order_status_history SELECT * FROM _bak_order_status_history;
DROP TABLE _bak_order_items;
DROP TABLE _bak_order_status_history;

CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency ON orders(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_payment_expiry ON orders(payment_expires_at) WHERE payment_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);

-- History is written by the database so it can never be skipped by a caller.
CREATE TRIGGER IF NOT EXISTS orders_status_history AFTER UPDATE OF status ON orders
WHEN NEW.status <> OLD.status
BEGIN
  INSERT INTO order_status_history (id, order_id, from_status, to_status, note, changed_by)
  VALUES (lower(hex(randomblob(16))), NEW.id, OLD.status, NEW.status, NEW.status_note, NEW.status_changed_by);
END;

-- Restock fires only on the transition into CANCELLED from a status that still
-- holds stock, so a cancel that loses a race restocks nothing and nothing
-- restocks twice.
CREATE TRIGGER IF NOT EXISTS orders_cancel_restock AFTER UPDATE OF status ON orders
WHEN NEW.status = 'CANCELLED' AND OLD.status IN ('PENDING','CONFIRMED','PAYMENT_PENDING','PAYMENT_FAILED','PAID','PROCESSING','PACKED')
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

-- Returned parcels (customer returns and undelivered RTO parcels) go back on
-- the shelf exactly once. Damaged pieces are written off afterwards with an
-- inventory adjustment.
CREATE TRIGGER IF NOT EXISTS orders_return_restock AFTER UPDATE OF status ON orders
WHEN NEW.status = 'RETURNED' AND OLD.status IN ('RETURN_REQUESTED','SHIPPED','OUT_FOR_DELIVERY')
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
  SELECT lower(hex(randomblob(16))), oi.product_id, NULLIF(oi.variant_id, ''), oi.quantity, 'RETURN', NEW.id, NEW.status_changed_by
    FROM order_items oi WHERE oi.order_id = NEW.id;
END;

-- ---------- Payments --------------------------------------------------------

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  provider TEXT NOT NULL CHECK (provider IN ('razorpay','cod','manual')),
  provider_order_id TEXT,
  provider_payment_id TEXT UNIQUE,
  method TEXT,
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','AUTHORIZED','CAPTURED','FAILED','CANCELLED','REFUNDED','PARTIALLY_REFUNDED')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
  amount_refunded_paise INTEGER NOT NULL DEFAULT 0 CHECK (amount_refunded_paise >= 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  failure_reason TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  authorized_at TEXT,
  captured_at TEXT,
  failed_at TEXT,
  CHECK (amount_refunded_paise <= amount_paise)
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_provider_order ON payments(provider_order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status_created ON payments(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at DESC);

-- Cash on delivery is collected by the courier: delivering the parcel is what
-- makes the order paid, and the collection is recorded as a payment.
CREATE TRIGGER IF NOT EXISTS orders_cod_delivered AFTER UPDATE OF status ON orders
WHEN NEW.status = 'DELIVERED' AND OLD.status <> 'DELIVERED' AND NEW.payment_method = 'COD' AND NEW.payment_status IN ('UNPAID','PENDING')
BEGIN
  UPDATE orders SET payment_status = 'PAID', paid_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  INSERT INTO payments (id, order_id, provider, method, status, amount_paise, captured_at)
  VALUES (lower(hex(randomblob(16))), NEW.id, 'cod', 'cod', 'CAPTURED', NEW.total_paise, CURRENT_TIMESTAMP);
END;

-- Webhook deliveries, keyed by the gateway's event id so a redelivered event is
-- recognised and processed once.
CREATE TABLE IF NOT EXISTS payment_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event TEXT NOT NULL,
  provider_order_id TEXT,
  provider_payment_id TEXT,
  provider_refund_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','PROCESSED','IGNORED','FAILED')),
  error TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_payment_events_received ON payment_events(received_at DESC);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  payment_id TEXT REFERENCES payments(id),
  provider TEXT NOT NULL CHECK (provider IN ('razorpay','manual')),
  provider_refund_id TEXT UNIQUE,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  reason TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','PROCESSING','COMPLETED','REJECTED','FAILED')),
  failure_reason TEXT,
  requested_by TEXT,
  processed_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refunds_status_created ON refunds(status, created_at DESC);
-- One open refund per order at a time, so two admins cannot refund twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_one_open ON refunds(order_id) WHERE status IN ('REQUESTED','PROCESSING');

-- A completed refund is applied to the payment and the order exactly once.
CREATE TRIGGER IF NOT EXISTS refunds_complete AFTER UPDATE OF status ON refunds
WHEN NEW.status = 'COMPLETED' AND OLD.status <> 'COMPLETED'
BEGIN
  UPDATE payments
     SET amount_refunded_paise = MIN(amount_paise, amount_refunded_paise + NEW.amount_paise),
         status = CASE WHEN amount_refunded_paise + NEW.amount_paise >= amount_paise THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END,
         updated_at = CURRENT_TIMESTAMP
   WHERE id = NEW.payment_id;
  UPDATE orders
     SET refunded_paise = refunded_paise + NEW.amount_paise,
         payment_status = CASE WHEN refunded_paise + NEW.amount_paise >= total_paise THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END,
         status_note = CASE WHEN refunded_paise + NEW.amount_paise >= total_paise AND status = 'REFUND_PENDING' THEN 'Refund completed' ELSE status_note END,
         status_changed_by = CASE WHEN refunded_paise + NEW.amount_paise >= total_paise AND status = 'REFUND_PENDING' THEN NEW.processed_by ELSE status_changed_by END,
         status = CASE WHEN refunded_paise + NEW.amount_paise >= total_paise AND status = 'REFUND_PENDING' THEN 'REFUNDED' ELSE status END,
         updated_at = CURRENT_TIMESTAMP
   WHERE id = NEW.order_id;
END;

-- ---------- Coupons ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  label TEXT NOT NULL DEFAULT '',
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('PERCENT','FIXED')),
  value INTEGER NOT NULL CHECK (value > 0),
  minimum_subtotal_paise INTEGER CHECK (minimum_subtotal_paise IS NULL OR minimum_subtotal_paise >= 0),
  max_discount_paise INTEGER CHECK (max_discount_paise IS NULL OR max_discount_paise > 0),
  usage_limit INTEGER CHECK (usage_limit IS NULL OR usage_limit > 0),
  per_user_limit INTEGER CHECK (per_user_limit IS NULL OR per_user_limit > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  starts_at TEXT,
  ends_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (type <> 'PERCENT' OR value <= 90),
  CHECK (usage_limit IS NULL OR used_count <= usage_limit)
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id TEXT PRIMARY KEY,
  coupon_id TEXT NOT NULL REFERENCES coupons(id),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  user_id TEXT NOT NULL,
  discount_paise INTEGER NOT NULL CHECK (discount_paise >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon_user ON coupon_redemptions(coupon_id, user_id);

-- Per-customer limits are enforced by the database so concurrent checkouts
-- cannot both squeeze past them; the global limit is the CHECK on used_count.
CREATE TRIGGER IF NOT EXISTS coupon_redemptions_per_user BEFORE INSERT ON coupon_redemptions
WHEN (SELECT per_user_limit FROM coupons WHERE id = NEW.coupon_id) IS NOT NULL
 AND (SELECT COUNT(*) FROM coupon_redemptions WHERE coupon_id = NEW.coupon_id AND user_id = NEW.user_id)
     >= (SELECT per_user_limit FROM coupons WHERE id = NEW.coupon_id)
BEGIN
  SELECT RAISE(ABORT, 'Coupon limit reached');
END;

CREATE TRIGGER IF NOT EXISTS coupon_redemptions_count AFTER INSERT ON coupon_redemptions
BEGIN
  UPDATE coupons SET used_count = used_count + 1 WHERE id = NEW.coupon_id;
END;

-- An order cancelled before it was paid gives its coupon use back.
CREATE TRIGGER IF NOT EXISTS orders_cancel_coupon AFTER UPDATE OF status ON orders
WHEN NEW.status = 'CANCELLED' AND OLD.status <> 'CANCELLED' AND NEW.payment_status NOT IN ('PAID','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED')
BEGIN
  UPDATE coupons SET used_count = MAX(0, used_count - 1)
   WHERE id IN (SELECT coupon_id FROM coupon_redemptions WHERE order_id = NEW.id);
  DELETE FROM coupon_redemptions WHERE order_id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS cart_coupons (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Accounts --------------------------------------------------------

CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS login_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('CUSTOMER','ADMIN')),
  event TEXT NOT NULL,
  email TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_created ON login_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(role, created_at DESC);

-- ---------- Enquiries & newsletter -----------------------------------------

CREATE TABLE IF NOT EXISTS contact_submissions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  subject TEXT NOT NULL,
  order_number TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','READ','REPLIED','CLOSED')),
  admin_notes TEXT,
  user_id TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_contact_status_created ON contact_submissions(status, created_at DESC);

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'SUBSCRIBED' CHECK (status IN ('SUBSCRIBED','UNSUBSCRIBED')),
  source TEXT,
  user_id TEXT,
  subscribed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unsubscribed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_newsletter_status ON newsletter_subscribers(status, subscribed_at DESC);

-- ---------- Website content --------------------------------------------------

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS banners (
  id TEXT PRIMARY KEY,
  placement TEXT NOT NULL,
  eyebrow TEXT,
  heading TEXT NOT NULL,
  subheading TEXT,
  media_type TEXT NOT NULL DEFAULT 'IMAGE' CHECK (media_type IN ('IMAGE','VIDEO')),
  image_url TEXT,
  mobile_image_url TEXT,
  image_alt TEXT,
  video_url TEXT,
  href TEXT,
  cta_label TEXT,
  secondary_href TEXT,
  secondary_cta_label TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  starts_at TEXT,
  ends_at TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_banners_placement ON banners(placement, sort_order);

CREATE TABLE IF NOT EXISTS homepage_sections (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  heading TEXT,
  subheading TEXT,
  href TEXT,
  link_label TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The homepage as it is built today, in order. Featured and trending rails are
-- new and start hidden so the live homepage does not change until enabled.
INSERT OR IGNORE INTO homepage_sections (id, key, type, heading, subheading, href, link_label, sort_order, is_active) VALUES
  ('hs-hero', 'hero', 'BANNER', 'Hero', 'Placement: Home hero', NULL, NULL, 10, 1),
  ('hs-editorial-intro', 'editorial-intro', 'STATIC', 'Editorial introduction', NULL, NULL, NULL, 20, 1),
  ('hs-category-cards', 'category-cards', 'STATIC', 'Shop by category', NULL, NULL, NULL, 30, 1),
  ('hs-new-arrivals', 'new-arrivals', 'PRODUCT_RAIL', 'New Arrivals', 'Fresh expressions of timeless craftsmanship.', '/collections/new-arrivals', 'View all new arrivals', 40, 1),
  ('hs-featured-products', 'featured-products', 'PRODUCT_RAIL', 'Featured', 'Chosen by our atelier.', '/collections/best-sellers', 'View all', 45, 0),
  ('hs-featured-banner', 'featured-banner', 'BANNER', 'Featured banner', 'Placement: Home featured', NULL, NULL, 50, 1),
  ('hs-heritage-story', 'heritage-story', 'STATIC', 'Heritage story', NULL, NULL, NULL, 60, 1),
  ('hs-gift-packaging', 'gift-packaging', 'BANNER', 'Gift packaging banner', 'Placement: Home gift packaging', NULL, NULL, 70, 1),
  ('hs-best-sellers', 'best-sellers', 'PRODUCT_GRID', 'Most Loved', 'The pieces our customers return to, ranked by what actually sells.', '/collections/best-sellers', 'View all', 80, 1),
  ('hs-trending', 'trending', 'PRODUCT_RAIL', 'Trending Now', 'What our clients are reaching for this season.', '/collections/best-sellers', 'View all', 85, 0),
  ('hs-gifting-banner', 'gifting-banner', 'BANNER', 'Gifting banner', 'Placement: Home gifting', NULL, NULL, 90, 1),
  ('hs-trust-bar', 'trust-bar', 'STATIC', 'Trust bar', NULL, NULL, NULL, 100, 1),
  ('hs-recently-viewed', 'recently-viewed', 'STATIC', 'Recently viewed', NULL, NULL, NULL, 110, 1),
  ('hs-social-grid', 'social-grid', 'STATIC', 'Social grid', NULL, NULL, NULL, 120, 1);

CREATE TABLE IF NOT EXISTS content_pages (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  eyebrow TEXT,
  intro TEXT,
  sections_json TEXT NOT NULL DEFAULT '[]',
  faqs_json TEXT NOT NULL DEFAULT '[]',
  updated_label TEXT,
  meta_title TEXT,
  meta_description TEXT,
  status TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('DRAFT','PUBLISHED')),
  is_system INTEGER NOT NULL DEFAULT 1 CHECK (is_system IN (0,1)),
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS seo_entries (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL DEFAULT 'PAGE',
  entity_id TEXT,
  path TEXT NOT NULL UNIQUE,
  title TEXT,
  description TEXT,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  canonical_url TEXT,
  og_image_url TEXT,
  robots_index INTEGER NOT NULL DEFAULT 1 CHECK (robots_index IN (0,1)),
  robots_follow INTEGER NOT NULL DEFAULT 1 CHECK (robots_follow IN (0,1)),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS redirects (
  id TEXT PRIMARY KEY,
  from_path TEXT NOT NULL UNIQUE,
  to_path TEXT NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 301 CHECK (status_code IN (301,302,307,308)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE media_objects ADD COLUMN duration_seconds REAL;

-- ---------- Cache versions ---------------------------------------------------
-- Public reads are served from a per-isolate copy that is reused while these
-- counters are unchanged. Every write to the underlying tables bumps them here,
-- in the same transaction, so a cached copy can never outlive a change.

CREATE TABLE IF NOT EXISTS cache_versions (
  key TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO cache_versions (key, version) VALUES ('catalog', 1), ('content', 1);

CREATE TRIGGER IF NOT EXISTS cv_products_i AFTER INSERT ON products BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_products_u AFTER UPDATE ON products BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_products_d AFTER DELETE ON products BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_variants_i AFTER INSERT ON product_variants BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_variants_u AFTER UPDATE ON product_variants BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_variants_d AFTER DELETE ON product_variants BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_images_i AFTER INSERT ON product_images BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_images_u AFTER UPDATE ON product_images BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_images_d AFTER DELETE ON product_images BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_links_i AFTER INSERT ON product_collections BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_links_u AFTER UPDATE ON product_collections BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_links_d AFTER DELETE ON product_collections BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_collections_i AFTER INSERT ON collections BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_collections_u AFTER UPDATE ON collections BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_collections_d AFTER DELETE ON collections BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_categories_i AFTER INSERT ON categories BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_categories_u AFTER UPDATE ON categories BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_categories_d AFTER DELETE ON categories BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_terms_i AFTER INSERT ON taxonomy_terms BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_terms_u AFTER UPDATE ON taxonomy_terms BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;
CREATE TRIGGER IF NOT EXISTS cv_terms_d AFTER DELETE ON taxonomy_terms BEGIN UPDATE cache_versions SET version = random() WHERE key = 'catalog'; END;

CREATE TRIGGER IF NOT EXISTS cv_settings_i AFTER INSERT ON site_settings BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_settings_u AFTER UPDATE ON site_settings BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_settings_d AFTER DELETE ON site_settings BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_banners_i AFTER INSERT ON banners BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_banners_u AFTER UPDATE ON banners BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_banners_d AFTER DELETE ON banners BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_sections_i AFTER INSERT ON homepage_sections BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_sections_u AFTER UPDATE ON homepage_sections BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_sections_d AFTER DELETE ON homepage_sections BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_pages_i AFTER INSERT ON content_pages BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_pages_u AFTER UPDATE ON content_pages BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_pages_d AFTER DELETE ON content_pages BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_seo_i AFTER INSERT ON seo_entries BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_seo_u AFTER UPDATE ON seo_entries BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_seo_d AFTER DELETE ON seo_entries BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_redirects_i AFTER INSERT ON redirects BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_redirects_u AFTER UPDATE OF from_path, to_path, status_code, is_active ON redirects BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_redirects_d AFTER DELETE ON redirects BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
