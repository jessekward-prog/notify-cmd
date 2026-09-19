-- notify-cmd schema snapshot
-- Authoritative source: initDb() in server.js. Regenerate when DDL changes.

CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  external_id TEXT UNIQUE,         -- reverb-link: stable sha1 per message. MacroDroid: sha1(source|direction|sender|body|60s-bucket)
  source      TEXT NOT NULL,       -- whatsapp/messenger/instagram/sms, else a slug of the app's package name
  sender      TEXT,                -- contact or group name; the raw number for SMS
  body        TEXT,                -- full message text from MessagingStyle; truncated preview when it came from MacroDroid
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  direction   TEXT NOT NULL DEFAULT 'in' CHECK (direction IN ('in','out')),
  app_package TEXT,                -- e.g. com.whatsapp; null for MacroDroid-era rows
  thread_key  TEXT,                -- conversation title or notification tag, for grouping
  kind        TEXT NOT NULL DEFAULT 'msg' CHECK (kind IN ('msg','other'))
);

-- 'source' has no CHECK constraint on purpose: reverb-link captures every app, so the
-- value set is open-ended. Format is validated at the webhook instead.

CREATE INDEX IF NOT EXISTS notifications_source_time_idx ON notifications (source, occurred_at DESC);
CREATE INDEX IF NOT EXISTS notifications_kind_time_idx   ON notifications (kind, occurred_at DESC);
