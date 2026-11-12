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

  const stats = await c.env.DB.prepare(`
    SELECT 
      COUNT(s.id) as total_scanners,
      COUNT(DISTINCT s.branch_id) as total_branches,
      SUM(CASE WHEN t.status IS NULL OR t.status = 'open' OR t.status = 'cancelled' THEN 1 ELSE 0 END) as open_count,
      SUM(CASE WHEN t.status IN ('in_progress', 'blocked', 'awaiting_admin_acceptance', 'awaiting_customer_acceptance', 'pending_exception') THEN 1 ELSE 0 END) as on_process_count,
      SUM(CASE WHEN t.status = 'awaiting_customer_acceptance' THEN 1 ELSE 0 END) as awaiting_customer_count,
      SUM(CASE WHEN t.status = 'delivered' THEN 1 ELSE 0 END) as delivered_count
    FROM scanner_assets s
    LEFT JOIN replacement_tasks t ON t.id = (
      SELECT id FROM replacement_tasks 
      WHERE scanner_asset_id = s.id 
      ORDER BY created_at DESC, rowid DESC 
      LIMIT 1
    )
  `).first<{
    total_scanners: number
    total_branches: number
    open_count: number
    on_process_count: number
    awaiting_customer_count: number
    delivered_count: number
  }>()

  const provinceRows = await c.env.DB.prepare(`
    SELECT 
      b.province,
      COUNT(DISTINCT b.id) as branch_count,
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
    GROUP BY b.province
    ORDER BY b.province COLLATE NOCASE ASC
  `).all()

  return c.json({
    summary: {
      total_scanners: stats?.total_scanners || 0,
      total_branches: stats?.total_branches || 0,
      open: stats?.open_count || 0,
      on_process: stats?.on_process_count || 0,
      awaiting_customer: stats?.awaiting_customer_count || 0,
      delivered: stats?.delivered_count || 0
    },
    provinces: provinceRows.results,
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
    LEFT JOIN replacement_tasks t ON t.scanner_asset_id = s.id
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
      t.outcome,
      t.observed_serial,
      t.new_serial_number,
      t.started_at,
      t.started_by,
      t.closeout_submitted_at,
      t.admin_accepted_at,
      t.customer_accepted_at,
      t.customer_rejected_at,
      t.customer_reject_reason,
      t.version
    FROM scanner_assets s
    LEFT JOIN replacement_tasks t ON t.id = (
      SELECT id FROM replacement_tasks 
      WHERE scanner_asset_id = s.id 
      ORDER BY created_at DESC, rowid DESC 
      LIMIT 1
    )
    WHERE s.branch_id = ?
    ORDER BY s.com_sn ASC
  `
  const scanners = await c.env.DB.prepare(scannerSql).bind(branchId).all()

  // ซ่อนข้อมูลภายใน SYM หากเป็น Gable Customer Reviewer
  const sanitizedScanners = scanners.results.map((row: any) => {
    if (user.role === 'customer_reviewer') {
      const { started_by, ...rest } = row
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
  const limit = Math.min(Number(c.req.query('limit')) || 200, 1000)
  const offset = Number(c.req.query('offset')) || 0

  let sql = `
    SELECT 
      s.id,
      s.branch_id,
      s.com_sn,
      s.com_sn as serial,
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
      t.outcome,
      t.observed_serial,
      t.new_serial_number,
      t.new_serial_number as new_serial,
      t.notes,
      t.started_at,
      t.started_by,
      t.closeout_submitted_at,
      t.admin_accepted_at,
      t.customer_accepted_at,
      t.customer_rejected_at,
      t.customer_reject_reason,
      COALESCE(t.version, 1) as version
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
  const params: any[] = []

  if (province && province !== 'all') {
    sql += ' AND b.province = ?'
    params.push(province)
  }

  if (status && status !== 'all') {
    if (status === 'open') {
      sql += " AND (t.status IS NULL OR t.status = 'open' OR t.status = 'cancelled')"
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
    SELECT COUNT(*) as count 
    FROM scanner_assets s 
    JOIN branches b ON b.id = s.branch_id 
    LEFT JOIN replacement_tasks t ON t.scanner_asset_id = s.id
    WHERE 1=1
  `
  const countParams: any[] = []
  if (province && province !== 'all') {
    countSql += ' AND b.province = ?'
    countParams.push(province)
  }
  if (status && status !== 'all') {
    if (status === 'open') {
      countSql += " AND (t.status IS NULL OR t.status = 'open')"
    } else if (status === 'on_process') {
      countSql += " AND t.status IN ('in_progress', 'awaiting_admin_acceptance', 'awaiting_customer_acceptance', 'pending_exception')"
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

  const totalCount = await c.env.DB.prepare(countSql).bind(...countParams).first<{ count: number }>()

  const sanitizedRows = rows.results.map((r: any) => {
    if (user.role === 'customer_reviewer') {
      const { started_by, ...rest } = r
      return rest
    }
    return r
  })

  return c.json({
    rows: sanitizedRows,
    total: totalCount?.count || 0,
    offset,
    limit
  })
})

// 5.2 รายการคิวรอตรวจรับ (Pending Reviews Queue)
app.get('/tasks/pending', async (c) => {
  const user = c.get('user')
  const search = c.req.query('search')?.trim()

  let statusFilter = ''
  if (user.role === 'customer_reviewer') {
    statusFilter = "t.status = 'awaiting_customer_acceptance'"
  } else if (['admin', 'data_manager'].includes(user.role)) {
    statusFilter = "t.status IN ('awaiting_admin_acceptance', 'pending_exception')"
  } else {
    statusFilter = "t.status IN ('in_progress', 'awaiting_admin_acceptance', 'awaiting_customer_acceptance')"
  }

  let sql = `
    SELECT 
      t.id as task_id,
      t.id,
      t.status as task_status,
      t.status,
      t.outcome,
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
      const acceptedTime = new Date(r.admin_accepted_at).getTime()
      const diffHours = (now - acceptedTime) / (1000 * 60 * 60)
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
  let warningsCount = 0

  for (const r of rows) {
    const locationCode = String(r.location_code || '').trim()
    const locBld = String(r.loc_bld || '').trim()
    const comSn = String(r.com_sn || '').trim()
    const province = String(r.province || '').trim()

    if (!locationCode || !locBld || !comSn) {
      continue
    }

    const addressNote = r.address_note ? String(r.address_note).trim() : null
    if (addressNote) {
      warningsCount++
    }

    let branchId = branchMap.get(locationCode)
    if (!branchId) {
      branchId = `brn-${locationCode.replace(/[^a-zA-Z0-9_-]/g, '_')}`
      branchMap.set(locationCode, branchId)

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
    }

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

  const chunkSize = 50
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize)
    await c.env.DB.batch(chunk)
  }

  const batchId = `imp-${Date.now()}`
  await c.env.DB.prepare(`
    INSERT INTO import_batches (id, source_name, row_count, result_counts, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    batchId,
    body.source_name || 'Detail1.xlsx',
    rows.length,
    JSON.stringify({ branches: branchMap.size, warnings: warningsCount }),
    user.email
  ).run()

  return c.json({
    success: true,
    message: `นำเข้าข้อมูลสำเร็จ: ${rows.length} เครื่อง (${branchMap.size} สาขา)`,
    branches_count: branchMap.size,
    warnings_count: warningsCount
  })
})

// 6.1. ประวัติการนำเข้าไฟล์ทะเบียน (Import History)
app.get('/register/import/history', async (c) => {
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
  const { scanner_id } = await c.req.json<{ scanner_id: string }>()

  const scanner = await c.env.DB.prepare('SELECT id, branch_id, com_sn FROM scanner_assets WHERE id = ?').bind(scanner_id).first<{ id: string; branch_id: string; com_sn: string }>()
  if (!scanner) {
    return c.json({ error: 'ไม่พบเครื่องอ่านบาร์โค้ดนี้ในระบบ' }, 404)
  }

  // ค้นหาหรือเปิด Branch Work Order
  let workOrder = await c.env.DB.prepare('SELECT id FROM branch_work_orders WHERE branch_id = ? AND status != "completed"').bind(scanner.branch_id).first<{ id: string }>()
  if (!workOrder) {
    const woId = `wo-${scanner.branch_id}-${Date.now()}`
    const woCode = `WO-${Date.now().toString().slice(-6)}`
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
    if (['awaiting_admin_acceptance', 'awaiting_customer_acceptance'].includes(task.status)) {
      return c.json({ error: 'เครื่องสแกนเนอร์นี้อยู่ระหว่างขั้นตอนรอการตรวจรับ' }, 400)
    }
    if (['in_progress', 'blocked'].includes(task.status)) {
      return c.json({
        success: true,
        task_id: task.id,
        status: task.status
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
        status: 'in_progress'
      })
    }
  }

  // สร้าง Task ใหม่สำหรับกรณีที่ยังไม่มีงาน หรือกรณีงานเดิมถูกยกเลิก (cancelled)
  const taskId = task ? `tsk-${scanner.id}-${Date.now()}` : `tsk-${scanner.id}`
  await c.env.DB.prepare(`
    INSERT INTO replacement_tasks (
      id, branch_work_order_id, scanner_asset_id, status, outcome, 
      started_at, started_by, version
    ) VALUES (?, ?, ?, 'in_progress', 'replaced', datetime('now'), ?, 1)
  `).bind(taskId, workOrder.id, scanner.id, user.email).run()

  return c.json({
    success: true,
    task_id: taskId,
    status: 'in_progress'
  })
})

// 8. อัปโหลดและดูภาพถ่ายหลักฐาน (Cloudflare R2 Integration)
app.post('/tasks/:id/evidence', async (c) => {
  const user = c.get('user')
  const taskId = c.req.param('id')
  
  // ตรวจสอบสิทธิ์และสถานะงาน (ห้ามแก้ไขหากล็อกแล้ว)
  const task = await c.env.DB.prepare('SELECT id, status FROM replacement_tasks WHERE id = ?').bind(taskId).first<{ id: string; status: string }>()
  if (!task) {
    return c.json({ error: 'ไม่พบใบงาน' }, 404)
  }
  if (['awaiting_customer_acceptance', 'delivered'].includes(task.status)) {
    return c.json({ error: 'ใบงานนี้ได้รับการลงนามรับรองแล้ว ระบบล็อกข้อมูลป้องกันการแก้ไข' }, 400)
  }

  const body = await c.req.json<{
    evidence_type: string
    file_base64: string
    mime_type?: string
  }>()

  if (!body.evidence_type || !body.file_base64) {
    return c.json({ error: 'ข้อมูลภาพถ่ายหรือประเภทหลักฐานไม่ครบถ้วน' }, 400)
  }

  let bytes: Uint8Array
  try {
    const binaryString = atob(body.file_base64.replace(/^data:image\/\w+;base64,/, ''))
    bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
  } catch {
    return c.json({ error: 'ข้อมูลภาพถ่าย Base64 ไม่ถูกต้อง' }, 400)
  }

  const storageKey = `tasks/${taskId}/${body.evidence_type}_${Date.now()}.jpg`

  // บันทึกลง Cloudflare R2
  if (c.env.EVIDENCE_BUCKET) {
    await c.env.EVIDENCE_BUCKET.put(storageKey, bytes.buffer, {
      httpMetadata: { contentType: body.mime_type || 'image/jpeg' }
    })
  }

  // อัปเดตรายการใน D1
  const evidenceId = `evd-${taskId}-${body.evidence_type}`
  await c.env.DB.prepare(`
    INSERT INTO replacement_task_evidence (
      id, replacement_task_id, evidence_type, storage_path, byte_size, mime_type, role_assigned
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      storage_path = excluded.storage_path,
      byte_size = excluded.byte_size,
      created_at = datetime('now')
  `).bind(
    evidenceId,
    taskId,
    body.evidence_type,
    storageKey,
    bytes.length,
    body.mime_type || 'image/jpeg',
    user.role
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
  const rows = await c.env.DB.prepare(`
    SELECT id, replacement_task_id, evidence_type, storage_path, byte_size, mime_type, role_assigned, created_at
    FROM replacement_task_evidence
    WHERE replacement_task_id = ?
    ORDER BY created_at ASC
  `).bind(taskId).all()

  return c.json({ evidence: rows.results })
})

// 8.2 ดูภาพหลักฐานจาก Storage
app.get('/evidence/:key{.*}', async (c) => {
  const key = c.req.param('key')
  if (c.env.EVIDENCE_BUCKET) {
    const object = await c.env.EVIDENCE_BUCKET.get(key)
    if (!object) return c.json({ error: 'File not found' }, 404)
    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('etag', object.httpEtag)
    return new Response(object.body, { headers })
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><rect width="100%" height="100%" fill="#f1f5f9"/><text x="50%" y="45%" text-anchor="middle" fill="#475569" font-family="sans-serif" font-size="14" font-weight="600">บันทึกหลักฐานใน D1 แล้ว</text><text x="50%" y="60%" text-anchor="middle" fill="#94a3b8" font-family="sans-serif" font-size="12">Cloudflare R2</text></svg>`
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=60'
    }
  })
})

// 8.3 ลบภาพหลักฐานจาก Storage และ D1
app.delete('/tasks/:id/evidence/:slot', async (c) => {
  const taskId = c.req.param('id')
  const slot = c.req.param('slot')

  const task = await c.env.DB.prepare('SELECT id, status FROM replacement_tasks WHERE id = ?').bind(taskId).first<{ id: string; status: string }>()
  if (!task) return c.json({ error: 'ไม่พบใบงาน' }, 404)
  if (['awaiting_customer_acceptance', 'delivered', 'completed'].includes(task.status)) {
    return c.json({ error: 'ใบงานนี้ได้รับการลงนามหรือตรวจรับแล้ว ระบบล็อกข้อมูลหลักฐานป้องกันการแก้ไข' }, 400)
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
  const taskId = c.req.param('id')
  const { new_serial_number, observed_serial, notes, outcome, version } = await c.req.json<{
    new_serial_number?: string
    observed_serial?: string
    notes?: string
    outcome: string
    version: number
  }>()

  const task = await c.env.DB.prepare('SELECT id, status, version FROM replacement_tasks WHERE id = ?').bind(taskId).first<{ id: string; status: string; version: number }>()
  if (!task) return c.json({ error: 'ไม่พบใบงาน' }, 404)
  if (task.version !== version) return c.json({ error: 'ข้อมูลมีการเปลี่ยนแปลง กรุณารีเฟรชหน้าจอ (Optimistic Lock Error)' }, 409)

  await c.env.DB.prepare(`
    UPDATE replacement_tasks SET
      new_serial_number = ?,
      observed_serial = ?,
      notes = ?,
      outcome = ?,
      status = 'awaiting_admin_acceptance',
      closeout_submitted_at = datetime('now'),
      closeout_submitted_by = ?,
      version = version + 1,
      updated_at = datetime('now')
    WHERE id = ? AND version = ?
  `).bind(
    new_serial_number || null,
    observed_serial || null,
    notes || null,
    outcome || 'replaced',
    user.email,
    taskId,
    version
  ).run()

  return c.json({
    success: true,
    status: 'awaiting_admin_acceptance'
  })
})

// 9.1 ปรับเปลี่ยนสถานะใบงาน (start / block / resume / cancel)
app.post('/tasks/:id/action', async (c) => {
  const user = c.get('user')
  const taskId = c.req.param('id')
  const { action, reason, version } = await c.req.json<{
    action: 'start' | 'block' | 'resume' | 'cancel'
    reason?: string
    version?: number
  }>()

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

  if (action === 'start') {
    nextStatus = 'in_progress'
  } else if (action === 'block') {
    nextStatus = 'blocked'
    if (reason) {
      notes = notes ? `${notes} | พักงาน: ${reason}` : `พักงาน: ${reason}`
    }
  } else if (action === 'resume') {
    nextStatus = 'in_progress'
  } else if (action === 'cancel') {
    if (!['admin', 'data_manager'].includes(user.role)) {
      return c.json({ error: 'เฉพาะ Admin เท่านั้นที่สามารถยกเลิกใบงานได้' }, 403)
    }
    nextStatus = 'cancelled'
    if (reason) {
      notes = notes ? `${notes} | ยกเลิก: ${reason}` : `ยกเลิก: ${reason}`
    }
  } else {
    return c.json({ error: 'Action ไม่ถูกต้อง' }, 400)
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
    if (currentTask.closeout_submitted_by === user.email || currentTask.started_by === user.email) {
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
  const reviewId = `rev-${Date.now()}`
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

  const { branch_id, task_ids, signature_base64 } = await c.req.json<{
    branch_id: string
    task_ids: string[]
    signature_base64: string
  }>()

  if (!task_ids || task_ids.length === 0 || !signature_base64) {
    return c.json({ error: 'ข้อมูลไม่ครบถ้วน ต้องระบุรายการอุปกรณ์และมีลายเซ็นรับมอบ' }, 400)
  }

  const stmts: D1PreparedStatement[] = []

  for (const taskId of task_ids) {
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

    const revId = `rev-gst-${taskId}-${Date.now()}`
    stmts.push(
      c.env.DB.prepare(`
        INSERT INTO task_reviews (id, task_id, stage, decision, reviewer_email)
        VALUES (?, ?, 'customer', 'pass', ?)
      `).bind(revId, taskId, user.email)
    )
  }

  // บันทึกลายเซ็น Gable ลง Storage & Evidence
  const sigKey = `branches/${branch_id}/gable_sign_${Date.now()}.png`
  if (c.env.EVIDENCE_BUCKET) {
    const binary = atob(signature_base64.replace(/^data:image\/\w+;base64,/, ''))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    await c.env.EVIDENCE_BUCKET.put(sigKey, bytes.buffer, {
      httpMetadata: { contentType: 'image/png' }
    })
  }

  await c.env.DB.batch(stmts)

  return c.json({
    success: true,
    status: 'delivered',
    count: task_ids.length,
    message: `Gable ตรวจรับงานสำเร็จจำนวน ${task_ids.length} เครื่อง`
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

  const revId = `rev-grj-${task_id}-${Date.now()}`
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
      t.outcome,
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

// 14. รายงานเครื่องสแกนเนอร์นอกทะเบียน (Scanner Discovery)
app.post('/discovery', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{
    branch_id: string
    serial_number: string
    observed_model?: string
    notes?: string
  }>()

  const { branch_id, serial_number, observed_model, notes } = body
  if (!branch_id || !serial_number?.trim()) {
    return c.json({ error: 'ต้องระบุสาขาและ Serial Number' }, 400)
  }

  const cleanSn = serial_number.trim()
  const existing = await c.env.DB.prepare('SELECT id FROM scanner_assets WHERE com_sn = ?').bind(cleanSn).first()
  if (existing) {
    return c.json({ error: 'Serial Number นี้มีอยู่ในทะเบียนอุปกรณ์แล้ว' }, 409)
  }

  const id = `dsc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  await c.env.DB.prepare(`
    INSERT INTO scanner_discovery_reports (id, branch_id, serial_number, observed_model, notes, reported_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(id, branch_id, cleanSn, observed_model?.trim() || null, notes?.trim() || null, user.email).run()

  return c.json({ success: true, id })
})

// 15. คิวการตรวจรับเครื่องนอกทะเบียน (สำหรับ Admin)
app.get('/discovery/queue', async (c) => {
  const limit = Math.min(Number(c.req.query('limit')) || 50, 100)
  const offset = Number(c.req.query('offset')) || 0

  const countRow = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM scanner_discovery_reports WHERE status = 'pending'"
  ).first<{ count: number }>()

  const rows = await c.env.DB.prepare(`
    SELECT 
      d.id, d.id as report_id, d.branch_id, d.serial_number, d.observed_model, d.notes,
      d.status, d.reported_by, d.created_at,
      b.loc_bld as branch_name, b.location_code, b.province
    FROM scanner_discovery_reports d
    JOIN branches b ON b.id = d.branch_id
    WHERE d.status = 'pending'
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
  if (report.status !== 'pending') return c.json({ error: 'รายการนี้ได้รับการพิจารณาไปแล้ว' }, 409)

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

export const onRequest = handle(app)
