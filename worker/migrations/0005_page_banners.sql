-- Page banners: a banner with placement PAGE_BANNER is shown at the top of the
-- storefront page(s) named by page_path.
--
-- page_path is an exact path ("/about", "/collections/pure-pashmina"), a
-- section wildcard ("/collections/*" covers /collections and every page below
-- it) or "*" for every page. Additive only; existing banners keep NULL.
-- (Line comments only: the remote D1 /query endpoint rejects /* */ blocks.)

ALTER TABLE banners ADD COLUMN page_path TEXT;
CREATE INDEX IF NOT EXISTS idx_banners_page_path ON banners(placement, page_path);
