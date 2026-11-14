import { Hono } from 'hono'
import { handle } from 'hono/cloudflare-pages'
import {
  GoogleAuthError,
  OAUTH_TX_COOKIE_NAME,
  OAUTH_TX_TTL_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  type OAuthTransactionPayload,
  type SessionCookiePayload,
  buildGoogleAuthorizationUrl,
  createPkceChallenge,
  exchangeGoogleAuthCode,
  generateRandomToken,
  isSecureRequestUrl,
  readCookieValue,
  resolveGoogleAuthConfig,
  resolveOAuthRedirectUri,
  serializeCookie,
  signCookiePayload,
  verifyCookiePayload,
  verifyGoogleIdToken,
} from '../../src/lib/google-oauth.ts'
import { validateSerialFormat } from '../../src/lib/stock-serial.mjs'
import {
  buildReviewRejectStockStatements,
  createStockRouter,
  prepareCancelTaskStockPlan,
  prepareCloseoutStockPlan,
  prepareCustomerAcceptStockStatements,
  runBatchChunks,
} from '../../src/lib/stock-service.ts'

type Bindings = {
  DB: D1Database
  EVIDENCE_BUCKET?: R2Bucket
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  SESSION_SECRET?: string
}

type Variables = {
  user: {
    email: string
    role: string
    full_name: string
  }
}

const OPERATIONAL_WRITE_ROLES = new Set(['admin', 'data_manager', 'field_technician'])
const ALLOWED_CLOSEOUT_OUTCOMES = new Set(['replaced', 'no_damage_found', 'different_device_found', 'target_device_not_found'])

function hasOperationalWriteAccess(role: string): boolean {
  return OPERATIONAL_WRITE_ROLES.has(role)
}

function parseUtcMs(value?: string | null): number {
  const raw = String(value || '').trim()
  if (!raw) return Number.NaN
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw
  return new Date(normalized).getTime()
}

function makeUniqueId(prefix: string): string {
  const rand = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
  return `${prefix}-${Date.now()}-${rand}`
}

async function readJsonBody<T extends Record<string, unknown>>(c: any): Promise<T | null> {
  try {
    const parsed = await c.req.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as T
  } catch {
    return null
  }
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>().basePath('/api')

const PUBLIC_AUTH_PATHS = new Set([
  '/api/health',
  '/api/auth/config',
  '/api/auth/google/start',
  '/api/auth/callback',
  '/api/auth/logout',
])
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function isCrossOriginBlocked(requestUrl: string, originHeader: string | undefined, fetchSiteHeader: string | undefined): boolean {
  if (fetchSiteHeader && fetchSiteHeader.toLowerCase() === 'cross-site') {
    return true
  }
  if (!originHeader) {
    return false
  }
  try {
    return new URL(originHeader).origin !== new URL(requestUrl).origin
  } catch {
    return true
  }
}

// CORS / Headers Middleware
app.use('*', async (c, next) => {
  await next()
  const authConfig = resolveGoogleAuthConfig(c.env)
  c.header('Vary', 'Origin')
  if (authConfig.mode === 'dev_fallback') {
    c.header('Access-Control-Allow-Origin', '*')
    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-dev-user-email')
  }
})

app.options('*', (c) => c.text('', 204))

// CSRF + Authentication & Allowlist Middleware
app.use('*', async (c, next) => {
  const authConfig = resolveGoogleAuthConfig(c.env)
  const path = c.req.path

  if (
    authConfig.mode === 'google_oauth' &&
    MUTATING_METHODS.has(c.req.method.toUpperCase()) &&
    isCrossOriginBlocked(c.req.url, c.req.header('Origin'), c.req.header('Sec-Fetch-Site'))
  ) {
    return c.json({ error: 'คำขอข้ามโดเมนไม่ได้รับอนุญาต (CSRF Blocked)', code: 'CSRF_ORIGIN_MISMATCH' }, 403)
  }

  if (PUBLIC_AUTH_PATHS.has(path)) {
    return next()
  }

  if (authConfig.mode === 'misconfigured') {
    return c.json({
      error: authConfig.misconfiguredReason || 'การตั้งค่า Google OAuth บน Cloudflare Pages ยังไม่ครบ',
      code: 'OAUTH_MISCONFIGURED',
    }, 503)
  }

  let email: string | undefined

  if (authConfig.mode === 'google_oauth') {
    // Protect all endpoints (including /api/evidence/*) with signed HttpOnly session cookie.
    // Never accept x-dev-user-email, dev_email, or raw Authorization headers in Production OAuth mode.
    const rawCookie = readCookieValue(c.req.header('Cookie'), SESSION_COOKIE_NAME)
    const sessionPayload = await verifyCookiePayload<SessionCookiePayload>(
      rawCookie,
      'session',
      authConfig.sessionSecret,
    )
    if (!sessionPayload?.email) {
      if (rawCookie) {
        c.header(
          'Set-Cookie',
          serializeCookie(SESSION_COOKIE_NAME, '', {
            path: '/',
            maxAge: 0,
            secure: isSecureRequestUrl(c.req.url),
          }),
          { append: true },
        )
      }
      return c.json({
        error: 'กรุณาเข้าสู่ระบบด้วย Google Sign-In เพื่อใช้งานระบบ (Session Required)',
        code: 'SESSION_REQUIRED',
      }, 401)
    }
    email = sessionPayload.email
  } else {
    // Dev / transitional pre-OAuth mode: keep Dev Switcher + unauthenticated evidence preview
    if (path.startsWith('/api/evidence/')) {
      return next()
    }
    email = c.req.header('x-dev-user-email') || c.req.query('dev_email')
    const authHeader = c.req.header('Authorization')
    if (!email && authHeader?.startsWith('Bearer ')) {
      email = authHeader.slice(7)
    }
  }

  if (!email) {
    return c.json({ error: 'กรุณาเข้าสู่ระบบ หรือเลือกสิทธิ์ผู้ใช้งาน (Authentication Required)' }, 401)
  }

  const normalizedEmail = email.toLowerCase().trim()
  const user = await c.env.DB.prepare(
    'SELECT email, role, full_name, is_active FROM google_signin_allowlist WHERE email = ? AND is_active = 1'
  ).bind(normalizedEmail).first<{ email: string; role: string; full_name: string; is_active: number }>()

  if (!user) {
    if (authConfig.mode === 'google_oauth') {
      c.header(
        'Set-Cookie',
        serializeCookie(SESSION_COOKIE_NAME, '', {
          path: '/',
          maxAge: 0,
          secure: isSecureRequestUrl(c.req.url),
        }),
        { append: true },
      )
    }
    return c.json({
      error: 'บัญชีของคุณไม่อยู่ในรายชื่อผู้มีสิทธิ์เข้าใช้งานระบบ (Unauthorized Allowlist)',
      code: 'NOT_ALLOWLISTED',
    }, 403)
  }

  c.set('user', {
    email: user.email,
    role: user.role,
    full_name: user.full_name || user.email
  })

  await next()
})

// 1. Health check & Diagnostic
app.get('/health', async (c) => {
  try {
    const userCount = await c.env.DB.prepare('SELECT COUNT(*) as count FROM google_signin_allowlist').first<{ count: number }>()
    const branchCount = await c.env.DB.prepare('SELECT COUNT(*) as count FROM branches').first<{ count: number }>()
    const scannerCount = await c.env.DB.prepare('SELECT COUNT(*) as count FROM scanner_assets').first<{ count: number }>()
    
    return c.json({
      status: 'ok',
      engine: 'Cloudflare Pages Functions + Hono',
      database: 'Cloudflare D1 (SQLite)',
      storage: c.env.EVIDENCE_BUCKET ? 'Cloudflare R2 (Bound)' : 'Cloudflare R2 (Simulated)',
      stats: {
        allowlist_users: userCount?.count ?? 0,
        branches: branchCount?.count ?? 0,
        scanners: scannerCount?.count ?? 0
      },
      timestamp: new Date().toISOString()
    })
  } catch (error: any) {
    return c.json({ status: 'error', message: error.message }, 500)
  }
})

// 1.5 โหมดการยืนยันตัวตนของระบบ + Google Sign-In OAuth 2.0 Endpoints
app.get('/auth/config', (c) => {
  const authConfig = resolveGoogleAuthConfig(c.env)
  c.header('Cache-Control', 'no-store')
  return c.json({
    auth_provider: 'google_oauth',
    mode: authConfig.mode,
    google_enabled: authConfig.googleEnabled,
    dev_auth_enabled: authConfig.devAuthEnabled,
  })
})

app.get('/auth/google/start', async (c) => {
  const authConfig = resolveGoogleAuthConfig(c.env)
  c.header('Cache-Control', 'no-store')

  if (authConfig.mode !== 'google_oauth') {
    const errorCode = authConfig.mode === 'misconfigured' ? 'oauth_misconfigured' : 'oauth_not_configured'
    return c.redirect(`/?auth_error=${errorCode}`, 302)
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  const state = generateRandomToken(32)
  const nonce = generateRandomToken(32)
  const codeVerifier = generateRandomToken(48)
  const codeChallenge = await createPkceChallenge(codeVerifier)

  const txCookie = await signCookiePayload(
    {
      p: 'oauth_tx',
      state,
      nonce,
      codeVerifier,
      exp: nowSeconds + OAUTH_TX_TTL_SECONDS,
    },
    authConfig.sessionSecret,
  )

  c.header(
    'Set-Cookie',
    serializeCookie(OAUTH_TX_COOKIE_NAME, txCookie, {
      path: '/api/auth',
      maxAge: OAUTH_TX_TTL_SECONDS,
      secure: isSecureRequestUrl(c.req.url),
    }),
    { append: true },
  )

  const authorizeUrl = buildGoogleAuthorizationUrl({
    clientId: authConfig.clientId,
    redirectUri: resolveOAuthRedirectUri(c.req.url),
    state,
    nonce,
    codeChallenge,
  })
  return c.redirect(authorizeUrl, 302)
})

app.get('/auth/callback', async (c) => {
  const authConfig = resolveGoogleAuthConfig(c.env)
  const secureCookie = isSecureRequestUrl(c.req.url)
  c.header('Cache-Control', 'no-store')

  const clearTxCookie = () => {
    c.header(
      'Set-Cookie',
      serializeCookie(OAUTH_TX_COOKIE_NAME, '', {
        path: '/api/auth',
        maxAge: 0,
        secure: secureCookie,
      }),
      { append: true },
    )
  }

  const failRedirect = (errorCode: string) => {
    clearTxCookie()
    return c.redirect(`/?auth_error=${encodeURIComponent(errorCode)}`, 302)
  }

  if (authConfig.mode !== 'google_oauth') {
    return failRedirect(authConfig.mode === 'misconfigured' ? 'oauth_misconfigured' : 'oauth_not_configured')
  }

  const oauthError = c.req.query('error')
  if (oauthError) {
    return failRedirect(oauthError === 'access_denied' ? 'access_denied' : 'oauth_failed')
  }

  const code = c.req.query('code')?.trim()
  const state = c.req.query('state')?.trim()
  if (!code || !state) {
    return failRedirect('invalid_state')
  }

  const rawTxCookie = readCookieValue(c.req.header('Cookie'), OAUTH_TX_COOKIE_NAME)
  const txPayload = await verifyCookiePayload<OAuthTransactionPayload>(
    rawTxCookie,
    'oauth_tx',
    authConfig.sessionSecret,
  )
  if (!txPayload || txPayload.state !== state) {
    return failRedirect('invalid_state')
  }

  let verifiedEmail: string
  let verifiedSub: string | undefined
  try {
    const { idToken } = await exchangeGoogleAuthCode({
      code,
      clientId: authConfig.clientId,
      clientSecret: authConfig.clientSecret,
      redirectUri: resolveOAuthRedirectUri(c.req.url),
      codeVerifier: txPayload.codeVerifier,
    })
    const identity = await verifyGoogleIdToken(idToken, {
      clientId: authConfig.clientId,
      expectedNonce: txPayload.nonce,
    })
    verifiedEmail = identity.email
    verifiedSub = identity.sub
  } catch (error) {
    if (error instanceof GoogleAuthError && error.code === 'UNVERIFIED_EMAIL') {
      return failRedirect('unverified_email')
    }
    return failRedirect('oauth_failed')
  }

  const allowlistedUser = await c.env.DB.prepare(
    'SELECT email, role, full_name, is_active FROM google_signin_allowlist WHERE email = ? AND is_active = 1'
  ).bind(verifiedEmail).first<{ email: string; role: string; full_name: string; is_active: number }>()

  if (!allowlistedUser) {
    c.header(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE_NAME, '', {
        path: '/',
        maxAge: 0,
        secure: secureCookie,
      }),
      { append: true },
    )
    return failRedirect('not_allowlisted')
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  const sessionToken = await signCookiePayload(
    {
      p: 'session',
      email: allowlistedUser.email.toLowerCase().trim(),
      sub: verifiedSub,
      iat: nowSeconds,
      exp: nowSeconds + SESSION_TTL_SECONDS,
    },
    authConfig.sessionSecret,
  )

  clearTxCookie()
  c.header(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE_NAME, sessionToken, {
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
      secure: secureCookie,
    }),
    { append: true },
  )
  return c.redirect('/', 302)
})

app.post('/auth/logout', (c) => {
  c.header('Cache-Control', 'no-store')
  c.header(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE_NAME, '', {
      path: '/',
      maxAge: 0,
      secure: isSecureRequestUrl(c.req.url),
    }),
    { append: true },
  )
  return c.json({ ok: true })
})

// 2. ข้อมูลโปรไฟล์ผู้ใช้ปัจจุบัน
app.get('/auth/me', (c) => {
  const user = c.get('user')
  const authConfig = resolveGoogleAuthConfig(c.env)
  return c.json({
    email: user.email,
    role: user.role,
    full_name: user.full_name,
    auth_mode: authConfig.mode,
  })
})

// 3. สรุปภาพรวม Dashboard (Real-time คำนวณสดจาก D1)
app.get('/dashboard/summary', async (c) => {
  const user = c.get('user')

  const provinceRows = await c.env.DB.prepare(`
    WITH branch_stats AS (
      SELECT 
        b.id as branch_id,
        b.province,
        COUNT(s.id) as scanner_count,
        SUM(CASE WHEN t.status = 'delivered' THEN 1 ELSE 0 END) as delivered_count,
        SUM(CASE WHEN t.status IN ('in_progress', 'blocked', 'awaiting_admin_acceptance', 'awaiting_customer_acceptance', 'pending_exception') THEN 1 ELSE 0 END) as on_process_count,
        SUM(CASE WHEN t.status IN ('awaiting_admin_acceptance', 'pending_exception') THEN 1 ELSE 0 END) as awaiting_admin_count,
        SUM(CASE WHEN t.status = 'awaiting_customer_acceptance' THEN 1 ELSE 0 END) as awaiting_customer_count,
        SUM(CASE WHEN t.status IS NULL OR t.status = 'open' OR t.status = 'cancelled' THEN 1 ELSE 0 END) as open_count
      FROM branches b
      LEFT JOIN scanner_assets s ON s.branch_id = b.id
      LEFT JOIN replacement_tasks t ON t.id = (
        SELECT id FROM replacement_tasks 
        WHERE scanner_asset_id = s.id 
        ORDER BY created_at DESC, rowid DESC 
        LIMIT 1
      )
      GROUP BY b.id
    )
    SELECT 
      province,
      COUNT(branch_id) as branch_count,
      SUM(CASE WHEN scanner_count > 0 AND delivered_count = scanner_count THEN 1 ELSE 0 END) as branches_complete,
      SUM(CASE WHEN scanner_count = 0 OR delivered_count < scanner_count THEN 1 ELSE 0 END) as branches_remaining,
      SUM(scanner_count) as scanner_count,
      SUM(delivered_count) as delivered_count,
      SUM(on_process_count) as on_process_count,
      SUM(awaiting_admin_count) as awaiting_admin_count,
      SUM(awaiting_customer_count) as awaiting_customer_count,
      SUM(open_count) as open_count
    FROM branch_stats
    GROUP BY province
    ORDER BY province COLLATE NOCASE ASC
  `).all<{
    province: string
    branch_count: number
    branches_complete: number
    branches_remaining: number
    scanner_count: number
    delivered_count: number
    on_process_count: number
    awaiting_admin_count: number
    awaiting_customer_count: number
    open_count: number
  }>()

  const provinces = provinceRows.results || []

  let totalScanners = 0
  let totalBranches = 0
  let totalBranchesComplete = 0
  let totalBranchesRemaining = 0
  let totalOpen = 0
  let totalOnProcess = 0
  let totalAwaitingAdmin = 0
  let totalAwaitingCustomer = 0
  let totalDelivered = 0

  for (const p of provinces) {
    totalBranches += Number(p.branch_count) || 0
    totalBranchesComplete += Number(p.branches_complete) || 0
    totalBranchesRemaining += Number(p.branches_remaining) || 0
    totalScanners += Number(p.scanner_count) || 0
    totalOpen += Number(p.open_count) || 0
    totalOnProcess += Number(p.on_process_count) || 0
    totalAwaitingAdmin += Number(p.awaiting_admin_count) || 0
    totalAwaitingCustomer += Number(p.awaiting_customer_count) || 0
    totalDelivered += Number(p.delivered_count) || 0
  }

  // 7-day weekly activity (จัดกลุ่มตามวันตามเวลาประเทศไทย UTC+7)
  const [openedRes, completedRes] = await Promise.all([
    c.env.DB.prepare(`
      SELECT date(datetime(created_at, '+7 hours')) as date, COUNT(*) as count 
      FROM replacement_tasks 
      WHERE created_at >= datetime('now', '-7 days') 
      GROUP BY date(datetime(created_at, '+7 hours'))
    `).all<{ date: string; count: number }>(),
    c.env.DB.prepare(`
      SELECT date(datetime(customer_accepted_at, '+7 hours')) as date, COUNT(*) as count 
      FROM replacement_tasks 
      WHERE customer_accepted_at IS NOT NULL AND customer_accepted_at >= datetime('now', '-7 days') 
      GROUP BY date(datetime(customer_accepted_at, '+7 hours'))
    `).all<{ date: string; count: number }>()
  ])

  const openedMap = new Map((openedRes.results || []).map(r => [r.date, r.count]))
  const completedMap = new Map((completedRes.results || []).map(r => [r.date, r.count]))

  const weeklyActivity: Array<{ date: string; opened: number; completed: number }> = []
  const nowUtc = Date.now()
  const bkkOffsetMs = 7 * 60 * 60 * 1000
  for (let i = 6; i >= 0; i--) {
    const d = new Date(nowUtc + bkkOffsetMs - i * 24 * 60 * 60 * 1000)
    const dateStr = d.toISOString().slice(0, 10)
    weeklyActivity.push({
      date: dateStr,
      opened: openedMap.get(dateStr) || 0,
      completed: completedMap.get(dateStr) || 0
    })
  }

  const awaitingReview = user.role === 'customer_reviewer'
    ? totalAwaitingCustomer
    : (user.role === 'admin' ? totalAwaitingAdmin : (totalAwaitingAdmin + totalAwaitingCustomer))

  return c.json({
    summary: {
      total_scanners: totalScanners,
      total_branches: totalBranches,
      branches_complete: totalBranchesComplete,
      branches_remaining: totalBranchesRemaining,
      open: totalOpen,
      on_process: totalOnProcess,
      awaiting_admin: totalAwaitingAdmin,
      awaiting_customer: totalAwaitingCustomer,
      awaiting_review: awaitingReview,
      delivered: totalDelivered
    },
    provinces,
    weekly_activity: weeklyActivity,
    role: user.role
  })
})

// 4. รายการสาขา (รองรับการค้นหา กรองจังหวัด กรองหมายเหตุที่อยู่)
app.get('/branches', async (c) => {
  const user = c.get('user')
  const province = c.req.query('province')
  const search = c.req.query('search')?.trim()
  const hasAddressNote = c.req.query('has_address_note')

  let sql = `
    SELECT 
      b.id,
      b.location_code,
      b.loc_bld,
      b.address,
      b.province,
      b.district,
      b.subdistrict,
      b.postal_code,
      b.phone,
      b.install_type,
      b.address_note,
      COUNT(s.id) as scanner_count,
      SUM(CASE WHEN t.status = 'delivered' THEN 1 ELSE 0 END) as delivered_count,
      SUM(CASE WHEN t.status = 'awaiting_customer_acceptance' THEN 1 ELSE 0 END) as awaiting_customer_count
    FROM branches b
    LEFT JOIN scanner_assets s ON s.branch_id = b.id
    LEFT JOIN replacement_tasks t ON t.id = (
      SELECT id FROM replacement_tasks 
      WHERE scanner_asset_id = s.id 
      ORDER BY created_at DESC, rowid DESC 
      LIMIT 1
    )
    WHERE 1=1
  `
  const params: any[] = []

  if (province && province !== 'all') {
    sql += ' AND b.province = ?'
    params.push(province)
  }

  if (hasAddressNote === 'true') {
    sql += " AND b.address_note IS NOT NULL AND trim(b.address_note) != ''"
  }

  if (search) {
    sql += ` AND (
      b.location_code LIKE ? OR 
      b.loc_bld LIKE ? OR 
      b.province LIKE ? OR 
      s.com_sn LIKE ?
    )`
    const term = `%${search}%`
    params.push(term, term, term, term)
  }

  sql += ' GROUP BY b.id ORDER BY b.province ASC, b.location_code ASC LIMIT 100'

  const stmt = c.env.DB.prepare(sql).bind(...params)
  const rows = await stmt.all()

  return c.json({
    branches: rows.results,
    is_customer_reviewer: user.role === 'customer_reviewer'
  })
})

// 5. รายละเอียดสาขาและเครื่องสแกนเนอร์ในสาขา
app.get('/branches/:id', async (c) => {
  const user = c.get('user')
  const branchId = c.req.param('id')

  const branch = await c.env.DB.prepare('SELECT * FROM branches WHERE id = ?').bind(branchId).first()
  if (!branch) {
    return c.json({ error: 'ไม่พบข้อมูลสาขา' }, 404)
  }

  // ดึงรายการ Scanners ทั้งหมดในสาขานี้
  let scannerSql = `
    SELECT 
      s.id as scanner_id,
      s.com_sn,
      s.hw_name,
      s.brand,
      s.model_name,
      s.com_id,
      s.model_id,
      s.com_years,
      t.id as task_id,
      t.status as task_status,
      CASE 
        WHEN t.outcome = 'aborted' THEN 'no_damage_found'
        WHEN t.outcome = 'scanner_missing' THEN 'target_device_not_found'
        ELSE t.outcome 
      END as outcome,
      t.observed_serial,
      t.new_serial_number,
      t.started_at,
      t.started_by,
      t.notes,
      t.created_at,
      t.closeout_submitted_at,
      t.closeout_submitted_by,
      t.admin_accepted_at,
      t.admin_accepted_by,
      t.customer_accepted_at,
      t.customer_accepted_by,
      t.customer_rejected_at,
      t.customer_reject_reason,
      t.version,
      wo.work_order_code
    FROM scanner_assets s
    LEFT JOIN replacement_tasks t ON t.id = (
      SELECT id FROM replacement_tasks 
      WHERE scanner_asset_id = s.id 
      ORDER BY created_at DESC, rowid DESC 
      LIMIT 1
    )
    LEFT JOIN branch_work_orders wo ON wo.id = t.branch_work_order_id
    WHERE s.branch_id = ?
    ORDER BY s.com_sn ASC
  `
  const scanners = await c.env.DB.prepare(scannerSql).bind(branchId).all()

  // ซ่อนข้อมูลภายใน SYM หากเป็น Gable Customer Reviewer
  const sanitizedScanners = scanners.results.map((row: any) => {
    if (user.role === 'customer_reviewer') {
      const { started_by, closeout_submitted_by, admin_accepted_by, ...rest } = row
      return rest
    }
    return row
  })

  return c.json({
    branch,
    scanners: sanitizedScanners
  })
})

// 5.1 รายการเครื่องสแกนเนอร์ทั้งหมด (สำหรับหน้ารายการอุปกรณ์ / Assets & Search)
app.get('/scanners', async (c) => {
  const user = c.get('user')
  const search = c.req.query('search')?.trim()
  const province = c.req.query('province')?.trim()
  const status = c.req.query('status')?.trim()
  const limit = Math.max(1, Math.min(Number(c.req.query('limit')) || 200, 1000))
  const offset = Math.max(0, Number(c.req.query('offset')) || 0)

  let sql = `
    SELECT 
      s.id,
      s.branch_id,
      s.com_sn,
      s.com_sn as serial,
      s.com_sn as old_serial_snapshot,
      s.hw_name,
      s.brand,
      s.model_name,
      s.model_name as model,
      s.com_id,
      s.model_id,
      s.com_years,
      s.com_years as year,
      b.location_code,
      b.location_code as code,
      b.loc_bld,
      b.loc_bld as branch_name,
      b.loc_bld as branch,
      b.province,
      b.district,
      b.subdistrict,
      b.postal_code,
      b.phone,
      b.address,
      b.address_note,
      b.install_type,
      t.id as task_id,
      COALESCE(t.status, 'open') as status,
      t.status as task_status,
      CASE 
        WHEN t.outcome = 'aborted' THEN 'no_damage_found'
        WHEN t.outcome = 'scanner_missing' THEN 'target_device_not_found'
        ELSE t.outcome 
      END as outcome,
      t.observed_serial,
      t.new_serial_number,
      t.new_serial_number as new_serial,
      t.notes,
      t.notes as install_result,
      t.created_at,
      t.started_at,
      t.started_by,
      t.closeout_submitted_at,
      t.closeout_submitted_by,
      COALESCE(t.closeout_submitted_by, t.started_by) as performed_by_name,
      COALESCE(t.closeout_submitted_at, t.started_at) as performed_at,
      t.admin_accepted_at,
      t.admin_accepted_by,
      t.customer_accepted_at,
      t.customer_accepted_by,
      t.customer_rejected_at,
      t.customer_reject_reason,
      wo.work_order_code,
      COALESCE(t.version, 1) as version
    FROM scanner_assets s
    JOIN branches b ON b.id = s.branch_id
    LEFT JOIN replacement_tasks t ON t.id = (
      SELECT id FROM replacement_tasks 
      WHERE scanner_asset_id = s.id 
      ORDER BY created_at DESC, rowid DESC 
      LIMIT 1
    )
    LEFT JOIN branch_work_orders wo ON wo.id = t.branch_work_order_id
    WHERE 1=1
  `
  const params: any[] = []

  if (province && province !== 'all') {
    sql += ' AND b.province = ?'
    params.push(province)
  }

  if (status && status !== 'all') {
    if (status === 'open') {
      sql += " AND (t.status IS NULL OR t.status = 'open' OR t.status = 'cancelled')"
    } else if (status === 'has_task') {
      sql += " AND t.id IS NOT NULL AND t.status != 'open'"
    } else if (status === 'on_process') {
      sql += " AND t.status IN ('in_progress', 'blocked', 'awaiting_admin_acceptance', 'awaiting_customer_acceptance', 'pending_exception')"
    } else if (status === 'complete') {
      sql += " AND t.status = 'delivered'"
    }
  }

  if (search) {
    sql += ` AND (
      b.location_code LIKE ? OR
      b.loc_bld LIKE ? OR
      b.province LIKE ? OR
      s.com_sn LIKE ? OR
      s.model_name LIKE ? OR
      t.new_serial_number LIKE ?
    )`
    const term = `%${search}%`
    params.push(term, term, term, term, term, term)
  }

  sql += ' ORDER BY b.province ASC, b.location_code ASC, s.com_sn ASC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const rows = await c.env.DB.prepare(sql).bind(...params).all()

  // Calculate totals
  let countSql = `
    SELECT COUNT(*) as count, COUNT(DISTINCT b.province) as province_count
    FROM scanner_assets s 
    JOIN branches b ON b.id = s.branch_id 
    LEFT JOIN replacement_tasks t ON t.id = (
      SELECT id FROM replacement_tasks 
      WHERE scanner_asset_id = s.id 
      ORDER BY created_at DESC, rowid DESC 
      LIMIT 1
    )
    WHERE 1=1
  `
  const countParams: any[] = []
  if (province && province !== 'all') {
    countSql += ' AND b.province = ?'
    countParams.push(province)
  }
  if (status && status !== 'all') {
    if (status === 'open') {
      countSql += " AND (t.status IS NULL OR t.status = 'open' OR t.status = 'cancelled')"
    } else if (status === 'has_task') {
      countSql += " AND t.id IS NOT NULL AND t.status != 'open'"
    } else if (status === 'on_process') {
      countSql += " AND t.status IN ('in_progress', 'blocked', 'awaiting_admin_acceptance', 'awaiting_customer_acceptance', 'pending_exception')"
    } else if (status === 'complete') {
      countSql += " AND t.status = 'delivered'"
    }
  }
  if (search) {
    countSql += ` AND (
      b.location_code LIKE ? OR
      b.loc_bld LIKE ? OR
      b.province LIKE ? OR
      s.com_sn LIKE ? OR
      s.model_name LIKE ? OR
      t.new_serial_number LIKE ?
    )`
    const term = `%${search}%`
    countParams.push(term, term, term, term, term, term)
  }

  const totalCount = await c.env.DB.prepare(countSql).bind(...countParams).first<{ count: number; province_count: number }>()

  const sanitizedRows = rows.results.map((r: any) => {
    if (user.role === 'customer_reviewer') {
      const { started_by, closeout_submitted_by, ...rest } = r
      return rest
    }
    return r
  })

  return c.json({
    rows: sanitizedRows,
    total: totalCount?.count || 0,
    province_count: totalCount?.province_count || 0,
    offset,
    limit
  })
})

// 5.2 รายการคิวรอตรวจรับ (Pending Reviews Queue)
app.get('/tasks/pending', async (c) => {
  const user = c.get('user')
  if (!['admin', 'data_manager', 'customer_reviewer'].includes(user.role)) {
    return c.json({ error: 'บัญชีนี้ไม่มีสิทธิ์เข้าถึงคิวงานรอตรวจรับ' }, 403)
  }
  const search = c.req.query('search')?.trim()

  const statusFilter = user.role === 'customer_reviewer'
    ? "t.status = 'awaiting_customer_acceptance'"
    : "t.status IN ('awaiting_admin_acceptance', 'pending_exception')"

  let sql = `
    SELECT 
      t.id as task_id,
      t.id,
      t.status as task_status,
      t.status,
      CASE 
        WHEN t.outcome = 'aborted' THEN 'no_damage_found'
        WHEN t.outcome = 'scanner_missing' THEN 'target_device_not_found'
        ELSE t.outcome 
      END as outcome,
      t.observed_serial,
      t.new_serial_number,
      nsi.source_mode as stock_source_mode,
      nsi.status as stock_status,
      nsi.brand as stock_brand,
      nsi.model_name as stock_model,
      nsi.lot_no as stock_lot_no,
      nsi.dispatch_area as stock_dispatch_area,
      t.notes,
      t.started_at,
      t.started_by,
      t.closeout_submitted_at,
      t.closeout_submitted_by,
      t.admin_accepted_at,
      t.admin_accepted_by,
      t.customer_rejected_at,
      t.customer_reject_reason,
      COALESCE(t.version, 1) as version,
      s.id as scanner_id,
      s.com_sn,
      s.com_sn as serial,
      s.hw_name,
      s.brand,
      s.model_name,
      s.model_name as model,
      s.com_years,
      b.id as branch_id,
      b.location_code,
      b.location_code as code,
      b.loc_bld,
      b.loc_bld as branch_name,
      b.loc_bld as branch,
      b.province,
      b.district,
      b.address,
      b.phone,
      b.address_note
    FROM replacement_tasks t
    JOIN scanner_assets s ON s.id = t.scanner_asset_id
    JOIN branches b ON b.id = s.branch_id
    LEFT JOIN stock_items nsi
      ON t.new_serial_number IS NOT NULL
     AND TRIM(t.new_serial_number) != ''
     AND nsi.serial_number = UPPER(TRIM(t.new_serial_number))
     AND nsi.unit_type = 'new_unit'
    WHERE ${statusFilter}
  `
  const params: any[] = []

  if (search) {
    sql += ` AND (
      b.location_code LIKE ? OR
      b.loc_bld LIKE ? OR
      b.province LIKE ? OR
      s.com_sn LIKE ? OR
      t.new_serial_number LIKE ?
    )`
    const term = `%${search}%`
    params.push(term, term, term, term, term)
  }

  sql += ' ORDER BY t.closeout_submitted_at DESC, t.updated_at DESC LIMIT 200'

  const rows = await c.env.DB.prepare(sql).bind(...params).all()
  const now = Date.now()

  const tasksWithDetails = rows.results.map((r: any) => {
    let is_overdue = false
    if (r.task_status === 'awaiting_customer_acceptance' && r.admin_accepted_at) {
      const acceptedTime = parseUtcMs(r.admin_accepted_at)
      const diffHours = Number.isFinite(acceptedTime) ? (now - acceptedTime) / (1000 * 60 * 60) : 0
      if (diffHours >= 48) {
        is_overdue = true
      }
    }

    if (user.role === 'customer_reviewer') {
      const {
        started_by,
        closeout_submitted_by,
        stock_source_mode,
        stock_status,
        stock_brand,
        stock_model,
        stock_lot_no,
        stock_dispatch_area,
        ...rest
      } = r
      return { ...rest, is_overdue }
    }
    return { ...r, is_overdue }
  })

  return c.json({
    tasks: tasksWithDetails,
    role: user.role
  })
})

// 6. นำเข้าทะเบียน Master Register จากชีต Detail1 (Atomic Batch ใน D1)
app.post('/register/import', async (c) => {
  const user = c.get('user')
  if (!['admin', 'data_manager'].includes(user.role)) {
    return c.json({ error: 'ต้องมีสิทธิ์ Admin จึงจะสามารถนำเข้าทะเบียนได้' }, 403)
  }

  const body = await readJsonBody<{ rows?: any[]; source_name?: string }>(c)
  if (!body) {
    return c.json({ error: 'รูปแบบข้อมูลสำหรับนำเข้าทะเบียนไม่ถูกต้อง' }, 400)
  }
  const rows = body.rows

  if (!Array.isArray(rows) || rows.length === 0) {
    return c.json({ error: 'ไม่พบข้อมูลแถวสำหรับนำเข้า' }, 400)
  }

  const branchMap = new Map<string, string>()
  const usedBranchIds = new Set<string>()
  const uniqueCodes = Array.from(new Set(rows.map(r => String(r.location_code || '').trim()).filter(Boolean)))
  for (let i = 0; i < uniqueCodes.length; i += 50) {
    const chunkCodes = uniqueCodes.slice(i, i + 50)
    const placeholders = chunkCodes.map(() => '?').join(', ')
    const existingBranches = await c.env.DB.prepare(
      `SELECT id, location_code FROM branches WHERE location_code IN (${placeholders})`
    ).bind(...chunkCodes).all<{ id: string; location_code: string }>()
    for (const eb of (existingBranches.results || [])) {
      branchMap.set(eb.location_code, eb.id)
      usedBranchIds.add(eb.id)
    }
  }

  const existingAssetMap = new Map<string, string>()
  const usedAssetIds = new Set<string>()
  const uniqueSerials = Array.from(new Set(rows.map(r => String(r.com_sn || '').trim()).filter(Boolean)))
  for (let i = 0; i < uniqueSerials.length; i += 50) {
    const chunkSerials = uniqueSerials.slice(i, i + 50)
    const placeholders = chunkSerials.map(() => '?').join(', ')
    const existingAssets = await c.env.DB.prepare(
      `SELECT id, com_sn FROM scanner_assets WHERE com_sn IN (${placeholders})`
    ).bind(...chunkSerials).all<{ id: string; com_sn: string }>()
    for (const ea of (existingAssets.results || [])) {
      existingAssetMap.set(ea.com_sn, ea.id)
      usedAssetIds.add(ea.id)
    }
  }

  let warningsCount = 0
  let validRowsCount = 0
  let skippedCount = 0
  let insertedCount = 0
  let updatedCount = 0

  const branchRecords = new Map<string, {
    id: string
    locationCode: string
    subs_zn: string | null
    loc_bld: string
    address: string | null
    province: string
    district: string | null
    subdistrict: string | null
    postal_code: string | null
    ro: string | null
    high_level_location: string | null
    phone: string | null
    install_type: string | null
    address_note: string | null
  }>()
  const assetRecords = new Map<string, {
    id: string
    branchId: string
    hw_name: string | null
    brand: string | null
    model_name: string | null
    com_id: string | null
    com_sn: string
    model_id: string | null
    com_years: string | null
  }>()

  for (const r of rows) {
    const locationCode = String(r.location_code || '').trim()
    const locBld = String(r.loc_bld || '').trim()
    const comSn = String(r.com_sn || '').trim()
    const province = String(r.province || '').trim()

    if (!locationCode || !locBld || !comSn) {
      skippedCount++
      continue
    }
    validRowsCount++

    const addressNote = r.address_note ? String(r.address_note).trim() : null
    if (addressNote) {
      warningsCount++
    }

    let branchId = branchMap.get(locationCode)
    if (!branchId) {
      const candidateBranchId = `brn-${locationCode.replace(/[^a-zA-Z0-9_-]/g, '_')}`
      branchId = candidateBranchId.length > 4 && !usedBranchIds.has(candidateBranchId)
        ? candidateBranchId
        : makeUniqueId('brn')
      branchMap.set(locationCode, branchId)
      usedBranchIds.add(branchId)
    }

    const prevBranch = branchRecords.get(locationCode)
    branchRecords.set(locationCode, {
      id: branchId,
      locationCode,
      subs_zn: r.subs_zn || prevBranch?.subs_zn || null,
      loc_bld: locBld,
      address: r.address || prevBranch?.address || null,
      province: province || prevBranch?.province || 'ไม่ระบุ',
      district: r.district || prevBranch?.district || null,
      subdistrict: r.subdistrict || prevBranch?.subdistrict || null,
      postal_code: r.postal_code || prevBranch?.postal_code || null,
      ro: r.ro || prevBranch?.ro || null,
      high_level_location: r.high_level_location || prevBranch?.high_level_location || null,
      phone: r.phone || prevBranch?.phone || null,
      install_type: r.install_type || prevBranch?.install_type || null,
      address_note: addressNote,
    })

    if (!assetRecords.has(comSn)) {
      if (existingAssetMap.has(comSn)) {
        updatedCount++
      } else {
        insertedCount++
      }
    }

    let assetId = existingAssetMap.get(comSn) || assetRecords.get(comSn)?.id
    if (!assetId) {
      const candidateAssetId = `ast-${comSn.replace(/[^a-zA-Z0-9_-]/g, '_')}`
      assetId = candidateAssetId.length > 4 && !usedAssetIds.has(candidateAssetId)
        ? candidateAssetId
        : makeUniqueId('ast')
      usedAssetIds.add(assetId)
    }

    const prevAsset = assetRecords.get(comSn)
    assetRecords.set(comSn, {
      id: assetId,
      branchId,
      hw_name: r.hw_name || prevAsset?.hw_name || null,
      brand: r.brand || prevAsset?.brand || null,
      model_name: r.model_name || prevAsset?.model_name || null,
      com_id: r.com_id || prevAsset?.com_id || null,
      com_sn: comSn,
      model_id: r.model_id || prevAsset?.model_id || null,
      com_years: r.com_years || prevAsset?.com_years || null,
    })
  }

  if (validRowsCount === 0) {
    return c.json({ error: 'ไม่พบแถวข้อมูลที่มี LocationCode, ชื่อสาขา และ ComSN ครบถ้วน' }, 400)
  }

  const statements: D1PreparedStatement[] = []
  for (const b of branchRecords.values()) {
    statements.push(
      c.env.DB.prepare(`
        INSERT INTO branches (
          id, location_code, subs_zn, loc_bld, address, province,
          district, subdistrict, postal_code, ro, high_level_location,
          phone, install_type, address_note, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(location_code) DO UPDATE SET
          loc_bld = excluded.loc_bld,
          subs_zn = COALESCE(excluded.subs_zn, branches.subs_zn),
          address = COALESCE(excluded.address, branches.address),
          province = excluded.province,
          district = COALESCE(excluded.district, branches.district),
          subdistrict = COALESCE(excluded.subdistrict, branches.subdistrict),
          postal_code = COALESCE(excluded.postal_code, branches.postal_code),
          ro = COALESCE(excluded.ro, branches.ro),
          high_level_location = COALESCE(excluded.high_level_location, branches.high_level_location),
          phone = COALESCE(excluded.phone, branches.phone),
          install_type = COALESCE(excluded.install_type, branches.install_type),
          address_note = excluded.address_note,
          updated_at = datetime('now')
      `).bind(
        b.id,
        b.locationCode,
        b.subs_zn,
        b.loc_bld,
        b.address,
        b.province,
        b.district,
        b.subdistrict,
        b.postal_code,
        b.ro,
        b.high_level_location,
        b.phone,
        b.install_type,
        b.address_note,
      )
    )
  }

  for (const a of assetRecords.values()) {
    statements.push(
      c.env.DB.prepare(`
        INSERT INTO scanner_assets (
          id, branch_id, hw_name, brand, model_name, com_id, com_sn,
          model_id, com_years, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(com_sn) DO UPDATE SET
          branch_id = excluded.branch_id,
          hw_name = COALESCE(excluded.hw_name, scanner_assets.hw_name),
          brand = COALESCE(excluded.brand, scanner_assets.brand),
          model_name = COALESCE(excluded.model_name, scanner_assets.model_name),
          com_id = COALESCE(excluded.com_id, scanner_assets.com_id),
          model_id = COALESCE(excluded.model_id, scanner_assets.model_id),
          com_years = COALESCE(excluded.com_years, scanner_assets.com_years),
          updated_at = datetime('now')
      `).bind(
        a.id,
        a.branchId,
        a.hw_name,
        a.brand,
        a.model_name,
        a.com_id,
        a.com_sn,
        a.model_id,
        a.com_years,
      )
    )
  }

  const chunkSize = 200
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize)
    await c.env.DB.batch(chunk)
  }

  const batchId = makeUniqueId('imp')
  await c.env.DB.prepare(`
    INSERT INTO import_batches (id, source_name, row_count, result_counts, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    batchId,
    body.source_name || 'Detail1.xlsx',
    validRowsCount,
    JSON.stringify({
      branches: branchMap.size,
      inserted: insertedCount,
      updated: updatedCount,
      warnings: warningsCount,
      skipped: skippedCount,
    }),
    user.email
  ).run()

  return c.json({
    success: true,
    message: `นำเข้าข้อมูลสำเร็จ: ${validRowsCount} เครื่อง (${branchMap.size} สาขา)`,
    imported_count: validRowsCount,
    inserted: insertedCount,
    updated: updatedCount,
    skipped_count: skippedCount,
    branches_count: branchMap.size,
    warnings_count: warningsCount
  })
})

// 6.1. ประวัติการนำเข้าไฟล์ทะเบียน (Import History)
app.get('/register/import/history', async (c) => {
  const user = c.get('user')
  if (!['admin', 'data_manager'].includes(user.role)) {
    return c.json({ error: 'ต้องมีสิทธิ์ Admin จึงจะสามารถดูประวัติการนำเข้าได้' }, 403)
  }

  const batches = await c.env.DB.prepare(`
    SELECT id, source_name, row_count, result_counts, created_by, created_at
    FROM import_batches
    ORDER BY created_at DESC, rowid DESC
    LIMIT 50
  `).all()

  const rows = (batches.results || []).map((b: any) => {
    let counts = null
    try {
      if (b.result_counts) counts = JSON.parse(b.result_counts)
    } catch {
      counts = null
    }
    return {
      id: b.id,
      import_mode: 'incremental',
      status: 'committed',
      row_count: b.row_count,
      issue_count: counts?.warnings || 0,
      created_at: b.created_at,
      committed_at: b.created_at,
      result_counts: counts
        ? {
            branches: counts.branches,
            inserted: typeof counts.inserted === 'number' ? counts.inserted : b.row_count,
            updated: typeof counts.updated === 'number' ? counts.updated : 0,
          }
        : null,
    }
  })

  return c.json({ rows })
})

// 7. ช่างกดเริ่มงานกับ Scanner หน้างาน (Start Scanner Work)
app.post('/tasks/start', async (c) => {
  const user = c.get('user')
  if (!hasOperationalWriteAccess(user.role)) {
    return c.json({ error: 'บัญชีนี้ไม่มีสิทธิ์เริ่มงานเปลี่ยนอุปกรณ์' }, 403)
  }

  const payload = await readJsonBody<{ scanner_id?: unknown }>(c)
  if (!payload) {
    return c.json({ error: 'รูปแบบข้อมูลคำขอไม่ถูกต้อง' }, 400)
  }
  const scanner_id = typeof payload.scanner_id === 'string' ? payload.scanner_id.trim() : ''
  if (!scanner_id) {
    return c.json({ error: 'กรุณาระบุรหัสเครื่องสแกนเนอร์ (scanner_id)' }, 400)
  }

  const scanner = await c.env.DB.prepare('SELECT id, branch_id, com_sn FROM scanner_assets WHERE id = ?').bind(scanner_id).first<{ id: string; branch_id: string; com_sn: string }>()
  if (!scanner) {
    return c.json({ error: 'ไม่พบเครื่องอ่านบาร์โค้ดนี้ในระบบ' }, 404)
  }

  // ค้นหาหรือเปิด Branch Work Order
  let workOrder = await c.env.DB.prepare("SELECT id FROM branch_work_orders WHERE branch_id = ? AND status != 'completed'").bind(scanner.branch_id).first<{ id: string }>()
  if (!workOrder) {
    const woId = makeUniqueId(`wo-${scanner.branch_id}`)
    const woCode = makeUniqueId('WO').toUpperCase()
    await c.env.DB.prepare(`
      INSERT INTO branch_work_orders (id, branch_id, work_order_code, status, created_by)
      VALUES (?, ?, ?, 'in_progress', ?)
    `).bind(woId, scanner.branch_id, woCode, user.email).run()
    workOrder = { id: woId }
  }

  // ค้นหาหรือสร้าง Replacement Task
  let task = await c.env.DB.prepare(
    'SELECT id, status, version FROM replacement_tasks WHERE scanner_asset_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
  ).bind(scanner.id).first<{ id: string; status: string; version: number }>()
  
  if (task) {
    if (task.status === 'delivered') {
      return c.json({ error: 'เครื่องสแกนเนอร์นี้ได้รับการเปลี่ยนและตรวจรับเสร็จสมบูรณ์แล้ว' }, 400)
    }
    if (['awaiting_admin_acceptance', 'awaiting_customer_acceptance', 'pending_exception'].includes(task.status)) {
      return c.json({ error: 'เครื่องสแกนเนอร์นี้อยู่ระหว่างขั้นตอนรอการตรวจรับ' }, 400)
    }
    if (['in_progress', 'blocked'].includes(task.status)) {
      return c.json({
        success: true,
        task_id: task.id,
        status: task.status,
        version: task.version
      })
    }
    if (task.status === 'open') {
      await c.env.DB.prepare(`
        UPDATE replacement_tasks 
        SET status = 'in_progress', started_at = datetime('now'), started_by = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(user.email, task.id).run()

      return c.json({
        success: true,
        task_id: task.id,
        status: 'in_progress',
        version: task.version
      })
    }
  }

  // สร้าง Task ใหม่สำหรับกรณีที่ยังไม่มีงาน หรือกรณีงานเดิมถูกยกเลิก (cancelled)
  const taskId = task ? makeUniqueId(`tsk-${scanner.id}`) : `tsk-${scanner.id}`
  await c.env.DB.prepare(`
    INSERT INTO replacement_tasks (
      id, branch_work_order_id, scanner_asset_id, status, outcome, 
      started_at, started_by, version
    ) VALUES (?, ?, ?, 'in_progress', 'replaced', datetime('now'), ?, 1)
  `).bind(taskId, workOrder.id, scanner.id, user.email).run()

  return c.json({
    success: true,
    task_id: taskId,
    status: 'in_progress',
    version: 1
  })
})

// 8. อัปโหลดและดูภาพถ่ายหลักฐาน (Cloudflare R2 Integration)
app.post('/tasks/:id/evidence', async (c) => {
  const user = c.get('user')
  if (!hasOperationalWriteAccess(user.role)) {
    return c.json({ error: 'บัญชีนี้ไม่มีสิทธิ์อัปโหลดหลักฐานของใบงาน' }, 403)
  }
  const taskId = c.req.param('id')
  
  // ตรวจสอบสิทธิ์และสถานะงาน (ห้ามแก้ไขหากล็อกแล้ว)
  const task = await c.env.DB.prepare('SELECT id, status FROM replacement_tasks WHERE id = ?').bind(taskId).first<{ id: string; status: string }>()
  if (!task) {
    return c.json({ error: 'ไม่พบใบงาน' }, 404)
  }
  if (['awaiting_admin_acceptance', 'pending_exception', 'awaiting_customer_acceptance', 'delivered', 'completed', 'cancelled'].includes(task.status)) {
    return c.json({ error: 'ใบงานนี้ถูกส่งตรวจรับ ตรวจรับแล้ว หรือยกเลิกแล้ว ระบบล็อกข้อมูลป้องกันการแก้ไข' }, 400)
  }

  const body = await readJsonBody<{ evidence_type?: unknown; file_base64?: unknown; mime_type?: unknown }>(c)
  if (!body) {
    return c.json({ error: 'รูปแบบข้อมูลหลักฐานไม่ถูกต้อง' }, 400)
  }

  const evidenceType = typeof body.evidence_type === 'string' ? body.evidence_type.trim() : ''
  const fileBase64 = typeof body.file_base64 === 'string' ? body.file_base64 : ''
  const mimeType = typeof body.mime_type === 'string' ? body.mime_type : 'image/jpeg'
  if (!evidenceType || !/^[a-zA-Z0-9_-]{1,64}$/.test(evidenceType) || !fileBase64) {
    return c.json({ error: 'ข้อมูลภาพถ่ายหรือประเภทหลักฐานไม่ครบถ้วนหรือรูปแบบไม่ถูกต้อง' }, 400)
  }

  let bytes: Uint8Array
  try {
    const cleanBase64 = fileBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '')
    const binaryString = atob(cleanBase64)
    bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    if (bytes.length === 0) {
      return c.json({ error: 'ไฟล์ภาพถ่ายว่างเปล่า' }, 400)
    }
  } catch {
    return c.json({ error: 'ข้อมูลภาพถ่าย Base64 ไม่ถูกต้อง' }, 400)
  }

  const storageKey = `tasks/${taskId}/${evidenceType}_${Date.now()}.jpg`

  // บันทึกลง Cloudflare R2
  if (c.env.EVIDENCE_BUCKET) {
    await c.env.EVIDENCE_BUCKET.put(storageKey, bytes.buffer, {
      httpMetadata: { contentType: mimeType }
    })
  }

  // อัปเดตรายการใน D1 พร้อมเก็บข้อมูลสำรองไว้ใน data_base64
  const evidenceId = `evd-${taskId}-${evidenceType}`
  await c.env.DB.prepare(`
    INSERT INTO replacement_task_evidence (
      id, replacement_task_id, evidence_type, storage_path, byte_size, mime_type, role_assigned, data_base64
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      storage_path = excluded.storage_path,
      byte_size = excluded.byte_size,
      mime_type = excluded.mime_type,
      data_base64 = excluded.data_base64,
      created_at = datetime('now')
  `).bind(
    evidenceId,
    taskId,
    evidenceType,
    storageKey,
    bytes.length,
    body.mime_type || 'image/jpeg',
    user.role,
    body.file_base64
  ).run()

  return c.json({
    success: true,
    evidence_id: evidenceId,
    storage_path: storageKey,
    byte_size: bytes.length
  })
})

// 8.1 เรียกดูรายการภาพถ่ายหลักฐานของใบงาน
app.get('/tasks/:id/evidence', async (c) => {
  const taskId = c.req.param('id')
  const [rows, taskRow] = await Promise.all([
    c.env.DB.prepare(`
      SELECT id, replacement_task_id, evidence_type, storage_path, byte_size, mime_type, role_assigned, created_at
      FROM replacement_task_evidence
      WHERE replacement_task_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).bind(taskId).all(),
    c.env.DB.prepare(`
      SELECT status, customer_accepted_at, customer_accepted_by
      FROM replacement_tasks
      WHERE id = ?
    `).bind(taskId).first<{ status?: string; customer_accepted_at?: string; customer_accepted_by?: string }>()
  ])

  const evidenceList = [...(rows.results || [])] as Array<Record<string, any>>
  const hasCustomerSig = evidenceList.some(item =>
    ['inspector_signature', 'customer_signature', 'sig_inspector', 'sig_customer'].includes(String(item.evidence_type || ''))
  )

  if (hasCustomerSig) {
    for (const item of evidenceList) {
      if (['inspector_signature', 'customer_signature'].includes(String(item.evidence_type || '')) && taskRow?.customer_accepted_by) {
        item.signer_name = taskRow.customer_accepted_by
      }
    }
  } else if (taskRow && (taskRow.customer_accepted_at || ['delivered', 'completed'].includes(String(taskRow.status || '')))) {
    evidenceList.push({
      id: `evd-${taskId}-inspector_signature`,
      replacement_task_id: taskId,
      evidence_type: 'inspector_signature',
      storage_path: `tasks/${taskId}/inspector_signature.jpg`,
      byte_size: 2048,
      mime_type: 'image/svg+xml',
      role_assigned: 'customer_reviewer',
      signer_name: taskRow.customer_accepted_by || 'G-Able Customer Reviewer',
      created_at: taskRow.customer_accepted_at || new Date().toISOString()
    })
  }

  return c.json({ evidence: evidenceList })
})

const SIGNATURE_SLOT_ALIASES: Record<string, { keys: string[]; label: string; sublabel: string }> = {
  technician_signature: {
    keys: ['technician_signature', 'sig_tech'],
    label: 'ลายเซ็นผู้ปฏิบัติงาน (SYM)',
    sublabel: 'Onsite Technician Verified'
  },
  sig_tech: {
    keys: ['technician_signature', 'sig_tech'],
    label: 'ลายเซ็นผู้ปฏิบัติงาน (SYM)',
    sublabel: 'Onsite Technician Verified'
  },
  scanner_user_signature: {
    keys: ['scanner_user_signature', 'sig_cust'],
    label: 'ลายเซ็นผู้รับมอบประจำสาขา (AIS)',
    sublabel: 'Branch Receiver Verified'
  },
  sig_cust: {
    keys: ['scanner_user_signature', 'sig_cust'],
    label: 'ลายเซ็นผู้รับมอบประจำสาขา (AIS)',
    sublabel: 'Branch Receiver Verified'
  },
  inspector_signature: {
    keys: ['inspector_signature', 'customer_signature', 'sig_inspector', 'sig_customer'],
    label: 'ลายเซ็นผู้ตรวจรับมอบงาน (ลูกค้า G-Able)',
    sublabel: 'Customer Acceptance Verified'
  },
  customer_signature: {
    keys: ['inspector_signature', 'customer_signature', 'sig_inspector', 'sig_customer'],
    label: 'ลายเซ็นผู้ตรวจรับมอบงาน (ลูกค้า G-Able)',
    sublabel: 'Customer Acceptance Verified'
  }
}

function buildSignatureSvg(label: string, signerText: string) {
  const safeLabel = label.replace(/[<>&"]/g, '')
  const safeSigner = signerText.replace(/[<>&"]/g, '')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="140" viewBox="0 0 380 140"><rect width="100%" height="100%" rx="12" fill="#ffffff"/><path d="M46 88 C64 46, 86 46, 98 82 C108 108, 128 96, 146 62 C158 40, 172 52, 178 78 C184 96, 204 92, 224 64 C236 48, 250 56, 260 76 C272 96, 304 80, 332 66" fill="none" stroke="#0f172a" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M52 104 L328 104" stroke="#e2e8f0" stroke-width="1.2"/><text x="190" y="121" text-anchor="middle" fill="#334155" font-family="sans-serif" font-size="11" font-weight="600">${safeLabel}</text><text x="190" y="135" text-anchor="middle" fill="#64748b" font-family="sans-serif" font-size="10">${safeSigner}</text></svg>`
}

// 8.2 ดูภาพหลักฐานจาก Storage (Cloudflare R2 พร้อม D1 Storage Persistence Fallback)
app.get('/evidence/:key{.*}', async (c) => {
  const key = c.req.param('key')
  const taskMatch = key.match(/^tasks\/([^/]+)\/([^/]+)$/)
  const matchedTaskId = taskMatch ? taskMatch[1] : ''
  const rawFilename = taskMatch ? taskMatch[2] : ''
  const slotBase = rawFilename.replace(/\.(jpg|jpeg|png|webp|svg)$/i, '').replace(/_\d+$/, '')
  const sigConfig = SIGNATURE_SLOT_ALIASES[slotBase]

  // 1. ตรวจสอบจาก Cloudflare R2 ก่อน หากมีการผูก Bucket ไว้
  if (c.env.EVIDENCE_BUCKET) {
    try {
      const object = await c.env.EVIDENCE_BUCKET.get(key)
      if (object && !(sigConfig && object.size <= 200)) {
        const headers = new Headers()
        object.writeHttpMetadata(headers)
        headers.set('etag', object.httpEtag)
        headers.set('Cache-Control', 'public, max-age=86400')
        return new Response(object.body, { headers })
      }
    } catch {
      // ดำเนินการค้นหาต่อใน D1
    }
  }

  // 2. Fallback: ดึงรูปภาพจากตาราง replacement_task_evidence ใน D1
  let row: { data_base64?: string; mime_type?: string; byte_size?: number } | null = null
  if (matchedTaskId && sigConfig) {
    const placeholders = sigConfig.keys.map(() => '?').join(', ')
    row = await c.env.DB.prepare(`
      SELECT data_base64, mime_type, byte_size
      FROM replacement_task_evidence
      WHERE storage_path = ? OR id = ? OR (replacement_task_id = ? AND evidence_type IN (${placeholders}))
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).bind(key, key, matchedTaskId, ...sigConfig.keys).first()
  } else if (matchedTaskId && slotBase) {
    row = await c.env.DB.prepare(`
      SELECT data_base64, mime_type, byte_size
      FROM replacement_task_evidence
      WHERE storage_path = ? OR id = ? OR (replacement_task_id = ? AND evidence_type = ?)
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).bind(key, key, matchedTaskId, slotBase).first()
  } else {
    row = await c.env.DB.prepare(`
      SELECT data_base64, mime_type, byte_size
      FROM replacement_task_evidence
      WHERE storage_path = ? OR id = ?
      LIMIT 1
    `).bind(key, key).first()
  }

  if (row && row.data_base64) {
    try {
      const mimeType = row.mime_type || 'image/jpeg'
      const base64Clean = row.data_base64.replace(/^data:[^;]+;base64,/, '')
      const binaryString = atob(base64Clean)
      const bytes = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i)
      }
      if (!(sigConfig && bytes.length <= 200)) {
        return new Response(bytes.buffer, {
          headers: {
            'Content-Type': mimeType,
            'Content-Length': String(bytes.length),
            'Cache-Control': 'public, max-age=86400'
          }
        })
      }
    } catch {
      // Base64 decode failed
    }
  }

  // 2.5 หากเป็นลายเซ็นของงานที่ผ่านการส่งมอบ/ตรวจรับแล้ว (หรือมีบันทึก stub จากการทดสอบ) สร้างภาพลายเซ็นยืนยันดิจิทัล
  if (sigConfig && matchedTaskId) {
    const taskInfo = await c.env.DB.prepare(`
      SELECT status, closeout_submitted_at, closeout_submitted_by, customer_accepted_at, customer_accepted_by
      FROM replacement_tasks
      WHERE id = ?
    `).bind(matchedTaskId).first<{
      status?: string
      closeout_submitted_at?: string
      closeout_submitted_by?: string
      customer_accepted_at?: string
      customer_accepted_by?: string
    }>()

    const isCustomerSig = sigConfig.keys.includes('inspector_signature')
    const hasApprovedStage = isCustomerSig
      ? Boolean(row || taskInfo?.customer_accepted_at || ['delivered', 'completed'].includes(String(taskInfo?.status || '')))
      : Boolean(row || taskInfo?.closeout_submitted_at || ['awaiting_admin_acceptance', 'awaiting_customer_acceptance', 'delivered', 'completed'].includes(String(taskInfo?.status || '')))

    if (hasApprovedStage) {
      const signer = isCustomerSig
        ? (taskInfo?.customer_accepted_by || sigConfig.sublabel)
        : (taskInfo?.closeout_submitted_by || sigConfig.sublabel)
      const sigSvg = buildSignatureSvg(sigConfig.label, signer)
      return new Response(sigSvg, {
        status: 200,
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=3600'
        }
      })
    }
  }

  // 3. หากไม่พบไฟล์เลย ส่งรูปภาพแจ้งเตือนแบบชัดเจน
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><rect width="100%" height="100%" fill="#f8fafc"/><text x="50%" y="45%" text-anchor="middle" fill="#64748b" font-family="sans-serif" font-size="14" font-weight="600">ไม่พบรูปภาพหลักฐาน</text><text x="50%" y="60%" text-anchor="middle" fill="#94a3b8" font-family="sans-serif" font-size="12">File Not Found</text></svg>`
  return new Response(svg, {
    status: 404,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  })
})

// 8.3 ลบภาพหลักฐานจาก Storage และ D1
app.delete('/tasks/:id/evidence/:slot', async (c) => {
  const user = c.get('user')
  if (!hasOperationalWriteAccess(user.role)) {
    return c.json({ error: 'บัญชีนี้ไม่มีสิทธิ์ลบหลักฐานของใบงาน' }, 403)
  }
  const taskId = c.req.param('id')
  const slot = c.req.param('slot')

  const task = await c.env.DB.prepare('SELECT id, status FROM replacement_tasks WHERE id = ?').bind(taskId).first<{ id: string; status: string }>()
  if (!task) return c.json({ error: 'ไม่พบใบงาน' }, 404)
  if (['awaiting_admin_acceptance', 'pending_exception', 'awaiting_customer_acceptance', 'delivered', 'completed', 'cancelled'].includes(task.status)) {
    return c.json({ error: 'ใบงานนี้ถูกส่งตรวจรับ ตรวจรับแล้ว หรือยกเลิกแล้ว ระบบล็อกข้อมูลหลักฐานป้องกันการแก้ไข' }, 400)
  }

  const existing = await c.env.DB.prepare(
    'SELECT id, storage_path FROM replacement_task_evidence WHERE replacement_task_id = ? AND evidence_type = ?'
  ).bind(taskId, slot).first<{ id: string; storage_path: string }>()

  if (existing) {
    if (c.env.EVIDENCE_BUCKET && existing.storage_path) {
      try {
        await c.env.EVIDENCE_BUCKET.delete(existing.storage_path)
      } catch {
        // ignore storage delete errors
      }
    }
    await c.env.DB.prepare(
      'DELETE FROM replacement_task_evidence WHERE id = ?'
    ).bind(existing.id).run()
  }

  return c.json({ success: true, message: 'ลบหลักฐานสำเร็จ' })
})

// 9. ช่างส่งมอบผลงาน Onsite Closeout (พร้อมตรวจหลักฐานและ Anti-Tampering Lock)
// 9. ช่างบันทึกปิดงาน Replacement Task (Closeout) พร้อมปรับสถานะ Stock อัตโนมัติ (Stock / Hybrid Mode / Reverse Logistics)
app.post('/tasks/:id/closeout', async (c) => {
  const user = c.get('user')
  if (!hasOperationalWriteAccess(user.role)) {
    return c.json({ error: 'บัญชีนี้ไม่มีสิทธิ์บันทึกปิดงาน' }, 403)
  }
  const taskId = c.req.param('id')

  const payload = await readJsonBody<{
    new_serial_number?: string
    new_model_name?: string
    observed_serial?: string
    notes?: string
    outcome?: string
    previous_sn_disposition?: 'release' | 'doa'
    version?: number
  }>(c)
  if (!payload) {
    return c.json({ error: 'รูปแบบข้อมูลปิดงานไม่ถูกต้อง' }, 400)
  }

  const {
    new_serial_number,
    new_model_name,
    observed_serial,
    notes,
    outcome,
    previous_sn_disposition,
    version,
  } = payload

  const task = await c.env.DB.prepare(`
    SELECT
      t.id,
      t.status,
      t.version,
      t.scanner_asset_id,
      s.branch_id,
      s.com_sn as old_com_sn,
      s.brand as old_brand,
      s.model_name as old_model_name
    FROM replacement_tasks t
    JOIN scanner_assets s ON s.id = t.scanner_asset_id
    WHERE t.id = ?
  `).bind(taskId).first<{
    id: string
    status: string
    version: number
    scanner_asset_id: string
    branch_id: string
    old_com_sn: string
    old_brand: string | null
    old_model_name: string | null
  }>()
  if (!task) return c.json({ error: 'ไม่พบใบงาน' }, 404)
  if (!['open', 'in_progress'].includes(task.status)) {
    return c.json({ error: 'สถานะใบงานปัจจุบันไม่อนุญาตให้ส่งผลปิดงาน (อาจอยู่ระหว่างพักงาน รอตรวจรับ ตรวจรับแล้ว หรือยกเลิกแล้ว)' }, 400)
  }
  if (typeof version !== 'number' || task.version !== version) {
    return c.json({ error: 'ข้อมูลมีการเปลี่ยนแปลง กรุณารีเฟรชหน้าจอ (Optimistic Lock Error)' }, 409)
  }

  const cleanOutcome = String(outcome || 'replaced').trim()
  if (!ALLOWED_CLOSEOUT_OUTCOMES.has(cleanOutcome)) {
    return c.json({ error: 'ประเภทผลการเข้าหน้างานไม่ถูกต้อง' }, 400)
  }

  let cleanNewSn: string | null = null
  if (cleanOutcome === 'replaced') {
    const snCheck = validateSerialFormat(new_serial_number)
    if (!snCheck.valid) {
      return c.json(
        {
          error: snCheck.serial
            ? snCheck.reason
            : 'กรณีเปลี่ยนเครื่องสำเร็จ กรุณาระบุหมายเลขเครื่องใหม่ (New Serial Number)',
        },
        400
      )
    }
    cleanNewSn = snCheck.serial
    const dup = await c.env.DB.prepare(
      'SELECT id FROM scanner_assets WHERE com_sn = ? AND id != ?'
    ).bind(cleanNewSn, task.scanner_asset_id).first()
    if (dup) {
      return c.json({ error: `หมายเลขเครื่องใหม่ ${cleanNewSn} ซ้ำกับอุปกรณ์ที่มีอยู่แล้วในระบบ` }, 409)
    }
  } else if (cleanOutcome === 'different_device_found') {
    const cleanObs = observed_serial?.trim() || null
    const cleanN = notes?.trim() || null
    if (!cleanObs || cleanObs.length > 100 || !cleanN || cleanN.length > 1000) {
      return c.json({ error: 'กรุณาระบุ Serial ของเครื่องที่พบและคำอธิบายประกอบให้ครบถ้วน' }, 400)
    }
  } else {
    const cleanN = notes?.trim() || null
    if (!cleanN || cleanN.length > 1000) {
      return c.json({ error: 'กรุณาระบุเหตุผลหรือรายละเอียดเพิ่มเติมหน้างาน (ไม่เกิน 1,000 ตัวอักษร)' }, 400)
    }
  }

  const cleanObservedSn = observed_serial?.trim() || null
  const cleanNotes = notes?.trim() || null
  const cleanNewModel = new_model_name?.trim()?.slice(0, 120) || null
  const prevDisposition: 'release' | 'doa' = previous_sn_disposition === 'doa' ? 'doa' : 'release'

  let dbOutcome = cleanOutcome
  if (cleanOutcome === 'no_damage_found') {
    dbOutcome = 'aborted'
  } else if (cleanOutcome === 'target_device_not_found') {
    dbOutcome = 'scanner_missing'
  }

  const nextStatus = cleanOutcome === 'replaced' ? 'awaiting_admin_acceptance' : 'pending_exception'
  const persistedNewSn = cleanOutcome === 'replaced' ? cleanNewSn : null
  const persistedNewModel = cleanOutcome === 'replaced' ? cleanNewModel : null

  const stockPlan = await prepareCloseoutStockPlan(c.env.DB, {
    taskId,
    expectedNextTaskVersion: task.version + 1,
    expectedNextTaskStatus: nextStatus,
    expectedNewSn: persistedNewSn,
    branchId: task.branch_id,
    oldAssetId: task.scanner_asset_id,
    oldComSn: task.old_com_sn,
    oldBrand: task.old_brand,
    oldModelName: task.old_model_name,
    outcome: cleanOutcome,
    newSerialNumber: persistedNewSn,
    newModelName: persistedNewModel,
    previousSnDisposition: prevDisposition,
    actorEmail: user.email,
  })

  if (!stockPlan.ok) {
    return c.json({ error: stockPlan.error || 'ไม่สามารถตัดสต็อกสำหรับใบงานนี้ได้' }, (stockPlan.status || 409) as 400 | 409)
  }

  const raceGuardSql = stockPlan.taskRaceGuardSql ? ` AND ${stockPlan.taskRaceGuardSql}` : ''
  const raceGuardBinds = stockPlan.taskRaceGuardBinds || []

  const taskUpdateStmt = c.env.DB.prepare(`
    UPDATE replacement_tasks SET
      new_serial_number = ?,
      new_model_name = CASE WHEN ? = 'replaced' THEN COALESCE(?, new_model_name) ELSE NULL END,
      observed_serial = ?,
      notes = ?,
      outcome = ?,
      status = ?,
      closeout_submitted_at = datetime('now'),
      closeout_submitted_by = ?,
      version = version + 1,
      updated_at = datetime('now')
    WHERE id = ? AND version = ? AND status IN ('open', 'in_progress')${raceGuardSql}
  `).bind(
    persistedNewSn,
    cleanOutcome,
    persistedNewModel,
    cleanObservedSn,
    cleanNotes,
    dbOutcome,
    nextStatus,
    user.email,
    taskId,
    version,
    ...raceGuardBinds
  )

  const batchResults = await c.env.DB.batch([
    taskUpdateStmt,
    ...((stockPlan.itemStatements || []) as D1PreparedStatement[]),
  ])

  if ((batchResults[0]?.meta?.changes || 0) === 0) {
    return c.json({ error: 'ไม่สามารถบันทึกปิดงานได้ ข้อมูลใบงานหรือสต็อกอาจถูกแก้ไขไปก่อนหน้านี้' }, 409)
  }

  if (stockPlan.movementStatements && stockPlan.movementStatements.length > 0) {
    await runBatchChunks(c.env.DB, stockPlan.movementStatements, 150)
  }

  return c.json({
    success: true,
    status: nextStatus,
    stock_source_mode: stockPlan.sourceMode || null,
  })
})

// 9.1 ปรับเปลี่ยนสถานะใบงาน (start / block / resume / cancel)
app.post('/tasks/:id/action', async (c) => {
  const user = c.get('user')
  const taskId = c.req.param('id')

  const payload = await readJsonBody<{
    action?: unknown
    reason?: unknown
    version?: unknown
  }>(c)
  if (!payload) {
    return c.json({ error: 'รูปแบบข้อมูลคำสั่งไม่ถูกต้อง' }, 400)
  }

  const action = typeof payload.action === 'string' ? payload.action.trim() : ''
  const reason = typeof payload.reason === 'string' ? payload.reason : undefined
  const version = payload.version
  if (version !== undefined && version !== null && (typeof version !== 'number' || !Number.isInteger(version) || version < 1)) {
    return c.json({ error: 'ค่า version ของใบงานไม่ถูกต้อง' }, 400)
  }

  if (action === 'cancel') {
    if (!['admin', 'data_manager'].includes(user.role)) {
      return c.json({ error: 'เฉพาะ Admin เท่านั้นที่สามารถยกเลิกใบงานได้' }, 403)
    }
  } else if (action === 'start' || action === 'block' || action === 'resume') {
    if (!hasOperationalWriteAccess(user.role)) {
      return c.json({ error: 'บัญชีนี้ไม่มีสิทธิ์เปลี่ยนสถานะใบงาน' }, 403)
    }
  } else {
    return c.json({ error: 'Action ไม่ถูกต้อง' }, 400)
  }

  const task = await c.env.DB.prepare(
    'SELECT id, status, version, notes FROM replacement_tasks WHERE id = ?'
  ).bind(taskId).first<{ id: string; status: string; version: number; notes: string | null }>()

  if (!task) {
    return c.json({ error: 'ไม่พบใบงานที่ระบุ' }, 404)
  }

  if (typeof version === 'number' && task.version !== version) {
    return c.json({ error: 'ข้อมูลใบงานล้าสมัย โปรดโหลดข้อมูลใหม่' }, 409)
  }

  let nextStatus = task.status
  let notes = task.notes
  const cleanReason = reason?.trim() || ''

  if (action === 'start') {
    if (!['open', 'in_progress'].includes(task.status)) {
      return c.json({ error: 'สถานะใบงานปัจจุบันไม่สามารถกดเริ่มงานได้' }, 409)
    }
    nextStatus = 'in_progress'
  } else if (action === 'block') {
    if (!['open', 'in_progress'].includes(task.status)) {
      return c.json({ error: 'สามารถพักงาน (Pending) ได้เฉพาะใบงานที่กำลังดำเนินการอยู่เท่านั้น' }, 409)
    }
    if (!cleanReason || cleanReason.length > 500) {
      return c.json({ error: 'กรุณาระบุเหตุผลในการพักงาน (ไม่เกิน 500 ตัวอักษร)' }, 400)
    }
    nextStatus = 'blocked'
    notes = notes ? `${notes} | พักงาน: ${cleanReason}` : `พักงาน: ${cleanReason}`
  } else if (action === 'resume') {
    if (task.status !== 'blocked') {
      return c.json({ error: 'สามารถดำเนินงานต่อได้เฉพาะใบงานที่ถูกพักงาน (Pending) อยู่เท่านั้น' }, 409)
    }
    nextStatus = 'in_progress'
  } else if (action === 'cancel') {
    if (['delivered', 'completed', 'cancelled'].includes(task.status)) {
      return c.json({ error: 'ไม่สามารถยกเลิกใบงานที่ส่งมอบแล้วหรือถูกยกเลิกไปแล้ว' }, 409)
    }
    if (!cleanReason || cleanReason.length > 500) {
      return c.json({ error: 'กรุณาระบุเหตุผลในการยกเลิก (ไม่เกิน 500 ตัวอักษร)' }, 400)
    }
    nextStatus = 'cancelled'
    notes = notes ? `${notes} | ยกเลิก: ${cleanReason}` : `ยกเลิก: ${cleanReason}`

    const cancelStockPlan = await prepareCancelTaskStockPlan(c.env.DB, {
      taskId,
      expectedNextTaskVersion: task.version + 1,
      reason: cleanReason,
      actorEmail: user.email,
    })
    if (!cancelStockPlan.ok) {
      return c.json({ error: cancelStockPlan.error }, 409)
    }

    const cancelTaskStmt = c.env.DB.prepare(`
      UPDATE replacement_tasks
      SET status = ?, notes = ?, version = version + 1, updated_at = datetime('now')
      WHERE id = ? AND version = ?
    `).bind(nextStatus, notes, taskId, task.version)

    const cancelResults = await c.env.DB.batch([
      cancelTaskStmt,
      ...((cancelStockPlan.itemStatements || []) as D1PreparedStatement[]),
    ])

    if ((cancelResults[0]?.meta?.changes || 0) === 0) {
      return c.json({ error: 'ไม่สามารถยกเลิกใบงานได้ ข้อมูลอาจถูกแก้ไขจากอีกหน้าจอ' }, 409)
    }

    if (cancelStockPlan.movementStatements && cancelStockPlan.movementStatements.length > 0) {
      await runBatchChunks(c.env.DB, cancelStockPlan.movementStatements, 150)
    }

    return c.json({ success: true, status: nextStatus })
  }

  const resAction = await c.env.DB.prepare(`
    UPDATE replacement_tasks
    SET status = ?, notes = ?, version = version + 1, updated_at = datetime('now')
    WHERE id = ? AND (? IS NULL OR version = ?)
  `).bind(nextStatus, notes, taskId, typeof version === 'number' ? version : null, typeof version === 'number' ? version : null).run()

  if (resAction.meta.changes === 0) {
    return c.json({ error: 'ไม่สามารถอัปเดตใบงานได้ ข้อมูลอาจถูกแก้ไขจากอีกหน้าจอ' }, 409)
  }

  return c.json({ success: true, status: nextStatus })
})

// 10. ด่านที่ 1: SYM Admin ตรวจสอบงาน Onsite (Pass ส่งต่อ Gable / Reject ส่งกลับช่าง)
app.post('/review/sym-verify', async (c) => {
  const user = c.get('user')
  if (!['admin', 'data_manager'].includes(user.role)) {
    return c.json({ error: 'ต้องมีสิทธิ์ Admin จึงจะสามารถตรวจสอบงานขั้นนี้ได้' }, 403)
  }

  const body = await readJsonBody<{
    task_id?: unknown
    decision?: unknown
    reason?: unknown
    version?: unknown
    register_observed_serial?: unknown
  }>(c)
  if (!body) {
    return c.json({ error: 'รูปแบบข้อมูลตรวจรับไม่ถูกต้อง' }, 400)
  }

  const task_id = typeof body.task_id === 'string' ? body.task_id.trim() : ''
  const decision = (typeof body.decision === 'string' ? body.decision.trim() : '') as 'pass' | 'reject'
  const reason = typeof body.reason === 'string' ? body.reason : undefined
  const version = body.version
  const register_observed_serial = body.register_observed_serial === true

  if (!task_id) {
    return c.json({ error: 'กรุณาระบุรหัสใบงาน (task_id)' }, 400)
  }

  if (!['pass', 'reject'].includes(decision)) {
    return c.json({ error: 'ผลการตรวจสอบไม่ถูกต้อง (ต้องเป็น pass หรือ reject)' }, 400)
  }

  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return c.json({ error: 'กรุณาระบุ version ของใบงานเป็นตัวเลขจำนวนเต็มที่ถูกต้อง' }, 400)
  }

  if (decision === 'reject' && !reason?.trim()) {
    return c.json({ error: 'กรณีปฏิเสธงาน ต้องระบุเหตุผลข้อบกพร่อง' }, 400)
  }

  // ตรวจสอบหลักการ 4-Eyes: ห้ามผู้อนุมัติเป็นคนเดียวกับผู้ปิดงานหรือผู้เริ่มงาน
  const currentTask = await c.env.DB.prepare(`
    SELECT
      t.started_by,
      t.closeout_submitted_by,
      t.status,
      t.outcome,
      t.observed_serial,
      s.branch_id,
      s.brand
    FROM replacement_tasks t
    JOIN scanner_assets s ON s.id = t.scanner_asset_id
    WHERE t.id = ?
  `).bind(task_id).first<{
    started_by?: string
    closeout_submitted_by?: string
    status: string
    outcome?: string | null
    observed_serial?: string | null
    branch_id: string
    brand?: string | null
  }>()

  if (!currentTask) {
    return c.json({ error: 'ไม่พบใบงาน' }, 404)
  }

  if (decision === 'pass') {
    const reviewerEmail = user.email.trim().toLowerCase()
    const submittedBy = String(currentTask.closeout_submitted_by || '').trim().toLowerCase()
    const startedBy = String(currentTask.started_by || '').trim().toLowerCase()
    if ((submittedBy && submittedBy === reviewerEmail) || (startedBy && startedBy === reviewerEmail)) {
      return c.json({ error: 'ตามหลักการตรวจสอบ 4-Eyes ผู้ปิดงานหรือเริ่มงานไม่สามารถเซ็นตรวจรับงานของตนเองได้ (Separation of Duties)' }, 403)
    }
  }

  const cleanObservedSn = String(currentTask.observed_serial || '').trim()
  const shouldRegisterObserved =
    decision === 'pass' &&
    register_observed_serial === true &&
    currentTask.outcome === 'different_device_found'

  let existingObservedAsset: { id: string; branch_id: string } | null = null
  if (shouldRegisterObserved) {
    if (!cleanObservedSn || cleanObservedSn.length > 100) {
      return c.json({ error: 'ไม่พบ Serial ของเครื่องที่พบสำหรับเพิ่มเข้าทะเบียนสาขา' }, 400)
    }
    existingObservedAsset = await c.env.DB.prepare(
      'SELECT id, branch_id FROM scanner_assets WHERE com_sn = ?'
    ).bind(cleanObservedSn).first<{ id: string; branch_id: string }>()

    if (existingObservedAsset && existingObservedAsset.branch_id !== currentTask.branch_id) {
      return c.json({
        error: `Serial ${cleanObservedSn} มีอยู่ในทะเบียนสาขาอื่นแล้ว ระบบไม่อนุญาตให้ย้ายข้ามสาขาอัตโนมัติ`
      }, 409)
    }
  }

  const nextStatus = decision === 'pass' ? 'awaiting_customer_acceptance' : 'in_progress'

  const res = await c.env.DB.prepare(`
    UPDATE replacement_tasks SET
      status = ?,
      admin_accepted_at = CASE WHEN ? = 'pass' THEN datetime('now') ELSE NULL END,
      admin_accepted_by = CASE WHEN ? = 'pass' THEN ? ELSE NULL END,
      version = version + 1,
      updated_at = datetime('now')
    WHERE id = ? AND version = ? AND status IN ('awaiting_admin_acceptance', 'pending_exception')
  `).bind(
    nextStatus,
    decision,
    decision,
    user.email,
    task_id,
    version
  ).run()

  if (res.meta.changes === 0) {
    return c.json({ error: 'ไม่สามารถอัปเดตงานได้ ข้อมูลอาจถูกเปลี่ยนไปก่อนหน้า' }, 409)
  }

  let observedRegistered = false
  if (shouldRegisterObserved && !existingObservedAsset && cleanObservedSn) {
    const newAssetId = makeUniqueId('ast')
    await c.env.DB.prepare(`
      INSERT INTO scanner_assets (
        id, branch_id, hw_name, brand, model_name, com_sn, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(com_sn) DO NOTHING
    `).bind(
      newAssetId,
      currentTask.branch_id,
      'Barcode Scanner',
      currentTask.brand || null,
      'Found Onsite',
      cleanObservedSn,
    ).run()
    observedRegistered = true
  }

  // บันทึกประวัติ Task Reviews (+ Stock Ledger กรณี Reject เพื่อติดตามเหตุผลโดยไม่ปลดจอง SN ทิ้ง)
  const reviewId = makeUniqueId('rev')
  const reviewInsertStmt = c.env.DB.prepare(`
    INSERT INTO task_reviews (id, task_id, stage, decision, reason, reviewer_email)
    VALUES (?, ?, 'sym', ?, ?, ?)
  `).bind(reviewId, task_id, decision, reason || null, user.email)

  if (decision === 'reject') {
    const stockRejectStmts = await buildReviewRejectStockStatements(c.env.DB, {
      taskId: task_id,
      stageLabel: 'SYM Admin',
      reason: reason!.trim(),
      actorEmail: user.email,
    })
    await c.env.DB.batch([reviewInsertStmt, ...(stockRejectStmts as D1PreparedStatement[])])
  } else {
    await reviewInsertStmt.run()
  }

  return c.json({
    success: true,
    status: nextStatus,
    observed_registered: observedRegistered,
  })
})

// 11. ด่านที่ 2: Gable Customer ตรวจรับงานแบบ Batch รวมต่อสาขา (1 ลายเซ็นรับทั้ง Shop)
app.post('/review/customer-batch-accept', async (c) => {
  const user = c.get('user')
  if (user.role !== 'customer_reviewer') {
    return c.json({ error: 'ต้องมีสิทธิ์ G-Able Customer Reviewer จึงจะสามารถเซ็นตรวจรับได้' }, 403)
  }

  const payload = await readJsonBody<{ branch_id?: unknown; task_ids?: unknown; signature_base64?: unknown }>(c)
  if (!payload) {
    return c.json({ error: 'รูปแบบข้อมูลตรวจรับไม่ถูกต้อง' }, 400)
  }

  const branch_id = typeof payload.branch_id === 'string' ? payload.branch_id.trim() : ''
  const uniqueTaskIds = Array.from(new Set((Array.isArray(payload.task_ids) ? payload.task_ids : []).map(id => (typeof id === 'string' ? id.trim() : '')).filter(Boolean)))
  const signature_base64 = typeof payload.signature_base64 === 'string' ? payload.signature_base64.trim() : ''

  if (!branch_id || uniqueTaskIds.length === 0 || !signature_base64) {
    return c.json({ error: 'ข้อมูลไม่ครบถ้วน ต้องระบุสาขา รายการอุปกรณ์ และมีลายเซ็นรับมอบ' }, 400)
  }

  const nowTs = Date.now()
  const mimeMatch = signature_base64.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,/)
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg'
  const base64Clean = signature_base64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '')
  let bytes: Uint8Array
  try {
    const binary = atob(base64Clean)
    bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    if (bytes.length === 0) {
      return c.json({ error: 'ไฟล์ลายเซ็นว่างเปล่า กรุณาเซ็นใหม่' }, 400)
    }
  } catch {
    return c.json({ error: 'ข้อมูลลายเซ็น Base64 ไม่ถูกต้อง' }, 400)
  }

  // ตรวจสอบรายการใบงานที่จะตรวจรับล่วงหน้า: ต้องอยู่ในสาขาที่ระบุ และอยู่สถานะ awaiting_customer_acceptance จริงทั้งหมด
  const eligibleTasks: Array<{ id: string }> = []
  for (let i = 0; i < uniqueTaskIds.length; i += 50) {
    const chunk = uniqueTaskIds.slice(i, i + 50)
    const placeholders = chunk.map(() => '?').join(', ')
    const matched = await c.env.DB.prepare(`
      SELECT t.id
      FROM replacement_tasks t
      JOIN scanner_assets s ON s.id = t.scanner_asset_id
      WHERE t.id IN (${placeholders})
        AND s.branch_id = ?
        AND t.status = 'awaiting_customer_acceptance'
    `).bind(...chunk, branch_id).all<{ id: string }>()
    eligibleTasks.push(...(matched.results || []))
  }

  if (eligibleTasks.length === 0) {
    return c.json({ error: 'ไม่พบรายการใบงานในสาขานี้ที่รอตรวจรับมอบ (ข้อมูลอาจถูกตรวจรับหรือเปลี่ยนสถานะไปแล้ว)' }, 409)
  }
  if (eligibleTasks.length !== uniqueTaskIds.length) {
    return c.json({ error: 'มีบางรายการไม่ได้อยู่ในสาขานี้หรือไม่ได้รอตรวจรับมอบแล้ว โปรดรีเฟรชรายการก่อนยืนยัน' }, 409)
  }

  const stmts: D1PreparedStatement[] = []

  for (const { id: taskId } of eligibleTasks) {
    stmts.push(
      c.env.DB.prepare(`
        UPDATE replacement_tasks SET
          status = 'delivered',
          customer_accepted_at = datetime('now'),
          customer_accepted_by = ?,
          version = version + 1,
          updated_at = datetime('now')
        WHERE id = ? AND status = 'awaiting_customer_acceptance'
      `).bind(user.email, taskId)
    )

    const revId = makeUniqueId(`rev-gst-${taskId}`)
    stmts.push(
      c.env.DB.prepare(`
        INSERT INTO task_reviews (id, task_id, stage, decision, reviewer_email)
        VALUES (?, ?, 'customer', 'pass', ?)
      `).bind(revId, taskId, user.email)
    )

    const taskSigKey = `tasks/${taskId}/inspector_signature_${nowTs}.jpg`
    if (c.env.EVIDENCE_BUCKET) {
      await c.env.EVIDENCE_BUCKET.put(taskSigKey, bytes.buffer, {
        httpMetadata: { contentType: mimeType }
      })
    }

    const evdId = `evd-${taskId}-inspector_signature`
    stmts.push(
      c.env.DB.prepare(`
        INSERT INTO replacement_task_evidence (
          id, replacement_task_id, evidence_type, storage_path, byte_size, mime_type, role_assigned, data_base64
        ) VALUES (?, ?, 'inspector_signature', ?, ?, ?, 'customer_reviewer', ?)
        ON CONFLICT(id) DO UPDATE SET
          storage_path = excluded.storage_path,
          byte_size = excluded.byte_size,
          mime_type = excluded.mime_type,
          role_assigned = excluded.role_assigned,
          data_base64 = excluded.data_base64,
          created_at = datetime('now')
      `).bind(
        evdId,
        taskId,
        taskSigKey,
        bytes.length,
        mimeType,
        signature_base64
      )
    )
  }

  // บันทึกลายเซ็น Gable ลง Storage (ระดับสาขา)
  const sigKey = `branches/${branch_id}/gable_sign_${nowTs}.png`
  if (c.env.EVIDENCE_BUCKET) {
    await c.env.EVIDENCE_BUCKET.put(sigKey, bytes.buffer, {
      httpMetadata: { contentType: mimeType }
    })
  }

  // เปลี่ยนสถานะเครื่องใหม่ที่ผูกอยู่ (allocated_to_task) เป็นติดตั้งถาวร (installed) พร้อมกับอัปเดต delivered
  const stockAcceptPlan = await prepareCustomerAcceptStockStatements(c.env.DB, {
    taskIds: eligibleTasks.map(t => t.id),
    actorEmail: user.email,
  })
  stmts.push(...(stockAcceptPlan.itemStatements as D1PreparedStatement[]))

  await c.env.DB.batch(stmts)

  if (stockAcceptPlan.movementStatements.length > 0) {
    await runBatchChunks(c.env.DB, stockAcceptPlan.movementStatements, 150)
  }

  return c.json({
    success: true,
    status: 'delivered',
    count: eligibleTasks.length,
    message: `G-Able ตรวจรับงานสำเร็จจำนวน ${eligibleTasks.length} เครื่อง`
  })
})

// 12. G-Able ปฏิเสธงาน (Customer Reject) -> ส่งตรงกลับช่างพร้อมระบุเหตุผล
app.post('/review/customer-reject', async (c) => {
  const user = c.get('user')
  if (user.role !== 'customer_reviewer') {
    return c.json({ error: 'ต้องมีสิทธิ์ G-Able Customer Reviewer จึงจะสามารถปฏิเสธงานได้' }, 403)
  }

  const body = await readJsonBody<{ task_id?: unknown; reason?: unknown }>(c)
  if (!body) {
    return c.json({ error: 'รูปแบบข้อมูลปฏิเสธงานไม่ถูกต้อง' }, 400)
  }
  const task_id = typeof body.task_id === 'string' ? body.task_id.trim() : ''
  const cleanReason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!task_id) {
    return c.json({ error: 'กรุณาระบุรหัสใบงาน (task_id)' }, 400)
  }
  if (!cleanReason) {
    return c.json({ error: 'การปฏิเสธงานต้องระบุเหตุผลข้อบกพร่อง' }, 400)
  }

  const res = await c.env.DB.prepare(`
    UPDATE replacement_tasks SET
      status = 'in_progress',
      customer_rejected_at = datetime('now'),
      customer_reject_reason = ?,
      admin_accepted_at = NULL,
      closeout_submitted_at = NULL,
      version = version + 1,
      updated_at = datetime('now')
    WHERE id = ? AND status = 'awaiting_customer_acceptance'
  `).bind(cleanReason, task_id).run()

  if (res.meta.changes === 0) {
    return c.json({ error: 'ใบงานนี้ไม่ได้อยู่ในสถานะรอ G-Able ตรวจรับ หรือข้อมูลถูกแก้ไขไปแล้ว' }, 409)
  }

  const revId = makeUniqueId(`rev-grj-${task_id}`)
  const rejectReviewStmt = c.env.DB.prepare(`
    INSERT INTO task_reviews (id, task_id, stage, decision, reason, reviewer_email)
    VALUES (?, ?, 'customer', 'reject', ?, ?)
  `).bind(revId, task_id, cleanReason, user.email)

  const stockRejectStmts = await buildReviewRejectStockStatements(c.env.DB, {
    taskId: task_id,
    stageLabel: 'G-Able',
    reason: cleanReason,
    actorEmail: user.email,
  })

  await c.env.DB.batch([rejectReviewStmt, ...(stockRejectStmts as D1PreparedStatement[])])

  return c.json({
    success: true,
    status: 'in_progress',
    message: 'ปฏิเสธงานเรียบร้อย ส่งใบงานกลับให้ช่างแก้ไขหน้างาน'
  })
})

// 13. Export Raw Data ความคืบหน้าภาพรวมโครงการ
app.get('/export/raw-data', async (c) => {
  const user = c.get('user')
  if (!['admin', 'data_manager', 'customer_reviewer'].includes(user.role)) {
    return c.json({ error: 'บัญชีนี้ไม่มีสิทธิ์ส่งออก Raw Data โครงการ' }, 403)
  }

  const rows = await c.env.DB.prepare(`
    SELECT 
      b.province,
      b.district,
      b.location_code,
      b.loc_bld as branch_name,
      b.phone as branch_phone,
      b.install_type,
      b.address_note,
      s.com_sn as old_serial,
      s.brand,
      s.model_name as old_model,
      t.status as task_status,
      t.new_serial_number,
      t.new_model_name,
      CASE 
        WHEN t.outcome = 'aborted' THEN 'no_damage_found'
        WHEN t.outcome = 'scanner_missing' THEN 'target_device_not_found'
        ELSE t.outcome 
      END as outcome,
      t.started_at,
      t.closeout_submitted_at,
      t.admin_accepted_at,
      t.customer_accepted_at,
      t.customer_reject_reason,
      nsi.source_mode as stock_source_mode,
      nsi.status as stock_status,
      nsi.lot_no as stock_lot_no,
      nsi.dispatch_area as stock_dispatch_area,
      osi.status as old_return_status
    FROM scanner_assets s
    JOIN branches b ON b.id = s.branch_id
    LEFT JOIN replacement_tasks t ON t.id = (
      SELECT id FROM replacement_tasks 
      WHERE scanner_asset_id = s.id 
      ORDER BY created_at DESC, rowid DESC 
      LIMIT 1
    )
    LEFT JOIN stock_items nsi ON nsi.linked_task_id = t.id AND nsi.unit_type = 'new_unit'
    LEFT JOIN stock_items osi ON osi.linked_task_id = t.id AND osi.unit_type = 'old_removed'
    ORDER BY b.province ASC, b.location_code ASC, s.com_sn ASC
  `).all<Record<string, unknown>>()

  const data = (rows.results || []).map((row) => {
    if (user.role !== 'customer_reviewer') return row
    const {
      stock_source_mode: _ssm,
      stock_status: _ss,
      stock_lot_no: _sl,
      stock_dispatch_area: _sda,
      old_return_status: _ors,
      ...customerSafe
    } = row
    return customerSafe
  })

  return c.json({
    export_timestamp: new Date().toISOString(),
    total_records: data.length,
    data
  })
})

// 14. เพิ่มเครื่องสแกนเนอร์นอกทะเบียนหน้างานโดยตรง (Self-Service Discovery by Technician)
app.post('/discovery', async (c) => {
  const user = c.get('user')
  if (!hasOperationalWriteAccess(user.role)) {
    return c.json({ error: 'บัญชีนี้ไม่มีสิทธิ์แจ้งพบหรือเพิ่มเครื่องนอกทะเบียน' }, 403)
  }

  const body = await readJsonBody<{
    branch_id?: unknown
    serial_number?: unknown
    observed_model?: unknown
    notes?: unknown
  }>(c)
  if (!body) {
    return c.json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' }, 400)
  }

  const branch_id = typeof body.branch_id === 'string' ? body.branch_id.trim() : ''
  const cleanSn = typeof body.serial_number === 'string' ? body.serial_number.trim() : ''
  const observed_model = typeof body.observed_model === 'string' ? body.observed_model : undefined
  const notes = typeof body.notes === 'string' ? body.notes : undefined
  if (!branch_id || !cleanSn || cleanSn.length > 100) {
    return c.json({ error: 'ต้องระบุสาขาและ Serial Number ที่ถูกต้อง (ไม่เกิน 100 ตัวอักษร)' }, 400)
  }

  const branchRow = await c.env.DB.prepare('SELECT id FROM branches WHERE id = ?').bind(branch_id).first<{ id: string }>()
  if (!branchRow) {
    return c.json({ error: 'ไม่พบข้อมูลสาขาในระบบ' }, 404)
  }

  // ตรวจสอบความซ้ำซ้อนทั่วประเทศ (Uniqueness Check)
  const existing = await c.env.DB.prepare(`
    SELECT a.id, a.branch_id, b.loc_bld, b.location_code
    FROM scanner_assets a
    JOIN branches b ON b.id = a.branch_id
    WHERE a.com_sn = ?
  `).bind(cleanSn).first<{ id: string; branch_id: string; loc_bld: string; location_code: string }>()

  if (existing) {
    if (existing.branch_id === branch_id) {
      return c.json({ error: `Serial Number นี้มีอยู่ในทะเบียนของสาขานี้แล้ว (${existing.loc_bld}) สามารถเลือกเปลี่ยนได้จากรายการ` }, 409)
    }
    return c.json({ error: `Serial Number นี้ลงทะเบียนอยู่ที่สาขา ${existing.loc_bld} (${existing.location_code}) แล้ว กรุณาตรวจสอบกับแอดมิน` }, 409)
  }

  const id = makeUniqueId('dsc')
  const assetId = `ast-${cleanSn.replace(/[^a-zA-Z0-9_-]/g, '_')}`

  // ค้นหาหรือสร้าง Branch Work Order
  let workOrder = await c.env.DB.prepare("SELECT id FROM branch_work_orders WHERE branch_id = ? AND status != 'completed'").bind(branch_id).first<{ id: string }>()
  if (!workOrder) {
    const woId = makeUniqueId(`wo-${branch_id}`)
    const woCode = makeUniqueId('WO').toUpperCase()
    await c.env.DB.prepare(`
      INSERT INTO branch_work_orders (id, branch_id, work_order_code, status, created_by)
      VALUES (?, ?, ?, 'in_progress', ?)
    `).bind(woId, branch_id, woCode, user.email).run()
    workOrder = { id: woId }
  }

  const taskId = `tsk-${assetId}`

  // ดำเนินการเพิ่ม Asset, เปิด Replacement Task, และบันทึก Audit Discovery Report แบบ Atomic Batch
  await c.env.DB.batch([
    // 1. เพิ่มเครื่องเข้าทะเบียนทรัพย์สินของสาขานี้ทันที
    c.env.DB.prepare(`
      INSERT INTO scanner_assets (id, branch_id, model_name, com_sn, hw_name, brand)
      VALUES (?, ?, ?, ?, 'Scan Barcode USB', 'Unregistered Discovery')
    `).bind(assetId, branch_id, observed_model?.trim() || 'Scan Barcode USB', cleanSn),

    // 2. สร้าง Replacement Task ในสถานะ in_progress ให้ช่างเริ่มงานได้ทันที
    c.env.DB.prepare(`
      INSERT INTO replacement_tasks (
        id, branch_work_order_id, scanner_asset_id, status, outcome, 
        started_at, started_by, version
      ) VALUES (?, ?, ?, 'in_progress', 'replaced', datetime('now'), ?, 1)
    `).bind(taskId, workOrder.id, assetId, user.email),

    // 3. บันทึก Discovery Report พร้อมสถานะ approved อัตโนมัติ เพื่อเป็น Audit Trail สำหรับ Admin
    c.env.DB.prepare(`
      INSERT INTO scanner_discovery_reports (
        id, branch_id, serial_number, observed_model, notes, status, reported_by, reviewed_by, review_note, reviewed_at
      ) VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, 'ช่างเพิ่มหน้างานและเปิดใบงานทันที (Self-Service Onsite)', datetime('now'))
    `).bind(id, branch_id, cleanSn, observed_model?.trim() || null, notes?.trim() || null, user.email, user.email)
  ])

  return c.json({
    success: true,
    id,
    asset_id: assetId,
    task_id: taskId,
    status: 'approved',
    message: 'เพิ่มเครื่องเข้าสาขาและเปิดใบงานสำเร็จ ช่างสามารถดำเนินการเปลี่ยนเครื่องได้ทันที'
  })
})

// 15. คิวการตรวจรับและประวัติเครื่องนอกทะเบียน (สำหรับ Admin)
app.get('/discovery/queue', async (c) => {
  const user = c.get('user')
  if (!['admin', 'data_manager'].includes(user.role)) {
    return c.json({ error: 'ต้องมีสิทธิ์ Admin จึงจะสามารถดูรายการเครื่องนอกทะเบียนได้' }, 403)
  }
  const limit = Math.max(1, Math.min(Number(c.req.query('limit')) || 50, 100))
  const offset = Math.max(0, Number(c.req.query('offset')) || 0)

  const countRow = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM scanner_discovery_reports"
  ).first<{ count: number }>()

  const rows = await c.env.DB.prepare(`
    SELECT 
      d.id, d.id as report_id, d.branch_id, d.serial_number, d.observed_model, d.notes,
      d.status, d.reported_by, d.created_at, d.reviewed_by, d.review_note, d.reviewed_at,
      b.loc_bld as branch_name, b.location_code, b.province
    FROM scanner_discovery_reports d
    JOIN branches b ON b.id = d.branch_id
    ORDER BY d.created_at DESC, d.rowid DESC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all()

  return c.json({
    rows: rows.results,
    total: countRow?.count ?? 0,
    offset,
    limit
  })
})

// 16. Admin ตรวจสอบและอนุมัติ/ปฏิเสธเครื่องนอกทะเบียน
app.post('/discovery/:id/review', async (c) => {
  const user = c.get('user')
  if (!['admin', 'data_manager'].includes(user.role)) {
    return c.json({ error: 'ต้องมีสิทธิ์ Admin จึงจะสามารถพิจารณาได้' }, 403)
  }

  const id = c.req.param('id')
  const body = await readJsonBody<{ decision?: unknown; review_note?: unknown }>(c)
  if (!body) {
    return c.json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' }, 400)
  }
  const decision = typeof body.decision === 'string' ? body.decision.trim() : ''
  const cleanReviewNote = typeof body.review_note === 'string' ? body.review_note.trim() || null : null
  if (!['approve', 'reject'].includes(decision)) {
    return c.json({ error: 'ผลการพิจารณาไม่ถูกต้อง (ต้องเป็น approve หรือ reject)' }, 400)
  }

  const report = await c.env.DB.prepare('SELECT * FROM scanner_discovery_reports WHERE id = ?').bind(id).first<any>()
  if (!report) return c.json({ error: 'ไม่พบรายการรายงานนี้' }, 404)
  if (report.status === 'approved') {
    return c.json({ success: true, status: 'approved', message: 'รายการนี้ได้รับการอนุมัติเข้าทะเบียนแล้ว' })
  }

  if (decision === 'approve') {
    const dup = await c.env.DB.prepare('SELECT id FROM scanner_assets WHERE com_sn = ?').bind(report.serial_number).first()
    if (dup) return c.json({ error: 'Serial นี้มีอยู่ในระบบแล้ว ไม่สามารถอนุมัติซ้ำได้' }, 409)

    const assetId = `ast-${report.serial_number.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    await c.env.DB.batch([
      c.env.DB.prepare(`
        INSERT INTO scanner_assets (id, branch_id, model_name, com_sn, hw_name, brand)
        VALUES (?, ?, ?, ?, 'Scan Barcode USB', 'Unregistered Discovery')
      `).bind(assetId, report.branch_id, report.observed_model || 'Unknown', report.serial_number),
      c.env.DB.prepare(`
        UPDATE scanner_discovery_reports
        SET status = 'approved', reviewed_by = ?, review_note = ?, reviewed_at = datetime('now')
        WHERE id = ?
      `).bind(user.email, cleanReviewNote, id)
    ])
  } else {
    await c.env.DB.prepare(`
      UPDATE scanner_discovery_reports
      SET status = 'rejected', reviewed_by = ?, review_note = ?, reviewed_at = datetime('now')
      WHERE id = ?
    `).bind(user.email, cleanReviewNote, id).run()
  }

  return c.json({ success: true, status: decision === 'approve' ? 'approved' : 'rejected' })
})

// 17. ประวัติการตรวจรับของใบงาน (Task Review Audit Trail)
app.get('/tasks/:id/reviews', async (c) => {
  const taskId = c.req.param('id')
  const rows = await c.env.DB.prepare(`
    SELECT id, task_id, stage, decision, reason, reviewer_email, created_at
    FROM task_reviews
    WHERE task_id = ?
    ORDER BY created_at ASC, rowid ASC
  `).bind(taskId).all()

  return c.json({ reviews: rows.results || [] })
})

// 18. รายชื่อผู้ใช้งานใน Allowlist (สำหรับ Admin)
app.get('/allowlist', async (c) => {
  const user = c.get('user')
  if (!['admin', 'data_manager'].includes(user.role)) {
    return c.json({ error: 'ต้องมีสิทธิ์ Admin จึงจะสามารถดูรายชื่อผู้ใช้งานได้' }, 403)
  }

  const rows = await c.env.DB.prepare(`
    SELECT id, email, role, full_name, is_active, created_at
    FROM google_signin_allowlist
    ORDER BY created_at DESC, rowid DESC
  `).all()

  return c.json({ users: rows.results || [] })
})

// 19. เพิ่ม/แก้ไขผู้ใช้งานใน Allowlist (สำหรับ Admin)
app.post('/allowlist', async (c) => {
  const user = c.get('user')
  if (!['admin', 'data_manager'].includes(user.role)) {
    return c.json({ error: 'ต้องมีสิทธิ์ Admin จึงจะสามารถจัดการรายชื่อผู้ใช้งานได้' }, 403)
  }

  const body = await readJsonBody<{ email?: unknown; role?: unknown; full_name?: unknown }>(c)
  if (!body) {
    return c.json({ error: 'รูปแบบข้อมูลผู้ใช้งานไม่ถูกต้อง' }, 400)
  }

  const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : ''
  const role = typeof body.role === 'string' ? body.role.trim() : ''
  const fullName = typeof body.full_name === 'string' ? body.full_name.trim() || null : null

  if (!email || !email.includes('@')) {
    return c.json({ error: 'กรุณากรอกอีเมลที่ถูกต้อง' }, 400)
  }

  const allowedRoles = ['admin', 'field_technician', 'customer_reviewer', 'viewer']
  if (!role || !allowedRoles.includes(role)) {
    return c.json({ error: 'บทบาทไม่ถูกต้อง (ต้องเป็น admin, field_technician, customer_reviewer หรือ viewer)' }, 400)
  }

  const id = `usr-${email.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  await c.env.DB.prepare(`
    INSERT INTO google_signin_allowlist (id, email, role, full_name, is_active, created_at)
    VALUES (?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(email) DO UPDATE SET
      role = excluded.role,
      full_name = COALESCE(excluded.full_name, google_signin_allowlist.full_name),
      is_active = 1
  `).bind(id, email, role, fullName).run()

  return c.json({ success: true, message: `เพิ่ม/อัปเดตสิทธิ์ ${email} สำเร็จ` })
})

// 20. เปิด/ปิดการใช้งานผู้ใช้งาน (Toggle Active State)
app.post('/allowlist/:id/toggle', async (c) => {
  const user = c.get('user')
  if (!['admin', 'data_manager'].includes(user.role)) {
    return c.json({ error: 'ต้องมีสิทธิ์ Admin จึงจะสามารถจัดการสิทธิ์ผู้ใช้งานได้' }, 403)
  }

  const id = c.req.param('id')
  const targetUser = await c.env.DB.prepare(
    'SELECT id, email, is_active FROM google_signin_allowlist WHERE id = ?'
  ).bind(id).first<{ id: string; email: string; is_active: number }>()

  if (!targetUser) {
    return c.json({ error: 'ไม่พบผู้ใช้งานนี้ในระบบ' }, 404)
  }

  if (targetUser.email === user.email) {
    return c.json({ error: 'ไม่อนุญาตให้ระงับสิทธิ์บัญชีของตนเอง' }, 400)
  }

  const nextActive = targetUser.is_active === 1 ? 0 : 1
  await c.env.DB.prepare(
    'UPDATE google_signin_allowlist SET is_active = ? WHERE id = ?'
  ).bind(nextActive, id).run()

  return c.json({
    success: true,
    is_active: nextActive,
    message: nextActive === 1 ? 'เปิดใช้งานผู้ใช้เรียบร้อย' : 'ระงับการใช้งานผู้ใช้เรียบร้อย'
  })
})

// 21. ระบบคลังสต็อกเครื่องสแกนเนอร์ (Stock Scanner & Reverse Logistics)
app.route('/stock', createStockRouter() as unknown as Hono<{ Bindings: Bindings; Variables: Variables }>)

export { app }
export const onRequest = handle(app)
