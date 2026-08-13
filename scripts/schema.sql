-- notify-cmd schema snapshot
-- Authoritative source: initDb() in server.js. Regenerate when DDL changes.

CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  external_id TEXT UNIQUE,         -- sha1(source|sender|body|60s-bucket); dedupes webhook retries
  source      TEXT NOT NULL CHECK (source IN ('whatsapp','messenger','instagram')),
  sender      TEXT,                -- notification title, i.e. the contact/group name
  body        TEXT,                -- notification text, often truncated by Android
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_source_time_idx ON notifications (source, occurred_at DESC);
