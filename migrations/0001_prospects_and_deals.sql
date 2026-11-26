-- Split the CRM into a Prospects tab and a Deals tab (2026-11-26).
-- Adds a Channel column, keeps every row's previous stage in old_stage, and renames stages:
--   Prospects -> New, Attempt to connect -> Messaged, Connected -> Replied,
--   Closed won + site live -> Closed / Site live,
--   LTO -> Demo when it has a deal amount (they saw a mockup), otherwise No reply,
--   Lost (No response, no amount) -> No reply, Lost (Not interested, no amount) -> Not interested,
--   any other Lost stays Lost (a lost deal). Interested and In build keep their names.
-- Applied once by `wrangler d1 migrations apply` (tracked in the d1_migrations table).

ALTER TABLE contacts ADD COLUMN channel TEXT NOT NULL DEFAULT '';
ALTER TABLE contacts ADD COLUMN old_stage TEXT;

UPDATE contacts SET old_stage = stage;

UPDATE contacts SET stage = CASE
  WHEN stage = 'Prospects' THEN 'New'
  WHEN stage = 'Attempt to connect' THEN 'Messaged'
  WHEN stage = 'Connected' THEN 'Replied'
  WHEN stage = 'Closed won + site live' THEN 'Closed / Site live'
  WHEN stage = 'LTO' AND value IS NOT NULL THEN 'Demo'
  WHEN stage = 'LTO' THEN 'No reply'
  WHEN stage = 'Lost' AND lost_reason = 'No response' AND value IS NULL THEN 'No reply'
  WHEN stage = 'Lost' AND lost_reason = 'Not interested' AND value IS NULL THEN 'Not interested'
  ELSE stage
END;

-- Instagram-sourced leads were worked by Instagram DM.
UPDATE contacts SET channel = 'Instagram' WHERE channel = '' AND source = 'Instagram';

CREATE INDEX IF NOT EXISTS idx_contacts_stage ON contacts(stage);
