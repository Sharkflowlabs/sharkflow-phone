-- Sharkflow Phone database (Cloudflare D1 / SQLite)
-- Base tables. Later changes (new columns, renamed stages) live in migrations/ and run after this file.

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  business TEXT NOT NULL DEFAULT '',
  phone TEXT UNIQUE,                     -- E.164, e.g. +15551234567; NULL for Instagram/email-only prospects
  email TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  instagram TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',       -- where the lead was found: Instagram, Google Maps, BBB, ...
  stage TEXT NOT NULL DEFAULT 'Prospects',  -- the app always sets it; see STAGES in src/worker.js (migration 0001 renamed them)
  next_follow_up TEXT,                   -- YYYY-MM-DD or NULL
  notes TEXT NOT NULL DEFAULT '',
  value INTEGER,                         -- deal value in dollars
  hot INTEGER NOT NULL DEFAULT 0,
  touches INTEGER NOT NULL DEFAULT 0,    -- outreach attempts with no reply yet
  last_touch TEXT,                       -- YYYY-MM-DD
  next_step TEXT NOT NULL DEFAULT '',
  stage_since TEXT,                      -- YYYY-MM-DD the current stage started
  deadline TEXT,                         -- YYYY-MM-DD delivery deadline
  lost_reason TEXT NOT NULL DEFAULT '',
  opted_out INTEGER NOT NULL DEFAULT 0,  -- 1 after they text STOP
  opt_in_at TEXT,                        -- when they agreed to get texts (YYYY-MM-DD); NULL blocks texting
  opt_in_channel TEXT NOT NULL DEFAULT '',  -- where they agreed: Instagram DM, Phone call, Email, ...
  opt_in_note TEXT NOT NULL DEFAULT '',  -- what was asked and what they said
  unread INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,               -- 'in' | 'out'
  body TEXT NOT NULL,
  twilio_sid TEXT,
  status TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,               -- 'in' | 'out'
  twilio_sid TEXT UNIQUE,
  status TEXT,
  duration INTEGER,
  recording_sid TEXT,                    -- set when a voicemail was left
  recording_duration INTEGER,
  to_number TEXT,                        -- number dialled (set for quick calls to numbers not in the CRM)
  outcome TEXT,                          -- logged disposition (OUTCOMES key)
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due TEXT,                              -- YYYY-MM-DD or NULL
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  auto INTEGER NOT NULL DEFAULT 0,       -- created by a stage change
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Notes, logged DMs/emails and dialer outcomes shown on the contact's activity timeline.
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                    -- 'note' | 'email' | 'dm' | 'dial'
  outcome TEXT,                          -- dialer outcome key for kind = 'dial'
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_activities_contact ON activities(contact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(done, due);
CREATE INDEX IF NOT EXISTS idx_tasks_contact ON tasks(contact_id);
CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_sid ON messages(twilio_sid);
CREATE INDEX IF NOT EXISTS idx_calls_contact ON calls(contact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_contacts_followup ON contacts(next_follow_up);
