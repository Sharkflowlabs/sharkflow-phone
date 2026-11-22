-- Sharkflow Phone database (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  business TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL UNIQUE,            -- E.164, e.g. +15551234567
  email TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  instagram TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'Leads',
  next_follow_up TEXT,                   -- YYYY-MM-DD or NULL
  notes TEXT NOT NULL DEFAULT '',
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_sid ON messages(twilio_sid);
CREATE INDEX IF NOT EXISTS idx_calls_contact ON calls(contact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_contacts_followup ON contacts(next_follow_up);
