import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadEnv } from 'vite'

const env = loadEnv('production', process.cwd(), 'VITE_')
const rawUrl = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321'

if (!env.VITE_SUPABASE_URL && !process.env.VITE_SUPABASE_URL) {
  console.warn('VITE_SUPABASE_URL not configured in environment or .env.local; defaulting CSP origin to http://127.0.0.1:54321 for build.')
}

let supabaseUrl
try {
  supabaseUrl = new URL(rawUrl)
} catch {
  throw new Error('VITE_SUPABASE_URL must be a valid Supabase project URL.')
}

const isSupabaseCloud = supabaseUrl.protocol === 'https:' &&
  /^[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl.hostname) &&
  !supabaseUrl.port
const isLocalSupabase = supabaseUrl.protocol === 'http:' &&
  ['127.0.0.1', 'localhost'].includes(supabaseUrl.hostname) &&
  Boolean(supabaseUrl.port)

if ((!isSupabaseCloud && !isLocalSupabase) || supabaseUrl.username || supabaseUrl.password ||
  supabaseUrl.pathname !== '/' || supabaseUrl.search || supabaseUrl.hash) {
  throw new Error('VITE_SUPABASE_URL must be an HTTPS Supabase Cloud URL or a local localhost URL, without credentials or a path.')
}

const websocketProtocol = supabaseUrl.protocol === 'https:' ? 'wss:' : 'ws:'
const allowedOrigins = `${supabaseUrl.origin} ${websocketProtocol}//${supabaseUrl.host}`
const headerPath = path.resolve('dist', '_headers')
const headers = await readFile(headerPath, 'utf8')
const marker = '__SUPABASE_ORIGINS__'

if (!headers.includes(marker) || headers.indexOf(marker) !== headers.lastIndexOf(marker)) {
  throw new Error('Expected exactly one Supabase CSP marker in dist/_headers.')
}

await writeFile(headerPath, headers.replace(marker, allowedOrigins), 'utf8')
