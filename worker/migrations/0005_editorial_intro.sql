-- Copy fields for the homepage block "The Art of Indian Craft".
-- The row already exists; this fills the fields the website used to hard-code
-- so the admin form opens with the live copy. Later edits replace these values.
-- (Line comments only: the remote D1 /query endpoint rejects /* */ blocks.)

ALTER TABLE homepage_sections ADD COLUMN eyebrow TEXT;
ALTER TABLE homepage_sections ADD COLUMN body TEXT;
ALTER TABLE homepage_sections ADD COLUMN image_url TEXT;
ALTER TABLE homepage_sections ADD COLUMN image_alt TEXT;

UPDATE homepage_sections
SET
  eyebrow = 'Our Craft',
  heading = 'The Art of Indian Craft',
  subheading = 'Discover timeless textiles shaped by generations of craftsmanship, refined for the modern wardrobe.',
  body = 'Every Pashmore piece begins on the Changthang plateau, where pashm is combed by hand from Changthangi goats each spring, and ends in a Srinagar workshop where a single shawl can occupy one loom for six weeks. Nothing in between is hurried.',
  image_url = '/images/editorial/editorial-art-of-craft.png',
  image_alt = 'Undyed Pashmina yarn resting on a hand-carved wooden charkha in a Srinagar workshop',
  href = '/about',
  link_label = 'Discover Our Story'
WHERE key = 'editorial-intro'
  AND (heading IS NULL OR heading = 'Editorial introduction');
