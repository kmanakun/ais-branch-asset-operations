import {
  WEB_DIR,
  DB_NAME,
  R2_BUCKET,
  collectR2KeysWithBranchSignatures,
  queryD1Json,
  runWrangler,
  validateR2Key,
} from './cf-wrangler-helpers.mjs'

const CLEANUP_SQL = './d1/cleanup-e2e-test-data.sql'

function parseArgs(argv) {
  const flags = new Set(argv)
  return {
    isRemote: flags.has('--remote'),
    isExecute: flags.has('--execute'),
    confirmProd: flags.has('--confirm-production-delete'),
  }
}

async function getE2eCounts(isRemote) {
  const [counts = {}] = await queryD1Json(`
    SELECT
      (SELECT COUNT(*) FROM branches WHERE loc_bld LIKE 'AIS Shop E2E %') AS branches,
      (SELECT COUNT(*) FROM scanner_assets s JOIN branches b ON b.id = s.branch_id WHERE b.loc_bld LIKE 'AIS Shop E2E %') AS scanner_assets,
      (SELECT COUNT(*) FROM branch_work_orders w JOIN branches b ON b.id = w.branch_id WHERE b.loc_bld LIKE 'AIS Shop E2E %') AS branch_work_orders,
      (SELECT COUNT(*) FROM replacement_tasks t JOIN scanner_assets s ON s.id = t.scanner_asset_id JOIN branches b ON b.id = s.branch_id WHERE b.loc_bld LIKE 'AIS Shop E2E %') AS replacement_tasks,
      (SELECT COUNT(*) FROM replacement_task_evidence e JOIN replacement_tasks t ON t.id = e.replacement_task_id JOIN scanner_assets s ON s.id = t.scanner_asset_id JOIN branches b ON b.id = s.branch_id WHERE b.loc_bld LIKE 'AIS Shop E2E %') AS replacement_task_evidence,
      (SELECT COUNT(*) FROM task_reviews r JOIN replacement_tasks t ON t.id = r.task_id JOIN scanner_assets s ON s.id = t.scanner_asset_id JOIN branches b ON b.id = s.branch_id WHERE b.loc_bld LIKE 'AIS Shop E2E %') AS task_reviews,
      (SELECT COUNT(*) FROM scanner_discovery_reports d JOIN branches b ON b.id = d.branch_id WHERE b.loc_bld LIKE 'AIS Shop E2E %') AS scanner_discovery_reports,
      (SELECT COUNT(*) FROM google_signin_allowlist WHERE email GLOB 'testtech_[0-9]*@sym.co.th') AS google_signin_allowlist,
      (SELECT COUNT(*) FROM import_batches WHERE source_name LIKE 'E2E_Test_%') AS import_batches
  `, isRemote)
  return counts
}

export async function runCleanupE2e() {
  const { isRemote, isExecute, confirmProd } = parseArgs(process.argv.slice(2))
  const envLabel = isRemote ? 'REMOTE PRODUCTION' : 'LOCAL DEV'

  if (isRemote && isExecute && !confirmProd) {
    console.error('❌ ปฏิเสธการลบข้อมูล Production D1/R2 โดยไม่ยืนยัน: ต้องระบุ --remote --execute --confirm-production-delete')
    process.exit(1)
  }

  console.log(`🔎 ตรวจสอบข้อมูลทดสอบ E2E (${envLabel}) [${isExecute ? 'EXECUTE' : 'DRY-RUN'}]`)
  const counts = await getE2eCounts(isRemote)
  const r2Rows = await queryD1Json(`
    SELECT DISTINCT
      e.storage_path,
      s.branch_id
    FROM replacement_task_evidence e
    JOIN replacement_tasks t ON t.id = e.replacement_task_id
    JOIN scanner_assets s ON s.id = t.scanner_asset_id
    JOIN branches b ON b.id = s.branch_id
    WHERE b.loc_bld LIKE 'AIS Shop E2E %'
  `, isRemote)
  const r2Keys = collectR2KeysWithBranchSignatures(r2Rows)

  const totalRows = Object.values(counts).reduce((sum, n) => sum + Number(n || 0), 0)
  console.table(counts)
  console.log(`📦 D1 E2E rows total: ${totalRows}`)
  console.log(`🖼️ R2 E2E object keys found: ${r2Keys.length}`)
  if (r2Keys.length > 0) {
    console.log('   Sample keys:', r2Keys.slice(0, 5))
  }

  if (totalRows === 0 && r2Keys.length === 0) {
    console.log('✅ ไม่พบข้อมูลทดสอบ E2E ที่ต้องลบ')
    return
  }

  if (!isExecute) {
    console.log('\nℹ️  โหมด Dry-Run: ยังไม่มีการลบข้อมูลจริง')
    if (isRemote) {
      console.log('   หากต้องการลบ Production D1 + R2 ให้รัน: node scripts/cleanup-e2e.mjs --remote --execute --confirm-production-delete')
    } else {
      console.log('   หากต้องการลบ Local D1 + R2 ให้รัน: node scripts/cleanup-e2e.mjs --local --execute')
    }
    return
  }

  const modeFlag = isRemote ? '--remote' : '--local'

  // 1. Delete R2 objects BEFORE deleting D1 rows so exact storage_path references remain queryable
  if (r2Keys.length > 0) {
    console.log(`\n🧹 กำลังลบไฟล์ R2 จำนวน ${r2Keys.length} รายการจาก bucket ${R2_BUCKET} (${modeFlag})...`)
    // Local Miniflare R2 stores metadata in SQLite; sequential deletes avoid SQLITE_BUSY write locks.
    const batchSize = isRemote ? 4 : 1
    let completed = 0
    for (let i = 0; i < r2Keys.length; i += batchSize) {
      const slice = r2Keys.slice(i, i + batchSize)
      await Promise.all(
        slice.map(key => runWrangler(['r2', 'object', 'delete', `${R2_BUCKET}/${validateR2Key(key)}`, modeFlag], isRemote ? 5 : 1))
      )
      completed += slice.length
      if (completed === r2Keys.length || completed % 20 === 0 || slice.length === r2Keys.length) {
        console.log(`   ...ลบแล้ว ${completed}/${r2Keys.length} ไฟล์`)
      }
    }
    console.log('  ✔ ลบไฟล์ R2 เรียบร้อย')
  }

  // 2. Delete D1 rows cleanly in child -> parent FK order
  console.log(`\n🧹 กำลังรัน ${CLEANUP_SQL} บน ${DB_NAME} (${modeFlag})...`)
  const d1Args = ['d1', 'execute', DB_NAME, modeFlag, '--file', CLEANUP_SQL]
  if (isRemote) d1Args.push('--yes')
  await runWrangler(d1Args, isRemote ? 5 : 1)

  // 3. Post-cleanup verification
  const remaining = await getE2eCounts(isRemote)
  const remainingTotal = Object.values(remaining).reduce((sum, n) => sum + Number(n || 0), 0)
  console.log(`\n✅ ลบข้อมูลทดสอบ E2E เสร็จสิ้น — D1 E2E rows คงเหลือ: ${remainingTotal}`)
  if (remainingTotal !== 0) {
    console.table(remaining)
    process.exit(1)
  }
}

runCleanupE2e().catch(err => {
  console.error('\n❌ cleanup-e2e failed:', err?.message || err)
  process.exit(1)
})
