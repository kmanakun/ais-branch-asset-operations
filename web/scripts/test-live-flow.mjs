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

async function req(path, method = 'GET', body = null, email = 'admin@sym.co.th') {
  const options = {
    method,
    headers: {
      'x-dev-user-email': email,
      'Content-Type': 'application/json'
    }
  }
  if (body) options.body = JSON.stringify(body)
  const res = await fetch(`${BASE_URL}${path}`, options)
  const json = await res.json()
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${method} ${path}: ${json.error || JSON.stringify(json)}`)
  }
  return json
}

async function main() {
  console.log('🚀 Starting Full Edge Verification on', BASE_URL)
  const timestamp = Date.now()
  const testSn = `SN-E2E-${timestamp}`
  const newSn = `NEW-SN-${timestamp}`
  const branchCode = `BKK-${timestamp.toString().slice(-4)}`

  // 1. นำเข้าข้อมูล Master Register
  console.log('\n[1/12] Testing /api/register/import...')
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

  // 2. ตรวจสอบทะเบียนอุปกรณ์
  console.log('\n[2/12] Testing /api/scanners search...')
  const scanners = await req(`/api/scanners?search=${testSn}`, 'GET', null, 'admin@sym.co.th')
  if (!scanners.rows?.length) throw new Error('Scanner not found after import')
  const scanner = scanners.rows[0]
  console.log('  ✔ Scanner found:', scanner.com_sn, 'ID:', scanner.id, 'Branch ID:', scanner.branch_id)

  // 3. ช่างกดเริ่มงาน Onsite
  console.log('\n[3/12] Testing /api/tasks/start (Technician begins replacement)...')
  const startTask = await req('/api/tasks/start', 'POST', { scanner_id: scanner.id }, 'tech1@sym.co.th')
  console.log('  ✔ Task started:', startTask.task_id, 'Status:', startTask.status)
  const taskId = startTask.task_id

  // 4. ทดสอบ Action: พักงานชั่วคราว (Block) และทำต่อ (Resume)
  console.log('\n[4/12] Testing /api/tasks/:id/action (Block & Resume)...')
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
  console.log('\n[5/12] Testing /api/tasks/:id/evidence (Upload & Delete Evidence)...')
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
  console.log('\n[6/12] Testing /api/tasks/:id/closeout (Technician Closeout)...')
  const closeout = await req(`/api/tasks/${taskId}/closeout`, 'POST', {
    new_serial_number: newSn,
    observed_serial: testSn,
    notes: 'เปลี่ยนเครื่องสำเร็จและทดสอบสแกนบาร์โค้ดผ่าน',
    outcome: 'replaced',
    version: 3
  }, 'tech1@sym.co.th')
  console.log('  ✔ Closeout submitted. Status:', closeout.status)

  // 7. SYM Admin ตรวจสอบงาน Onsite (Stage 1 SYM Verification)
  console.log('\n[7/12] Testing /api/review/sym-verify (Stage 1 SYM Admin Approval)...')
  const adminPending = await req('/api/tasks/pending', 'GET', null, 'admin@sym.co.th')
  const targetTask = adminPending.tasks?.find(t => t.id === taskId)
  if (!targetTask) throw new Error('Task not found in Admin pending queue')
  console.log('  ✔ Task found in Admin queue. Version:', targetTask.version)

  const symVerify = await req('/api/review/sym-verify', 'POST', {
    task_id: taskId,
    decision: 'pass',
    version: targetTask.version
  }, 'admin@sym.co.th')
  console.log('  ✔ Stage 1 SYM Verify passed. Status:', symVerify.status)

  // 8. Gable Customer ตรวจรับงานแบบรวมสาขา (Stage 2 Batch Acceptance)
  console.log('\n[8/12] Testing /api/review/customer-batch-accept (Stage 2 Customer Accept)...')
  const gablePending = await req('/api/tasks/pending', 'GET', null, 'reviewer@gable.co.th')
  const gableTask = gablePending.tasks?.find(t => t.id === taskId)
  if (!gableTask) throw new Error('Task not found in Gable pending queue')
  console.log('  ✔ Task found in Gable queue for branch:', gableTask.branch_name)

  const customerBatch = await req('/api/review/customer-batch-accept', 'POST', {
    branch_id: scanner.branch_id,
    task_ids: [taskId],
    signature_base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  }, 'reviewer@gable.co.th')
  console.log('  ✔ Stage 2 Customer Batch Accept complete:', customerBatch.message)

  // 9. รายงานเครื่องนอกทะเบียน และ Admin ตรวจอนุมัติ (Scanner Discovery)
  console.log('\n[9/12] Testing /api/discovery (Scanner Discovery Report & Review)...')
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
  console.log('\n[10/12] Testing /api/dashboard/summary...')
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
  console.log('\n[11/12] Testing /api/tasks/:id/reviews (Governance Audit Trail)...')
  const taskReviews = await req(`/api/tasks/${taskId}/reviews`, 'GET', null, 'admin@sym.co.th')
  if (!taskReviews.reviews || taskReviews.reviews.length < 2) {
    throw new Error('Task reviews audit trail incomplete')
  }
  console.log('  ✔ Audit trail records found:', taskReviews.reviews.length, 'Stages:', taskReviews.reviews.map(r => r.stage).join(', '))

  // 12. Google Sign-In Allowlist Management
  console.log('\n[12/12] Testing /api/allowlist (User Management)...')
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

  console.log('\n🎉 ALL 12/12 EDGE INTEGRATION CHECKS PASSED!')
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
