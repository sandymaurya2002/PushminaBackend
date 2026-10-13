-- Baseline: the schema that already exists in the live pashmore-db database.
-- Every statement is IF NOT EXISTS so applying this to the live database is a
-- no-op; it only creates objects on a fresh (local/test) database.

CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE COLLATE NOCASE,name TEXT NOT NULL,password_hash TEXT NOT NULL,password_salt TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'CUSTOMER' CHECK(role IN('CUSTOMER','ADMIN')),phone TEXT,active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,access_hash TEXT NOT NULL UNIQUE,refresh_hash TEXT NOT NULL UNIQUE,expires_at INTEGER NOT NULL,refresh_expires_at INTEGER NOT NULL,revoked_at INTEGER,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY,slug TEXT NOT NULL UNIQUE,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PUBLISHED','ARCHIVED')),price_paise INTEGER NOT NULL CHECK(price_paise >= 0),stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),product_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY,slug TEXT NOT NULL UNIQUE,name TEXT NOT NULL,collection_json TEXT NOT NULL DEFAULT '{}',is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN(0,1)),updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS media_objects (id TEXT PRIMARY KEY,object_key TEXT NOT NULL UNIQUE,content_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS addresses(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,label TEXT NOT NULL DEFAULT 'Home',full_name TEXT NOT NULL,phone TEXT NOT NULL,line1 TEXT NOT NULL,line2 TEXT,city TEXT NOT NULL,state TEXT NOT NULL,postal_code TEXT NOT NULL,country TEXT NOT NULL DEFAULT 'India',is_default INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS audit_events(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),action TEXT NOT NULL,target_id TEXT,metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS cart_items(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,variant_id TEXT NOT NULL DEFAULT '',quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 99),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(user_id,product_id,variant_id));

CREATE TABLE IF NOT EXISTS login_attempts(login_key TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0,locked_until INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,order_number TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL REFERENCES users(id),status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CONFIRMED','PACKED','SHIPPED','DELIVERED','CANCELLED')),payment_status TEXT NOT NULL DEFAULT 'UNPAID' CHECK(payment_status IN('UNPAID','PAID','REFUNDED')),payment_method TEXT NOT NULL CHECK(payment_method IN('COD')),shipping_name TEXT NOT NULL,shipping_email TEXT NOT NULL,shipping_phone TEXT NOT NULL,shipping_address_json TEXT NOT NULL,subtotal_paise INTEGER NOT NULL CHECK(subtotal_paise>=0),shipping_paise INTEGER NOT NULL DEFAULT 0 CHECK(shipping_paise>=0),total_paise INTEGER NOT NULL CHECK(total_paise>=0),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS order_items(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,product_id TEXT NOT NULL,product_slug TEXT NOT NULL,product_name TEXT NOT NULL,variant_id TEXT NOT NULL DEFAULT '',quantity INTEGER NOT NULL CHECK(quantity>0),unit_price_paise INTEGER NOT NULL CHECK(unit_price_paise>=0),line_total_paise INTEGER NOT NULL CHECK(line_total_paise>=0));

CREATE TABLE IF NOT EXISTS wishlist_items(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(user_id,product_id));

CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_status_slug ON products(status,slug);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON sessions(refresh_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TRIGGER IF NOT EXISTS products_stock_nonnegative BEFORE UPDATE OF stock ON products WHEN NEW.stock<0 BEGIN SELECT RAISE(ABORT,'Insufficient stock'); END;
