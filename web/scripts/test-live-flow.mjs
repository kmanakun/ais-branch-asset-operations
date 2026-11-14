// Full End-to-End Integration Test for Cloudflare Pages + D1 Edge
// Safe by default: targets local `wrangler pages dev` (http://127.0.0.1:8788).
// To run against live deployment, explicitly pass `--live --confirm-live` (or E2E_BASE_URL + E2E_ALLOW_LIVE=1).

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const LIVE_URL = 'https://ais-branch-asset-operations.pages.dev'
const DEFAULT_LOCAL_URL = 'http://127.0.0.1:8788'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

function resolveOptions(argv) {
  const urlArg = argv.find(arg => arg.startsWith('--url='))?.slice(6)
  const useLive = argv.includes('--live')
  const confirmLive = argv.includes('--confirm-live') || process.env.E2E_ALLOW_LIVE === '1'
  const cleanupLocal = argv.includes('--cleanup') || process.env.E2E_CLEANUP === '1'

  const baseUrl = (urlArg || process.env.E2E_BASE_URL || (useLive ? LIVE_URL : DEFAULT_LOCAL_URL)).replace(/\/+$/, '')
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(baseUrl)

  if (!isLocal && !confirmLive) {
    console.error(`❌ ปฏิเสธการยิง E2E ที่สร้างข้อมูลทดสอบใส่ปลายทางที่ไม่ใช่ localhost: ${baseUrl}`)
    console.error('   • ทดสอบในเครื่อง: เปิด "npx wrangler pages dev dist --ip 127.0.0.1 --port 8788" แล้วรัน "npm run test:e2e"')
    console.error('   • ทดสอบในเครื่องพร้อมลบข้อมูลทดสอบอัตโนมัติ: "node scripts/test-live-flow.mjs --cleanup"')
    console.error('   • หากจำเป็นต้องทดสอบบน Live จริง: เพิ่ม "--live --confirm-live" (หรือ E2E_ALLOW_LIVE=1) และล้างข้อมูลด้วย "node scripts/cleanup-e2e.mjs --remote --execute --confirm-production-delete" หลังจบ')
    process.exit(1)
  }

  return { baseUrl, isLocal, cleanupLocal }
}

const { baseUrl: BASE_URL, isLocal, cleanupLocal } = resolveOptions(process.argv.slice(2))

async function reqRaw(path, method = 'GET', body = null, email = 'admin@sym.co.th') {
  const options = {
    method,
    headers: {
      'x-dev-user-email': email,
      'Content-Type': 'application/json'
    }
  }
  if (body) options.body = JSON.stringify(body)
  const res = await fetch(`${BASE_URL}${path}`, options)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, headers: res.headers, text, json }
}

async function req(path, method = 'GET', body = null, email = 'admin@sym.co.th') {
  const { status, json } = await reqRaw(path, method, body, email)
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status} on ${method} ${path}: ${json?.error || JSON.stringify(json)}`)
  }
  return json
}

async function main() {
  console.log('🚀 Starting Full Edge Verification on', BASE_URL)
  const timestamp = Date.now()
  const testSn = `SN-E2E-${timestamp}`
  const newSn = `SN-STOCK-E2E-${timestamp}`
  const doaSn = `SN-STOCK-E2E-DOA-${timestamp}`
  const stockLot = `LOT-E2E-${timestamp}`
  const branchCode = `BKK-${timestamp.toString().slice(-4)}`

  // 1. นำเข้าข้อมูล Master Register
  console.log('\n[1/14] Testing /api/register/import...')
  const importResult = await req('/api/register/import', 'POST', {
    source_name: `E2E_Test_${timestamp}.xlsx`,
    rows: [
      {
        location_code: branchCode,
        loc_bld: `AIS Shop E2E ${timestamp}`,
        com_sn: testSn,
        brand: 'Honeywell',
        model_name: '1900GSR',
        province: 'กรุงเทพมหานคร',
        district: 'ปทุมวัน',
        phone: '02-9999999',
        install_type: 'Counter',
        address_note: 'Test branch for E2E verification'
      }
    ]
  }, 'admin@sym.co.th')
  console.log('  ✔ Import successful:', importResult.message)

  // 2. ตรวจสอบทะเบียนอุปกรณ์ & รับเข้าสต็อกเครื่องใหม่
  console.log('\n[2/14] Testing /api/scanners search & /api/stock/import/commit...')
  const scanners = await req(`/api/scanners?search=${testSn}`, 'GET', null, 'admin@sym.co.th')
  if (!scanners.rows?.length) throw new Error('Scanner not found after import')
  const scanner = scanners.rows[0]
  console.log('  ✔ Scanner found:', scanner.com_sn, 'ID:', scanner.id, 'Branch ID:', scanner.branch_id)

  const stockCommit = await req('/api/stock/import/commit', 'POST', {
    source_name: `E2E_Test_Stock_${timestamp}.xlsx`,
    rows: [
      {
        serial_number: newSn,
        brand: 'Honeywell',
        model_name: '1950GHD',
        lot_no: stockLot,
        note: `E2E_Test_Stock_${timestamp}`,
      },
      {
        serial_number: doaSn,
        brand: 'Honeywell',
        model_name: '1950GHD',
        lot_no: stockLot,
        note: `E2E_Test_Stock_${timestamp}`,
      },
    ],
  }, 'admin@sym.co.th')
  console.log('  ✔ Stock receive document created:', stockCommit.doc_code)

  const preLookup = await req(`/api/stock/lookup?serial=${encodeURIComponent(newSn)}`, 'GET', null, 'tech1@sym.co.th')
  if (!preLookup.availability?.available_for_closeout || preLookup.item?.status !== 'in_warehouse') {
    throw new Error(`Expected new stock unit in_warehouse & available, got ${JSON.stringify(preLookup.availability)}`)
  }
  console.log('  ✔ Stock real-time lookup available_for_closeout=true, status=in_warehouse')

  // ทดสอบ DOA -> DOA Resolve (ADJ) Lifecycle บน Miniflare D1 จริง
  const doaMark = await req('/api/stock/doa', 'POST', {
    serial_numbers: [doaSn],
    note: `E2E_Test_DOA_${timestamp}`,
  }, 'admin@sym.co.th')
  if (!String(doaMark.doc_code || '').startsWith('DOA-')) {
    throw new Error(`Expected DOA document code, got ${doaMark.doc_code}`)
  }
  const doaLookup = await req(`/api/stock/lookup?serial=${encodeURIComponent(doaSn)}`, 'GET', null, 'tech1@sym.co.th')
  if (doaLookup.item?.status !== 'doa_defective' || doaLookup.availability?.available_for_closeout !== false) {
    throw new Error(`Expected DOA unit blocked from closeout, got ${JSON.stringify(doaLookup)}`)
  }
  const doaResolve = await req('/api/stock/doa/resolve', 'POST', {
    serial_numbers: [doaSn],
    note: `E2E_Test_DOA_Resolve_${timestamp}`,
  }, 'admin@sym.co.th')
  if (!String(doaResolve.doc_code || '').startsWith('ADJ-')) {
    throw new Error(`Expected ADJ document code after DOA resolve, got ${doaResolve.doc_code}`)
  }
  const resolvedLookup = await req(`/api/stock/lookup?serial=${encodeURIComponent(doaSn)}`, 'GET', null, 'tech1@sym.co.th')
  if (resolvedLookup.item?.status !== 'in_warehouse' || resolvedLookup.availability?.available_for_closeout !== true) {
    throw new Error(`Expected resolved DOA unit back to in_warehouse & available, got ${JSON.stringify(resolvedLookup)}`)
  }
  console.log('  ✔ DOA -> ADJ resolve verified cleanly:', doaMark.doc_code, '->', doaResolve.doc_code)

  // 3. ช่างกดเริ่มงาน Onsite
  console.log('\n[3/14] Testing /api/tasks/start (Technician begins replacement)...')
  const startTask = await req('/api/tasks/start', 'POST', { scanner_id: scanner.id }, 'tech1@sym.co.th')
  console.log('  ✔ Task started:', startTask.task_id, 'Status:', startTask.status)
  const taskId = startTask.task_id

  // 4. ทดสอบ Action: พักงานชั่วคราว (Block) และทำต่อ (Resume)
  console.log('\n[4/14] Testing /api/tasks/:id/action (Block & Resume)...')
  const blockResult = await req(`/api/tasks/${taskId}/action`, 'POST', {
    action: 'block',
    reason: 'รอช่างอาคารเปิดตู้ Rack',
    version: 1
  }, 'tech1@sym.co.th')
  console.log('  ✔ Task blocked successfully. Status:', blockResult.status)

  const resumeResult = await req(`/api/tasks/${taskId}/action`, 'POST', {
    action: 'resume',
    version: 2
  }, 'tech1@sym.co.th')
  console.log('  ✔ Task resumed successfully. Status:', resumeResult.status)

  // 5. อัปโหลดและลบภาพถ่ายหลักฐาน (Cloudflare R2 + D1)
  console.log('\n[5/14] Testing /api/tasks/:id/evidence (Upload & Delete Evidence)...')
  const sampleJpg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='
  const uploadResult = await req(`/api/tasks/${taskId}/evidence`, 'POST', {
    evidence_type: 'photo_old_serial',
    file_base64: sampleJpg,
    mime_type: 'image/jpeg'
  }, 'tech1@sym.co.th')
  console.log('  ✔ Evidence uploaded. Storage path:', uploadResult.storage_path)

  await req(`/api/tasks/${taskId}/evidence`, 'POST', {
    evidence_type: 'photo_backup_1',
    file_base64: sampleJpg,
    mime_type: 'image/jpeg'
  }, 'tech1@sym.co.th')
  await req(`/api/tasks/${taskId}/evidence/photo_backup_1`, 'DELETE', null, 'tech1@sym.co.th')

  const evidenceList = await req(`/api/tasks/${taskId}/evidence`, 'GET', null, 'tech1@sym.co.th')
  if (evidenceList.evidence?.length !== 1) {
    throw new Error(`Expected 1 evidence record after deleting backup slot, got ${evidenceList.evidence?.length}`)
  }
  console.log('  ✔ Evidence upload + delete verified. Remaining count:', evidenceList.evidence.length)

  // 6. ช่างส่งมอบผลงาน Closeout
  console.log('\n[6/14] Testing /api/tasks/:id/closeout (Technician Closeout)...')
  const closeout = await req(`/api/tasks/${taskId}/closeout`, 'POST', {
    new_serial_number: newSn,
    observed_serial: testSn,
    notes: 'เปลี่ยนเครื่องสำเร็จและทดสอบสแกนบาร์โค้ดผ่าน',
    outcome: 'replaced',
    version: 3
  }, 'tech1@sym.co.th')
  console.log('  ✔ Closeout submitted. Status:', closeout.status)

  // 7. SYM Admin ตรวจสอบงาน Onsite (Stage 1 SYM Verification)
  console.log('\n[7/14] Testing /api/review/sym-verify & pending stock metadata...')
  const adminPending = await req('/api/tasks/pending', 'GET', null, 'admin@sym.co.th')
  const targetTask = adminPending.tasks?.find(t => t.id === taskId)
  if (!targetTask) throw new Error('Task not found in Admin pending queue')
  if (targetTask.stock_lot_no !== stockLot || targetTask.stock_source_mode !== 'registered_stock') {
    throw new Error(`Expected pending stock_lot_no=${stockLot}, got ${JSON.stringify({ stock_lot_no: targetTask.stock_lot_no, stock_source_mode: targetTask.stock_source_mode })}`)
  }
  console.log('  ✔ Task found in Admin queue. Version:', targetTask.version, 'Stock Lot:', targetTask.stock_lot_no)

  const symVerify = await req('/api/review/sym-verify', 'POST', {
    task_id: taskId,
    decision: 'pass',
    version: targetTask.version
  }, 'admin@sym.co.th')
  console.log('  ✔ Stage 1 SYM Verify passed. Status:', symVerify.status)

  // 8. Gable Customer ตรวจรับงานแบบรวมสาขา (Stage 2 Batch Acceptance)
  console.log('\n[8/14] Testing /api/review/customer-batch-accept (Stage 2 Customer Accept & Least Privilege)...')
  const gablePending = await req('/api/tasks/pending', 'GET', null, 'reviewer@gable.co.th')
  const gableTask = gablePending.tasks?.find(t => t.id === taskId)
  if (!gableTask) throw new Error('Task not found in Gable pending queue')
  if ('stock_lot_no' in gableTask || 'stock_source_mode' in gableTask) {
    throw new Error('Customer reviewer should not receive internal SYM stock fields in /api/tasks/pending')
  }
  console.log('  ✔ Task found in Gable queue (stock fields redacted) for branch:', gableTask.branch_name)

  const customerBatch = await req('/api/review/customer-batch-accept', 'POST', {
    branch_id: scanner.branch_id,
    task_ids: [taskId],
    signature_base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  }, 'reviewer@gable.co.th')
  console.log('  ✔ Stage 2 Customer Batch Accept complete:', customerBatch.message)

  // 9. รายงานเครื่องนอกทะเบียน และ Admin ตรวจอนุมัติ (Scanner Discovery)
  console.log('\n[9/14] Testing /api/discovery (Scanner Discovery Report & Review)...')
  const unregSn = `UNREG-SN-${timestamp}`
  const discoveryReport = await req('/api/discovery', 'POST', {
    branch_id: scanner.branch_id,
    serial_number: unregSn,
    observed_model: 'Zebra DS2208',
    notes: 'พบเครื่องนอกทะเบียนที่เคาน์เตอร์หลังร้าน'
  }, 'tech1@sym.co.th')
  console.log('  ✔ Discovery report submitted. ID:', discoveryReport.id)

  const discoveryQueue = await req('/api/discovery/queue', 'GET', null, 'admin@sym.co.th')
  const pendingReport = discoveryQueue.rows?.find(r => r.serial_number === unregSn)
  if (!pendingReport) throw new Error('Report not found in Discovery queue')
  console.log('  ✔ Report found in Admin Discovery queue:', pendingReport.serial_number)

  const reviewReport = await req(`/api/discovery/${pendingReport.id}/review`, 'POST', {
    decision: 'approve',
    review_note: 'ตรวจสอบแล้ว เป็นเครื่องสำรองของสาขาจริง'
  }, 'admin@sym.co.th')
  console.log('  ✔ Admin approved discovery report:', reviewReport.status)

  // 10. Dashboard Summary ภาพรวม
  console.log('\n[10/14] Testing /api/dashboard/summary...')
  const summary = await req('/api/dashboard/summary', 'GET', null, 'admin@sym.co.th')
  console.log('  ✔ Dashboard Summary Stats:', summary.summary)
  if (!Array.isArray(summary.weekly_activity) || summary.weekly_activity.length !== 7) {
    throw new Error('Dashboard weekly_activity should contain 7 days')
  }
  if (typeof summary.summary.branches_complete !== 'number') {
    throw new Error('Dashboard summary missing branches_complete')
  }
  console.log('  ✔ Dashboard Weekly Activity verified (7 days):', summary.weekly_activity.map(d => `${d.date}: ${d.opened}/${d.completed}`).join(', '))

  // 11. Task Review Audit Trail
  console.log('\n[11/14] Testing /api/tasks/:id/reviews (Governance Audit Trail)...')
  const taskReviews = await req(`/api/tasks/${taskId}/reviews`, 'GET', null, 'admin@sym.co.th')
  if (!taskReviews.reviews || taskReviews.reviews.length < 2) {
    throw new Error('Task reviews audit trail incomplete')
  }
  console.log('  ✔ Audit trail records found:', taskReviews.reviews.length, 'Stages:', taskReviews.reviews.map(r => r.stage).join(', '))

  // 12. Google Sign-In Allowlist Management
  console.log('\n[12/14] Testing /api/allowlist (User Management)...')
  const newTechEmail = `testtech_${timestamp}@sym.co.th`
  const addAllowlist = await req('/api/allowlist', 'POST', {
    email: newTechEmail,
    role: 'field_technician',
    full_name: 'Test Technician'
  }, 'admin@sym.co.th')
  console.log('  ✔ Added user to allowlist:', addAllowlist.message)

  const allowlist = await req('/api/allowlist', 'GET', null, 'admin@sym.co.th')
  const addedUser = allowlist.users?.find(u => u.email === newTechEmail)
  if (!addedUser) throw new Error('Added user not found in allowlist')
  console.log('  ✔ Found user in allowlist:', addedUser.email, 'Role:', addedUser.role)

  const toggleUser = await req(`/api/allowlist/${addedUser.id}/toggle`, 'POST', {}, 'admin@sym.co.th')
  console.log('  ✔ Toggled user active status. New is_active:', toggleUser.is_active)

  // 13. Stock Installed + Reverse Logistics (RET -> HOV) + Stock Document Detail
  console.log('\n[13/14] Testing Stock Installed state, Reverse Logistics (RET -> HOV), & Document Detail...')
  const installedLookup = await req(`/api/stock/lookup?serial=${encodeURIComponent(newSn)}`, 'GET', null, 'admin@sym.co.th')
  if (installedLookup.item?.status !== 'installed') {
    throw new Error(`Expected new stock SN status='installed', got ${installedLookup.item?.status}`)
  }
  const removedLookup = await req(`/api/stock/lookup?serial=${encodeURIComponent(testSn)}`, 'GET', null, 'admin@sym.co.th')
  if (removedLookup.item?.unit_type !== 'old_removed' || removedLookup.item?.status !== 'removed_onsite') {
    throw new Error(`Expected old SN unit_type='old_removed' & status='removed_onsite', got ${JSON.stringify(removedLookup.item)}`)
  }
  console.log('  ✔ Installed & removed_onsite states verified automatically after Stage 2')

  const retRes = await req('/api/stock/old-returns/receive', 'POST', {
    serial_numbers: [testSn],
    note: `E2E_Test_RET_${timestamp}`,
  }, 'admin@sym.co.th')
  if (!String(retRes.doc_code || '').startsWith('RET-')) {
    throw new Error(`Expected RET document code, got ${retRes.doc_code}`)
  }
  console.log('  ✔ Reverse leg 1 receive document created:', retRes.doc_code)

  const hovRes = await req('/api/stock/old-returns/handover', 'POST', {
    serial_numbers: [testSn],
    recipient_name: 'E2E_Test_Customer',
    note: `E2E_Test_HOV_${timestamp}`,
  }, 'admin@sym.co.th')
  if (!String(hovRes.doc_code || '').startsWith('HOV-')) {
    throw new Error(`Expected HOV document code, got ${hovRes.doc_code}`)
  }
  console.log('  ✔ Reverse leg 2 handover document created:', hovRes.doc_code)

  const docDetail = await req(`/api/stock/documents/${encodeURIComponent(hovRes.doc_id)}`, 'GET', null, 'admin@sym.co.th')
  if (docDetail.document?.doc_code !== hovRes.doc_code || !docDetail.movements?.some(m => m.serial_number === testSn)) {
    throw new Error('Stock document detail verification failed for HOV document')
  }
  const finalOldLookup = await req(`/api/stock/lookup?serial=${encodeURIComponent(testSn)}`, 'GET', null, 'admin@sym.co.th')
  if (finalOldLookup.item?.status !== 'handed_over_to_customer') {
    throw new Error(`Expected final old SN status='handed_over_to_customer', got ${finalOldLookup.item?.status}`)
  }
  console.log('  ✔ Reverse Logistics RET -> HOV -> Document Detail verified cleanly')

  // 14. Security Hardening, Least-Privilege Privacy, ID Collisions & Live Concurrency
  console.log('\n[14/14] Testing Security Hardening, Least-Privilege Privacy, ID Collisions & Live Concurrency...')

  // 14a. Least-privilege privacy redaction for G-Able reviewer
  const gableScanners = await req(`/api/scanners?search=${encodeURIComponent(testSn)}`, 'GET', null, 'reviewer@gable.co.th')
  const gableScannerRow = gableScanners.rows?.[0] || {}
  for (const field of ['started_by', 'closeout_submitted_by', 'performed_by_name', 'admin_accepted_by']) {
    if (field in gableScannerRow) {
      throw new Error(`Expected ${field} to be redacted for customer_reviewer in /api/scanners`)
    }
  }
  const gableReviews = await req(`/api/tasks/${taskId}/reviews`, 'GET', null, 'reviewer@gable.co.th')
  const symReviewRow = gableReviews.reviews?.find(r => r.stage === 'sym')
  if (!symReviewRow || symReviewRow.reviewer_email !== null) {
    throw new Error(`Expected sym reviewer_email redacted to null for customer_reviewer, got ${JSON.stringify(symReviewRow)}`)
  }
  console.log('  ✔ G-Able least-privilege privacy redaction verified cleanly')

  // 14b. Key traversal protection & Allowlist data_manager parity + privilege escalation block
  const travRes = await reqRaw('/api/evidence/%2e%2e%2f%2e%2e%2fetc%2fpasswd', 'GET', null, 'admin@sym.co.th')
  if (
    travRes.status !== 404 ||
    travRes.headers.get('x-content-type-options') !== 'nosniff' ||
    !String(travRes.headers.get('content-security-policy') || '').includes('sandbox')
  ) {
    throw new Error(`Unexpected /api/evidence traversal response: status=${travRes.status}`)
  }
  console.log('  ✔ Evidence key traversal security headers verified')

  // 14c. Allowlist data_manager parity + privilege escalation block
  const dmEmail = `testtech_${timestamp}2@sym.co.th`
  await req('/api/allowlist', 'POST', {
    email: dmEmail,
    role: 'data_manager',
    full_name: 'E2E Data Manager',
  }, 'admin@sym.co.th')
  const dmListRes = await reqRaw('/api/allowlist', 'GET', null, dmEmail)
  const dmEscRes = await reqRaw('/api/allowlist', 'POST', { email: dmEmail, role: 'admin' }, dmEmail)
  if (dmListRes.status !== 403 || dmEscRes.status !== 403) {
    throw new Error(`Expected data_manager allowlist access to fail 403, got ${dmListRes.status}/${dmEscRes.status}`)
  }
  console.log('  ✔ Allowlist data_manager parity & escalation protection (403) verified')

  // 14d. Sanitized branch ID collision guard, SVG XSS upload block, & live concurrency
  const secSnA = `SN-E2E-SEC-A-${timestamp}`
  const secSnB = `SN-E2E-SEC-B-${timestamp}`
  await req('/api/register/import', 'POST', {
    source_name: `E2E_Test_SecA_${timestamp}.xlsx`,
    rows: [{ location_code: `E2E-SEC/${timestamp}`, loc_bld: `AIS Shop E2E Sec A ${timestamp}`, com_sn: secSnA, province: 'กรุงเทพมหานคร' }],
  }, 'admin@sym.co.th')
  await req('/api/register/import', 'POST', {
    source_name: `E2E_Test_SecB_${timestamp}.xlsx`,
    rows: [{ location_code: `E2E-SEC_${timestamp}`, loc_bld: `AIS Shop E2E Sec B ${timestamp}`, com_sn: secSnB, province: 'กรุงเทพมหานคร' }],
  }, 'admin@sym.co.th')

  const secScanners = await req(`/api/scanners?search=${encodeURIComponent(secSnA)}`, 'GET', null, 'admin@sym.co.th')
  const secScannerA = secScanners.rows?.[0]
  if (!secScannerA) throw new Error('Security test scannerA not found')

  const [st1, st2] = await Promise.all([
    reqRaw('/api/tasks/start', 'POST', { scanner_id: secScannerA.id }, 'tech1@sym.co.th'),
    reqRaw('/api/tasks/start', 'POST', { scanner_id: secScannerA.id }, 'tech2@sym.co.th'),
  ])
  if (st1.status !== 200 || st2.status !== 200 || st1.json?.task_id !== st2.json?.task_id) {
    throw new Error(`Concurrent /tasks/start expected matching 200 task_id, got ${st1.status}:${st1.json?.task_id} vs ${st2.status}:${st2.json?.task_id}`)
  }
  const raceTaskId = st1.json.task_id

  const svgRes = await reqRaw(`/api/tasks/${raceTaskId}/evidence`, 'POST', {
    evidence_type: 'spare_photo_1',
    file_base64: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64')}`,
    mime_type: 'image/svg+xml',
  }, 'tech1@sym.co.th')
  if (svgRes.status !== 400) {
    throw new Error(`Expected SVG evidence upload to fail with 400 on active task, got ${svgRes.status}`)
  }
  console.log('  ✔ SVG XSS evidence upload blocked (400) cleanly')

  const stockRace1 = `SN-STOCK-E2E-SEC1-${timestamp}`
  const stockRace2 = `SN-STOCK-E2E-SEC2-${timestamp}`
  await req('/api/stock/import/commit', 'POST', {
    source_name: `E2E_Test_SecStock_${timestamp}.xlsx`,
    defaults: { lot_no: `LOT-E2E-SEC-${timestamp}`, brand: 'Zebra', model_name: 'DS2208', note: `E2E_Test_Sec_${timestamp}` },
    rows: [
      { source_row: 2, serial_number: stockRace1 },
      { source_row: 3, serial_number: stockRace2 },
    ],
  }, 'admin@sym.co.th')
  await req('/api/stock/dispatch', 'POST', {
    serial_numbers: [stockRace1],
    dispatch_area: `E2E_Test_Team_${timestamp}`,
  }, 'admin@sym.co.th')

  const [rc1, rc2] = await Promise.all([
    reqRaw('/api/stock/recall', 'POST', { serial_numbers: [stockRace1], note: `E2E_Test_RC1_${timestamp}` }, 'admin@sym.co.th'),
    reqRaw('/api/stock/recall', 'POST', { serial_numbers: [stockRace1], note: `E2E_Test_RC2_${timestamp}` }, 'admin@sym.co.th'),
  ])
  if ([rc1.status, rc2.status].sort().join(',') !== '200,409') {
    throw new Error(`Concurrent /stock/recall expected 200+409, got ${rc1.status}/${rc2.status}`)
  }

  const [coRace, doaRace] = await Promise.all([
    reqRaw(`/api/tasks/${raceTaskId}/closeout`, 'POST', {
      version: 1,
      outcome: 'replaced',
      new_serial_number: stockRace2,
      notes: `E2E_Test_Race_${timestamp}`,
    }, 'tech1@sym.co.th'),
    reqRaw('/api/stock/doa', 'POST', {
      serial_numbers: [stockRace2],
      note: `E2E_Test_DOA_Race_${timestamp}`,
    }, 'admin@sym.co.th'),
  ])
  const afterRaceTask = await req(`/api/scanners?search=${encodeURIComponent(secSnA)}`, 'GET', null, 'admin@sym.co.th')
  const afterRaceStock = await req(`/api/stock/lookup?serial=${encodeURIComponent(stockRace2)}`, 'GET', null, 'admin@sym.co.th')
  const raceStatuses = [coRace.status, doaRace.status].sort().join(',')
  if (
    raceStatuses !== '200,409' ||
    (afterRaceTask.rows?.[0]?.task_status === 'awaiting_admin_acceptance' && afterRaceStock.item?.status !== 'allocated_to_task') ||
    (afterRaceTask.rows?.[0]?.task_status === 'in_progress' && afterRaceStock.item?.status !== 'doa_defective')
  ) {
    throw new Error(`Closeout vs DOA race state mismatch: statuses=${raceStatuses}, task=${afterRaceTask.rows?.[0]?.task_status}, stock=${afterRaceStock.item?.status}`)
  }
  console.log('  ✔ Collision safety & live HTTP concurrency (tasks/start, stock/recall, closeout vs doa) verified cleanly')

  console.log('\n🎉 ALL 14/14 EDGE INTEGRATION & SECURITY CHECKS PASSED!')
}

main()
  .catch(err => {
    console.error('\n❌ E2E Verification failed:', err)
    process.exitCode = 1
  })
  .finally(() => {
    if (cleanupLocal && isLocal) {
      console.log('\n🧹 Cleaning up local E2E synthetic data (D1 + R2)...')
      execFileSync(process.execPath, [resolve(SCRIPT_DIR, 'cleanup-e2e.mjs'), '--local', '--execute'], {
        stdio: 'inherit'
      })
    }
  })
