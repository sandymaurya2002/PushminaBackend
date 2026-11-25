-- Journal articles and the Craftsmanship page, edited in the admin.
-- Built-in journal articles stay on the website until an article with the
-- same address is published here. The four craft stages open with the copy
-- the website already shows, so applying this changes nothing on its own.
-- (Line comments only: the remote D1 /query endpoint rejects /* */ blocks.)

CREATE TABLE IF NOT EXISTS blog_categories (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS blog_posts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES blog_categories(id),
  author_name TEXT NOT NULL DEFAULT 'Pashmore Editorial',
  cover_url TEXT,
  cover_alt TEXT,
  blocks_json TEXT NOT NULL DEFAULT '[]',
  faqs_json TEXT NOT NULL DEFAULT '[]',
  reading_minutes INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED')),
  published_at TEXT,
  scheduled_at TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS blog_posts_status ON blog_posts (status, published_at);
CREATE INDEX IF NOT EXISTS blog_posts_category ON blog_posts (category_id);

CREATE TABLE IF NOT EXISTS craftsmanship_pages (
  id TEXT PRIMARY KEY,
  eyebrow TEXT,
  heading TEXT,
  intro TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS craftsmanship_stages (
  id TEXT PRIMARY KEY,
  step TEXT NOT NULL,
  heading TEXT NOT NULL,
  duration TEXT NOT NULL,
  body TEXT NOT NULL,
  image_url TEXT,
  image_alt TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO blog_categories (id, slug, name, description, sort_order, is_active) VALUES
  ('bc-pashmina-guide', 'pashmina-guide', 'Pashmina Guide', 'What Pashmina actually is, how to judge it, and how to buy it without being sold something else.', 10, 1),
  ('bc-kashmiri-craft', 'kashmiri-craft', 'Kashmiri Craft', 'Sozni, kani, tilla and jamawar — the techniques and the people who keep them.', 20, 1),
  ('bc-indian-textiles', 'indian-textiles', 'Indian Textiles', 'Handloom traditions from Kashmir to Varanasi, and how they travelled.', 30, 1),
  ('bc-fashion', 'fashion', 'Fashion', 'Wearing handwoven cloth in a modern wardrobe.', 40, 1),
  ('bc-care-guide', 'care-guide', 'Care Guide', 'Storing, cleaning and repairing fine textiles so they outlive you.', 50, 1),
  ('bc-gift-guide', 'gift-guide', 'Gift Guide', 'Choosing a textile as a present — weddings, occasions and corporate gifting.', 60, 1),
  ('bc-style-guide', 'style-guide', 'Style Guide', 'How to drape, knot and layer shawls, stoles and dupattas.', 70, 1),
  ('bc-craftsmanship', 'craftsmanship', 'Craftsmanship', 'Inside the workshop: looms, dyes, certification and the people at the bench.', 80, 1);

INSERT OR IGNORE INTO craftsmanship_pages (id, eyebrow, heading, intro) VALUES (
  'craftsmanship',
  'Craftsmanship',
  'Four stages, three hundred kilometres, one shawl',
  'Between a Changthangi goat on the Ladakh plateau and a finished shawl in a box lie four distinct crafts, practised by four different sets of hands. None of them can be hurried, and every shortcut shows in the surface of the cloth.'
);

INSERT OR IGNORE INTO craftsmanship_stages (id, step, heading, duration, body, image_url, image_alt, sort_order) VALUES
  (
    'craft-01',
    '01',
    'Combing',
    'Two weeks each spring',
    'Changthangi goats moult as the plateau thaws. Herders comb the underfleece out by hand, taking around 150 grams per animal. Nothing is shorn — shearing mixes coarse outer hair into the pashm and cannot be undone.',
    '/images/editorial/editorial-kashmir.png',
    'The Changthang plateau in early spring where Pashmina fibre is hand-combed',
    10
  ),
  (
    'craft-02',
    '02',
    'Dehairing and spinning',
    'Six to nine weeks',
    'Raw pashm is dehaired by hand to remove the coarse guard hair, then spun on a charkha at a few grams an hour. Mill spinning breaks fibre this fine, which is why this stage has never been mechanised in Kashmir.',
    '/images/editorial/editorial-atelier.png',
    'Hand-spun Pashmina yarn wound onto bobbins in the Pashmore atelier',
    20
  ),
  (
    'craft-03',
    '03',
    'Weaving',
    'Four to six weeks, or two years',
    'A plain shawl takes four to six weeks on a wooden handloom. A full-field kani shawl — pattern built thread by thread from a coded talim script — can occupy two weavers for close to two years.',
    '/images/editorial/editorial-loom.png',
    'A weaver passing weft through a wooden handloom in Srinagar',
    30
  ),
  (
    'craft-04',
    '04',
    'Embroidery and finishing',
    'Three months to two years',
    'Sozni is worked with a single needle in silk thread, and a master covers about a square inch a day. Tilla couches flattened metallic thread onto the surface. Fringes are knotted and edges rolled by hand.',
    '/images/editorial/editorial-artisan.png',
    'An artisan finishing sozni embroidery on a cream Pashmina shawl',
    40
  );

CREATE TRIGGER IF NOT EXISTS cv_blog_posts_i AFTER INSERT ON blog_posts BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_blog_posts_u AFTER UPDATE ON blog_posts BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_blog_posts_d AFTER DELETE ON blog_posts BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_craft_stages_i AFTER INSERT ON craftsmanship_stages BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_craft_stages_u AFTER UPDATE ON craftsmanship_stages BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_craft_stages_d AFTER DELETE ON craftsmanship_stages BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
CREATE TRIGGER IF NOT EXISTS cv_craft_page_u AFTER UPDATE ON craftsmanship_pages BEGIN UPDATE cache_versions SET version = random() WHERE key = 'content'; END;
