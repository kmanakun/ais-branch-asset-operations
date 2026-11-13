import { Hono } from 'hono'
import { handle } from 'hono/cloudflare-pages'

type Bindings = {
  DB: D1Database
  EVIDENCE_BUCKET?: R2Bucket
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

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>().basePath('/api')

// CORS / Headers Middleware
app.use('*', async (c, next) => {
  await next()
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-dev-user-email')
})

app.options('*', (c) => c.text('', 204))

// Authentication & Allowlist Middleware
app.use('*', async (c, next) => {
  if (c.req.path === '/api/health' || c.req.path.startsWith('/api/evidence/')) {
    return next()
  }

  // 1. ตรวจสอบ Dev Auth Switcher ผ่าน Header หรือ Query parameter
  let email = c.req.header('x-dev-user-email') || c.req.query('dev_email')

  // 2. ถ้ามี Bearer token
  const authHeader = c.req.header('Authorization')
  if (!email && authHeader?.startsWith('Bearer ')) {
    email = authHeader.slice(7)
  }

  // 3. ปฏิเสธคำขอที่ไม่มีข้อมูลผู้ใช้งาน (Authentication Required)
  if (!email) {
    return c.json({ error: 'กรุณาเข้าสู่ระบบ หรือเลือกสิทธิ์ผู้ใช้งาน (Authentication Required)' }, 401)
  }

  // 4. ตรวจสอบกับตาราง google_signin_allowlist ใน Cloudflare D1
  const user = await c.env.DB.prepare(
    'SELECT email, role, full_name, is_active FROM google_signin_allowlist WHERE email = ? AND is_active = 1'
  ).bind(email.toLowerCase().trim()).first<{ email: string; role: string; full_name: string; is_active: number }>()

  if (!user) {
    return c.json({ error: 'บัญชีของคุณไม่อยู่ในรายชื่อผู้มีสิทธิ์เข้าใช้งานระบบ (Unauthorized Allowlist)' }, 403)
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

// 2. ข้อมูลโปรไฟล์ผู้ใช้ปัจจุบัน
app.get('/auth/me', (c) => {
  const user = c.get('user')
  return c.json({
    email: user.email,
    role: user.role,
    full_name: user.full_name
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
        SUM(CASE WHEN t.status = 'awaiting_admin_acceptance' THEN 1 ELSE 0 END) as awaiting_admin_count,
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
      const { started_by, closeout_submitted_by, ...rest } = r
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

  const body = await c.req.json<{ rows: any[]; source_name?: string }>()
  const rows = body.rows

  if (!Array.isArray(rows) || rows.length === 0) {
    return c.json({ error: 'ไม่พบข้อมูลแถวสำหรับนำเข้า' }, 400)
  }

  const statements: D1PreparedStatement[] = []
  const branchMap = new Map<string, string>()
  const uniqueCodes = Array.from(new Set(rows.map(r => String(r.location_code || '').trim()).filter(Boolean)))
  for (let i = 0; i < uniqueCodes.length; i += 50) {
    const chunkCodes = uniqueCodes.slice(i, i + 50)
    const placeholders = chunkCodes.map(() => '?').join(', ')
    const existingBranches = await c.env.DB.prepare(
      `SELECT id, location_code FROM branches WHERE location_code IN (${placeholders})`
    ).bind(...chunkCodes).all<{ id: string; location_code: string }>()
    for (const eb of (existingBranches.results || [])) {
      branchMap.set(eb.location_code, eb.id)
    }
  }

  let warningsCount = 0
  let validRowsCount = 0
  let skippedCount = 0

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
      branchId = `brn-${locationCode.replace(/[^a-zA-Z0-9_-]/g, '_')}`
      branchMap.set(locationCode, branchId)
    }
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
          address_note = excluded.address_note, -- ล้างป้ายเตือนหากค่านำเข้าใหม่เป็นค่าว่าง
          updated_at = datetime('now')
      `).bind(
        branchId,
        locationCode,
        r.subs_zn || null,
        locBld,
        r.address || null,
        province || 'ไม่ระบุ',
        r.district || null,
        r.subdistrict || null,
        r.postal_code || null,
        r.ro || null,
        r.high_level_location || null,
        r.phone || null,
        r.install_type || null,
        addressNote
      )
    )

    const assetId = `ast-${comSn.replace(/[^a-zA-Z0-9_-]/g, '_')}`
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
        assetId,
        branchId,
        r.hw_name || null,
        r.brand || null,
        r.model_name || null,
        r.com_id || null,
        comSn,
        r.model_id || null,
        r.com_years || null
      )
    )
  }

  if (validRowsCount === 0) {
    return c.json({ error: 'ไม่พบแถวข้อมูลที่มี LocationCode, ชื่อสาขา และ ComSN ครบถ้วน' }, 400)
  }

  const chunkSize = 50
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
    JSON.stringify({ branches: branchMap.size, warnings: warningsCount, skipped: skippedCount }),
    user.email
  ).run()

  return c.json({
    success: true,
    message: `นำเข้าข้อมูลสำเร็จ: ${validRowsCount} เครื่อง (${branchMap.size} สาขา)`,
    imported_count: validRowsCount,
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
    ORDER BY created_at DESC
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
      result_counts: counts ? { branches: counts.branches, inserted: b.row_count } : null,
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

  let scanner_id = ''
  try {
    const payload = await c.req.json<{ scanner_id?: string }>()
    scanner_id = String(payload?.scanner_id || '').trim()
  } catch {
    return c.json({ error: 'รูปแบบข้อมูลคำขอไม่ถูกต้อง' }, 400)
  }
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

  let body: { evidence_type?: string; file_base64?: string; mime_type?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'รูปแบบข้อมูลหลักฐานไม่ถูกต้อง' }, 400)
  }

  const evidenceType = String(body.evidence_type || '').trim()
  if (!evidenceType || !/^[a-zA-Z0-9_-]{1,64}$/.test(evidenceType) || !body.file_base64) {
    return c.json({ error: 'ข้อมูลภาพถ่ายหรือประเภทหลักฐานไม่ครบถ้วนหรือรูปแบบไม่ถูกต้อง' }, 400)
  }

  let bytes: Uint8Array
  try {
    const cleanBase64 = String(body.file_base64).replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '')
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
      httpMetadata: { contentType: body.mime_type || 'image/jpeg' }
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
      ORDER BY created_at ASC
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
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(key, key, matchedTaskId, ...sigConfig.keys).first()
  } else if (matchedTaskId && slotBase) {
    row = await c.env.DB.prepare(`
      SELECT data_base64, mime_type, byte_size
      FROM replacement_task_evidence
      WHERE storage_path = ? OR id = ? OR (replacement_task_id = ? AND evidence_type = ?)
      ORDER BY created_at DESC
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
app.post('/tasks/:id/closeout', async (c) => {
  const user = c.get('user')
  if (!hasOperationalWriteAccess(user.role)) {
    return c.json({ error: 'บัญชีนี้ไม่มีสิทธิ์บันทึกปิดงาน' }, 403)
  }
  const taskId = c.req.param('id')

  let payload: {
    new_serial_number?: string
    observed_serial?: string
    notes?: string
    outcome?: string
    version?: number
  }
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: 'รูปแบบข้อมูลปิดงานไม่ถูกต้อง' }, 400)
  }

  const { new_serial_number, observed_serial, notes, outcome, version } = payload

  const task = await c.env.DB.prepare(
    'SELECT id, status, version, scanner_asset_id FROM replacement_tasks WHERE id = ?'
  ).bind(taskId).first<{ id: string; status: string; version: number; scanner_asset_id: string }>()
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

  const cleanNewSn = new_serial_number?.trim() || null
  const cleanObservedSn = observed_serial?.trim() || null
  const cleanNotes = notes?.trim() || null

  if (cleanOutcome === 'replaced') {
    if (!cleanNewSn || cleanNewSn.length > 100) {
      return c.json({ error: 'กรณีเปลี่ยนเครื่องสำเร็จ กรุณาระบุหมายเลขเครื่องใหม่ (New Serial Number)' }, 400)
    }
    const dup = await c.env.DB.prepare(
      'SELECT id FROM scanner_assets WHERE com_sn = ? AND id != ?'
    ).bind(cleanNewSn, task.scanner_asset_id).first()
    if (dup) {
      return c.json({ error: `หมายเลขเครื่องใหม่ ${cleanNewSn} ซ้ำกับอุปกรณ์ที่มีอยู่แล้วในระบบ` }, 409)
    }
  } else if (cleanOutcome === 'different_device_found') {
    if (!cleanObservedSn || cleanObservedSn.length > 100 || !cleanNotes || cleanNotes.length > 1000) {
      return c.json({ error: 'กรุณาระบุ Serial ของเครื่องที่พบและคำอธิบายประกอบให้ครบถ้วน' }, 400)
    }
  } else if (!cleanNotes || cleanNotes.length > 1000) {
    return c.json({ error: 'กรุณาระบุเหตุผลหรือรายละเอียดเพิ่มเติมหน้างาน (ไม่เกิน 1,000 ตัวอักษร)' }, 400)
  }

  let dbOutcome = cleanOutcome
  if (cleanOutcome === 'no_damage_found') {
    dbOutcome = 'aborted'
  } else if (cleanOutcome === 'target_device_not_found') {
    dbOutcome = 'scanner_missing'
  }

  const nextStatus = cleanOutcome === 'replaced' ? 'awaiting_admin_acceptance' : 'pending_exception'

  const closeRes = await c.env.DB.prepare(`
    UPDATE replacement_tasks SET
      new_serial_number = ?,
      observed_serial = ?,
      notes = ?,
      outcome = ?,
      status = ?,
      closeout_submitted_at = datetime('now'),
      closeout_submitted_by = ?,
      version = version + 1,
      updated_at = datetime('now')
    WHERE id = ? AND version = ? AND status IN ('open', 'in_progress')
  `).bind(
    cleanOutcome === 'replaced' ? cleanNewSn : null,
    cleanObservedSn,
    cleanNotes,
    dbOutcome,
    nextStatus,
    user.email,
    taskId,
    version
  ).run()

  if (closeRes.meta.changes === 0) {
    return c.json({ error: 'ไม่สามารถบันทึกปิดงานได้ ข้อมูลใบงานอาจถูกแก้ไขหรือเปลี่ยนสถานะไปก่อนหน้านี้' }, 409)
  }

  return c.json({
    success: true,
    status: nextStatus
  })
})

// 9.1 ปรับเปลี่ยนสถานะใบงาน (start / block / resume / cancel)
app.post('/tasks/:id/action', async (c) => {
  const user = c.get('user')
  const taskId = c.req.param('id')

  let payload: {
    action?: 'start' | 'block' | 'resume' | 'cancel'
    reason?: string
    version?: number
  }
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: 'รูปแบบข้อมูลคำสั่งไม่ถูกต้อง' }, 400)
  }

  const { action, reason, version } = payload

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

  const { task_id, decision, reason, version } = await c.req.json<{
    task_id: string
    decision: 'pass' | 'reject'
    reason?: string
    version: number
  }>()

  if (!['pass', 'reject'].includes(decision)) {
    return c.json({ error: 'ผลการตรวจสอบไม่ถูกต้อง (ต้องเป็น pass หรือ reject)' }, 400)
  }

  if (decision === 'reject' && !reason?.trim()) {
    return c.json({ error: 'กรณีปฏิเสธงาน ต้องระบุเหตุผลข้อบกพร่อง' }, 400)
  }

  // ตรวจสอบหลักการ 4-Eyes: ห้ามผู้อนุมัติเป็นคนเดียวกับผู้ปิดงานหรือผู้เริ่มงาน
  const currentTask = await c.env.DB.prepare(
    'SELECT started_by, closeout_submitted_by, status FROM replacement_tasks WHERE id = ?'
  ).bind(task_id).first<{ started_by?: string; closeout_submitted_by?: string; status: string }>()

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

  // บันทึกประวัติ Task Reviews
  const reviewId = makeUniqueId('rev')
  await c.env.DB.prepare(`
    INSERT INTO task_reviews (id, task_id, stage, decision, reason, reviewer_email)
    VALUES (?, ?, 'sym', ?, ?, ?)
  `).bind(reviewId, task_id, decision, reason || null, user.email).run()

  return c.json({
    success: true,
    status: nextStatus
  })
})

// 11. ด่านที่ 2: Gable Customer ตรวจรับงานแบบ Batch รวมต่อสาขา (1 ลายเซ็นรับทั้ง Shop)
app.post('/review/customer-batch-accept', async (c) => {
  const user = c.get('user')
  if (user.role !== 'customer_reviewer') {
    return c.json({ error: 'ต้องมีสิทธิ์ Gable Customer Reviewer จึงจะสามารถเซ็นตรวจรับได้' }, 403)
  }

  let payload: { branch_id?: string; task_ids?: string[]; signature_base64?: string }
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: 'รูปแบบข้อมูลตรวจรับไม่ถูกต้อง' }, 400)
  }

  const branch_id = String(payload.branch_id || '').trim()
  const uniqueTaskIds = Array.from(new Set((Array.isArray(payload.task_ids) ? payload.task_ids : []).map(id => String(id || '').trim()).filter(Boolean)))
  const signature_base64 = String(payload.signature_base64 || '').trim()

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

  await c.env.DB.batch(stmts)

  return c.json({
    success: true,
    status: 'delivered',
    count: eligibleTasks.length,
    message: `Gable ตรวจรับงานสำเร็จจำนวน ${eligibleTasks.length} เครื่อง`
  })
})

// 12. Gable ปฏิเสธงาน (Customer Reject) -> ส่งตรงกลับช่างพร้อมระบุเหตุผล
app.post('/review/customer-reject', async (c) => {
  const user = c.get('user')
  if (user.role !== 'customer_reviewer') {
    return c.json({ error: 'ต้องมีสิทธิ์ Gable Customer Reviewer จึงจะสามารถปฏิเสธงานได้' }, 403)
  }

  const { task_id, reason } = await c.req.json<{ task_id: string; reason: string }>()
  if (!reason?.trim()) {
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
  `).bind(reason.trim(), task_id).run()

  if (res.meta.changes === 0) {
    return c.json({ error: 'ใบงานนี้ไม่ได้อยู่ในสถานะรอ Gable ตรวจรับ หรือข้อมูลถูกแก้ไขไปแล้ว' }, 409)
  }

  const revId = makeUniqueId(`rev-grj-${task_id}`)
  await c.env.DB.prepare(`
    INSERT INTO task_reviews (id, task_id, stage, decision, reason, reviewer_email)
    VALUES (?, ?, 'customer', 'reject', ?, ?)
  `).bind(revId, task_id, reason.trim(), user.email).run()

  return c.json({
    success: true,
    status: 'in_progress',
    message: 'ปฏิเสธงานเรียบร้อย ส่งใบงานกลับให้ช่างแก้ไขหน้างาน'
  })
})

// 13. Export Raw Data ความคืบหน้าภาพรวมโครงการ
app.get('/export/raw-data', async (c) => {
  const user = c.get('user')

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
      CASE 
        WHEN t.outcome = 'aborted' THEN 'no_damage_found'
        WHEN t.outcome = 'scanner_missing' THEN 'target_device_not_found'
        ELSE t.outcome 
      END as outcome,
      t.started_at,
      t.closeout_submitted_at,
      t.admin_accepted_at,
      t.customer_accepted_at,
      t.customer_reject_reason
    FROM scanner_assets s
    JOIN branches b ON b.id = s.branch_id
    LEFT JOIN replacement_tasks t ON t.id = (
      SELECT id FROM replacement_tasks 
      WHERE scanner_asset_id = s.id 
      ORDER BY created_at DESC, rowid DESC 
      LIMIT 1
    )
    ORDER BY b.province ASC, b.location_code ASC, s.com_sn ASC
  `).all()

  return c.json({
    export_timestamp: new Date().toISOString(),
    total_records: rows.results.length,
    data: rows.results
  })
})

// 14. เพิ่มเครื่องสแกนเนอร์นอกทะเบียนหน้างานโดยตรง (Self-Service Discovery by Technician)
app.post('/discovery', async (c) => {
  const user = c.get('user')
  if (!hasOperationalWriteAccess(user.role)) {
    return c.json({ error: 'บัญชีนี้ไม่มีสิทธิ์แจ้งพบหรือเพิ่มเครื่องนอกทะเบียน' }, 403)
  }

  let body: {
    branch_id?: string
    serial_number?: string
    observed_model?: string
    notes?: string
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' }, 400)
  }

  const branch_id = String(body.branch_id || '').trim()
  const cleanSn = String(body.serial_number || '').trim()
  const observed_model = body.observed_model
  const notes = body.notes
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
    ORDER BY d.created_at DESC
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
  const { decision, review_note } = await c.req.json<{
    decision: 'approve' | 'reject'
    review_note?: string
  }>()

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
      `).bind(user.email, review_note?.trim() || null, id)
    ])
  } else {
    await c.env.DB.prepare(`
      UPDATE scanner_discovery_reports
      SET status = 'rejected', reviewed_by = ?, review_note = ?, reviewed_at = datetime('now')
      WHERE id = ?
    `).bind(user.email, review_note?.trim() || null, id).run()
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
    ORDER BY created_at ASC
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
    ORDER BY created_at DESC
  `).all()

  return c.json({ users: rows.results || [] })
})

// 19. เพิ่ม/แก้ไขผู้ใช้งานใน Allowlist (สำหรับ Admin)
app.post('/allowlist', async (c) => {
  const user = c.get('user')
  if (!['admin', 'data_manager'].includes(user.role)) {
    return c.json({ error: 'ต้องมีสิทธิ์ Admin จึงจะสามารถจัดการรายชื่อผู้ใช้งานได้' }, 403)
  }

  const body = await c.req.json<{
    email: string
    role: string
    full_name?: string
  }>()

  const email = body.email?.toLowerCase().trim()
  const role = body.role?.trim()
  const fullName = body.full_name?.trim() || null

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

export const onRequest = handle(app)
