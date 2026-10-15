-- Editable copy for every homepage block (admin: Website > Homepage).
--
-- Lists such as the heritage chapters, category cards, Instagram tiles and the
-- menu feature cards are stored in items_json. Fields left empty fall back to
-- the website's built-in copy, so applying this changes nothing on its own.
-- (Line comments only: the remote D1 /query endpoint rejects /* */ blocks.)

ALTER TABLE homepage_sections ADD COLUMN secondary_href TEXT;
ALTER TABLE homepage_sections ADD COLUMN secondary_link_label TEXT;
ALTER TABLE homepage_sections ADD COLUMN items_json TEXT NOT NULL DEFAULT '[]';

-- Not a homepage block: the image cards in the desktop menu (Men, Women,
-- Collections, Gifting). Kept here so they are edited on the same screen.
INSERT OR IGNORE INTO homepage_sections (id, key, type, heading, subheading, href, link_label, sort_order, is_active) VALUES
  ('hs-menu-features', 'menu-features', 'MENU', NULL, NULL, NULL, NULL, 1000, 1);
