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
app.use(express.json())

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
    ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_source_check;
    ALTER TABLE notifications ADD CONSTRAINT notifications_source_check CHECK (source IN ('whatsapp','messenger','instagram','sms'));
  `)
}

// --- MacroDroid webhook ingest ---

app.post('/api/webhook/:token', async (req, res) => {
  if (!WEBHOOK_TOKEN || req.params.token !== WEBHOOK_TOKEN) return res.status(403).end()
  const payload = req.body && Object.keys(req.body).length ? req.body : req.query
  const { source, sender, body } = payload
  if (!source || !['whatsapp', 'messenger', 'instagram', 'sms'].includes(source)) {
    return res.status(400).json({ error: 'invalid source' })
  }
  const occurredAt = payload.occurred_at || new Date().toISOString()
  // Android notifications have no stable id, so dedupe on source+sender+body
  // within a 60s bucket — same trick text-cmd uses for its no-stable-id case.
  const bucket = Math.floor(Date.now() / 60000)
  const externalId = crypto.createHash('sha1')
    .update(`${source}|${sender || ''}|${body || ''}|${bucket}`)
    .digest('hex')
  await pool.query(
    `INSERT INTO notifications (external_id, source, sender, body, occurred_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (external_id) DO NOTHING`,
    [externalId, source, sender || null, body || null, occurredAt]
  )
  res.json({ ok: true })
})

// --- Read, service-to-service — used by reverb's notify-cmd tools ---

app.get('/api/notifications/recent', async (req, res) => {
  if (!SERVICE_TOKEN || req.headers['x-service-token'] !== SERVICE_TOKEN) return res.status(403).end()
  const limit = Math.min(parseInt(req.query.limit) || 30, 500)
  const source = req.query.source || null
  const since = req.query.since || null
  const { rows } = await pool.query(
    `SELECT id, source, sender, body, occurred_at
     FROM notifications
     WHERE ($1::text IS NULL OR source = $1)
       AND ($3::timestamptz IS NULL OR occurred_at >= $3)
     ORDER BY occurred_at DESC LIMIT $2`, [source, limit, since]
  )
  res.json(rows.reverse())
})

initDb().then(() => {
  app.listen(PORT, () => console.log(`notify-cmd on :${PORT}`))
})
