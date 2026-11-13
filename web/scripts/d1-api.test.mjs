import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { app } from '../functions/api/[[route]].ts'

const schemaSql = readFileSync(new URL('../d1/schema.sql', import.meta.url), 'utf-8')
const seedSql = readFileSync(new URL('../d1/seed.sql', import.meta.url), 'utf-8')

function createMemoryD1() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(schemaSql)
  db.exec(seedSql)

  function makeStatement(sql, boundParams = []) {
    const cleanParams = boundParams.map(value => (value === undefined ? null : value))
    return {
      sql,
      params: cleanParams,
      bind(...args) {
        return makeStatement(sql, args)
      },
      async first(colName) {
        const stmt = db.prepare(sql)
        const row = stmt.get(...cleanParams)
        if (!row) return null
        if (colName) return row[colName] ?? null
        return { ...row }
      },
      async all() {
        const stmt = db.prepare(sql)
        const rows = stmt.all(...cleanParams)
        return {
          success: true,
          results: rows.map(row => ({ ...row })),
          meta: { changes: 0 }
        }
      },
      async run() {
        const stmt = db.prepare(sql)
        const res = stmt.run(...cleanParams)
        return {
          success: true,
          meta: {
            changes: Number(res.changes || 0),
            last_row_id: Number(res.lastInsertRowid || 0)
          }
        }
      }
    }
  }

  return {
    raw: db,
    prepare(sql) {
      return makeStatement(sql)
    },
    async batch(stmts) {
      const results = []
      db.exec('BEGIN IMMEDIATE;')
      try {
        for (const stmt of stmts) {
          if (/^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(stmt.sql)) {
            results.push(await stmt.all())
          } else {
            results.push(await stmt.run())
          }
        }
        db.exec('COMMIT;')
        return results
      } catch (err) {
        db.exec('ROLLBACK;')
        throw err
      }
    }
  }
}

function createMemoryR2() {
  const store = new Map()
  return {
    store,
    async put(key, value, opts = {}) {
      const bytes = value instanceof ArrayBuffer
        ? new Uint8Array(value.slice(0))
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
          : new Uint8Array(Buffer.from(String(value)))
      store.set(key, { bytes, httpMetadata: opts.httpMetadata || {} })
    },
    async get(key) {
      const entry = store.get(key)
      if (!entry) return null
      return {
        httpMetadata: entry.httpMetadata,
        async arrayBuffer() {
          return entry.bytes.slice().buffer
        }
      }
    },
    async delete(key) {
      store.delete(key)
    }
  }
}

function createTestEnv() {
  return {
    DB: createMemoryD1(),
    EVIDENCE_BUCKET: createMemoryR2()
  }
}

async function apiReq(env, path, { method = 'GET', body = undefined, email = 'admin@sym.co.th' } = {}) {
  const headers = new Headers()
  if (email !== null) {
    headers.set('x-dev-user-email', email)
  }
  const init = { method, headers }
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json')
    init.body = JSON.stringify(body)
  }
  const res = await app.request(path, init, env)
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, json, res }
}

test('D1 schema file exists and contains valid core tables', () => {
  const schema = readFileSync('d1/schema.sql', 'utf-8')
  assert.match(schema, /CREATE TABLE IF NOT EXISTS branches/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS scanner_assets/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS branch_work_orders/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS replacement_tasks/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS replacement_task_evidence/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS task_reviews/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS google_signin_allowlist/)
  assert.match(schema, /address_note TEXT/)
  assert.match(schema, /phone TEXT/)
  assert.match(schema, /install_type TEXT/)
})

test('D1 allowlist supports customer_reviewer role', () => {
  const schema = readFileSync('d1/schema.sql', 'utf-8')
  assert.match(schema, /customer_reviewer/)
})

test('Task table supports customer review timestamps and direct reject reason', () => {
  const schema = readFileSync('d1/schema.sql', 'utf-8')
  assert.match(schema, /customer_accepted_at TEXT/)
  assert.match(schema, /customer_rejected_at TEXT/)
  assert.match(schema, /customer_reject_reason TEXT/)
  assert.match(schema, /version INTEGER NOT NULL DEFAULT 1/)
})

test('Task reviews audit trail supports sym and customer stages', () => {
  const schema = readFileSync('d1/schema.sql', 'utf-8')
  assert.match(schema, /stage TEXT NOT NULL CHECK \(stage IN \('sym', 'customer'\)\)/)
  assert.match(schema, /decision TEXT NOT NULL CHECK \(decision IN \('pass', 'reject'\)\)/)
})

test('D1 schema supports scanner discovery reports and full lifecycle status', () => {
  const schema = readFileSync('d1/schema.sql', 'utf-8')
  assert.match(schema, /CREATE TABLE IF NOT EXISTS scanner_discovery_reports/)
  assert.match(schema, /'blocked'/)
  assert.match(schema, /'cancelled'/)
})

test('Edge API routes contain discovery, action, and evidence delete endpoints', () => {
  const routeCode = readFileSync('functions/api/[[route]].ts', 'utf-8')
  assert.match(routeCode, /app\.post\('\/discovery'/)
  assert.match(routeCode, /app\.get\('\/discovery\/queue'/)
  assert.match(routeCode, /app\.post\('\/discovery\/:id\/review'/)
  assert.match(routeCode, /app\.post\('\/tasks\/:id\/action'/)
  assert.match(routeCode, /app\.delete\('\/tasks\/:id\/evidence\/:slot'/)
})

test('Edge API routes contain allowlist user management and review audit trail', () => {
  const routeCode = readFileSync('functions/api/[[route]].ts', 'utf-8')
  assert.match(routeCode, /app\.get\('\/tasks\/:id\/reviews'/)
  assert.match(routeCode, /app\.get\('\/allowlist'/)
  assert.match(routeCode, /app\.post\('\/allowlist'/)
  assert.match(routeCode, /app\.post\('\/allowlist\/:id\/toggle'/)
})

test('HTTP runtime: Auth middleware rejects unauthenticated and unknown users', async () => {
  const env = createTestEnv()

  const noAuth = await apiReq(env, '/api/auth/me', { email: null })
  assert.equal(noAuth.status, 401)

  const unknownUser = await apiReq(env, '/api/auth/me', { email: 'intruder@example.com' })
  assert.equal(unknownUser.status, 403)

  const validAdmin = await apiReq(env, '/api/auth/me', { email: 'admin@sym.co.th' })
  assert.equal(validAdmin.status, 200)
  assert.equal(validAdmin.json.role, 'admin')
})

test('HTTP runtime: RBAC enforces least privilege on /export/raw-data, /tasks/pending, /discovery/queue, and /register/import/history', async () => {
  const env = createTestEnv()

  // Seed one scanner so /export/raw-data returns real rows for allowed roles
  const imp = await apiReq(env, '/api/register/import', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      source_name: 'RBAC_Test.xlsx',
      rows: [{ location_code: 'BKK-RBAC', loc_bld: 'AIS RBAC Shop', com_sn: 'SN-RBAC-001', province: 'กรุงเทพมหานคร' }]
    }
  })
  assert.equal(imp.status, 200)

  // Viewer & field_technician are denied raw CSV export & admin queues
  for (const roleEmail of ['viewer@ais.co.th', 'tech1@sym.co.th']) {
    const exp = await apiReq(env, '/api/export/raw-data', { email: roleEmail })
    assert.equal(exp.status, 403, `Expected 403 for ${roleEmail} on /export/raw-data`)

    const pending = await apiReq(env, '/api/tasks/pending', { email: roleEmail })
    assert.equal(pending.status, 403, `Expected 403 for ${roleEmail} on /tasks/pending`)

    const queue = await apiReq(env, '/api/discovery/queue', { email: roleEmail })
    assert.equal(queue.status, 403, `Expected 403 for ${roleEmail} on /discovery/queue`)

    const hist = await apiReq(env, '/api/register/import/history', { email: roleEmail })
    assert.equal(hist.status, 403, `Expected 403 for ${roleEmail} on /register/import/history`)
  }

  // Customer reviewer may export raw data & view customer pending queue, but cannot access SYM discovery queue or import history
  const revExp = await apiReq(env, '/api/export/raw-data', { email: 'reviewer@gable.co.th' })
  assert.equal(revExp.status, 200)
  assert.equal(revExp.json.total_records, 1)
  assert.equal('started_by' in revExp.json.data[0], false)

  const revPending = await apiReq(env, '/api/tasks/pending', { email: 'reviewer@gable.co.th' })
  assert.equal(revPending.status, 200)

  const revQueue = await apiReq(env, '/api/discovery/queue', { email: 'reviewer@gable.co.th' })
  assert.equal(revQueue.status, 403)

  // Admin can access export & import history
  const adminExp = await apiReq(env, '/api/export/raw-data', { email: 'admin@sym.co.th' })
  assert.equal(adminExp.status, 200)
  const adminHist = await apiReq(env, '/api/register/import/history', { email: 'admin@sym.co.th' })
  assert.equal(adminHist.status, 200)
  assert.equal(adminHist.json.rows.length, 1)
})

test('HTTP runtime: /register/import preserves existing custom branch_id and reports imported_count & skipped_count', async () => {
  const env = createTestEnv()
  env.DB.raw.prepare(`
    INSERT INTO branches (id, location_code, loc_bld, province)
    VALUES ('brn-legacy-custom', 'BKK-LEG1', 'AIS Legacy Shop', 'กรุงเทพมหานคร')
  `).run()

  const res = await apiReq(env, '/api/register/import', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      source_name: 'Incremental.xlsx',
      rows: [
        { location_code: 'BKK-LEG1', loc_bld: 'AIS Legacy Shop', com_sn: 'SN-LEG-01', province: 'กรุงเทพมหานคร' },
        { location_code: 'BKK-LEG1', loc_bld: 'AIS Legacy Shop', com_sn: '', province: 'กรุงเทพมหานคร' }
      ]
    }
  })

  assert.equal(res.status, 200)
  assert.equal(res.json.imported_count, 1)
  assert.equal(res.json.skipped_count, 1)

  const scanner = env.DB.raw.prepare('SELECT branch_id FROM scanner_assets WHERE com_sn = ?').get('SN-LEG-01')
  assert.equal(scanner.branch_id, 'brn-legacy-custom')
})

test('HTTP runtime: 4-Eyes blocks case-insensitive self-approval and Customer Batch Accept validates before mutating R2/D1', async () => {
  const env = createTestEnv()

  const imp = await apiReq(env, '/api/register/import', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      source_name: 'Flow.xlsx',
      rows: [
        { location_code: 'BKK-FLOW', loc_bld: 'AIS Flow Shop', com_sn: 'SN-FLOW-01', province: 'กรุงเทพมหานคร' }
      ]
    }
  })
  assert.equal(imp.status, 200)

  const list = await apiReq(env, '/api/scanners?search=SN-FLOW-01', { email: 'admin@sym.co.th' })
  assert.equal(list.status, 200)
  const scanner = list.json.rows[0]

  // Admin starts and closes out the task personally
  const started = await apiReq(env, '/api/tasks/start', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { scanner_id: scanner.id }
  })
  assert.equal(started.status, 200)

  const closeout = await apiReq(env, `/api/tasks/${started.json.task_id}/closeout`, {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      outcome: 'no_damage_found',
      notes: 'ตรวจแล้วเครื่องเดิมใช้งานได้ปกติ',
      version: 1
    }
  })
  assert.equal(closeout.status, 200)
  assert.equal(closeout.json.status, 'pending_exception')

  // Outcome alias in DB ('aborted') is exposed cleanly as 'no_damage_found'
  const scannersAfter = await apiReq(env, '/api/scanners?search=SN-FLOW-01', { email: 'admin@sym.co.th' })
  assert.equal(scannersAfter.json.rows[0].outcome, 'no_damage_found')

  // Same admin with different letter casing must be blocked by 4-Eyes
  const selfVerify = await apiReq(env, '/api/review/sym-verify', {
    method: 'POST',
    email: 'Admin@SYM.co.th',
    body: { task_id: started.json.task_id, decision: 'pass', version: 2 }
  })
  assert.equal(selfVerify.status, 403)

  // Second admin approves Stage 1 -> awaiting_customer_acceptance
  const peerVerify = await apiReq(env, '/api/review/sym-verify', {
    method: 'POST',
    email: 'karunyaphasmanakun@gmail.com',
    body: { task_id: started.json.task_id, decision: 'pass', version: 2 }
  })
  assert.equal(peerVerify.status, 200)
  assert.equal(peerVerify.json.status, 'awaiting_customer_acceptance')

  const samplePng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  // Wrong branch_id in customer-batch-accept must fail 409 BEFORE writing to R2
  const badBatch = await apiReq(env, '/api/review/customer-batch-accept', {
    method: 'POST',
    email: 'reviewer@gable.co.th',
    body: {
      branch_id: 'brn-wrong-branch',
      task_ids: [started.json.task_id],
      signature_base64: samplePng
    }
  })
  assert.equal(badBatch.status, 409)
  assert.equal(env.EVIDENCE_BUCKET.store.size, 0)

  // Correct branch_id succeeds, persists R2 signature keys, and logs both review stages
  const okBatch = await apiReq(env, '/api/review/customer-batch-accept', {
    method: 'POST',
    email: 'reviewer@gable.co.th',
    body: {
      branch_id: scanner.branch_id,
      task_ids: [started.json.task_id],
      signature_base64: samplePng
    }
  })
  assert.equal(okBatch.status, 200)
  assert.equal(okBatch.json.status, 'delivered')

  const r2Keys = Array.from(env.EVIDENCE_BUCKET.store.keys())
  assert.ok(r2Keys.some(k => k.startsWith(`tasks/${started.json.task_id}/inspector_signature_`)))
  assert.ok(r2Keys.some(k => k.startsWith(`branches/${scanner.branch_id}/gable_sign_`)))

  const reviews = await apiReq(env, `/api/tasks/${started.json.task_id}/reviews`, { email: 'admin@sym.co.th' })
  assert.equal(reviews.status, 200)
  assert.deepEqual(reviews.json.reviews.map(r => r.stage).sort(), ['customer', 'sym'])
})
