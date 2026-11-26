-- Bring back LTO (long-term opportunity) as a Deals column (2026-11-26).
-- Rows that were LTO before migration 0001 go back to LTO, unless they've been moved since.
UPDATE contacts SET stage = 'LTO', stage_since = COALESCE(stage_since, strftime('%Y-%m-%d','now'))
WHERE old_stage = 'LTO' AND stage IN ('Demo', 'No reply');
