// Live self-check for the ingest path.
//
//   DATABASE_URL=postgres://user:pass@host:port/scratch node scripts/ingest.test.js
//
// Boots the real server against a throwaway database and drives it over HTTP, so it
// covers the migration, the batch payload shape, client-supplied external_ids and
// dedupe exactly as production runs them. The migration is deliberately applied to a
// *legacy-shaped* table, because that is the case that actually breaks — a fresh
// CREATE TABLE would never exercise the ALTERs.
//
// Refuses to run against the production database.

import pg from 'pg'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const { DATABASE_URL } = process.env
if (!DATABASE_URL) {
  console.error('Set DATABASE_URL to a throwaway database.')
  process.exit(1)
}
if (/\/notifycmd(\?|$)/.test(DATABASE_URL)) {
  console.error('Refusing to run against the production notifycmd database.')
  process.exit(1)
}

const PORT = 3941
const TOKEN = 'test-webhook-token'
const SERVICE = 'test-service-token'
const base = `http://127.0.0.1:${PORT}`

const pool = new pg.Pool({ connectionString: DATABASE_URL })

async function seedLegacySchema() {
  await pool.query(`
    DROP TABLE IF EXISTS notifications;
    CREATE TABLE notifications (
      id          BIGSERIAL PRIMARY KEY,
      external_id TEXT UNIQUE,
      source      TEXT NOT NULL CHECK (source IN ('whatsapp','messenger','instagram','sms')),
      sender      TEXT,
      body        TEXT,
      occurred_at TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)
  // A row from the MacroDroid era, to prove the ALTERs cope with existing data.
  await pool.query(
    `INSERT INTO notifications (external_id, source, sender, body, occurred_at)
     VALUES ('legacyrow0000', 'whatsapp', 'Old Sender', 'old preview text', NOW())`
  )
}

function startServer() {
  const child = spawn('node', ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), WEBHOOK_TOKEN: TOKEN, SERVICE_TOKEN: SERVICE },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stderr.on('data', d => process.stderr.write(`[server] ${d}`))
  return child
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/notifications/recent`, { headers: { 'X-Service-Token': SERVICE } })
      if (r.status === 200) return
    } catch { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error('server did not come up')
}

const post = (body) =>
  fetch(`${base}/api/webhook/${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

const count = async (where = 'TRUE', params = []) =>
  Number((await pool.query(`SELECT COUNT(*) FROM notifications WHERE ${where}`, params)).rows[0].count)

async function main() {
  await seedLegacySchema()
  const server = startServer()
  try {
    await waitForServer()

    // The migration ran against the legacy table without losing the existing row.
    assert.equal(await count(`external_id = 'legacyrow0000'`), 1, 'legacy row survived migration')
    assert.equal(await count(`kind = 'msg'`), 1, 'existing rows default to kind=msg')

    // A reverb-link batch with stable per-message ids.
    const batch = {
      items: [
        { external_id: 'a'.repeat(40), source: 'whatsapp', app_package: 'com.whatsapp', thread_key: 'Jaan', sender: 'Jaan', body: 'first message', kind: 'msg', direction: 'in', occurred_at: new Date().toISOString() },
        { external_id: 'b'.repeat(40), source: 'whatsapp', app_package: 'com.whatsapp', thread_key: 'Jaan', sender: 'Jaan', body: 'second message', kind: 'msg', direction: 'in', occurred_at: new Date().toISOString() }
      ]
    }
    let r = await post(batch)
    assert.equal(r.status, 200, 'batch accepted')
    assert.equal(await count(`app_package = 'com.whatsapp'`), 2, 'batch stored both messages')

    // Replaying it is what Android actually does — MessagingStyle re-sends the whole
    // conversation on every new message. It must not duplicate.
    await post(batch)
    await post(batch)
    assert.equal(await count(`app_package = 'com.whatsapp'`), 2, 'replayed batch deduped')

    // An app outside the original four is now allowed.
    r = await post({ external_id: 'c'.repeat(40), source: 'org.thoughtcrime.securesms', app_package: 'org.thoughtcrime.securesms', sender: 'Someone', body: 'signal message', kind: 'msg' })
    assert.equal(r.status, 200, 'arbitrary package accepted')
    assert.equal(await count(`source = 'org.thoughtcrime.securesms'`), 1)

    // A non-message notification is tagged so reverb can filter it out.
    await post({ external_id: 'd'.repeat(40), source: 'com.ubercab.eats', app_package: 'com.ubercab.eats', sender: 'Uber Eats', body: 'Your order is on the way', kind: 'other' })
    assert.equal(await count(`kind = 'other'`), 1, 'non-message tagged kind=other')

    // MacroDroid's old payload shape still works, with no external_id of its own.
    r = await post({ source: 'instagram', sender: 'someone', body: 'macrodroid-era payload' })
    assert.equal(r.status, 200, 'legacy single payload accepted')
    assert.equal(await count(`body = 'macrodroid-era payload'`), 1)

    // Junk sources are still rejected.
    r = await post({ source: 'not a valid source!!', sender: 'x', body: 'y' })
    assert.equal(r.status, 400, 'invalid source rejected')

    // kind filtering is opt-in: no kind param must return everything, as reverb expects.
    const all = await (await fetch(`${base}/api/notifications/recent?limit=500`, { headers: { 'X-Service-Token': SERVICE } })).json()
    const msgs = await (await fetch(`${base}/api/notifications/recent?limit=500&kind=msg`, { headers: { 'X-Service-Token': SERVICE } })).json()
    assert.equal(all.length, await count(), 'unfiltered read returns every row')
    assert.ok(msgs.length < all.length, 'kind=msg excludes the "other" row')
    assert.ok(msgs.every(m => m.kind === 'msg'), 'kind filter is honoured')

    console.log(`OK — ${all.length} rows, ${msgs.length} messages`)
  } finally {
    server.kill()
    await pool.end()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
