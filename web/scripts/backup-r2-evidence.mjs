import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import {
  WEB_DIR,
  R2_BUCKET,
  collectR2KeysWithBranchSignatures,
  queryD1Json,
  runWrangler,
  validateR2Key,
} from './cf-wrangler-helpers.mjs'

function parseArgs(argv) {
  const outArg = argv.find(arg => arg.startsWith('--outdir='))?.slice(9)
  const flags = new Set(argv)
  return {
    isRemote: flags.has('--remote'),
    isExecute: flags.has('--execute') && !flags.has('--dry-run'),
    outdir: outArg ? resolve(WEB_DIR, outArg) : resolve(WEB_DIR, '.tmp-r2-backup'),
  }
}

function resolveSafeDest(rootDir, key) {
  const cleanKey = validateR2Key(key)
  const dest = resolve(rootDir, ...cleanKey.split('/'))
  const normalizedRoot = rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`
  if (!dest.startsWith(normalizedRoot)) {
    throw new Error(`Resolved path escapes target directory: ${dest}`)
  }
  return { cleanKey, dest }
}

async function downloadOne(rootDir, key, isRemote) {
  const { cleanKey, dest } = resolveSafeDest(rootDir, key)
  await mkdir(dirname(dest), { recursive: true })
  const modeFlag = isRemote ? '--remote' : '--local'

  try {
    await runWrangler(
      ['r2', 'object', 'get', `${R2_BUCKET}/${cleanKey}`, '--file', dest, modeFlag],
      isRemote ? 5 : 1
    )
    const info = await stat(dest)
    const bytes = await readFile(dest)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    return { key: cleanKey, status: 'downloaded', byte_size: info.size, sha256 }
  } catch (err) {
    const out = `${err?.stdout || ''}\n${err?.stderr || ''}\n${err?.message || ''}`
    await rm(dest, { force: true }).catch(() => {})
    if (/specified key does not exist|404|NoSuchKey/i.test(out)) {
      return { key: cleanKey, status: 'missing_in_r2', byte_size: 0, sha256: null }
    }
    throw err
  }
}

async function main() {
  const { isRemote, isExecute, outdir } = parseArgs(process.argv.slice(2))
  const envLabel = isRemote ? 'REMOTE PRODUCTION' : 'LOCAL DEV'

  console.log(`🔎 ค้นหารายการหลักฐาน R2 จาก D1 (${envLabel}) [${isExecute ? 'EXECUTE' : 'DRY-RUN'}]`)
  const rows = await queryD1Json(`
    SELECT DISTINCT
      e.storage_path,
      s.branch_id
    FROM replacement_task_evidence e
    LEFT JOIN replacement_tasks t ON t.id = e.replacement_task_id
    LEFT JOIN scanner_assets s ON s.id = t.scanner_asset_id
    ORDER BY e.storage_path ASC
  `, isRemote)

  const r2Keys = collectR2KeysWithBranchSignatures(rows)
  console.log(`🖼️ พบ R2 Object Keys ทั้งหมด: ${r2Keys.length} รายการ`)
  if (r2Keys.length > 0) {
    console.log('   ตัวอย่าง:', r2Keys.slice(0, 5))
  }

  if (!isExecute) {
    console.log('\nℹ️  โหมด Dry-Run: ยังไม่มีการดาวน์โหลดไฟล์ R2 จริง')
    console.log(`   หากต้องการดาวน์โหลด R2 Backup ให้รัน: node scripts/backup-r2-evidence.mjs ${isRemote ? '--remote' : '--local'} --execute --outdir=<target-dir>`)
    return
  }

  await mkdir(outdir, { recursive: true })
  const manifest = {
    generated_at: new Date().toISOString(),
    environment: isRemote ? 'remote' : 'local',
    bucket: R2_BUCKET,
    total_keys: r2Keys.length,
    downloaded_count: 0,
    missing_count: 0,
    total_bytes: 0,
    objects: [],
  }

  const batchSize = isRemote ? 4 : 2
  for (let i = 0; i < r2Keys.length; i += batchSize) {
    const slice = r2Keys.slice(i, i + batchSize)
    const results = await Promise.all(slice.map(key => downloadOne(outdir, key, isRemote)))
    for (const item of results) {
      manifest.objects.push(item)
      if (item.status === 'downloaded') {
        manifest.downloaded_count += 1
        manifest.total_bytes += item.byte_size
      } else {
        manifest.missing_count += 1
      }
    }
    const processed = manifest.objects.length
    if (processed === r2Keys.length || processed % 20 === 0 || slice.length === r2Keys.length) {
      console.log(`   ...ดึงข้อมูลแล้ว ${processed}/${r2Keys.length} ไฟล์`)
    }
  }

  const manifestPath = resolve(outdir, 'r2-manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  console.log(`✅ R2 Evidence Backup เสร็จสิ้น: ดาวน์โหลดได้ ${manifest.downloaded_count} ไฟล์ (${manifest.total_bytes} bytes), ไม่พบใน R2 ${manifest.missing_count} ไฟล์`)
  console.log(`   Manifest: ${manifestPath}`)
}

main().catch(err => {
  console.error('\n❌ backup-r2-evidence failed:', err?.message || err)
  process.exit(1)
})
