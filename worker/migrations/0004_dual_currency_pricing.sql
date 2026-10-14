-- Dual-currency pricing: India pays in INR, every other country in USD.
--
-- Additive only. Existing products keep their INR price and have no USD price
-- until an admin enters one (prices are never converted); until then they are
-- not sold outside India. Every existing order is an INR order.
--
-- The *_paise amount columns on orders, order_items, payments, refunds and
-- coupon_redemptions hold the minor unit of the order's currency: paise for
-- INR orders, cents for USD orders.
-- (Line comments only: the remote D1 /query endpoint rejects /* */ blocks.)

ALTER TABLE products ADD COLUMN price_usd_cents INTEGER CHECK (price_usd_cents IS NULL OR price_usd_cents >= 0);
ALTER TABLE products ADD COLUMN compare_at_price_usd_cents INTEGER CHECK (compare_at_price_usd_cents IS NULL OR compare_at_price_usd_cents >= 0);

ALTER TABLE product_variants ADD COLUMN price_usd_cents INTEGER CHECK (price_usd_cents IS NULL OR price_usd_cents >= 0);
ALTER TABLE product_variants ADD COLUMN compare_at_price_usd_cents INTEGER CHECK (compare_at_price_usd_cents IS NULL OR compare_at_price_usd_cents >= 0);

ALTER TABLE orders ADD COLUMN currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency IN ('INR','USD'));
-- ISO country the shopper was pricing in when the order was placed (detected or chosen).
ALTER TABLE orders ADD COLUMN pricing_country TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_currency_created ON orders(currency, created_at DESC);
