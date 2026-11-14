import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { app } from '../functions/api/[[route]].ts'

const schemaSql = readFileSync(new URL('../d1/schema.sql', import.meta.url), 'utf-8')
const seedSql = readFileSync(new URL('../d1/seed.sql', import.meta.url), 'utf-8')
const migrationSql = readFileSync(new URL('../d1/migration-add-stock-scanner.sql', import.meta.url), 'utf-8')

function createMemoryD1(initialSql = `${schemaSql}\n${seedSql}`) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(initialSql)

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
          meta: { changes: 0 },
        }
      },
      async run() {
        const stmt = db.prepare(sql)
        const res = stmt.run(...cleanParams)
        return {
          success: true,
          meta: {
            changes: Number(res.changes || 0),
            last_row_id: Number(res.lastInsertRowid || 0),
          },
        }
      },
    }
  }

  let batchQueue = Promise.resolve()

  return {
    raw: db,
    prepare(sql) {
      return makeStatement(sql)
    },
    batch(stmts) {
      const execBatch = async () => {
        const results = []
        db.exec('BEGIN IMMEDIATE;')
        try {
          for (const stmt of stmts) {
            const prepared = db.prepare(stmt.sql)
            if (/^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(stmt.sql)) {
              const rows = prepared.all(...stmt.params)
              results.push({
                success: true,
                results: rows.map(row => ({ ...row })),
                meta: { changes: 0 },
              })
            } else {
              const res = prepared.run(...stmt.params)
              results.push({
                success: true,
                meta: {
                  changes: Number(res.changes || 0),
                  last_row_id: Number(res.lastInsertRowid || 0),
                },
              })
            }
          }
          db.exec('COMMIT;')
          return results
        } catch (err) {
          db.exec('ROLLBACK;')
          throw err
        }
      }
      const next = batchQueue.then(execBatch, execBatch)
      batchQueue = next.catch(() => {})
      return next
    },
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
      store.set(key, { bytes, httpMetadata: opts.httpMetadata || {}, httpEtag: `etag-${store.size + 1}` })
    },
    async get(key) {
      const entry = store.get(key)
      if (!entry) return null
      return {
        httpMetadata: entry.httpMetadata,
        httpEtag: entry.httpEtag,
        size: entry.bytes.byteLength,
        body: entry.bytes.slice(),
        writeHttpMetadata(headers) {
          if (entry.httpMetadata?.contentType) {
            headers.set('content-type', entry.httpMetadata.contentType)
          }
        },
        async arrayBuffer() {
          return entry.bytes.slice().buffer
        },
      }
    },
  }
}

function createTestEnv() {
  return {
    DB: createMemoryD1(),
    EVIDENCE_BUCKET: createMemoryR2(),
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

const samplePng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function seedBranchesAndScanners(env, count = 4) {
  const rows = []
  for (let i = 1; i <= count; i++) {
    rows.push({
      location_code: `BR-STK-${i}`,
      loc_bld: `AIS Stock Branch ${i}`,
      com_sn: `OLD-SN-00${i}`,
      brand: 'Honeywell',
      model_name: 'Voyager 1400g',
      province: 'กรุงเทพมหานคร',
    })
  }
  const res = await apiReq(env, '/api/register/import', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { source_name: 'StockTestBranches.xlsx', rows },
  })
  assert.equal(res.status, 200)
  const list = await apiReq(env, '/api/scanners?search=OLD-SN-00', { email: 'admin@sym.co.th' })
  assert.equal(list.status, 200)
  const bySn = new Map(list.json.rows.map(r => [r.com_sn, r]))
  return bySn
}

test('Stock schema and idempotent migration script backfill legacy tasks safely on repeated runs', () => {
  // Strip Stock tables from schema to simulate pre-Phase-1 production DB
  const coreOnlySchema = schemaSql.split('-- 11. เอกสารเคลื่อนไหวสต็อกเครื่องสแกนเนอร์')[0]
  const db = createMemoryD1(`${coreOnlySchema}\n${seedSql}`)

  db.raw.exec(`
    INSERT INTO branches (id, location_code, loc_bld, province) VALUES ('br-leg', 'LEG-01', 'AIS Legacy', 'เชียงใหม่');
    INSERT INTO scanner_assets (id, branch_id, brand, model_name, com_sn) VALUES
      ('sa-leg-1', 'br-leg', 'Zebra', 'LS2208', 'OLD-LEG-1'),
      ('sa-leg-2', 'br-leg', 'Zebra', 'LS2208', 'OLD-LEG-2');
    INSERT INTO branch_work_orders (id, branch_id, work_order_code, status) VALUES ('wo-leg', 'br-leg', 'WO-LEG', 'in_progress');
    INSERT INTO replacement_tasks (id, branch_work_order_id, scanner_asset_id, status, outcome, new_serial_number, new_model_name, closeout_submitted_by, customer_accepted_at)
    VALUES
      ('tsk-leg-1', 'wo-leg', 'sa-leg-1', 'delivered', 'replaced', 'NEW-LEG-1', 'DS9308', 'tech1@sym.co.th', datetime('now')),
      ('tsk-leg-2', 'wo-leg', 'sa-leg-2', 'in_progress', 'replaced', 'NEW-LEG-2', 'DS9308', 'tech1@sym.co.th', NULL);
  `)

  // Run migration twice to prove strict idempotency
  db.raw.exec(migrationSql)
  db.raw.exec(migrationSql)

  const new1 = db.raw.prepare('SELECT status, source_mode FROM stock_items WHERE serial_number = ?').get('NEW-LEG-1')
  const new2 = db.raw.prepare('SELECT status, source_mode FROM stock_items WHERE serial_number = ?').get('NEW-LEG-2')
  const old1 = db.raw.prepare('SELECT unit_type, status FROM stock_items WHERE serial_number = ?').get('OLD-LEG-1')
  const moveCount = db.raw.prepare('SELECT COUNT(*) as c FROM stock_movements').get()

  assert.equal(new1.status, 'installed')
  assert.equal(new1.source_mode, 'hybrid_unregistered')
  assert.equal(new2.status, 'allocated_to_task')
  assert.equal(old1.unit_type, 'old_removed')
  assert.equal(old1.status, 'removed_onsite')
  assert.equal(moveCount.c, 4)
})

test('Supplier import preview/commit validates duplicates, scientific notation, branch assets, and supports atomic commit', async () => {
  const env = createTestEnv()
  await seedBranchesAndScanners(env, 1)

  // Commit initial clean batch with batch defaults (single-column style supplier file)
  const okCommit = await apiReq(env, '/api/stock/import/commit', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      source_name: 'SupplierLot1.xlsx',
      defaults: { brand: 'Zebra', model_name: 'DS9308', lot_no: 'PO-2026-01' },
      rows: [
        { source_row: 2, serial_number: 'NEW-SUP-001' },
        { source_row: 3, serial_number: 'NEW-SUP-002' },
      ],
    },
  })
  assert.equal(okCommit.status, 200)
  assert.equal(okCommit.json.committed_count, 2)
  assert.match(okCommit.json.doc_code, /^RCV-\d{8}-/)

  // Preview mixed bad rows
  const preview = await apiReq(env, '/api/stock/import/preview', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      defaults: { brand: 'Zebra', model_name: 'DS9308', lot_no: 'PO-2026-02' },
      rows: [
        { source_row: 2, serial_number: 'NEW-SUP-003' },
        { source_row: 3, serial_number: 'NEW-SUP-003' }, // intra-file duplicate
        { source_row: 4, serial_number: '2.31455E+14' }, // Excel scientific notation
        { source_row: 5, serial_number: 'OLD-SN-001' }, // existing branch old asset
        { source_row: 6, serial_number: 'NEW-SUP-001' }, // already registered in stock
      ],
    },
  })
  assert.equal(preview.status, 200)
  assert.equal(preview.json.summary.create_new, 1)
  assert.equal(preview.json.summary.errors, 4)
  assert.match(preview.json.items[1].reason, /ซ้ำภายในไฟล์เดียวกับแถวที่ 2/)
  assert.match(preview.json.items[2].reason, /วิทยาศาสตร์/)
  assert.match(preview.json.items[3].reason, /เครื่องเก่าในทะเบียนสาขา/)
  assert.match(preview.json.items[4].reason, /มีอยู่ในสต็อกแล้ว/)

  // Commit without skip_invalid must fail 409 atomically and NOT insert NEW-SUP-003
  const blockedCommit = await apiReq(env, '/api/stock/import/commit', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      source_name: 'BadBatch.xlsx',
      rows: [
        { source_row: 2, serial_number: 'NEW-SUP-003' },
        { source_row: 3, serial_number: 'OLD-SN-001' },
      ],
    },
  })
  assert.equal(blockedCommit.status, 409)
  const check003 = env.DB.raw.prepare('SELECT * FROM stock_items WHERE serial_number = ?').get('NEW-SUP-003')
  assert.equal(check003, undefined)
})

test('Full lifecycle: Dispatch Model B -> Closeout -> Reject same SN -> G-Able Reject -> Swap & DOA -> Customer Accept installed', async () => {
  const env = createTestEnv()
  const scanners = await seedBranchesAndScanners(env, 2)
  const s1 = scanners.get('OLD-SN-001')
  const s2 = scanners.get('OLD-SN-002')

  // Receive 4 new units
  await apiReq(env, '/api/stock/import/commit', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      defaults: { brand: 'Zebra', model_name: 'DS9308', lot_no: 'PO-MAIN' },
      rows: [
        { source_row: 2, serial_number: 'NEW-B-001' },
        { source_row: 3, serial_number: 'NEW-B-002' },
        { source_row: 4, serial_number: 'NEW-B-003' },
        { source_row: 5, serial_number: 'NEW-B-004' },
      ],
    },
  })

  // Dispatch Model B (central pool tagged with area)
  const dsp = await apiReq(env, '/api/stock/dispatch', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      serial_numbers: ['NEW-B-001', 'NEW-B-002', 'NEW-B-003'],
      dispatch_area: 'ทีมภาคเหนือ',
      note: 'กระจายรอบแรก',
    },
  })
  assert.equal(dsp.status, 200)
  assert.equal(dsp.json.count, 3)

  // Start Tasks 1 & 2
  const t1 = await apiReq(env, '/api/tasks/start', { method: 'POST', email: 'tech1@sym.co.th', body: { scanner_id: s1.id } })
  const t2 = await apiReq(env, '/api/tasks/start', { method: 'POST', email: 'tech2@sym.co.th', body: { scanner_id: s2.id } })

  // Guard: Tech cannot enter old scanner's own SN as new_serial_number
  const selfOldErr = await apiReq(env, `/api/tasks/${t1.json.task_id}/closeout`, {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: { outcome: 'replaced', new_serial_number: 'OLD-SN-001', version: 1 },
  })
  assert.equal(selfOldErr.status, 400)

  // Tech 1 closes Task 1 using dispatched NEW-B-001
  const c1 = await apiReq(env, `/api/tasks/${t1.json.task_id}/closeout`, {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: { outcome: 'replaced', new_serial_number: 'NEW-B-001', new_model_name: 'DS9308', version: 1 },
  })
  assert.equal(c1.status, 200)
  assert.equal(c1.json.stock_source_mode, 'registered_stock')

  // Guard: Tech 2 cannot allocate NEW-B-001 or removed OLD-SN-001
  const doubleAlloc = await apiReq(env, `/api/tasks/${t2.json.task_id}/closeout`, {
    method: 'POST',
    email: 'tech2@sym.co.th',
    body: { outcome: 'replaced', new_serial_number: 'NEW-B-001', version: 1 },
  })
  assert.equal(doubleAlloc.status, 409)

  const oldUnitReuse = await apiReq(env, `/api/tasks/${t2.json.task_id}/closeout`, {
    method: 'POST',
    email: 'tech2@sym.co.th',
    body: { outcome: 'replaced', new_serial_number: 'OLD-SN-001', version: 1 },
  })
  assert.equal(oldUnitReuse.status, 409)

  // SYM Admin rejects Task 1 (e.g. blurry photo) -> NEW-B-001 stays allocated_to_task
  const symRej = await apiReq(env, '/api/review/sym-verify', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { task_id: t1.json.task_id, decision: 'reject', reason: 'ภาพ Serial ไม่ชัด', version: 2 },
  })
  assert.equal(symRej.status, 200)
  const b1AfterRej = env.DB.raw.prepare('SELECT status, linked_task_id FROM stock_items WHERE serial_number = ?').get('NEW-B-001')
  assert.equal(b1AfterRej.status, 'allocated_to_task')
  assert.equal(b1AfterRej.linked_task_id, t1.json.task_id)

  // Lookup confirms Tech 1 can resubmit SAME SN for Task 1, while others cannot
  const lookupSame = await apiReq(env, `/api/stock/lookup?serial=NEW-B-001&task_id=${t1.json.task_id}`, { email: 'tech1@sym.co.th' })
  assert.equal(lookupSame.json.availability.available_for_closeout, true)
  assert.equal(lookupSame.json.availability.code, 'ALREADY_ALLOCATED_THIS_TASK')

  // Tech 1 resubmits with SAME NEW-B-001 -> SYM Passes -> stays allocated_to_task until G-Able signs
  const c1Resub = await apiReq(env, `/api/tasks/${t1.json.task_id}/closeout`, {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: { outcome: 'replaced', new_serial_number: 'NEW-B-001', version: 3 },
  })
  assert.equal(c1Resub.status, 200)
  const symPass1 = await apiReq(env, '/api/review/sym-verify', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { task_id: t1.json.task_id, decision: 'pass', version: 4 },
  })
  assert.equal(symPass1.status, 200)
  assert.equal(
    env.DB.raw.prepare('SELECT status FROM stock_items WHERE serial_number = ?').get('NEW-B-001').status,
    'allocated_to_task'
  )

  // G-Able Customer Rejects Task 1 -> NEW-B-001 fails onsite QC -> Tech swaps to NEW-B-002 with previous_sn_disposition = 'doa'
  const gableRej = await apiReq(env, '/api/review/customer-reject', {
    method: 'POST',
    email: 'reviewer@gable.co.th',
    body: { task_id: t1.json.task_id, reason: 'เครื่องสแกนไม่ติดตอนเทสหน้าร้าน' },
  })
  assert.equal(gableRej.status, 200)

  const c1SwapDoa = await apiReq(env, `/api/tasks/${t1.json.task_id}/closeout`, {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: {
      outcome: 'replaced',
      new_serial_number: 'NEW-B-002',
      previous_sn_disposition: 'doa',
      version: 6,
    },
  })
  assert.equal(c1SwapDoa.status, 200)

  // NEW-B-001 is now doa_defective & unlinked; NEW-B-002 is allocated_to_task
  const b1Doa = env.DB.raw.prepare('SELECT status, linked_task_id FROM stock_items WHERE serial_number = ?').get('NEW-B-001')
  const b2Alloc = env.DB.raw.prepare('SELECT status, linked_task_id FROM stock_items WHERE serial_number = ?').get('NEW-B-002')
  assert.equal(b1Doa.status, 'doa_defective')
  assert.equal(b1Doa.linked_task_id, null)
  assert.equal(b2Alloc.status, 'allocated_to_task')
  assert.equal(b2Alloc.linked_task_id, t1.json.task_id)

  // Task 2: Tech 2 closes with dispatched NEW-B-003, SYM rejects typo, Tech 2 swaps cleanly to in_warehouse NEW-B-004 -> NEW-B-003 restores to 'dispatched' (pre_task_status)!
  await apiReq(env, `/api/tasks/${t2.json.task_id}/closeout`, {
    method: 'POST',
    email: 'tech2@sym.co.th',
    body: { outcome: 'replaced', new_serial_number: 'NEW-B-003', version: 1 },
  })
  await apiReq(env, '/api/review/sym-verify', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { task_id: t2.json.task_id, decision: 'reject', reason: 'SN ผิดกล่อง', version: 2 },
  })
  const c2SwapRelease = await apiReq(env, `/api/tasks/${t2.json.task_id}/closeout`, {
    method: 'POST',
    email: 'tech2@sym.co.th',
    body: { outcome: 'replaced', new_serial_number: 'NEW-B-004', previous_sn_disposition: 'release', version: 3 },
  })
  assert.equal(c2SwapRelease.status, 200)
  const b3Restored = env.DB.raw.prepare('SELECT status, dispatch_area, linked_task_id FROM stock_items WHERE serial_number = ?').get('NEW-B-003')
  assert.equal(b3Restored.status, 'dispatched')
  assert.equal(b3Restored.dispatch_area, 'ทีมภาคเหนือ')
  assert.equal(b3Restored.linked_task_id, null)

  // Both pass SYM & G-Able Batch Accept -> allocated_to_task becomes 'installed'
  await apiReq(env, '/api/review/sym-verify', { method: 'POST', email: 'admin@sym.co.th', body: { task_id: t1.json.task_id, decision: 'pass', version: 7 } })
  await apiReq(env, '/api/review/sym-verify', { method: 'POST', email: 'admin@sym.co.th', body: { task_id: t2.json.task_id, decision: 'pass', version: 4 } })

  const accept1 = await apiReq(env, '/api/review/customer-batch-accept', {
    method: 'POST',
    email: 'reviewer@gable.co.th',
    body: { branch_id: s1.branch_id, task_ids: [t1.json.task_id], signature_base64: samplePng },
  })
  assert.equal(accept1.status, 200)
  const accept2 = await apiReq(env, '/api/review/customer-batch-accept', {
    method: 'POST',
    email: 'reviewer@gable.co.th',
    body: { branch_id: s2.branch_id, task_ids: [t2.json.task_id], signature_base64: samplePng },
  })
  assert.equal(accept2.status, 200)

  assert.equal(env.DB.raw.prepare('SELECT status FROM stock_items WHERE serial_number = ?').get('NEW-B-002').status, 'installed')
  assert.equal(env.DB.raw.prepare('SELECT status FROM stock_items WHERE serial_number = ?').get('NEW-B-004').status, 'installed')
})

test('Hybrid Mode prevents Ghost Stock on swap/cancel and cleanly reconciles with subsequent Supplier Excel import', async () => {
  const env = createTestEnv()
  const scanners = await seedBranchesAndScanners(env, 2)
  const s1 = scanners.get('OLD-SN-001')
  const s2 = scanners.get('OLD-SN-002')

  // Task 1: Tech submits Hybrid SN typo -> gets rejected -> swaps to real Hybrid SN -> typo becomes void_hybrid (NO Ghost Stock!)
  const t1 = await apiReq(env, '/api/tasks/start', { method: 'POST', email: 'tech1@sym.co.th', body: { scanner_id: s1.id } })
  const c1 = await apiReq(env, `/api/tasks/${t1.json.task_id}/closeout`, {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: { outcome: 'replaced', new_serial_number: 'HYB-TYPO-01', version: 1 },
  })
  assert.equal(c1.status, 200)
  assert.equal(c1.json.stock_source_mode, 'hybrid_unregistered')

  await apiReq(env, '/api/review/sym-verify', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { task_id: t1.json.task_id, decision: 'reject', reason: 'คีย์ SN ตกหล่น', version: 2 },
  })
  await apiReq(env, `/api/tasks/${t1.json.task_id}/closeout`, {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: { outcome: 'replaced', new_serial_number: 'HYB-REAL-01', version: 3 },
  })

  const typoState = env.DB.raw.prepare('SELECT status, linked_task_id FROM stock_items WHERE serial_number = ?').get('HYB-TYPO-01')
  assert.equal(typoState.status, 'void_hybrid')
  assert.equal(typoState.linked_task_id, null)

  // Task 2: Tech submits Hybrid SN -> Admin Cancels Task -> new unit void_hybrid & old unit cancelled_restored
  const t2 = await apiReq(env, '/api/tasks/start', { method: 'POST', email: 'tech2@sym.co.th', body: { scanner_id: s2.id } })
  await apiReq(env, `/api/tasks/${t2.json.task_id}/closeout`, {
    method: 'POST',
    email: 'tech2@sym.co.th',
    body: { outcome: 'replaced', new_serial_number: 'HYB-CANCEL-02', version: 1 },
  })
  const cancelRes = await apiReq(env, `/api/tasks/${t2.json.task_id}/action`, {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { action: 'cancel', reason: 'สาขายกเลิกแผนเปลี่ยน' },
  })
  assert.equal(cancelRes.status, 200)
  assert.equal(env.DB.raw.prepare('SELECT status FROM stock_items WHERE serial_number = ?').get('HYB-CANCEL-02').status, 'void_hybrid')
  assert.equal(env.DB.raw.prepare('SELECT status FROM stock_items WHERE serial_number = ?').get('OLD-SN-002').status, 'cancelled_restored')

  // Later Supplier Excel arrives containing HYB-REAL-01 + HYB-TYPO-01 + fresh SN -> Reconcile upgrades HYB-REAL-01 without breaking task allocation!
  const recPreview = await apiReq(env, '/api/stock/import/preview', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      defaults: { brand: 'Honeywell', model_name: 'HF680', lot_no: 'PO-LATE-01' },
      rows: [
        { source_row: 2, serial_number: 'HYB-REAL-01' },
        { source_row: 3, serial_number: 'SUP-FRESH-01' },
      ],
    },
  })
  assert.equal(recPreview.status, 200)
  assert.equal(recPreview.json.summary.reconcile_hybrid, 1)
  assert.equal(recPreview.json.summary.create_new, 1)

  const recCommit = await apiReq(env, '/api/stock/import/commit', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      defaults: { brand: 'Honeywell', model_name: 'HF680', lot_no: 'PO-LATE-01' },
      rows: [
        { source_row: 2, serial_number: 'HYB-REAL-01' },
        { source_row: 3, serial_number: 'SUP-FRESH-01' },
      ],
    },
  })
  assert.equal(recCommit.status, 200)

  const reconciled = env.DB.raw.prepare('SELECT status, source_mode, lot_no, linked_task_id FROM stock_items WHERE serial_number = ?').get('HYB-REAL-01')
  assert.equal(reconciled.status, 'allocated_to_task')
  assert.equal(reconciled.source_mode, 'registered_stock')
  assert.equal(reconciled.lot_no, 'PO-LATE-01')
  assert.equal(reconciled.linked_task_id, t1.json.task_id)

  // Summary excludes void_hybrid and shows exact real warehouse availability
  const sum = await apiReq(env, '/api/stock/summary', { email: 'admin@sym.co.th' })
  assert.equal(sum.status, 200)
  assert.equal(sum.json.new_units.in_warehouse, 1)
  assert.equal(sum.json.new_units.allocated_to_task, 1)
  assert.equal(sum.json.new_units.hybrid_unregistered, 0)
  assert.equal(sum.json.old_removed.removed_onsite, 1)
})

test('Reverse Logistics enforces Receive -> Handover lifecycle, protects returned scrap from silent cancel, and supports Recall/DOA', async () => {
  const env = createTestEnv()
  const scanners = await seedBranchesAndScanners(env, 1)
  const s1 = scanners.get('OLD-SN-001')

  // Import & dispatch, then recall one unit and mark another DOA
  await apiReq(env, '/api/stock/import/commit', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      defaults: { brand: 'Zebra', model_name: 'DS9308', lot_no: 'PO-REV', dispatch_area: 'กทม.', dispatch_mode: 'dispatched' },
      rows: [
        { source_row: 2, serial_number: 'NEW-REV-01' },
        { source_row: 3, serial_number: 'NEW-REV-02' },
        { source_row: 4, serial_number: 'NEW-REV-03' },
      ],
    },
  })

  const recallRes = await apiReq(env, '/api/stock/recall', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { serial_numbers: ['NEW-REV-02'], note: 'ทีมส่งคืนเครื่องสำรอง' },
  })
  assert.equal(recallRes.status, 200)
  assert.equal(env.DB.raw.prepare('SELECT status, dispatch_area FROM stock_items WHERE serial_number = ?').get('NEW-REV-02').status, 'in_warehouse')

  const doaRes = await apiReq(env, '/api/stock/doa', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { serial_numbers: ['NEW-REV-03'], note: 'เลนส์แตกตอน QC คลัง' },
  })
  assert.equal(doaRes.status, 200)
  assert.equal(env.DB.raw.prepare('SELECT status FROM stock_items WHERE serial_number = ?').get('NEW-REV-03').status, 'doa_defective')

  // Tech installs NEW-REV-01 & replaces OLD-SN-001
  const t1 = await apiReq(env, '/api/tasks/start', { method: 'POST', email: 'tech1@sym.co.th', body: { scanner_id: s1.id } })
  await apiReq(env, `/api/tasks/${t1.json.task_id}/closeout`, {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: { outcome: 'replaced', new_serial_number: 'NEW-REV-01', version: 1 },
  })

  // Handover before warehouse receipt must fail 409
  const badHandover = await apiReq(env, '/api/stock/old-returns/handover', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { serial_numbers: ['OLD-SN-001'], recipient_name: 'คุณสมชาย G-Able' },
  })
  assert.equal(badHandover.status, 409)

  // Warehouse receives OLD-SN-001 -> returned_to_warehouse
  const retRes = await apiReq(env, '/api/stock/old-returns/receive', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { serial_numbers: ['OLD-SN-001'], note: 'สภาพครบมีสาย USB' },
  })
  assert.equal(retRes.status, 200)
  assert.match(retRes.json.doc_code, /^RET-\d{8}-/)

  // Guardrail: Admin cannot silently cancel a task whose old hardware was already returned to warehouse
  const blockedCancel = await apiReq(env, `/api/tasks/${t1.json.task_id}/action`, {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { action: 'cancel', reason: 'ทดลองยกเลิกหลังรับซากแล้ว' },
  })
  assert.equal(blockedCancel.status, 409)

  // Handover OLD-SN-001 to G-Able/AIS -> handed_over_to_customer
  const hovRes = await apiReq(env, '/api/stock/old-returns/handover', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { serial_numbers: ['OLD-SN-001'], recipient_name: 'คุณวิชัย (AIS Asset)', note: 'ส่งมอบครบถ้วน' },
  })
  assert.equal(hovRes.status, 200)
  assert.match(hovRes.json.doc_code, /^HOV-\d{8}-/)
  assert.equal(env.DB.raw.prepare('SELECT status FROM stock_items WHERE serial_number = ?').get('OLD-SN-001').status, 'handed_over_to_customer')
})

test('Stock RBAC enforces least privilege and masks sensitive serial numbers for viewer role', async () => {
  const env = createTestEnv()
  await apiReq(env, '/api/stock/import/commit', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      defaults: { brand: 'Zebra', model_name: 'DS9308', lot_no: 'PO-SEC-01' },
      rows: [{ source_row: 2, serial_number: 'SECRET-SN-998877' }],
    },
  })

  // Viewer sees summary counts cleanly
  const viewerSum = await apiReq(env, '/api/stock/summary', { email: 'viewer@ais.co.th' })
  assert.equal(viewerSum.status, 200)
  assert.equal(viewerSum.json.new_units.in_warehouse, 1)

  // Viewer gets masked serial numbers and no raw lot/internal emails
  const viewerItems = await apiReq(env, '/api/stock/items', { email: 'viewer@ais.co.th' })
  assert.equal(viewerItems.status, 200)
  assert.equal(viewerItems.json.rows[0].serial_number, 'SE***8877')
  assert.equal(viewerItems.json.rows[0].created_by, undefined)
  assert.equal(viewerItems.json.rows[0].lot_no, undefined)

  // Viewer blocked from exact serial lookup, documents, and all mutations
  assert.equal((await apiReq(env, '/api/stock/lookup?serial=SECRET-SN-998877', { email: 'viewer@ais.co.th' })).status, 403)
  assert.equal((await apiReq(env, '/api/stock/documents', { email: 'viewer@ais.co.th' })).status, 403)

  // Technician can lookup SN availability & list available items, but cannot mutate warehouse stock or read admin documents
  const techLookup = await apiReq(env, '/api/stock/lookup?serial=SECRET-SN-998877', { email: 'tech1@sym.co.th' })
  assert.equal(techLookup.status, 200)
  assert.equal(techLookup.json.availability.available_for_closeout, true)
  assert.equal((await apiReq(env, '/api/stock/documents', { email: 'tech1@sym.co.th' })).status, 403)

  for (const endpoint of ['/import/preview', '/import/commit', '/dispatch', '/recall', '/doa', '/doa/resolve', '/old-returns/receive', '/old-returns/handover']) {
    for (const actor of ['tech1@sym.co.th', 'reviewer@gable.co.th', 'viewer@ais.co.th']) {
      const res = await apiReq(env, `/api/stock${endpoint}`, { method: 'POST', email: actor, body: {} })
      assert.equal(res.status, 403, `Expected 403 for ${actor} on POST /api/stock${endpoint}`)
    }
  }

  // Customer reviewer sees items cleanly without internal SYM operator emails
  const gableItems = await apiReq(env, '/api/stock/items', { email: 'reviewer@gable.co.th' })
  assert.equal(gableItems.status, 200)
  assert.equal(gableItems.json.rows[0].serial_number, 'SECRET-SN-998877')
  assert.equal(gableItems.json.rows[0].created_by, undefined)
})

test('Stock DOA -> ADJ resolve restores defective unit into warehouse inventory and allows re-dispatch', async () => {
  const env = createTestEnv()
  await apiReq(env, '/api/stock/import/commit', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      defaults: { brand: 'Zebra', model_name: 'DS9308', lot_no: 'PO-DOA-1', dispatch_area: 'ทีมกทม.', dispatch_mode: 'dispatched' },
      rows: [{ source_row: 2, serial_number: 'SN-DOA-RES-001' }],
    },
  })

  // Mark unit DOA -> doa_defective + DOA-... document
  const doaRes = await apiReq(env, '/api/stock/doa', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { serial_numbers: ['SN-DOA-RES-001'], note: 'เปิดเครื่องไม่ติดตั้งแต่แกะกล่อง' },
  })
  assert.equal(doaRes.status, 200)
  assert.match(doaRes.json.doc_code, /^DOA-\d{8}-/)
  assert.equal(env.DB.raw.prepare('SELECT status FROM stock_items WHERE serial_number = ?').get('SN-DOA-RES-001').status, 'doa_defective')

  // Guardrail: DOA unit cannot be dispatched directly without resolving first
  const blockedDispatch = await apiReq(env, '/api/stock/dispatch', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { serial_numbers: ['SN-DOA-RES-001'], dispatch_area: 'ทีมภาคเหนือ' },
  })
  assert.equal(blockedDispatch.status, 409)

  // Resolve DOA -> ADJ-... adjustment document + restored to in_warehouse (cleared stale dispatch metadata)
  const resolveRes = await apiReq(env, '/api/stock/doa/resolve', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { serial_numbers: ['SN-DOA-RES-001'], note: 'รับเครื่องซ่อมเคลมกลับเข้าคลังกลาง' },
  })
  assert.equal(resolveRes.status, 200)
  assert.match(resolveRes.json.doc_code, /^ADJ-\d{8}-/)
  assert.equal(resolveRes.json.count, 1)

  const itemAfter = env.DB.raw.prepare('SELECT status, dispatch_area, dispatch_doc_id FROM stock_items WHERE serial_number = ?').get('SN-DOA-RES-001')
  assert.equal(itemAfter.status, 'in_warehouse')
  assert.equal(itemAfter.dispatch_area, null)
  assert.equal(itemAfter.dispatch_doc_id, null)

  const adjDoc = env.DB.raw.prepare('SELECT doc_type, destination_area FROM stock_documents WHERE doc_code = ?').get(resolveRes.json.doc_code)
  assert.equal(adjDoc.doc_type, 'adjustment')
  assert.equal(adjDoc.destination_area, 'คลังกลาง SYM')

  const latestMove = env.DB.raw.prepare('SELECT action, from_status, to_status FROM stock_movements ORDER BY rowid DESC LIMIT 1').get()
  assert.equal(latestMove.action, 'adjusted')
  assert.equal(latestMove.from_status, 'doa_defective')
  assert.equal(latestMove.to_status, 'in_warehouse')

  // Re-dispatch now succeeds cleanly
  const reDispatch = await apiReq(env, '/api/stock/dispatch', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: { serial_numbers: ['SN-DOA-RES-001'], dispatch_area: 'ทีมภาคเหนือ' },
  })
  assert.equal(reDispatch.status, 200)
})

test('Concurrency TOCTOU guards: simultaneous stock batch actions never emit phantom docs/movements and closeout vs dispatch stays atomic', async () => {
  const env = createTestEnv()
  const scanners = await seedBranchesAndScanners(env, 2)

  await apiReq(env, '/api/stock/import/commit', {
    method: 'POST',
    email: 'admin@sym.co.th',
    body: {
      defaults: { brand: 'Zebra', model_name: 'DS9308', lot_no: 'PO-CONC', dispatch_mode: 'in_warehouse' },
      rows: [
        { source_row: 2, serial_number: 'SN-CONC-1' },
        { source_row: 3, serial_number: 'SN-CONC-2' },
      ],
    },
  })

  // 1. Concurrent /stock/dispatch on the same SN: exactly one 200 and one 409, zero phantom docs or duplicate movements
  const [d1, d2] = await Promise.all([
    apiReq(env, '/api/stock/dispatch', {
      method: 'POST',
      email: 'admin@sym.co.th',
      body: { serial_numbers: ['SN-CONC-1'], dispatch_area: 'ทีม A' },
    }),
    apiReq(env, '/api/stock/dispatch', {
      method: 'POST',
      email: 'admin@sym.co.th',
      body: { serial_numbers: ['SN-CONC-1'], dispatch_area: 'ทีม B' },
    }),
  ])
  assert.deepEqual([d1.status, d2.status].sort((a, b) => a - b), [200, 409])
  assert.equal(
    env.DB.raw.prepare("SELECT COUNT(*) as c FROM stock_documents WHERE doc_type = 'dispatch'").get().c,
    1
  )
  assert.equal(
    env.DB.raw.prepare("SELECT COUNT(*) as c FROM stock_movements WHERE action = 'dispatched'").get().c,
    1
  )

  // Concurrent /stock/recall on the same dispatched SN
  const [r1, r2] = await Promise.all([
    apiReq(env, '/api/stock/recall', {
      method: 'POST',
      email: 'admin@sym.co.th',
      body: { serial_numbers: ['SN-CONC-1'], note: 'recall 1' },
    }),
    apiReq(env, '/api/stock/recall', {
      method: 'POST',
      email: 'admin@sym.co.th',
      body: { serial_numbers: ['SN-CONC-1'], note: 'recall 2' },
    }),
  ])
  assert.deepEqual([r1.status, r2.status].sort((a, b) => a - b), [200, 409])
  assert.equal(
    env.DB.raw.prepare("SELECT COUNT(*) as c FROM stock_documents WHERE doc_type = 'adjustment'").get().c,
    1
  )

  // Concurrent /stock/doa + /stock/doa/resolve
  const [doa1, doa2] = await Promise.all([
    apiReq(env, '/api/stock/doa', {
      method: 'POST',
      email: 'admin@sym.co.th',
      body: { serial_numbers: ['SN-CONC-1'], note: 'faulty 1' },
    }),
    apiReq(env, '/api/stock/doa', {
      method: 'POST',
      email: 'admin@sym.co.th',
      body: { serial_numbers: ['SN-CONC-1'], note: 'faulty 2' },
    }),
  ])
  assert.deepEqual([doa1.status, doa2.status].sort((a, b) => a - b), [200, 409])
  assert.equal(
    env.DB.raw.prepare("SELECT COUNT(*) as c FROM stock_documents WHERE doc_type = 'doa_claim'").get().c,
    1
  )

  // 2. Race closeout on SN-CONC-2 vs concurrent /stock/dispatch on SN-CONC-2
  const started = await apiReq(env, '/api/tasks/start', {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: { scanner_id: scanners.get('OLD-SN-001').id },
  })
  const taskId = started.json.task_id

  // Deterministic TOCTOU test: inject a concurrent /stock/dispatch right before closeout executes DB.batch
  let intercepted = false
  const origBatch = env.DB.batch.bind(env.DB)
  const interceptEnv = {
    ...env,
    DB: {
      ...env.DB,
      batch(stmts) {
        if (!intercepted && stmts.some(s => String(s.sql).includes('UPDATE replacement_tasks SET'))) {
          intercepted = true
          // Simulate concurrent /stock/dispatch committed between prepareCloseoutStockPlan and DB.batch
          return origBatch([
            env.DB.prepare(
              "UPDATE stock_items SET status = 'dispatched', version = version + 1 WHERE serial_number = 'SN-CONC-2' AND version = 1"
            ),
          ]).then(() => origBatch(stmts))
        }
        return origBatch(stmts)
      },
    },
  }

  const tornCloseRes = await apiReq(interceptEnv, `/api/tasks/${taskId}/closeout`, {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: { outcome: 'replaced', new_serial_number: 'SN-CONC-2', new_model_name: 'DS9308', version: 1 },
  })
  assert.equal(tornCloseRes.status, 409)
  const taskAfterRace = env.DB.raw.prepare('SELECT status, new_serial_number FROM replacement_tasks WHERE id = ?').get(taskId)
  const stockAfterRace = env.DB.raw.prepare('SELECT status, linked_task_id, version FROM stock_items WHERE serial_number = ?').get('SN-CONC-2')
  assert.equal(taskAfterRace.status, 'in_progress')
  assert.equal(taskAfterRace.new_serial_number, null)
  assert.equal(stockAfterRace.status, 'dispatched')
  assert.equal(stockAfterRace.linked_task_id, null)
  assert.equal(stockAfterRace.version, 2)

  // Now complete legitimate closeout -> SYM pass -> G-Able accept, then test concurrent /old-returns/receive + /handover
  const okClose = await apiReq(env, `/api/tasks/${taskId}/closeout`, {
    method: 'POST',
    email: 'tech1@sym.co.th',
    body: { outcome: 'replaced', new_serial_number: 'SN-CONC-2', new_model_name: 'DS9308', version: 1 },
  })
  assert.equal(okClose.status, 200)

  const [ret1, ret2] = await Promise.all([
    apiReq(env, '/api/stock/old-returns/receive', {
      method: 'POST',
      email: 'admin@sym.co.th',
      body: { serial_numbers: ['OLD-SN-001'], note: 'ret 1' },
    }),
    apiReq(env, '/api/stock/old-returns/receive', {
      method: 'POST',
      email: 'admin@sym.co.th',
      body: { serial_numbers: ['OLD-SN-001'], note: 'ret 2' },
    }),
  ])
  assert.deepEqual([ret1.status, ret2.status].sort((a, b) => a - b), [200, 409])
  assert.equal(
    env.DB.raw.prepare("SELECT COUNT(*) as c FROM stock_documents WHERE doc_type = 'return_in'").get().c,
    1
  )

  const [hov1, hov2] = await Promise.all([
    apiReq(env, '/api/stock/old-returns/handover', {
      method: 'POST',
      email: 'admin@sym.co.th',
      body: { serial_numbers: ['OLD-SN-001'], recipient_name: 'AIS Rep A' },
    }),
    apiReq(env, '/api/stock/old-returns/handover', {
      method: 'POST',
      email: 'admin@sym.co.th',
      body: { serial_numbers: ['OLD-SN-001'], recipient_name: 'AIS Rep B' },
    }),
  ])
  assert.deepEqual([hov1.status, hov2.status].sort((a, b) => a - b), [200, 409])
  assert.equal(
    env.DB.raw.prepare("SELECT COUNT(*) as c FROM stock_documents WHERE doc_type = 'handover_out'").get().c,
    1
  )
})
