import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { app } from '../functions/api/[[route]].ts'
import { clearGoogleJwksCache } from '../src/lib/google-oauth.ts'

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

function signTestJwt(privateKeyPem, header, payload) {
  const encodePart = obj => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')
  const signingInput = `${encodePart(header)}.${encodePart(payload)}`
  const signature = cryptoSign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), privateKeyPem)
  return `${signingInput}.${signature.toString('base64url')}`
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie()
  }
  const single = headers.get('set-cookie')
  return single ? [single] : []
}

function extractCookiePair(setCookieList, name) {
  for (const entry of setCookieList) {
    const firstSegment = entry.split(';')[0]
    if (firstSegment.startsWith(`${name}=`)) {
      return firstSegment
    }
  }
  return null
}

test('HTTP runtime: Google OAuth config resolves cleanly and fails closed on partial or weak secret setup', async () => {
  const env = createTestEnv()

  const devCfgRes = await app.request('/api/auth/config', {}, env)
  const devCfg = await devCfgRes.json()
  assert.equal(devCfgRes.status, 200)
  assert.equal(devCfg.mode, 'dev_fallback')
  assert.equal(devCfg.dev_auth_enabled, true)
  assert.equal(devCfg.google_enabled, false)

  const partialEnv = { ...env, GOOGLE_CLIENT_ID: 'client-id-123.apps.googleusercontent.com' }
  const partialCfgRes = await app.request('/api/auth/config', {}, partialEnv)
  const partialCfg = await partialCfgRes.json()
  assert.equal(partialCfg.mode, 'misconfigured')
  assert.equal(partialCfg.dev_auth_enabled, false)

  const spoofRes = await app.request('/api/auth/me', {
    headers: { 'x-dev-user-email': 'admin@sym.co.th' },
  }, partialEnv)
  assert.equal(spoofRes.status, 503)

  const weakSecretEnv = {
    ...env,
    GOOGLE_CLIENT_ID: 'client-id-123.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'secret-123',
    SESSION_SECRET: 'too-short-secret',
  }
  const weakCfg = await (await app.request('/api/auth/config', {}, weakSecretEnv)).json()
  assert.equal(weakCfg.mode, 'misconfigured')
  assert.equal((await app.request('/api/auth/me', { headers: { 'x-dev-user-email': 'admin@sym.co.th' } }, weakSecretEnv)).status, 503)
})

test('HTTP runtime: Google Sign-In OAuth PKCE flow issues signed HttpOnly cookie, blocks dev spoofing, checks allowlist/revocation/CSRF', async () => {
  clearGoogleJwksCache()
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'google-key-1', alg: 'RS256', use: 'sig' }

  const origin = 'https://ais-branch-asset-operations.pages.dev'
  const clientId = 'ais-scanner-client.apps.googleusercontent.com'
  const clientSecret = 'google-client-secret-value'
  const sessionSecret = '0123456789abcdef0123456789abcdef-test-session-secret'
  const baseEnv = {
    ...createTestEnv(),
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    SESSION_SECRET: sessionSecret,
  }

  let nextExchangeNonce = ''
  let nextEmail = 'admin@sym.co.th'
  let nextEmailVerified = true
  let lastTokenBody = null

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      lastTokenBody = new URLSearchParams(String(init?.body || ''))
      const now = Math.floor(Date.now() / 1000)
      const idToken = signTestJwt(privateKey, { alg: 'RS256', kid: 'google-key-1' }, {
        iss: 'https://accounts.google.com',
        aud: clientId,
        sub: 'google-sub-12345',
        email: nextEmail,
        email_verified: nextEmailVerified,
        nonce: nextExchangeNonce,
        exp: now + 3600,
      })
      return new Response(JSON.stringify({ id_token: idToken, token_type: 'Bearer' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return originalFetch(input, init)
  }

  try {
    // 1. Config hides Dev Auth Bar and enables Google OAuth without leaking secrets
    const cfgJson = await (await app.request(`${origin}/api/auth/config`, {}, baseEnv)).json()
    assert.equal(cfgJson.mode, 'google_oauth')
    assert.equal(cfgJson.google_enabled, true)
    assert.equal(cfgJson.dev_auth_enabled, false)
    assert.equal('SESSION_SECRET' in cfgJson, false)

    // 2. Reject x-dev-user-email / query / Bearer spoofing and unauthenticated /api/evidence/*
    const devSpoof = await app.request(`${origin}/api/auth/me?dev_email=admin@sym.co.th`, {
      headers: {
        'x-dev-user-email': 'admin@sym.co.th',
        Authorization: 'Bearer admin@sym.co.th',
      },
    }, baseEnv)
    assert.equal(devSpoof.status, 401)
    assert.equal((await app.request(`${origin}/api/evidence/tasks/t1/old.jpg`, {}, baseEnv)).status, 401)

    // 3. Start OAuth flow: issues HttpOnly signed ais_oauth_tx cookie and redirects with PKCE S256
    const startRes = await app.request(`${origin}/api/auth/google/start`, {}, baseEnv)
    assert.equal(startRes.status, 302)
    const redirectLocation = new URL(startRes.headers.get('location'))
    assert.equal(redirectLocation.origin, 'https://accounts.google.com')
    assert.equal(redirectLocation.searchParams.get('redirect_uri'), `${origin}/api/auth/callback`)
    assert.equal(redirectLocation.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(redirectLocation.searchParams.get('prompt'), 'select_account')
    const state = redirectLocation.searchParams.get('state')
    const nonce = redirectLocation.searchParams.get('nonce')
    const codeChallenge = redirectLocation.searchParams.get('code_challenge')
    assert.ok(state && nonce && codeChallenge)

    const startSetCookies = getSetCookies(startRes.headers)
    const txCookiePair = extractCookiePair(startSetCookies, 'ais_oauth_tx')
    assert.ok(txCookiePair)
    assert.match(startSetCookies[0], /HttpOnly/i)
    assert.match(startSetCookies[0], /SameSite=Lax/i)
    assert.match(startSetCookies[0], /Secure/i)

    // 4. Invalid state rejected with invalid_state & clears tx cookie
    const badStateRes = await app.request(`${origin}/api/auth/callback?code=c1&state=wrong-state`, {
      headers: { Cookie: txCookiePair },
    }, baseEnv)
    assert.equal(badStateRes.status, 302)
    assert.equal(badStateRes.headers.get('location'), '/?auth_error=invalid_state')

    // 5. Unverified email rejected & issues no session cookie
    nextExchangeNonce = nonce
    nextEmail = 'admin@sym.co.th'
    nextEmailVerified = false
    const unverifiedRes = await app.request(`${origin}/api/auth/callback?code=c2&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: txCookiePair },
    }, baseEnv)
    assert.equal(unverifiedRes.status, 302)
    assert.equal(unverifiedRes.headers.get('location'), '/?auth_error=unverified_email')
    assert.equal(extractCookiePair(getSetCookies(unverifiedRes.headers), 'ais_session'), null)

    // Verify PKCE code_verifier hashed to the exact code_challenge from /start
    const verifier = lastTokenBody.get('code_verifier')
    assert.equal(createHash('sha256').update(verifier).digest('base64url'), codeChallenge)

    // 6. Verified Google email NOT in allowlist gets not_allowlisted & no session cookie
    nextEmailVerified = true
    nextEmail = 'outsider@gmail.com'
    const deniedRes = await app.request(`${origin}/api/auth/callback?code=c3&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: txCookiePair },
    }, baseEnv)
    assert.equal(deniedRes.status, 302)
    assert.equal(deniedRes.headers.get('location'), '/?auth_error=not_allowlisted')

    // 7. Valid allowlisted Google user receives signed HttpOnly ais_session cookie
    nextEmail = 'ADMIN@SYM.CO.TH'
    const okCallbackRes = await app.request(`${origin}/api/auth/callback?code=c4&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: txCookiePair },
    }, baseEnv)
    assert.equal(okCallbackRes.status, 302)
    assert.equal(okCallbackRes.headers.get('location'), '/')
    const cbCookies = getSetCookies(okCallbackRes.headers)
    const sessionCookiePair = extractCookiePair(cbCookies, 'ais_session')
    assert.ok(sessionCookiePair)
    const sessionHeaderLine = cbCookies.find(line => line.startsWith('ais_session='))
    assert.match(sessionHeaderLine, /HttpOnly/i)
    assert.match(sessionHeaderLine, /SameSite=Lax/i)
    assert.match(sessionHeaderLine, /Secure/i)

    // 8. Signed cookie authenticates /api/auth/me and /api/evidence/*, while tampered cookie fails 401
    const meRes = await app.request(`${origin}/api/auth/me`, {
      headers: { Cookie: sessionCookiePair },
    }, baseEnv)
    const meJson = await meRes.json()
    assert.equal(meRes.status, 200)
    assert.equal(meJson.email, 'admin@sym.co.th')
    assert.equal(meJson.role, 'admin')
    assert.equal(meJson.auth_mode, 'google_oauth')

    const evidenceAuthRes = await app.request(`${origin}/api/evidence/tasks/missing/photo.jpg`, {
      headers: { Cookie: sessionCookiePair },
    }, baseEnv)
    assert.equal(evidenceAuthRes.status, 404)

    const tamperedCookie = `${sessionCookiePair.slice(0, -4)}AAAA`
    assert.equal((await app.request(`${origin}/api/auth/me`, { headers: { Cookie: tamperedCookie } }, baseEnv)).status, 401)

    // 9. CSRF cross-site Origin rejected on mutating requests
    const csrfBlocked = await app.request(`${origin}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: sessionCookiePair, Origin: 'https://evil.example' },
    }, baseEnv)
    assert.equal(csrfBlocked.status, 403)

    // 10. Real-time allowlist deactivation revokes active cookie immediately on next request
    baseEnv.DB.prepare("UPDATE google_signin_allowlist SET is_active = 0 WHERE email = 'admin@sym.co.th'").run()
    const revokedRes = await app.request(`${origin}/api/auth/me`, {
      headers: { Cookie: sessionCookiePair },
    }, baseEnv)
    assert.equal(revokedRes.status, 403)
    assert.match(getSetCookies(revokedRes.headers).find(c => c.startsWith('ais_session=')) || '', /Max-Age=0/i)

    // 11. Logout clears ais_session cookie
    const logoutRes = await app.request(`${origin}/api/auth/logout`, {
      method: 'POST',
      headers: { Origin: origin },
    }, baseEnv)
    assert.equal(logoutRes.status, 200)
    assert.match(getSetCookies(logoutRes.headers).find(c => c.startsWith('ais_session=')) || '', /Max-Age=0/i)
  } finally {
    globalThis.fetch = originalFetch
    clearGoogleJwksCache()
  }
})

test('HTTP runtime: /register/import scales to 1,992 devices across 580 branches and tracks inserted/updated history counts accurately', async () => {
  const env = createTestEnv()
  const rows = []
  for (let i = 0; i < 1992; i++) {
    const branchIdx = i % 580
    rows.push({
      location_code: `LOC-${String(branchIdx).padStart(4, '0')}`,
      loc_bld: `AIS Shop ${branchIdx}`,
      province: branchIdx % 2 === 0 ? 'กรุงเทพมหานคร' : 'เชียงใหม่',
      com_sn: `SN-SCALE-${String(i).padStart(5, '0')}`,
      brand: 'Zebra',
      model_name: 'DS9308',
    })
  }

  const firstImport = await apiReq(env, '/api/register/import', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { source_name: 'Scale_1992.xlsx', rows },
  })
  assert.equal(firstImport.status, 200)
  assert.equal(firstImport.json.imported_count, 1992)
  assert.equal(firstImport.json.inserted, 1992)
  assert.equal(firstImport.json.updated, 0)
  assert.equal(firstImport.json.branches_count, 580)

  // Re-import mixing 100 existing scanners + 10 brand new scanners
  const deltaRows = [
    ...rows.slice(0, 100).map(r => ({ ...r, model_name: 'DS9308-V2' })),
    ...Array.from({ length: 10 }, (_, j) => ({
      location_code: 'LOC-0000',
      loc_bld: 'AIS Shop 0',
      province: 'กรุงเทพมหานคร',
      com_sn: `SN-DELTA-${j}`,
      brand: 'Honeywell',
      model_name: 'HF680',
    })),
  ]
  const secondImport = await apiReq(env, '/api/register/import', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { source_name: 'Delta.xlsx', rows: deltaRows },
  })
  assert.equal(secondImport.status, 200)
  assert.equal(secondImport.json.imported_count, 110)
  assert.equal(secondImport.json.inserted, 10)
  assert.equal(secondImport.json.updated, 100)

  const hist = await apiReq(env, '/api/register/import/history', { email: 'admin@sym.co.th' })
  assert.equal(hist.status, 200)
  const latest = hist.json.rows[0]
  assert.equal(latest.result_counts.inserted, 10)
  assert.equal(latest.result_counts.updated, 100)
})

test('HTTP runtime: /review/sym-verify registers different_device_found SN only within branch and blocks cross-branch move', async () => {
  const env = createTestEnv()
  await apiReq(env, '/api/register/import', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      source_name: 'DiffDevice.xlsx',
      rows: [
        { location_code: 'BR-A', loc_bld: 'AIS A', com_sn: 'SN-A-1', province: 'กรุงเทพมหานคร', brand: 'Zebra' },
        { location_code: 'BR-A', loc_bld: 'AIS A', com_sn: 'SN-A-2', province: 'กรุงเทพมหานคร', brand: 'Zebra' },
        { location_code: 'BR-B', loc_bld: 'AIS B', com_sn: 'SN-B-EXISTING', province: 'นนทบุรี', brand: 'Zebra' },
      ],
    },
  })

  const list = await apiReq(env, '/api/scanners?search=SN-A-', { email: 'admin@sym.co.th' })
  const snA1 = list.json.rows.find(r => r.com_sn === 'SN-A-1')
  const snA2 = list.json.rows.find(r => r.com_sn === 'SN-A-2')

  // Case 1: observed serial belongs to BR-B -> must reject 409 without moving branch or approving task
  const start1 = await apiReq(env, '/api/tasks/start', {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: { scanner_id: snA1.id },
  })
  await apiReq(env, `/api/tasks/${start1.json.task_id}/closeout`, {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: { outcome: 'different_device_found', observed_serial: 'SN-B-EXISTING', notes: 'พบ SN ของอีกสาขา', version: 1 },
  })
  const dashWhilePending = await apiReq(env, '/api/dashboard/summary', { email: 'admin@sym.co.th' })
  assert.equal(dashWhilePending.status, 200)
  assert.equal(dashWhilePending.json.summary.awaiting_admin, 1)
  assert.equal(dashWhilePending.json.summary.awaiting_review, 1)
  const blockedCrossBranch = await apiReq(env, '/api/review/sym-verify', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { task_id: start1.json.task_id, decision: 'pass', version: 2, register_observed_serial: true },
  })
  assert.equal(blockedCrossBranch.status, 409)
  const snBCheck = env.DB.raw.prepare('SELECT b.location_code FROM scanner_assets s JOIN branches b ON b.id = s.branch_id WHERE s.com_sn = ?').get('SN-B-EXISTING')
  assert.equal(snBCheck.location_code, 'BR-B')

  // Case 2: brand new observed serial -> registers in BR-A and approves task to awaiting_customer_acceptance
  const start2 = await apiReq(env, '/api/tasks/start', {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: { scanner_id: snA2.id },
  })
  await apiReq(env, `/api/tasks/${start2.json.task_id}/closeout`, {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: { outcome: 'different_device_found', observed_serial: 'SN-A-NEW-FOUND', notes: 'เครื่องจริงหน้าร้านต่างจากทะเบียน', version: 1 },
  })
  const okPass = await apiReq(env, '/api/review/sym-verify', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { task_id: start2.json.task_id, decision: 'pass', version: 2, register_observed_serial: true },
  })
  assert.equal(okPass.status, 200)
  assert.equal(okPass.json.status, 'awaiting_customer_acceptance')
  assert.equal(okPass.json.observed_registered, true)
  const newAsset = env.DB.raw.prepare('SELECT b.location_code FROM scanner_assets s JOIN branches b ON b.id = s.branch_id WHERE s.com_sn = ?').get('SN-A-NEW-FOUND')
  assert.equal(newAsset.location_code, 'BR-A')
})

test('Production wipe SQL in switch-to-production.ps1 obeys FK constraints and preserves allowlist', async () => {
  const env = createTestEnv()
  await apiReq(env, '/api/register/import', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      source_name: 'WipeCheck.xlsx',
      rows: [{ location_code: 'WIPE-1', loc_bld: 'AIS Wipe Shop', com_sn: 'SN-WIPE-1', province: 'กรุงเทพมหานคร' }],
    },
  })
  const list = await apiReq(env, '/api/scanners?search=SN-WIPE-1', { email: 'admin@sym.co.th' })
  const scanner = list.json.rows[0]
  const start = await apiReq(env, '/api/tasks/start', {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: { scanner_id: scanner.id },
  })
  await apiReq(env, `/api/tasks/${start.json.task_id}/closeout`, {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: { outcome: 'replaced', new_serial_number: 'SN-WIPE-NEW', version: 1 },
  })
  await apiReq(env, '/api/review/sym-verify', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { task_id: start.json.task_id, decision: 'pass', version: 2 },
  })
  await apiReq(env, '/api/discovery', {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: { branch_id: scanner.branch_id, serial_number: 'SN-WIPE-DISC' },
  })
  await apiReq(env, '/api/stock/import/commit', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      source_name: 'WipeStock.xlsx',
      rows: [{ serial_number: 'SN-WIPE-STOCK', brand: 'Zebra', model_name: 'DS9308', lot_no: 'PO-WIPE' }],
    },
  })
  env.DB.raw.prepare("INSERT INTO audit_events (id, entity_type, entity_id, action, actor_email) VALUES ('aud-1', 'task', 't1', 'test', 'admin@sym.co.th')").run()

  const psScript = readFileSync('scripts/switch-to-production.ps1', 'utf-8')
  const match = psScript.match(/\$wipeSql\s*=\s*@"([\s\S]*?)"@/)
  assert.ok(match, 'switch-to-production.ps1 must define $wipeSql here-string')
  env.DB.raw.exec(match[1])

  for (const table of [
    'stock_movements',
    'stock_items',
    'stock_documents',
    'replacement_task_evidence',
    'task_reviews',
    'scanner_discovery_reports',
    'replacement_tasks',
    'branch_work_orders',
    'scanner_assets',
    'branches',
    'import_batches',
    'audit_events',
  ]) {
    const row = env.DB.raw.prepare(`SELECT COUNT(*) as c FROM ${table}`).get()
    assert.equal(row.c, 0, `Expected ${table} to be empty after wipe`)
  }
  const allowlist = env.DB.raw.prepare('SELECT COUNT(*) as c FROM google_signin_allowlist').get()
  assert.ok(allowlist.c >= 6, 'Allowlist must be preserved across production wipe')
})

test('HTTP runtime: /api/tasks/pending includes stock metadata for SYM Admin, reflects hybrid reconcile, and strips it for customer_reviewer', async () => {
  const env = createTestEnv()

  await apiReq(env, '/api/register/import', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      source_name: 'PendingStockMeta.xlsx',
      rows: [
        { location_code: 'BKK-PEND-1', loc_bld: 'AIS Pending Shop', com_sn: 'SN-PEND-OLD-REG', province: 'กรุงเทพมหานคร' },
        { location_code: 'BKK-PEND-1', loc_bld: 'AIS Pending Shop', com_sn: 'SN-PEND-OLD-HYB', province: 'กรุงเทพมหานคร' },
      ],
    },
  })

  await apiReq(env, '/api/stock/import/commit', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      source_name: 'PendingStockSupply.xlsx',
      rows: [
        { serial_number: 'SN-PEND-NEW-REG', brand: 'Honeywell', model_name: 'Xenon 1950g', lot_no: 'LOT-PEND-1' },
      ],
    },
  })

  const list = await apiReq(env, '/api/scanners?search=SN-PEND-OLD', { email: 'admin@sym.co.th' })
  assert.equal(list.status, 200)
  const regScanner = list.json.rows.find(r => r.com_sn === 'SN-PEND-OLD-REG')
  const hybScanner = list.json.rows.find(r => r.com_sn === 'SN-PEND-OLD-HYB')
  assert.ok(regScanner && hybScanner)

  const startReg = await apiReq(env, '/api/tasks/start', { method: 'POST', email: 'tech1@sym.co.th', body: { scanner_id: regScanner.id } })
  const closeReg = await apiReq(env, `/api/tasks/${startReg.json.task_id}/closeout`, {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: { outcome: 'replaced', new_serial_number: 'SN-PEND-NEW-REG', version: startReg.json.version },
  })
  assert.equal(closeReg.status, 200)

  const startHyb = await apiReq(env, '/api/tasks/start', { method: 'POST', email: 'tech1@sym.co.th', body: { scanner_id: hybScanner.id } })
  const closeHyb = await apiReq(env, `/api/tasks/${startHyb.json.task_id}/closeout`, {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: { outcome: 'replaced', new_serial_number: 'SN-PEND-NEW-HYB', version: startHyb.json.version },
  })
  assert.equal(closeHyb.status, 200)

  const adminPending = await apiReq(env, '/api/tasks/pending', { email: 'admin@sym.co.th' })
  assert.equal(adminPending.status, 200)
  const regRow = adminPending.json.tasks.find(t => t.id === startReg.json.task_id)
  const hybRow = adminPending.json.tasks.find(t => t.id === startHyb.json.task_id)

  assert.equal(regRow.stock_source_mode, 'registered_stock')
  assert.equal(regRow.stock_status, 'allocated_to_task')
  assert.equal(regRow.stock_brand, 'Honeywell')
  assert.equal(regRow.stock_model, 'Xenon 1950g')
  assert.equal(regRow.stock_lot_no, 'LOT-PEND-1')

  assert.equal(hybRow.stock_source_mode, 'hybrid_unregistered')
  assert.equal(hybRow.stock_status, 'allocated_to_task')
  assert.equal(hybRow.stock_lot_no, null)

  // Reconcile the hybrid unit and confirm /tasks/pending reflects the upgraded RCV lot
  const reconcile = await apiReq(env, '/api/stock/import/commit', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      source_name: 'HybridReconcile.xlsx',
      rows: [{ serial_number: 'SN-PEND-NEW-HYB', brand: 'Zebra', model_name: 'DS9308', lot_no: 'LOT-HYB-RCV' }],
    },
  })
  assert.equal(reconcile.status, 200)
  assert.equal(reconcile.json.summary.reconcile_hybrid, 1)

  const adminPendingAfter = await apiReq(env, '/api/tasks/pending', { email: 'admin@sym.co.th' })
  const hybAfter = adminPendingAfter.json.tasks.find(t => t.id === startHyb.json.task_id)
  assert.equal(hybAfter.stock_source_mode, 'registered_stock')
  assert.equal(hybAfter.stock_status, 'allocated_to_task')
  assert.equal(hybAfter.stock_lot_no, 'LOT-HYB-RCV')
  assert.equal(hybAfter.stock_brand, 'Zebra')
  assert.equal(hybAfter.stock_model, 'DS9308')

  // Pass SYM verify and check customer_reviewer least-privilege stripping
  const verifyReg = await apiReq(env, '/api/review/sym-verify', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { task_id: startReg.json.task_id, decision: 'pass', version: regRow.version },
  })
  assert.equal(verifyReg.status, 200)

  const revPending = await apiReq(env, '/api/tasks/pending', { email: 'reviewer@gable.co.th' })
  assert.equal(revPending.status, 200)
  const revRow = revPending.json.tasks.find(t => t.id === startReg.json.task_id)
  assert.ok(revRow)
  for (const redactedKey of [
    'started_by',
    'closeout_submitted_by',
    'stock_source_mode',
    'stock_status',
    'stock_brand',
    'stock_model',
    'stock_lot_no',
    'stock_dispatch_area',
  ]) {
    assert.equal(redactedKey in revRow, false, `customer_reviewer must not receive ${redactedKey}`)
  }
})

test('HTTP runtime: malformed or non-object JSON and missing required fields return clean 400 errors (never 500)', async () => {
  const env = createTestEnv()

  // Seed one task so routes checking body validation first or task presence behave predictably
  const imp = await apiReq(env, '/api/register/import', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      source_name: 'JsonGuard.xlsx',
      rows: [{ location_code: 'BKK-JGD1', loc_bld: 'AIS Json Guard', com_sn: 'SN-JGD-001', province: 'กรุงเทพมหานคร' }],
    },
  })
  assert.equal(imp.status, 200)
  const list = await apiReq(env, '/api/scanners?search=SN-JGD-001', { email: 'admin@sym.co.th' })
  const scannerId = list.json.rows[0].id
  const start = await apiReq(env, '/api/tasks/start', { method: 'POST', email: 'tech1@sym.co.th', body: { scanner_id: scannerId } })
  const taskId = start.json.task_id

  const rawJsonReq = async (path, rawBody, email = 'admin@sym.co.th') => {
    const res = await app.fetch(new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-dev-user-email': email,
      },
      body: rawBody,
    }), env)
    return { status: res.status, text: await res.text() }
  }

  for (const [path, actor] of [
    ['/api/register/import', 'admin@sym.co.th'],
    ['/api/tasks/start', 'tech1@sym.co.th'],
    [`/api/tasks/${taskId}/evidence`, 'tech1@sym.co.th'],
    [`/api/tasks/${taskId}/closeout`, 'tech1@sym.co.th'],
    [`/api/tasks/${taskId}/action`, 'admin@sym.co.th'],
    ['/api/review/sym-verify', 'admin@sym.co.th'],
    ['/api/review/customer-batch-accept', 'reviewer@gable.co.th'],
    ['/api/review/customer-reject', 'reviewer@gable.co.th'],
    ['/api/discovery', 'tech1@sym.co.th'],
    ['/api/discovery/dsc-fake/review', 'admin@sym.co.th'],
    ['/api/allowlist', 'admin@sym.co.th'],
    ['/api/stock/doa/resolve', 'admin@sym.co.th'],
  ]) {
    for (const badBody of ['{broken-json', 'null', '[]']) {
      const res = await rawJsonReq(path, badBody, actor)
      assert.equal(res.status, 400, `Expected 400 on ${path} for body=${badBody}, got ${res.status}: ${res.text}`)
    }
  }

  // Missing version or missing task_id on /review/sym-verify previously crashed D1 with 500 D1_TYPE_ERROR
  const missingVersion = await apiReq(env, '/api/review/sym-verify', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { task_id: taskId, decision: 'pass' },
  })
  assert.equal(missingVersion.status, 400)

  const missingTaskId = await apiReq(env, '/api/review/sym-verify', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { decision: 'pass', version: 1 },
  })
  assert.equal(missingTaskId.status, 400)

  // Missing task_id on /review/customer-reject and invalid decision on /discovery/:id/review
  const rejectNoTask = await apiReq(env, '/api/review/customer-reject', {
    method: 'POST',
    email: 'reviewer@gable.co.th',
    body: { reason: 'รูปไม่ชัด' },
  })
  assert.equal(rejectNoTask.status, 400)

  const badDiscoveryDecision = await apiReq(env, '/api/discovery/dsc-fake/review', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { decision: 'maybe' },
  })
  assert.equal(badDiscoveryDecision.status, 400)
})

test('HTTP runtime: /export/raw-data includes stock & reverse logistics metadata for Admin and redacts it for customer_reviewer', async () => {
  const env = createTestEnv()
  await apiReq(env, '/api/register/import', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      source_name: 'ExportStock.xlsx',
      rows: [{ location_code: 'BKK-EXP1', loc_bld: 'AIS Export Shop', com_sn: 'SN-EXP-OLD-1', province: 'กรุงเทพมหานคร' }],
    },
  })
  await apiReq(env, '/api/stock/import/commit', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      defaults: { brand: 'Zebra', model_name: 'DS9308', lot_no: 'LOT-EXP-99', dispatch_area: 'ทีม กทม.', dispatch_mode: 'dispatched' },
      rows: [{ serial_number: 'SN-EXP-NEW-1' }],
    },
  })

  const list = await apiReq(env, '/api/scanners?search=SN-EXP-OLD-1', { email: 'admin@sym.co.th' })
  const scannerId = list.json.rows[0].id
  const start = await apiReq(env, '/api/tasks/start', { method: 'POST', email: 'tech1@sym.co.th', body: { scanner_id: scannerId } })
  const close = await apiReq(env, `/api/tasks/${start.json.task_id}/closeout`, {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: { outcome: 'replaced', new_serial_number: 'SN-EXP-NEW-1', new_model_name: 'DS9308', version: start.json.version },
  })
  assert.equal(close.status, 200)

  const adminExp = await apiReq(env, '/api/export/raw-data', { email: 'admin@sym.co.th' })
  assert.equal(adminExp.status, 200)
  const adminRow = adminExp.json.data.find(r => r.old_serial === 'SN-EXP-OLD-1')
  assert.ok(adminRow)
  assert.equal(adminRow.new_serial_number, 'SN-EXP-NEW-1')
  assert.equal(adminRow.new_model_name, 'DS9308')
  assert.equal(adminRow.stock_source_mode, 'registered_stock')
  assert.equal(adminRow.stock_status, 'allocated_to_task')
  assert.equal(adminRow.stock_lot_no, 'LOT-EXP-99')
  assert.equal(adminRow.stock_dispatch_area, 'ทีม กทม.')
  assert.equal(adminRow.old_return_status, 'removed_onsite')

  const revExp = await apiReq(env, '/api/export/raw-data', { email: 'reviewer@gable.co.th' })
  assert.equal(revExp.status, 200)
  const revRow = revExp.json.data.find(r => r.old_serial === 'SN-EXP-OLD-1')
  assert.ok(revRow)
  assert.equal(revRow.new_serial_number, 'SN-EXP-NEW-1')
  assert.equal(revRow.new_model_name, 'DS9308')
  for (const key of ['stock_source_mode', 'stock_status', 'stock_lot_no', 'stock_dispatch_area', 'old_return_status']) {
    assert.equal(key in revRow, false, `customer_reviewer /export/raw-data must not receive ${key}`)
  }
})
