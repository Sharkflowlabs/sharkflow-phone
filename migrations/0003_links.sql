-- Profile links (Facebook, Instagram, BBB, Yelp, Google, ...) for each contact, one URL per line (2026-11-27).
ALTER TABLE contacts ADD COLUMN links TEXT NOT NULL DEFAULT '';
-- Some contacts had a non-Instagram link (usually Facebook) typed into the Instagram box. Move it to links.
UPDATE contacts SET links = trim(instagram), instagram = ''
WHERE instagram LIKE 'http%' AND lower(instagram) NOT LIKE '%instagram.com%';
