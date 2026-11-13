import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const execFileAsync = promisify(execFile)

export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const WEB_DIR = resolve(SCRIPT_DIR, '..')
export const WRANGLER_BIN = resolve(WEB_DIR, 'node_modules/wrangler/bin/wrangler.js')
export const DB_NAME = 'ais-scanner-db'
export const R2_BUCKET = 'ais-scanner-evidence'
export const SAFE_R2_KEY_PATTERN = /^[A-Za-z0-9_./-]+$/

export function validateR2Key(key) {
  const clean = String(key || '').trim()
  if (!clean || !SAFE_R2_KEY_PATTERN.test(clean) || clean.includes('..') || clean.startsWith('/')) {
    throw new Error(`Refusing unsafe R2 object key: ${key}`)
  }
  return clean
}

export async function runWrangler(args, maxAttempts = 2) {
  const nodeOptions = [process.env.NODE_OPTIONS, '--dns-result-order=ipv4first']
    .filter(Boolean)
    .join(' ')

  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { stdout } = await execFileAsync(process.execPath, [WRANGLER_BIN, ...args], {
        cwd: WEB_DIR,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 120_000,
        env: {
          ...process.env,
          NODE_OPTIONS: nodeOptions,
        },
      })
      return stdout
    } catch (err) {
      lastError = err
      const out = `${err?.stdout || ''}\n${err?.stderr || ''}\n${err?.message || ''}`
      if (attempt < maxAttempts && /fetch failed|ETIMEDOUT|ECONNRESET|429|502|503|504/i.test(out)) {
        await delay(attempt * 1500)
        continue
      }
      throw err
    }
  }
  throw lastError
}

export async function queryD1Json(sql, isRemote) {
  const modeFlag = isRemote ? '--remote' : '--local'
  const compactSql = sql.replace(/\s+/g, ' ').trim()
  const out = await runWrangler(
    ['d1', 'execute', DB_NAME, modeFlag, '--json', '--command', compactSql],
    isRemote ? 5 : 1
  )
  const parsed = JSON.parse(out)
  if (!Array.isArray(parsed) || !parsed[0]?.success) {
    throw new Error(`D1 query did not return success: ${out}`)
  }
  return parsed[0].results || []
}

export function collectR2KeysWithBranchSignatures(rows) {
  const keys = new Set()
  for (const row of rows) {
    const path = String(row?.storage_path || '').trim()
    if (!path) continue
    keys.add(validateR2Key(path))

    // Reconstruct branch-level Gable signature path written by /api/review/customer-batch-accept
    const sigMatch = path.match(/\/inspector_signature_(\d+)\.jpg$/)
    if (sigMatch && row?.branch_id) {
      keys.add(validateR2Key(`branches/${String(row.branch_id).trim()}/gable_sign_${sigMatch[1]}.png`))
    }
  }
  return Array.from(keys).sort()
}
