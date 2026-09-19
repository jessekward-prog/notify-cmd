import express from 'express'
import pg from 'pg'
import crypto from 'node:crypto'

const {
  DATABASE_URL,
  PORT = 3000,
  WEBHOOK_TOKEN,
  SERVICE_TOKEN
} = process.env

const pool = new pg.Pool({ connectionString: DATABASE_URL })
const app = express()
// 100kb (the default) is not enough for reverb-link's batched SMS backfill.
app.use(express.json({ limit: '2mb' }))

async function initDb() {
  for (let i = 0; ; i++) {
    try { await pool.query('SELECT 1'); break } catch (e) {
      if (i >= 9) throw e
      await new Promise(r => setTimeout(r, 3000))
    }
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id          BIGSERIAL PRIMARY KEY,
      external_id TEXT UNIQUE,
      source      TEXT NOT NULL CHECK (source IN ('whatsapp','messenger','instagram','sms')),
      sender      TEXT,
      body        TEXT,
      occurred_at TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS notifications_source_time_idx ON notifications (source, occurred_at DESC);
    -- The source whitelist is gone: reverb-link captures every app, so 'source' is now
    -- the four known names plus a slug of any other package. Format is still validated
    -- at the webhook. Dropped here without being re-added, deliberately.
    ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_source_check;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'in';
    ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_direction_check;
    ALTER TABLE notifications ADD CONSTRAINT notifications_direction_check CHECK (direction IN ('in','out'));
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS app_package TEXT;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS thread_key  TEXT;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'msg';
    ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
    ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('msg','other'));
    CREATE INDEX IF NOT EXISTS notifications_kind_time_idx ON notifications (kind, occurred_at DESC);
  `)
}

// --- Webhook ingest: reverb-link (batched) and MacroDroid (single) ---

const SOURCE_RE = /^[a-z0-9._-]{1,64}$/i
const EXTERNAL_ID_RE = /^[a-f0-9]{8,128}$/i

async function ingest(payload) {
  const source = String(payload.source || '')
  if (!SOURCE_RE.test(source)) return false
  const direction = payload.direction === 'out' ? 'out' : 'in'
  const kind = payload.kind === 'other' ? 'other' : 'msg'
  const sender = payload.sender || null
  const body = payload.body || null
  const occurredAt = payload.occurred_at || new Date().toISOString()

  // reverb-link sends a stable per-message id hashed off the MessagingStyle timestamp,
  // which survives Android re-posting the whole conversation on every new message.
  // MacroDroid has no such id, so it still falls back to the 60s bucket.
  const bucket = Math.floor(Date.now() / 60000)
  const externalId = EXTERNAL_ID_RE.test(payload.external_id || '')
    ? payload.external_id
    : crypto.createHash('sha1')
        .update(`${source}|${direction}|${sender || ''}|${body || ''}|${bucket}`)
        .digest('hex')

  await pool.query(
    `INSERT INTO notifications
       (external_id, source, sender, body, occurred_at, direction, app_package, thread_key, kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (external_id) DO NOTHING`,
    [externalId, source, sender, body, occurredAt, direction,
     payload.app_package || null, payload.thread_key || null, kind]
  )
  return true
}

app.post('/api/webhook/:token', async (req, res) => {
  if (!WEBHOOK_TOKEN || req.params.token !== WEBHOOK_TOKEN) return res.status(403).end()
  const payload = req.body && Object.keys(req.body).length ? req.body : req.query
  const items = Array.isArray(payload.items) ? payload.items : [payload]
  if (items.length > 500) return res.status(413).json({ error: 'too many items' })

  let stored = 0
  for (const item of items) {
    if (await ingest(item)) stored++
  }
  const rejected = items.length - stored
  if (!stored && rejected) return res.status(400).json({ error: 'invalid source' })
  res.json({ ok: true, stored, rejected })
})

// --- Read, service-to-service — used by reverb's notify-cmd tools ---

app.get('/api/notifications/recent', async (req, res) => {
  if (!SERVICE_TOKEN || req.headers['x-service-token'] !== SERVICE_TOKEN) return res.status(403).end()
  const limit = Math.min(parseInt(req.query.limit) || 30, 500)
  const source = req.query.source || null
  const since = req.query.since || null
  // Unfiltered by default so reverb's existing calls behave exactly as before.
  const kind = req.query.kind || null
  const { rows } = await pool.query(
    `SELECT id, source, sender, body, occurred_at, direction, app_package, thread_key, kind
     FROM notifications
     WHERE ($1::text IS NULL OR source = $1)
       AND ($3::timestamptz IS NULL OR occurred_at >= $3)
       AND ($4::text IS NULL OR kind = $4)
     ORDER BY occurred_at DESC LIMIT $2`, [source, limit, since, kind]
  )
  res.json(rows.reverse())
})

initDb().then(() => {
  app.listen(PORT, () => console.log(`notify-cmd on :${PORT}`))
})
