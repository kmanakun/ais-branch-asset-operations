import { Hono } from 'hono'
import {
  maskSerialForViewer,
  normalizeSerialInput,
  validateSerialFormat,
} from './stock-serial.mjs'

export interface StockD1StatementResult<T = Record<string, unknown>> {
  success: boolean
  results?: T[]
  meta?: {
    changes?: number
    last_row_id?: number
  }
}

export interface StockD1PreparedStatement {
  bind(...values: unknown[]): StockD1PreparedStatement
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<StockD1StatementResult<T>>
  run(): Promise<StockD1StatementResult>
}

export interface StockD1Database {
  prepare(query: string): StockD1PreparedStatement
  batch(statements: StockD1PreparedStatement[]): Promise<StockD1StatementResult[]>
}

export interface StockUserContext {
  email: string
  role: string
  full_name: string
}

export interface StockRouterEnv {
  Bindings: {
    DB: StockD1Database
  }
  Variables: {
    user: StockUserContext
  }
}

export interface StockItemRow {
  id: string
  serial_number: string
  unit_type: 'new_unit' | 'old_removed'
  status: string
  pre_task_status: string | null
  source_mode: 'registered_stock' | 'hybrid_unregistered' | 'onsite_removal'
  brand: string | null
  model_name: string | null
  lot_no: string | null
  receive_doc_id: string | null
  dispatch_doc_id: string | null
  dispatch_area: string | null
  return_doc_id: string | null
  handover_doc_id: string | null
  linked_task_id: string | null
  linked_branch_id: string | null
  linked_old_asset_id: string | null
  received_at: string | null
  dispatched_at: string | null
  allocated_at: string | null
  installed_at: string | null
  returned_at: string | null
  handed_over_at: string | null
  note: string | null
  created_by: string
  updated_by: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface StockImportInputRow {
  source_row?: number
  serial_number?: string | null
  brand?: string | null
  model_name?: string | null
  lot_no?: string | null
  dispatch_area?: string | null
  received_date?: string | null
  note?: string | null
}

export interface StockImportDefaults {
  brand?: string | null
  model_name?: string | null
  lot_no?: string | null
  dispatch_area?: string | null
  dispatch_mode?: 'in_warehouse' | 'dispatched' | 'auto_by_column'
  received_date?: string | null
  note?: string | null
}

export interface ValidatedStockImportItem {
  source_row: number
  serial_number: string
  action: 'create_new' | 'reconcile_hybrid' | 'reactivate' | 'error'
  valid: boolean
  target_status: 'in_warehouse' | 'dispatched' | null
  existing_item_id: string | null
  existing_status: string | null
  existing_task_id?: string | null
  existing_branch_id?: string | null
  brand: string | null
  model_name: string | null
  lot_no: string | null
  dispatch_area: string | null
  received_date: string | null
  note: string | null
  reason: string | null
}

const ADMIN_STOCK_ROLES = new Set(['admin', 'data_manager'])
const ALLOWED_UNIT_TYPES = new Set(['new_unit', 'old_removed'])
const ALLOWED_STOCK_STATUSES = new Set([
  'in_warehouse',
  'dispatched',
  'allocated_to_task',
  'installed',
  'doa_defective',
  'void_hybrid',
  'removed_onsite',
  'returned_to_warehouse',
  'handed_over_to_customer',
  'cancelled_restored',
])
const ALLOWED_SOURCE_MODES = new Set(['registered_stock', 'hybrid_unregistered', 'onsite_removal'])
const ALLOWED_DOC_TYPES = new Set(['receive', 'dispatch', 'return_in', 'handover_out', 'doa_claim', 'adjustment'])
const MAX_IMPORT_ROWS = 5000
const MAX_BATCH_ACTION_SNS = 500

export function makeStockUniqueId(prefix: string): string {
  const rand = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
  return `${prefix}-${Date.now()}-${rand}`
}

export function makeStockDocCode(prefix: 'RCV' | 'DSP' | 'RET' | 'HOV' | 'DOA' | 'ADJ'): string {
  const bkkNow = new Date(Date.now() + 7 * 60 * 60 * 1000)
  const ymd = bkkNow.toISOString().slice(0, 10).replaceAll('-', '')
  const rand = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase()
    : Math.random().toString(36).slice(2, 8).toUpperCase()
  return `${prefix}-${ymd}-${rand}`
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

export async function runBatchChunks(
  db: StockD1Database,
  statements: StockD1PreparedStatement[],
  chunkSize = 150
): Promise<void> {
  for (const chunk of chunkArray(statements, chunkSize)) {
    if (chunk.length > 0) {
      await db.batch(chunk)
    }
  }
}

function cleanOptionalText(value: unknown, maxLength: number): string | null {
  const text = String(value ?? '').replace(/[\x00-\x1F\x7F]/g, '').trim()
  if (!text) return null
  return text.slice(0, maxLength)
}

function normalizeReceivedDate(value: unknown): string | null {
  const text = cleanOptionalText(value, 32)
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text} 00:00:00`
  return text
}

export async function lookupStockBySerials(
  db: StockD1Database,
  serials: string[]
): Promise<Map<string, StockItemRow>> {
  const result = new Map<string, StockItemRow>()
  const unique = Array.from(new Set(serials.map(normalizeSerialInput).filter(Boolean)))
  for (const chunk of chunkArray(unique, 50)) {
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = await db
      .prepare(`SELECT * FROM stock_items WHERE serial_number IN (${placeholders})`)
      .bind(...chunk)
      .all<StockItemRow>()
    for (const row of rows.results || []) {
      result.set(row.serial_number, row)
    }
  }
  return result
}

export async function lookupScannerAssetsBySerials(
  db: StockD1Database,
  serials: string[]
): Promise<Map<string, { id: string; com_sn: string; branch_id: string; loc_bld: string | null; location_code: string | null }>> {
  const result = new Map<string, { id: string; com_sn: string; branch_id: string; loc_bld: string | null; location_code: string | null }>()
  const unique = Array.from(new Set(serials.map(normalizeSerialInput).filter(Boolean)))
  for (const chunk of chunkArray(unique, 50)) {
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = await db
      .prepare(`
        SELECT s.id, s.com_sn, s.branch_id, b.loc_bld, b.location_code
        FROM scanner_assets s
        LEFT JOIN branches b ON b.id = s.branch_id
        WHERE s.com_sn IN (${placeholders})
      `)
      .bind(...chunk)
      .all<{ id: string; com_sn: string; branch_id: string; loc_bld: string | null; location_code: string | null }>()
    for (const row of rows.results || []) {
      result.set(row.com_sn, row)
    }
  }
  return result
}

function formatStockRowForRole<T extends Record<string, any>>(row: T, role: string): T {
  if (role === 'viewer') {
    const masked: Record<string, any> = {
      ...row,
      serial_number: row.serial_number ? maskSerialForViewer(row.serial_number) : row.serial_number,
      old_asset_sn: row.old_asset_sn ? maskSerialForViewer(row.old_asset_sn) : row.old_asset_sn,
    }
    delete masked.created_by
    delete masked.updated_by
    delete masked.actor_email
    delete masked.lot_no
    return masked as T
  }
  if (role === 'customer_reviewer') {
    const sanitized: Record<string, any> = { ...row }
    delete sanitized.created_by
    delete sanitized.updated_by
    delete sanitized.actor_email
    return sanitized as T
  }
  return row
}

function buildMovementInsert(
  db: StockD1Database,
  params: {
    stockItemId: string
    docId?: string | null
    taskId?: string | null
    branchId?: string | null
    action: string
    fromStatus?: string | null
    toStatus: string
    actorEmail: string
    note?: string | null
  }
): StockD1PreparedStatement {
  return db.prepare(`
    INSERT INTO stock_movements (
      id, stock_item_id, doc_id, task_id, branch_id, action, from_status, to_status, actor_email, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    makeStockUniqueId('smv'),
    params.stockItemId,
    params.docId ?? null,
    params.taskId ?? null,
    params.branchId ?? null,
    params.action,
    params.fromStatus ?? null,
    params.toStatus,
    params.actorEmail,
    params.note ?? null
  )
}

function buildReleaseOrVoidPairs(
  db: StockD1Database,
  item: StockItemRow,
  actorEmail: string,
  taskId: string,
  disposition: 'release' | 'doa',
  reasonNote: string,
  taskGuardSql?: { whereFragment: string; binds: unknown[] }
): { itemStatements: StockD1PreparedStatement[]; movementStatements: StockD1PreparedStatement[] } {
  const guardSql = taskGuardSql ? ` AND ${taskGuardSql.whereFragment}` : ''
  const guardBinds = taskGuardSql ? taskGuardSql.binds : []

  if (disposition === 'doa') {
    return {
      itemStatements: [
        db.prepare(`
          UPDATE stock_items SET
            status = 'doa_defective',
            linked_task_id = NULL,
            linked_branch_id = NULL,
            linked_old_asset_id = NULL,
            allocated_at = NULL,
            note = ?,
            updated_by = ?,
            version = version + 1,
            updated_at = datetime('now')
          WHERE id = ? AND status = 'allocated_to_task' AND linked_task_id = ? AND version = ?${guardSql}
        `).bind(reasonNote, actorEmail, item.id, taskId, item.version, ...guardBinds),
      ],
      movementStatements: [
        buildMovementInsert(db, {
          stockItemId: item.id,
          taskId,
          branchId: item.linked_branch_id,
          action: 'marked_doa',
          fromStatus: 'allocated_to_task',
          toStatus: 'doa_defective',
          actorEmail,
          note: reasonNote,
        }),
      ],
    }
  }

  if (item.source_mode === 'hybrid_unregistered') {
    return {
      itemStatements: [
        db.prepare(`
          UPDATE stock_items SET
            status = 'void_hybrid',
            linked_task_id = NULL,
            linked_branch_id = NULL,
            linked_old_asset_id = NULL,
            allocated_at = NULL,
            note = ?,
            updated_by = ?,
            version = version + 1,
            updated_at = datetime('now')
          WHERE id = ? AND status = 'allocated_to_task' AND linked_task_id = ? AND version = ?${guardSql}
        `).bind(reasonNote, actorEmail, item.id, taskId, item.version, ...guardBinds),
      ],
      movementStatements: [
        buildMovementInsert(db, {
          stockItemId: item.id,
          taskId,
          branchId: item.linked_branch_id,
          action: 'voided_hybrid',
          fromStatus: 'allocated_to_task',
          toStatus: 'void_hybrid',
          actorEmail,
          note: reasonNote,
        }),
      ],
    }
  }

  const restoredStatus = item.pre_task_status === 'dispatched' ? 'dispatched' : 'in_warehouse'
  return {
    itemStatements: [
      db.prepare(`
        UPDATE stock_items SET
          status = ?,
          pre_task_status = NULL,
          linked_task_id = NULL,
          linked_branch_id = NULL,
          linked_old_asset_id = NULL,
          allocated_at = NULL,
          updated_by = ?,
          version = version + 1,
          updated_at = datetime('now')
        WHERE id = ? AND status = 'allocated_to_task' AND linked_task_id = ? AND version = ?${guardSql}
      `).bind(restoredStatus, actorEmail, item.id, taskId, item.version, ...guardBinds),
    ],
    movementStatements: [
      buildMovementInsert(db, {
        stockItemId: item.id,
        taskId,
        branchId: item.linked_branch_id,
        action: 'released_from_task',
        fromStatus: 'allocated_to_task',
        toStatus: restoredStatus,
        actorEmail,
        note: reasonNote,
      }),
    ],
  }
}

export interface CloseoutStockPlan {
  ok: boolean
  status?: number
  error?: string
  taskRaceGuardSql?: string
  taskRaceGuardBinds?: unknown[]
  itemStatements?: StockD1PreparedStatement[]
  movementStatements?: StockD1PreparedStatement[]
  sourceMode?: 'registered_stock' | 'hybrid_unregistered' | null
}

/**
 * Validates stock rules before closeout and builds atomic statements:
 * `itemStatements` execute in the same DB.batch as the task closeout UPDATE,
 * while `movementStatements` are appended only by the request that wins the optimistic lock.
 */
export async function prepareCloseoutStockPlan(
  db: StockD1Database,
  params: {
    taskId: string
    expectedNextTaskVersion: number
    expectedNextTaskStatus: string
    expectedNewSn: string | null
    branchId: string
    oldAssetId: string
    oldComSn: string
    oldBrand: string | null
    oldModelName: string | null
    outcome: string
    newSerialNumber: string | null
    newModelName: string | null
    previousSnDisposition: 'release' | 'doa'
    actorEmail: string
  }
): Promise<CloseoutStockPlan> {
  const {
    taskId,
    expectedNextTaskVersion,
    expectedNextTaskStatus,
    expectedNewSn,
    branchId,
    oldAssetId,
    oldComSn,
    oldBrand,
    oldModelName,
    outcome,
    newSerialNumber,
    newModelName,
    previousSnDisposition,
    actorEmail,
  } = params

  const linkedItemsRes = await db
    .prepare('SELECT * FROM stock_items WHERE linked_task_id = ?')
    .bind(taskId)
    .all<StockItemRow>()
  const linkedItems = linkedItemsRes.results || []
  const previousAllocatedNew = linkedItems.find(
    i => i.unit_type === 'new_unit' && i.status === 'allocated_to_task'
  )

  const oldAssetStock = oldComSn
    ? await db.prepare('SELECT * FROM stock_items WHERE serial_number = ?').bind(normalizeSerialInput(oldComSn)).first<StockItemRow>()
    : null

  const taskGuard = {
    whereFragment: `EXISTS (
      SELECT 1 FROM replacement_tasks rt
      WHERE rt.id = ?
        AND rt.version = ?
        AND rt.status = ?
        AND COALESCE(rt.new_serial_number, '') = COALESCE(?, '')
        AND rt.closeout_submitted_by = ?
    )`,
    binds: [taskId, expectedNextTaskVersion, expectedNextTaskStatus, expectedNewSn, actorEmail],
  }

  // Case A: Non-replacement outcomes (exception paths)
  if (outcome !== 'replaced') {
    if (
      oldAssetStock &&
      oldAssetStock.unit_type === 'old_removed' &&
      oldAssetStock.linked_task_id === taskId &&
      ['returned_to_warehouse', 'handed_over_to_customer'].includes(oldAssetStock.status)
    ) {
      return {
        ok: false,
        status: 409,
        error: `ไม่สามารถเปลี่ยนผลปิดงานเป็นไม่ได้เปลี่ยนเครื่องได้ เนื่องจากซากเครื่องเดิม ${oldComSn} ถูกรับคืนเข้าคลังหรือส่งมอบลูกค้าไปแล้ว`,
      }
    }

    const itemStatements: StockD1PreparedStatement[] = []
    const movementStatements: StockD1PreparedStatement[] = []
    if (previousAllocatedNew) {
      const rel = buildReleaseOrVoidPairs(
        db,
        previousAllocatedNew,
        actorEmail,
        taskId,
        previousSnDisposition,
        `เปลี่ยนผลปิดงานเป็น ${outcome}: ปลดการจองเครื่องใหม่ ${previousAllocatedNew.serial_number}`,
        taskGuard
      )
      itemStatements.push(...rel.itemStatements)
      movementStatements.push(...rel.movementStatements)
    }

    if (oldAssetStock && oldAssetStock.unit_type === 'old_removed' && oldAssetStock.status === 'removed_onsite' && oldAssetStock.linked_task_id === taskId) {
      itemStatements.push(
        db.prepare(`
          UPDATE stock_items SET
            status = 'cancelled_restored',
            linked_task_id = NULL,
            updated_by = ?,
            version = version + 1,
            updated_at = datetime('now')
          WHERE id = ? AND status = 'removed_onsite' AND linked_task_id = ? AND version = ? AND ${taskGuard.whereFragment}
        `).bind(actorEmail, oldAssetStock.id, taskId, oldAssetStock.version, ...taskGuard.binds)
      )
      movementStatements.push(
        buildMovementInsert(db, {
          stockItemId: oldAssetStock.id,
          taskId,
          branchId,
          action: 'cancelled_restored',
          fromStatus: 'removed_onsite',
          toStatus: 'cancelled_restored',
          actorEmail,
          note: `เปลี่ยนผลปิดงานเป็น ${outcome}: ยกเลิกรายการรอคืนซาก ${oldComSn}`,
        })
      )
    }

    return { ok: true, itemStatements, movementStatements, sourceMode: null }
  }

  // Case B: Replaced outcome
  const cleanNewSn = normalizeSerialInput(newSerialNumber)
  const cleanOldComSn = normalizeSerialInput(oldComSn)
  if (cleanOldComSn && cleanNewSn === cleanOldComSn) {
    return {
      ok: false,
      status: 400,
      error: `หมายเลขเครื่องใหม่ (${cleanNewSn}) ต้องไม่ซ้ำกับหมายเลขเครื่องเดิมของสาขา`,
    }
  }

  const targetStock = await db
    .prepare('SELECT * FROM stock_items WHERE serial_number = ?')
    .bind(cleanNewSn)
    .first<StockItemRow>()

  if (targetStock) {
    if (targetStock.unit_type === 'old_removed' && targetStock.status !== 'cancelled_restored') {
      return {
        ok: false,
        status: 409,
        error: `หมายเลขเครื่อง ${cleanNewSn} เป็นซากเครื่องเดิมที่ถอดจากสาขาแล้ว (${targetStock.status}) ไม่สามารถติดตั้งเป็นเครื่องใหม่ได้`,
      }
    }
    if (targetStock.status === 'installed') {
      return {
        ok: false,
        status: 409,
        error: `หมายเลขเครื่อง ${cleanNewSn} ถูกติดตั้งและตรวจรับไปแล้วในใบงานอื่น`,
      }
    }
    if (targetStock.status === 'doa_defective') {
      return {
        ok: false,
        status: 409,
        error: `หมายเลขเครื่อง ${cleanNewSn} ถูกแจ้งเสีย (DOA) ไว้ในระบบ ไม่สามารถนำไปติดตั้งได้`,
      }
    }
    if (targetStock.status === 'allocated_to_task' && targetStock.linked_task_id !== taskId) {
      return {
        ok: false,
        status: 409,
        error: `หมายเลขเครื่อง ${cleanNewSn} ถูกจองใช้งานอยู่กับใบงานอื่นแล้ว`,
      }
    }
  }

  if (
    oldAssetStock &&
    oldAssetStock.unit_type === 'old_removed' &&
    ['returned_to_warehouse', 'handed_over_to_customer'].includes(oldAssetStock.status) &&
    oldAssetStock.linked_task_id !== taskId
  ) {
    return {
      ok: false,
      status: 409,
      error: `ซากเครื่องเดิม ${cleanOldComSn} ถูกรับคืนเข้าคลังหรือส่งมอบลูกค้าในใบงานอื่นแล้ว`,
    }
  }

  const itemStatements: StockD1PreparedStatement[] = []
  const movementStatements: StockD1PreparedStatement[] = []

  // Release/DOA previously allocated new unit if technician swapped SN (e.g., after Reject or DOA onsite)
  if (previousAllocatedNew && previousAllocatedNew.serial_number !== cleanNewSn) {
    const noteText = previousSnDisposition === 'doa'
      ? `แจ้งเสียหน้างาน (DOA) และเปลี่ยนเป็น SN ${cleanNewSn}`
      : `เปลี่ยน SN เครื่องใหม่ในใบงานจาก ${previousAllocatedNew.serial_number} เป็น ${cleanNewSn}`
    const rel = buildReleaseOrVoidPairs(
      db,
      previousAllocatedNew,
      actorEmail,
      taskId,
      previousSnDisposition,
      noteText,
      taskGuard
    )
    itemStatements.push(...rel.itemStatements)
    movementStatements.push(...rel.movementStatements)
  }

  let resolvedSourceMode: 'registered_stock' | 'hybrid_unregistered' = 'hybrid_unregistered'

  if (targetStock) {
    if (targetStock.status === 'allocated_to_task' && targetStock.linked_task_id === taskId) {
      resolvedSourceMode = targetStock.source_mode === 'registered_stock' ? 'registered_stock' : 'hybrid_unregistered'
      if (newModelName) {
        itemStatements.push(
          db.prepare(`
            UPDATE stock_items SET
              model_name = COALESCE(?, model_name),
              updated_by = ?,
              updated_at = datetime('now')
            WHERE id = ? AND linked_task_id = ? AND ${taskGuard.whereFragment}
          `).bind(newModelName, actorEmail, targetStock.id, taskId, ...taskGuard.binds)
        )
      }
      movementStatements.push(
        buildMovementInsert(db, {
          stockItemId: targetStock.id,
          taskId,
          branchId,
          action: 'allocated_to_task',
          fromStatus: 'allocated_to_task',
          toStatus: 'allocated_to_task',
          actorEmail,
          note: 'ส่งปิดงานซ้ำด้วย SN เดิมหลังแก้ไขหน้างาน',
        })
      )
    } else if (targetStock.status === 'in_warehouse' || targetStock.status === 'dispatched') {
      resolvedSourceMode = 'registered_stock'
      const prevStatus = targetStock.status
      itemStatements.push(
        db.prepare(`
          UPDATE stock_items SET
            status = 'allocated_to_task',
            pre_task_status = ?,
            linked_task_id = ?,
            linked_branch_id = ?,
            linked_old_asset_id = ?,
            model_name = COALESCE(?, model_name),
            allocated_at = datetime('now'),
            updated_by = ?,
            version = version + 1,
            updated_at = datetime('now')
          WHERE id = ? AND status IN ('in_warehouse', 'dispatched') AND version = ? AND ${taskGuard.whereFragment}
        `).bind(
          prevStatus,
          taskId,
          branchId,
          oldAssetId,
          newModelName,
          actorEmail,
          targetStock.id,
          targetStock.version,
          ...taskGuard.binds
        )
      )
      movementStatements.push(
        buildMovementInsert(db, {
          stockItemId: targetStock.id,
          taskId,
          branchId,
          action: 'allocated_to_task',
          fromStatus: prevStatus,
          toStatus: 'allocated_to_task',
          actorEmail,
          note: 'ช่างเลือกตัดสต็อกจากคลังเพื่อปิดงาน',
        })
      )
    } else {
      resolvedSourceMode = 'hybrid_unregistered'
      const prevStatus = targetStock.status
      itemStatements.push(
        db.prepare(`
          UPDATE stock_items SET
            unit_type = 'new_unit',
            status = 'allocated_to_task',
            pre_task_status = NULL,
            source_mode = 'hybrid_unregistered',
            model_name = COALESCE(?, model_name),
            linked_task_id = ?,
            linked_branch_id = ?,
            linked_old_asset_id = ?,
            allocated_at = datetime('now'),
            updated_by = ?,
            version = version + 1,
            updated_at = datetime('now')
          WHERE id = ? AND status IN ('void_hybrid', 'cancelled_restored') AND version = ? AND ${taskGuard.whereFragment}
        `).bind(
          newModelName,
          taskId,
          branchId,
          oldAssetId,
          actorEmail,
          targetStock.id,
          targetStock.version,
          ...taskGuard.binds
        )
      )
      movementStatements.push(
        buildMovementInsert(db, {
          stockItemId: targetStock.id,
          taskId,
          branchId,
          action: 'allocated_to_task',
          fromStatus: prevStatus,
          toStatus: 'allocated_to_task',
          actorEmail,
          note: 'Hybrid Mode: เปิดใช้งาน SN เข้าใบงาน',
        })
      )
    }
  } else {
    resolvedSourceMode = 'hybrid_unregistered'
    const newStockItemId = makeStockUniqueId('stk')
    itemStatements.push(
      db.prepare(`
        INSERT INTO stock_items (
          id, serial_number, unit_type, status, pre_task_status, source_mode,
          model_name, linked_task_id, linked_branch_id, linked_old_asset_id,
          allocated_at, note, created_by, updated_by
        )
        SELECT ?, ?, 'new_unit', 'allocated_to_task', NULL, 'hybrid_unregistered',
               ?, ?, ?, ?, datetime('now'), 'Hybrid Mode: ช่างปิดงานก่อนนำเข้าไฟล์ Supplier', ?, ?
        WHERE ${taskGuard.whereFragment}
          AND NOT EXISTS (SELECT 1 FROM stock_items si2 WHERE si2.serial_number = ?)
      `).bind(
        newStockItemId,
        cleanNewSn,
        newModelName,
        taskId,
        branchId,
        oldAssetId,
        actorEmail,
        actorEmail,
        ...taskGuard.binds,
        cleanNewSn
      )
    )
    movementStatements.push(
      buildMovementInsert(db, {
        stockItemId: newStockItemId,
        taskId,
        branchId,
        action: 'allocated_to_task',
        fromStatus: null,
        toStatus: 'allocated_to_task',
        actorEmail,
        note: 'Hybrid Mode: ช่างปิดงานก่อนรับเข้าคลังในระบบ',
      })
    )
  }

  // Reverse Logistics tracking for the removed branch scanner (old_removed)
  if (cleanOldComSn) {
    if (!oldAssetStock) {
      const oldStockId = makeStockUniqueId('stk-old')
      itemStatements.push(
        db.prepare(`
          INSERT INTO stock_items (
            id, serial_number, unit_type, status, source_mode, brand, model_name,
            linked_task_id, linked_branch_id, linked_old_asset_id,
            note, created_by, updated_by
          )
          SELECT ?, ?, 'old_removed', 'removed_onsite', 'onsite_removal', ?, ?,
                 ?, ?, ?, 'ถอดจากสาขา รอส่งซากคืนคลังกลาง SYM', ?, ?
          WHERE ${taskGuard.whereFragment}
            AND NOT EXISTS (SELECT 1 FROM stock_items si2 WHERE si2.serial_number = ?)
        `).bind(
          oldStockId,
          cleanOldComSn,
          oldBrand,
          oldModelName,
          taskId,
          branchId,
          oldAssetId,
          actorEmail,
          actorEmail,
          ...taskGuard.binds,
          cleanOldComSn
        )
      )
      movementStatements.push(
        buildMovementInsert(db, {
          stockItemId: oldStockId,
          taskId,
          branchId,
          action: 'removed_onsite',
          fromStatus: null,
          toStatus: 'removed_onsite',
          actorEmail,
          note: 'ช่างถอดเครื่องเดิมออกจากสาขา',
        })
      )
    } else if (oldAssetStock.unit_type === 'old_removed' && oldAssetStock.status === 'cancelled_restored') {
      itemStatements.push(
        db.prepare(`
          UPDATE stock_items SET
            status = 'removed_onsite',
            linked_task_id = ?,
            linked_branch_id = ?,
            linked_old_asset_id = ?,
            updated_by = ?,
            version = version + 1,
            updated_at = datetime('now')
          WHERE id = ? AND status = 'cancelled_restored' AND version = ? AND ${taskGuard.whereFragment}
        `).bind(
          taskId,
          branchId,
          oldAssetId,
          actorEmail,
          oldAssetStock.id,
          oldAssetStock.version,
          ...taskGuard.binds
        )
      )
      movementStatements.push(
        buildMovementInsert(db, {
          stockItemId: oldAssetStock.id,
          taskId,
          branchId,
          action: 'removed_onsite',
          fromStatus: 'cancelled_restored',
          toStatus: 'removed_onsite',
          actorEmail,
          note: 'เปิดรายการรอคืนซากเครื่องเดิมอีกครั้งจากใบงาน',
        })
      )
    }
  }

  const taskRaceGuardSql = `
    NOT EXISTS (
      SELECT 1 FROM stock_items si
      WHERE si.serial_number = ?
        AND (
          (si.unit_type = 'old_removed' AND si.status != 'cancelled_restored')
          OR si.status IN ('installed', 'doa_defective')
          OR (si.status = 'allocated_to_task' AND si.linked_task_id != replacement_tasks.id)
        )
    )
  `

  return {
    ok: true,
    taskRaceGuardSql,
    taskRaceGuardBinds: [cleanNewSn],
    itemStatements,
    movementStatements,
    sourceMode: resolvedSourceMode,
  }
}

/**
 * Records audit ledger entries on SYM Stage 1 reject without releasing the allocated SN,
 * so the technician can either resubmit the same SN or swap it cleanly in the next closeout.
 */
export async function buildReviewRejectStockStatements(
  db: StockD1Database,
  params: {
    taskId: string
    stageLabel: 'SYM Admin' | 'G-Able'
    reason: string
    actorEmail: string
  }
): Promise<StockD1PreparedStatement[]> {
  const { taskId, stageLabel, reason, actorEmail } = params
  const items = await db
    .prepare("SELECT id, status, linked_branch_id FROM stock_items WHERE linked_task_id = ? AND unit_type = 'new_unit'")
    .bind(taskId)
    .all<{ id: string; status: string; linked_branch_id: string | null }>()

  return (items.results || []).map(item =>
    buildMovementInsert(db, {
      stockItemId: item.id,
      taskId,
      branchId: item.linked_branch_id,
      action: 'review_rejected',
      fromStatus: item.status,
      toStatus: item.status,
      actorEmail,
      note: `${stageLabel} Reject (คงสถานะจอง ${item.status} รอช่างแก้ไข): ${reason}`,
    })
  )
}

/**
 * Transitions all `allocated_to_task` new units for delivered tasks to permanent `installed`.
 */
export async function prepareCustomerAcceptStockStatements(
  db: StockD1Database,
  params: {
    taskIds: string[]
    actorEmail: string
  }
): Promise<{
  itemStatements: StockD1PreparedStatement[]
  movementStatements: StockD1PreparedStatement[]
}> {
  const itemStatements: StockD1PreparedStatement[] = []
  const movementStatements: StockD1PreparedStatement[] = []
  for (const chunk of chunkArray(params.taskIds, 50)) {
    const placeholders = chunk.map(() => '?').join(', ')
    const allocated = await db
      .prepare(`
        SELECT id, linked_task_id, linked_branch_id, version
        FROM stock_items
        WHERE unit_type = 'new_unit'
          AND status = 'allocated_to_task'
          AND linked_task_id IN (${placeholders})
      `)
      .bind(...chunk)
      .all<{ id: string; linked_task_id: string; linked_branch_id: string | null; version: number }>()

    for (const item of allocated.results || []) {
      itemStatements.push(
        db.prepare(`
          UPDATE stock_items SET
            status = 'installed',
            installed_at = datetime('now'),
            updated_by = ?,
            version = version + 1,
            updated_at = datetime('now')
          WHERE id = ? AND status = 'allocated_to_task' AND version = ?
        `).bind(params.actorEmail, item.id, item.version)
      )
      movementStatements.push(
        buildMovementInsert(db, {
          stockItemId: item.id,
          taskId: item.linked_task_id,
          branchId: item.linked_branch_id,
          action: 'installed',
          fromStatus: 'allocated_to_task',
          toStatus: 'installed',
          actorEmail: params.actorEmail,
          note: 'ผ่านตรวจรับ G-Able ส่งมอบติดตั้งถาวร',
        })
      )
    }
  }
  return { itemStatements, movementStatements }
}

/**
 * Validates and prepares atomic stock rollback when an Admin cancels a task.
 */
export async function prepareCancelTaskStockPlan(
  db: StockD1Database,
  params: {
    taskId: string
    expectedNextTaskVersion: number
    reason: string
    actorEmail: string
  }
): Promise<{
  ok: boolean
  status?: number
  error?: string
  itemStatements?: StockD1PreparedStatement[]
  movementStatements?: StockD1PreparedStatement[]
}> {
  const { taskId, expectedNextTaskVersion, reason, actorEmail } = params
  const linkedRes = await db
    .prepare('SELECT * FROM stock_items WHERE linked_task_id = ?')
    .bind(taskId)
    .all<StockItemRow>()
  const linked = linkedRes.results || []

  const returnedOld = linked.find(
    i => i.unit_type === 'old_removed' && ['returned_to_warehouse', 'handed_over_to_customer'].includes(i.status)
  )
  if (returnedOld) {
    return {
      ok: false,
      status: 409,
      error: `ไม่สามารถยกเลิกใบงานได้ เนื่องจากซากเครื่องเดิม ${returnedOld.serial_number} ถูกรับคืนเข้าคลังหรือส่งมอบลูกค้าไปแล้ว (${returnedOld.status})`,
    }
  }

  const taskCancelGuard = {
    whereFragment: `EXISTS (SELECT 1 FROM replacement_tasks rt WHERE rt.id = ? AND rt.version = ? AND rt.status = 'cancelled')`,
    binds: [taskId, expectedNextTaskVersion],
  }

  const itemStatements: StockD1PreparedStatement[] = []
  const movementStatements: StockD1PreparedStatement[] = []
  for (const item of linked) {
    if (item.unit_type === 'new_unit' && item.status === 'allocated_to_task') {
      const rel = buildReleaseOrVoidPairs(
        db,
        item,
        actorEmail,
        taskId,
        'release',
        `ยกเลิกใบงาน (${reason}): คืนสิทธิ์ SN ${item.serial_number}`,
        taskCancelGuard
      )
      itemStatements.push(...rel.itemStatements)
      movementStatements.push(...rel.movementStatements)
    } else if (item.unit_type === 'old_removed' && item.status === 'removed_onsite') {
      itemStatements.push(
        db.prepare(`
          UPDATE stock_items SET
            status = 'cancelled_restored',
            linked_task_id = NULL,
            updated_by = ?,
            version = version + 1,
            updated_at = datetime('now')
          WHERE id = ? AND status = 'removed_onsite' AND linked_task_id = ? AND version = ? AND ${taskCancelGuard.whereFragment}
        `).bind(actorEmail, item.id, taskId, item.version, ...taskCancelGuard.binds)
      )
      movementStatements.push(
        buildMovementInsert(db, {
          stockItemId: item.id,
          taskId,
          branchId: item.linked_branch_id,
          action: 'cancelled_restored',
          fromStatus: 'removed_onsite',
          toStatus: 'cancelled_restored',
          actorEmail,
          note: `ยกเลิกใบงาน (${reason}): ยกเลิกรายการรอคืนซาก ${item.serial_number}`,
        })
      )
    }
  }

  return { ok: true, itemStatements, movementStatements }
}

/**
 * Validates all rows of a Supplier new-scanner Excel batch against format rules,
 * intra-file uniqueness, registered branch old assets (`scanner_assets`), and existing `stock_items`.
 */
export async function validateStockImportBatch(
  db: StockD1Database,
  rawRows: StockImportInputRow[],
  defaults: StockImportDefaults = {}
): Promise<{
  summary: {
    total: number
    valid: number
    create_new: number
    reconcile_hybrid: number
    reactivate: number
    errors: number
    will_dispatch: number
  }
  items: ValidatedStockImportItem[]
}> {
  const defaultBrand = cleanOptionalText(defaults.brand, 100)
  const defaultModel = cleanOptionalText(defaults.model_name, 120)
  const defaultLot = cleanOptionalText(defaults.lot_no, 100)
  const defaultArea = cleanOptionalText(defaults.dispatch_area, 120)
  const defaultDate = normalizeReceivedDate(defaults.received_date)
  const defaultNote = cleanOptionalText(defaults.note, 500)
  const dispatchMode = defaults.dispatch_mode || 'in_warehouse'

  const candidateSerials = rawRows.map(r => normalizeSerialInput(r?.serial_number)).filter(Boolean)
  const [existingStockMap, existingAssetMap] = await Promise.all([
    lookupStockBySerials(db, candidateSerials),
    lookupScannerAssetsBySerials(db, candidateSerials),
  ])

  const seenInFile = new Map<string, number>()
  const items: ValidatedStockImportItem[] = []
  const counts = {
    total: rawRows.length,
    valid: 0,
    create_new: 0,
    reconcile_hybrid: 0,
    reactivate: 0,
    errors: 0,
    will_dispatch: 0,
  }

  rawRows.forEach((row, index) => {
    const rowNum = Number.isInteger(row?.source_row) && Number(row.source_row) > 0 ? Number(row.source_row) : index + 1
    const snCheck = validateSerialFormat(row?.serial_number)
    const brand = cleanOptionalText(row?.brand, 100) || defaultBrand
    const modelName = cleanOptionalText(row?.model_name, 120) || defaultModel
    const lotNo = cleanOptionalText(row?.lot_no, 100) || defaultLot
    const dispatchArea = cleanOptionalText(row?.dispatch_area, 120) || defaultArea
    const receivedDate = normalizeReceivedDate(row?.received_date) || defaultDate
    const note = cleanOptionalText(row?.note, 500) || defaultNote

    const pushError = (reason: string): void => {
      counts.errors++
      items.push({
        source_row: rowNum,
        serial_number: snCheck.serial || String(row?.serial_number ?? '').trim(),
        action: 'error',
        valid: false,
        target_status: null,
        existing_item_id: null,
        existing_status: null,
        brand,
        model_name: modelName,
        lot_no: lotNo,
        dispatch_area: dispatchArea,
        received_date: receivedDate,
        note,
        reason,
      })
    }

    if (!snCheck.valid) {
      pushError(snCheck.reason || 'Serial Number ไม่ถูกต้อง')
      return
    }

    const firstRow = seenInFile.get(snCheck.serial)
    if (firstRow !== undefined) {
      pushError(`Serial Number ซ้ำภายในไฟล์เดียวกับแถวที่ ${firstRow}`)
      return
    }
    seenInFile.set(snCheck.serial, rowNum)

    const existingBranchAsset = existingAssetMap.get(snCheck.serial)
    if (existingBranchAsset) {
      pushError(
        `Serial Number นี้เป็นเครื่องเก่าในทะเบียนสาขาแล้ว (${existingBranchAsset.location_code || ''} ${existingBranchAsset.loc_bld || ''})`.trim()
      )
      return
    }

    const existingStock = existingStockMap.get(snCheck.serial)
    if (existingStock) {
      if (
        existingStock.unit_type === 'new_unit' &&
        existingStock.source_mode === 'hybrid_unregistered' &&
        ['allocated_to_task', 'installed'].includes(existingStock.status)
      ) {
        counts.valid++
        counts.reconcile_hybrid++
        items.push({
          source_row: rowNum,
          serial_number: snCheck.serial,
          action: 'reconcile_hybrid',
          valid: true,
          target_status: existingStock.status as 'in_warehouse' | 'dispatched',
          existing_item_id: existingStock.id,
          existing_status: existingStock.status,
          existing_task_id: existingStock.linked_task_id,
          existing_branch_id: existingStock.linked_branch_id,
          brand,
          model_name: modelName,
          lot_no: lotNo,
          dispatch_area: dispatchArea,
          received_date: receivedDate,
          note,
          reason: `จับคู่อัปเกรดรายการ Hybrid ที่ช่างปิดงานไปแล้ว (${existingStock.status})`,
        })
        return
      }

      if (['void_hybrid', 'cancelled_restored'].includes(existingStock.status)) {
        const shouldDispatch =
          dispatchMode === 'dispatched' || (dispatchMode === 'auto_by_column' && Boolean(cleanOptionalText(row?.dispatch_area, 120) || defaultArea))
        if (shouldDispatch && !dispatchArea) {
          pushError('เลือกโหมดกระจายออกพื้นที่ทันที แต่ไม่พบชื่อพื้นที่/ทีมปลายทาง (dispatch_area)')
          return
        }
        const targetStatus = shouldDispatch ? 'dispatched' : 'in_warehouse'
        counts.valid++
        counts.reactivate++
        if (targetStatus === 'dispatched') counts.will_dispatch++
        items.push({
          source_row: rowNum,
          serial_number: snCheck.serial,
          action: 'reactivate',
          valid: true,
          target_status: targetStatus,
          existing_item_id: existingStock.id,
          existing_status: existingStock.status,
          brand,
          model_name: modelName,
          lot_no: lotNo,
          dispatch_area: dispatchArea,
          received_date: receivedDate,
          note,
          reason: `นำ SN ที่เคยถูกยกเลิก (${existingStock.status}) กลับเข้ารับสต็อกใหม่`,
        })
        return
      }

      pushError(`Serial Number นี้มีอยู่ในสต็อกแล้ว (ประเภท: ${existingStock.unit_type}, สถานะ: ${existingStock.status})`)
      return
    }

    const shouldDispatch =
      dispatchMode === 'dispatched' || (dispatchMode === 'auto_by_column' && Boolean(cleanOptionalText(row?.dispatch_area, 120) || defaultArea))
    if (shouldDispatch && !dispatchArea) {
      pushError('เลือกโหมดกระจายออกพื้นที่ทันที แต่ไม่พบชื่อพื้นที่/ทีมปลายทาง (dispatch_area)')
      return
    }
    const targetStatus = shouldDispatch ? 'dispatched' : 'in_warehouse'
    counts.valid++
    counts.create_new++
    if (targetStatus === 'dispatched') counts.will_dispatch++

    items.push({
      source_row: rowNum,
      serial_number: snCheck.serial,
      action: 'create_new',
      valid: true,
      target_status: targetStatus,
      existing_item_id: null,
      existing_status: null,
      brand,
      model_name: modelName,
      lot_no: lotNo,
      dispatch_area: dispatchArea,
      received_date: receivedDate,
      note,
      reason: null,
    })
  })

  return { summary: counts, items }
}

/**
 * Mounts all `/api/stock/*` endpoints for inventory management, supplier import,
 * warehouse dispatch, DOA marking, and old-unit reverse logistics.
 */
export function createStockRouter(): Hono<StockRouterEnv> {
  const stock = new Hono<StockRouterEnv>()

  // 1. KPI & ภาพรวมสต็อกเครื่องสแกนเนอร์ (ทุก role ที่ active ดูยอดรวมได้)
  stock.get('/summary', async (c) => {
    const [unitCounts, hybridCount, modelBreakdown, areaBreakdown, docCounts] = await Promise.all([
      c.env.DB.prepare(`
        SELECT unit_type, status, COUNT(*) as count
        FROM stock_items
        GROUP BY unit_type, status
      `).all<{ unit_type: string; status: string; count: number }>(),
      c.env.DB.prepare(`
        SELECT COUNT(*) as count
        FROM stock_items
        WHERE unit_type = 'new_unit'
          AND source_mode = 'hybrid_unregistered'
          AND status IN ('allocated_to_task', 'installed')
      `).first<{ count: number }>(),
      c.env.DB.prepare(`
        SELECT
          COALESCE(NULLIF(TRIM(brand), ''), 'ไม่ระบุยี่ห้อ') as brand,
          COALESCE(NULLIF(TRIM(model_name), ''), 'ไม่ระบุรุ่น') as model_name,
          SUM(CASE WHEN status = 'in_warehouse' THEN 1 ELSE 0 END) as in_warehouse,
          SUM(CASE WHEN status = 'dispatched' THEN 1 ELSE 0 END) as dispatched,
          SUM(CASE WHEN status = 'allocated_to_task' THEN 1 ELSE 0 END) as allocated_to_task,
          SUM(CASE WHEN status = 'installed' THEN 1 ELSE 0 END) as installed,
          SUM(CASE WHEN status = 'doa_defective' THEN 1 ELSE 0 END) as doa_defective,
          COUNT(*) as total
        FROM stock_items
        WHERE unit_type = 'new_unit' AND status != 'void_hybrid'
        GROUP BY COALESCE(NULLIF(TRIM(brand), ''), 'ไม่ระบุยี่ห้อ'), COALESCE(NULLIF(TRIM(model_name), ''), 'ไม่ระบุรุ่น')
        ORDER BY total DESC, model_name ASC
      `).all<{
        brand: string
        model_name: string
        in_warehouse: number
        dispatched: number
        allocated_to_task: number
        installed: number
        doa_defective: number
        total: number
      }>(),
      c.env.DB.prepare(`
        SELECT
          COALESCE(NULLIF(TRIM(dispatch_area), ''), 'ไม่ระบุพื้นที่') as dispatch_area,
          SUM(CASE WHEN status = 'dispatched' THEN 1 ELSE 0 END) as dispatched_available,
          SUM(CASE WHEN status = 'allocated_to_task' THEN 1 ELSE 0 END) as allocated_to_task,
          SUM(CASE WHEN status = 'installed' THEN 1 ELSE 0 END) as installed
        FROM stock_items
        WHERE unit_type = 'new_unit'
          AND status IN ('dispatched', 'allocated_to_task', 'installed')
          AND NULLIF(TRIM(dispatch_area), '') IS NOT NULL
        GROUP BY COALESCE(NULLIF(TRIM(dispatch_area), ''), 'ไม่ระบุพื้นที่')
        ORDER BY dispatched_available DESC, dispatch_area ASC
      `).all<{
        dispatch_area: string
        dispatched_available: number
        allocated_to_task: number
        installed: number
      }>(),
      c.env.DB.prepare(`
        SELECT doc_type, COUNT(*) as count
        FROM stock_documents
        GROUP BY doc_type
      `).all<{ doc_type: string; count: number }>(),
    ])

    const newUnits: Record<string, number> = {
      in_warehouse: 0,
      dispatched: 0,
      allocated_to_task: 0,
      installed: 0,
      doa_defective: 0,
      void_hybrid: 0,
      available_total: 0,
      total_active: 0,
      hybrid_unregistered: Number(hybridCount?.count || 0),
    }

    const oldRemoved: Record<string, number> = {
      removed_onsite: 0,
      returned_to_warehouse: 0,
      handed_over_to_customer: 0,
      cancelled_restored: 0,
      total_active: 0,
    }

    for (const row of unitCounts.results || []) {
      const cnt = Number(row.count) || 0
      if (row.unit_type === 'new_unit') {
        newUnits[row.status] = cnt
      } else if (row.unit_type === 'old_removed') {
        oldRemoved[row.status] = cnt
      }
    }

    newUnits.available_total = newUnits.in_warehouse + newUnits.dispatched
    newUnits.total_active =
      newUnits.in_warehouse +
      newUnits.dispatched +
      newUnits.allocated_to_task +
      newUnits.installed +
      newUnits.doa_defective

    oldRemoved.total_active =
      oldRemoved.removed_onsite +
      oldRemoved.returned_to_warehouse +
      oldRemoved.handed_over_to_customer

    const docsByType: Record<string, number> = {}
    for (const row of docCounts.results || []) {
      docsByType[row.doc_type] = Number(row.count) || 0
    }

    return c.json({
      new_units: newUnits,
      old_removed: oldRemoved,
      by_model: modelBreakdown.results || [],
      by_dispatch_area: areaBreakdown.results || [],
      documents_by_type: docsByType,
    })
  })

  // 2. รายการสต็อกเครื่องสแกนเนอร์ (รองรับค้นหา แบ่งหน้า และ masking ตามสิทธิ์ role)
  stock.get('/items', async (c) => {
    const user = c.get('user')
    const unitType = c.req.query('unit_type')?.trim()
    const statusParam = c.req.query('status')?.trim()
    const sourceMode = c.req.query('source_mode')?.trim()
    const dispatchArea = c.req.query('dispatch_area')?.trim()
    const lotNo = c.req.query('lot_no')?.trim()
    const branchId = c.req.query('branch_id')?.trim()
    const search = c.req.query('search')?.trim()
    const includeVoid = c.req.query('include_void') === '1' || c.req.query('include_void') === 'true'
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') || 50) || 50))
    const offset = Math.max(0, Number(c.req.query('offset') || 0) || 0)

    const whereParts: string[] = ['1=1']
    const params: unknown[] = []

    if (unitType) {
      if (!ALLOWED_UNIT_TYPES.has(unitType)) {
        return c.json({ error: 'unit_type ไม่ถูกต้อง' }, 400)
      }
      whereParts.push('si.unit_type = ?')
      params.push(unitType)
    }

    if (statusParam) {
      const requestedStatuses = Array.from(new Set(statusParam.split(',').map(s => s.trim()).filter(Boolean)))
      if (requestedStatuses.some(s => !ALLOWED_STOCK_STATUSES.has(s))) {
        return c.json({ error: 'status ไม่ถูกต้อง' }, 400)
      }
      if (requestedStatuses.length > 0) {
        const placeholders = requestedStatuses.map(() => '?').join(', ')
        whereParts.push(`si.status IN (${placeholders})`)
        params.push(...requestedStatuses)
      }
    } else if (!includeVoid) {
      whereParts.push("si.status NOT IN ('void_hybrid', 'cancelled_restored')")
    }

    if (sourceMode) {
      if (!ALLOWED_SOURCE_MODES.has(sourceMode)) {
        return c.json({ error: 'source_mode ไม่ถูกต้อง' }, 400)
      }
      whereParts.push('si.source_mode = ?')
      params.push(sourceMode)
    }

    if (dispatchArea) {
      whereParts.push('si.dispatch_area = ?')
      params.push(dispatchArea)
    }

    if (lotNo) {
      whereParts.push('si.lot_no = ?')
      params.push(lotNo)
    }

    if (branchId) {
      whereParts.push('si.linked_branch_id = ?')
      params.push(branchId)
    }

    if (search) {
      if (user.role === 'viewer') {
        whereParts.push(`(
          si.model_name LIKE ? OR
          si.brand LIKE ? OR
          si.dispatch_area LIKE ? OR
          b.location_code LIKE ? OR
          b.loc_bld LIKE ? OR
          b.province LIKE ?
        )`)
        const term = `%${search}%`
        params.push(term, term, term, term, term, term)
      } else {
        whereParts.push(`(
          si.serial_number LIKE ? OR
          si.model_name LIKE ? OR
          si.brand LIKE ? OR
          si.lot_no LIKE ? OR
          si.dispatch_area LIKE ? OR
          b.location_code LIKE ? OR
          b.loc_bld LIKE ? OR
          b.province LIKE ?
        )`)
        const term = `%${search}%`
        params.push(term, term, term, term, term, term, term, term)
      }
    }

    const whereSql = whereParts.join(' AND ')

    const [countRow, rowsRes] = await Promise.all([
      c.env.DB.prepare(`
        SELECT COUNT(*) as total
        FROM stock_items si
        LEFT JOIN branches b ON b.id = si.linked_branch_id
        WHERE ${whereSql}
      `).bind(...params).first<{ total: number }>(),
      c.env.DB.prepare(`
        SELECT
          si.*,
          b.location_code as branch_code,
          b.loc_bld as branch_name,
          b.province as branch_province,
          sa.com_sn as old_asset_sn,
          rt.status as linked_task_status,
          rdoc.doc_code as receive_doc_code,
          ddoc.doc_code as dispatch_doc_code,
          retdoc.doc_code as return_doc_code,
          hdoc.doc_code as handover_doc_code
        FROM stock_items si
        LEFT JOIN branches b ON b.id = si.linked_branch_id
        LEFT JOIN scanner_assets sa ON sa.id = si.linked_old_asset_id
        LEFT JOIN replacement_tasks rt ON rt.id = si.linked_task_id
        LEFT JOIN stock_documents rdoc ON rdoc.id = si.receive_doc_id
        LEFT JOIN stock_documents ddoc ON ddoc.id = si.dispatch_doc_id
        LEFT JOIN stock_documents retdoc ON retdoc.id = si.return_doc_id
        LEFT JOIN stock_documents hdoc ON hdoc.id = si.handover_doc_id
        WHERE ${whereSql}
        ORDER BY si.updated_at DESC, si.rowid DESC
        LIMIT ? OFFSET ?
      `).bind(...params, limit, offset).all<Record<string, any>>(),
    ])

    return c.json({
      total: Number(countRow?.total || 0),
      limit,
      offset,
      rows: (rowsRes.results || []).map(row => formatStockRowForRole(row, user.role)),
    })
  })

  // 3. ตรวจสอบสถานะ SN แบบ Real-time (ตอนช่างสแกนบาร์โค้ดปิดงาน หรือแอดมินตรวจสอบประวัติทั้งสาย)
  stock.get('/lookup', async (c) => {
    const user = c.get('user')
    if (user.role === 'viewer') {
      return c.json({ error: 'บัญชีผู้เข้าชมไม่ได้รับอนุญาตให้ค้นหา Serial Number รายตัว' }, 403)
    }

    const rawSerial = c.req.query('serial')
    const taskId = c.req.query('task_id')?.trim() || ''
    const snCheck = validateSerialFormat(rawSerial)
    if (!snCheck.valid) {
      return c.json({ error: snCheck.reason || 'กรุณาระบุ Serial Number ที่ถูกต้อง' }, 400)
    }

    const item = await c.env.DB.prepare(`
      SELECT
        si.*,
        b.location_code as branch_code,
        b.loc_bld as branch_name,
        b.province as branch_province,
        sa.com_sn as old_asset_sn,
        rdoc.doc_code as receive_doc_code,
        ddoc.doc_code as dispatch_doc_code,
        retdoc.doc_code as return_doc_code,
        hdoc.doc_code as handover_doc_code
      FROM stock_items si
      LEFT JOIN branches b ON b.id = si.linked_branch_id
      LEFT JOIN scanner_assets sa ON sa.id = si.linked_old_asset_id
      LEFT JOIN stock_documents rdoc ON rdoc.id = si.receive_doc_id
      LEFT JOIN stock_documents ddoc ON ddoc.id = si.dispatch_doc_id
      LEFT JOIN stock_documents retdoc ON retdoc.id = si.return_doc_id
      LEFT JOIN stock_documents hdoc ON hdoc.id = si.handover_doc_id
      WHERE si.serial_number = ?
    `).bind(snCheck.serial).first<Record<string, any>>()

    if (item) {
      const movementsRes = await c.env.DB.prepare(`
        SELECT m.*, d.doc_code, b.location_code as branch_code, b.loc_bld as branch_name
        FROM stock_movements m
        LEFT JOIN stock_documents d ON d.id = m.doc_id
        LEFT JOIN branches b ON b.id = m.branch_id
        WHERE m.stock_item_id = ?
        ORDER BY m.created_at DESC, m.rowid DESC
        LIMIT 50
      `).bind(item.id).all<Record<string, any>>()

      let availableForCloseout = false
      let availabilityCode = 'BLOCKED'
      let availabilityMessage = 'ไม่สามารถใช้งาน SN นี้ได้'

      if (item.unit_type === 'old_removed' && item.status !== 'cancelled_restored') {
        availabilityCode = 'OLD_REMOVED'
        availabilityMessage = `SN นี้เป็นซากเครื่องเดิมที่ถูกถอดจากสาขาแล้ว (${item.status})`
      } else if (item.status === 'in_warehouse') {
        availableForCloseout = true
        availabilityCode = 'IN_WAREHOUSE'
        availabilityMessage = 'เครื่องใหม่อยู่ในคลังกลาง พร้อมตัดใช้งาน'
      } else if (item.status === 'dispatched') {
        availableForCloseout = true
        availabilityCode = 'DISPATCHED'
        availabilityMessage = `เครื่องใหม่กระจายออกพื้นที่ (${item.dispatch_area || 'ไม่ระบุพื้นที่'}) พร้อมตัดใช้งาน`
      } else if (item.status === 'allocated_to_task') {
        if (taskId && item.linked_task_id === taskId) {
          availableForCloseout = true
          availabilityCode = 'ALREADY_ALLOCATED_THIS_TASK'
          availabilityMessage = 'SN นี้ถูกผูกอยู่กับใบงานนี้แล้ว สามารถส่งงานซ้ำได้'
        } else {
          availabilityCode = 'ALLOCATED_OTHER_TASK'
          availabilityMessage = 'SN นี้ถูกจองใช้งานกับใบงานอื่นอยู่'
        }
      } else if (item.status === 'installed') {
        availabilityCode = 'INSTALLED'
        availabilityMessage = `SN นี้ติดตั้งและตรวจรับไปแล้วที่ ${item.branch_name || 'สาขาอื่น'}`
      } else if (item.status === 'doa_defective') {
        availabilityCode = 'DOA_DEFECTIVE'
        availabilityMessage = 'SN นี้ถูกแจ้งเสีย (DOA) แล้ว'
      } else if (['void_hybrid', 'cancelled_restored'].includes(item.status)) {
        availableForCloseout = true
        availabilityCode = 'HYBRID_REACTIVATABLE'
        availabilityMessage = 'SN นี้อยู่ในสถานะยกเลิกเดิม สามารถใช้งานใหม่แบบ Hybrid Mode ได้'
      }

      return c.json({
        found: true,
        serial_number: snCheck.serial,
        availability: {
          available_for_closeout: availableForCloseout,
          code: availabilityCode,
          message: availabilityMessage,
        },
        item: formatStockRowForRole(item, user.role),
        movements: (movementsRes.results || []).map(m => formatStockRowForRole(m, user.role)),
      })
    }

    const branchAsset = await c.env.DB.prepare(`
      SELECT s.id, s.com_sn, s.branch_id, b.location_code, b.loc_bld
      FROM scanner_assets s
      LEFT JOIN branches b ON b.id = s.branch_id
      WHERE s.com_sn = ?
    `).bind(snCheck.serial).first<{ id: string; com_sn: string; branch_id: string; location_code: string | null; loc_bld: string | null }>()

    if (branchAsset) {
      return c.json({
        found: false,
        serial_number: snCheck.serial,
        availability: {
          available_for_closeout: false,
          code: 'EXISTING_BRANCH_ASSET',
          message: `SN นี้เป็นเครื่องเดิมในทะเบียนสาขา ${branchAsset.loc_bld || ''} (${branchAsset.location_code || ''})`,
        },
        item: null,
        movements: [],
      })
    }

    return c.json({
      found: false,
      serial_number: snCheck.serial,
      availability: {
        available_for_closeout: true,
        code: 'HYBRID_UNREGISTERED',
        message: 'ยังไม่พบ SN นี้ในสต็อกคลัง — สามารถปิดงานได้ทันทีด้วย Hybrid Mode และรอนำเข้าไฟล์ Supplier จับคู่ภายหลัง',
      },
      item: null,
      movements: [],
    })
  })

  // 4. Preview ตรวจสอบไฟล์สต็อกเครื่องใหม่จาก Supplier ก่อน Commit
  stock.post('/import/preview', async (c) => {
    const user = c.get('user')
    if (!ADMIN_STOCK_ROLES.has(user.role)) {
      return c.json({ error: 'เฉพาะ Admin เท่านั้นที่สามารถนำเข้าสต็อกเครื่องใหม่ได้' }, 403)
    }

    let body: { rows?: StockImportInputRow[]; defaults?: StockImportDefaults }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' }, 400)
    }

    const rows = body.rows
    if (!Array.isArray(rows) || rows.length === 0) {
      return c.json({ error: 'ไม่พบข้อมูลแถวสำหรับตรวจสอบนำเข้าสต็อก' }, 400)
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      return c.json({ error: `นำเข้าได้สูงสุด ${MAX_IMPORT_ROWS.toLocaleString()} แถวต่อชุด` }, 400)
    }

    const result = await validateStockImportBatch(c.env.DB, rows, body.defaults || {})
    return c.json(result)
  })

  // 5. ยืนยันนำเข้าสต็อกเครื่องใหม่เข้าคลังกลาง (Atomic Preview -> Re-Validate -> Commit)
  stock.post('/import/commit', async (c) => {
    const user = c.get('user')
    if (!ADMIN_STOCK_ROLES.has(user.role)) {
      return c.json({ error: 'เฉพาะ Admin เท่านั้นที่สามารถนำเข้าสต็อกเครื่องใหม่ได้' }, 403)
    }

    let body: {
      source_name?: string
      rows?: StockImportInputRow[]
      defaults?: StockImportDefaults
      skip_invalid?: boolean
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' }, 400)
    }

    const rows = body.rows
    if (!Array.isArray(rows) || rows.length === 0) {
      return c.json({ error: 'ไม่พบข้อมูลแถวสำหรับนำเข้าสต็อก' }, 400)
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      return c.json({ error: `นำเข้าได้สูงสุด ${MAX_IMPORT_ROWS.toLocaleString()} แถวต่อชุด` }, 400)
    }

    const defaults = body.defaults || {}
    const validation = await validateStockImportBatch(c.env.DB, rows, defaults)

    if (validation.summary.errors > 0 && !body.skip_invalid) {
      return c.json(
        {
          error: `พบข้อผิดพลาด ${validation.summary.errors} รายการ กรุณาแก้ไขก่อนยืนยันนำเข้า หรือเลือกข้ามแถวที่มีปัญหา`,
          summary: validation.summary,
          items: validation.items.filter(i => !i.valid).slice(0, 50),
        },
        409
      )
    }

    const validItems = validation.items.filter(i => i.valid)
    if (validItems.length === 0) {
      return c.json({ error: 'ไม่มีรายการที่ถูกต้องสำหรับนำเข้าสต็อก' }, 400)
    }

    const receiveDocId = makeStockUniqueId('sdoc')
    const receiveDocCode = makeStockDocCode('RCV')
    const defaultLot = cleanOptionalText(defaults.lot_no, 100) || validItems.find(i => i.lot_no)?.lot_no || null
    const defaultArea = cleanOptionalText(defaults.dispatch_area, 120) || null
    const sourceName = cleanOptionalText(body.source_name, 160)
    const defaultNote = cleanOptionalText(defaults.note, 500) || (sourceName ? `นำเข้าจากไฟล์ ${sourceName}` : null)

    const dispatchedItems = validItems.filter(i => i.target_status === 'dispatched' && i.action !== 'reconcile_hybrid')
    const dispatchDocId = dispatchedItems.length > 0 ? makeStockUniqueId('sdoc') : null
    const dispatchDocCode = dispatchedItems.length > 0 ? makeStockDocCode('DSP') : null

    const statements: StockD1PreparedStatement[] = [
      c.env.DB.prepare(`
        INSERT INTO stock_documents (id, doc_code, doc_type, lot_no, destination_area, note, item_count, created_by)
        VALUES (?, ?, 'receive', ?, ?, ?, ?, ?)
      `).bind(receiveDocId, receiveDocCode, defaultLot, defaultArea, defaultNote, validItems.length, user.email),
    ]

    if (dispatchDocId && dispatchDocCode) {
      const uniqueAreas = Array.from(new Set(dispatchedItems.map(i => i.dispatch_area).filter(Boolean)))
      const docAreaLabel = uniqueAreas.length === 1 ? uniqueAreas[0] : uniqueAreas.slice(0, 3).join(', ')
      statements.push(
        c.env.DB.prepare(`
          INSERT INTO stock_documents (id, doc_code, doc_type, lot_no, destination_area, note, item_count, created_by)
          VALUES (?, ?, 'dispatch', ?, ?, ?, ?, ?)
        `).bind(
          dispatchDocId,
          dispatchDocCode,
          defaultLot,
          docAreaLabel || defaultArea || 'หลายพื้นที่',
          `กระจายสต็อกอัตโนมัติพร้อมใบรับเข้า ${receiveDocCode}`,
          dispatchedItems.length,
          user.email
        )
      )
    }

    for (const item of validItems) {
      if (item.action === 'reconcile_hybrid' && item.existing_item_id) {
        statements.push(
          c.env.DB.prepare(`
            UPDATE stock_items SET
              source_mode = 'registered_stock',
              brand = COALESCE(?, brand),
              model_name = COALESCE(?, model_name),
              lot_no = COALESCE(?, lot_no),
              receive_doc_id = ?,
              received_at = COALESCE(received_at, ?, datetime('now')),
              note = COALESCE(?, note),
              updated_by = ?,
              version = version + 1,
              updated_at = datetime('now')
            WHERE id = ? AND source_mode = 'hybrid_unregistered'
          `).bind(
            item.brand,
            item.model_name,
            item.lot_no,
            receiveDocId,
            item.received_date,
            item.note,
            user.email,
            item.existing_item_id
          ),
          buildMovementInsert(c.env.DB, {
            stockItemId: item.existing_item_id,
            docId: receiveDocId,
            taskId: item.existing_task_id ?? null,
            branchId: item.existing_branch_id ?? null,
            action: 'reconciled_hybrid',
            fromStatus: item.existing_status,
            toStatus: item.existing_status || 'allocated_to_task',
            actorEmail: user.email,
            note: `จับคู่ไฟล์ Supplier (${receiveDocCode}) กับงาน Hybrid เดิม`,
          })
        )
        continue
      }

      if (item.action === 'reactivate' && item.existing_item_id) {
        const finalStatus = item.target_status || 'in_warehouse'
        const isDispatched = finalStatus === 'dispatched'
        statements.push(
          c.env.DB.prepare(`
            UPDATE stock_items SET
              unit_type = 'new_unit',
              status = ?,
              pre_task_status = NULL,
              source_mode = 'registered_stock',
              brand = ?,
              model_name = ?,
              lot_no = ?,
              receive_doc_id = ?,
              dispatch_doc_id = ?,
              dispatch_area = ?,
              return_doc_id = NULL,
              handover_doc_id = NULL,
              linked_task_id = NULL,
              linked_branch_id = NULL,
              linked_old_asset_id = NULL,
              received_at = COALESCE(?, datetime('now')),
              dispatched_at = CASE WHEN ? = 'dispatched' THEN datetime('now') ELSE NULL END,
              allocated_at = NULL,
              installed_at = NULL,
              returned_at = NULL,
              handed_over_at = NULL,
              note = ?,
              updated_by = ?,
              version = version + 1,
              updated_at = datetime('now')
            WHERE id = ? AND status IN ('void_hybrid', 'cancelled_restored')
          `).bind(
            finalStatus,
            item.brand,
            item.model_name,
            item.lot_no,
            receiveDocId,
            isDispatched ? dispatchDocId : null,
            item.dispatch_area,
            item.received_date,
            finalStatus,
            item.note,
            user.email,
            item.existing_item_id
          ),
          buildMovementInsert(c.env.DB, {
            stockItemId: item.existing_item_id,
            docId: receiveDocId,
            action: 'received',
            fromStatus: item.existing_status,
            toStatus: 'in_warehouse',
            actorEmail: user.email,
            note: item.note || `รับเข้าสต็อก (${receiveDocCode})`,
          })
        )
        if (isDispatched && dispatchDocId) {
          statements.push(
            buildMovementInsert(c.env.DB, {
              stockItemId: item.existing_item_id,
              docId: dispatchDocId,
              action: 'dispatched',
              fromStatus: 'in_warehouse',
              toStatus: 'dispatched',
              actorEmail: user.email,
              note: `กระจายไปยัง ${item.dispatch_area || 'พื้นที่'} (${dispatchDocCode})`,
            })
          )
        }
        continue
      }

      // create_new
      const newStockId = makeStockUniqueId('stk')
      const finalStatus = item.target_status || 'in_warehouse'
      const isDispatched = finalStatus === 'dispatched'
      statements.push(
        c.env.DB.prepare(`
          INSERT INTO stock_items (
            id, serial_number, unit_type, status, pre_task_status, source_mode,
            brand, model_name, lot_no, receive_doc_id, dispatch_doc_id, dispatch_area,
            received_at, dispatched_at, note, created_by, updated_by
          ) VALUES (
            ?, ?, 'new_unit', ?, NULL, 'registered_stock',
            ?, ?, ?, ?, ?, ?,
            COALESCE(?, datetime('now')),
            CASE WHEN ? = 'dispatched' THEN datetime('now') ELSE NULL END,
            ?, ?, ?
          )
        `).bind(
          newStockId,
          item.serial_number,
          finalStatus,
          item.brand,
          item.model_name,
          item.lot_no,
          receiveDocId,
          isDispatched ? dispatchDocId : null,
          item.dispatch_area,
          item.received_date,
          finalStatus,
          item.note,
          user.email,
          user.email
        ),
        buildMovementInsert(c.env.DB, {
          stockItemId: newStockId,
          docId: receiveDocId,
          action: 'received',
          fromStatus: null,
          toStatus: 'in_warehouse',
          actorEmail: user.email,
          note: item.note || `รับเข้าสต็อก (${receiveDocCode})`,
        })
      )
      if (isDispatched && dispatchDocId) {
        statements.push(
          buildMovementInsert(c.env.DB, {
            stockItemId: newStockId,
            docId: dispatchDocId,
            action: 'dispatched',
            fromStatus: 'in_warehouse',
            toStatus: 'dispatched',
            actorEmail: user.email,
            note: `กระจายไปยัง ${item.dispatch_area || 'พื้นที่'} (${dispatchDocCode})`,
          })
        )
      }
    }

    await runBatchChunks(c.env.DB, statements, 150)

    return c.json({
      success: true,
      doc_id: receiveDocId,
      doc_code: receiveDocCode,
      dispatch_doc_code: dispatchDocCode,
      committed_count: validItems.length,
      summary: validation.summary,
      message: `นำเข้าสต็อกสำเร็จ ${validItems.length} เครื่อง (${receiveDocCode})`,
    })
  })

  const resolveSerialBatchItems = async (
    db: StockD1Database,
    rawSerialNumbers: unknown,
    predicate: (item: StockItemRow) => boolean,
    formatInvalidReason: (sn: string, item?: StockItemRow) => string,
    invalidPrefixMessage: string
  ): Promise<{ ok: true; serials: string[]; eligible: StockItemRow[] } | { ok: false; status: 400 | 409; error: string; invalid_serials?: string[] }> => {
    const rawList = Array.isArray(rawSerialNumbers) ? rawSerialNumbers : []
    const serials: string[] = Array.from(
      new Set(rawList.map(value => normalizeSerialInput(value)).filter((sn): sn is string => sn.length > 0))
    )
    if (serials.length === 0) {
      return { ok: false, status: 400, error: 'กรุณาระบุ Serial Number อย่างน้อย 1 รายการ' }
    }
    if (serials.length > MAX_BATCH_ACTION_SNS) {
      return { ok: false, status: 400, error: `ดำเนินการได้สูงสุด ${MAX_BATCH_ACTION_SNS} เครื่องต่อครั้ง` }
    }

    const stockMap = await lookupStockBySerials(db, serials)
    const invalid: string[] = []
    const eligible: StockItemRow[] = []
    for (const sn of serials) {
      const item = stockMap.get(sn)
      if (!item || !predicate(item)) {
        invalid.push(formatInvalidReason(sn, item))
      } else {
        eligible.push(item)
      }
    }

    if (invalid.length > 0) {
      return {
        ok: false,
        status: 409,
        error: `${invalidPrefixMessage}: ${invalid.slice(0, 5).join(', ')}`,
        invalid_serials: invalid,
      }
    }

    return { ok: true, serials, eligible }
  }

  // 6. เบิก/กระจายสต็อกออกพื้นที่ (แบบ B: Central Pool -> Tagged Dispatched Area)
  stock.post('/dispatch', async (c) => {
    const user = c.get('user')
    if (!ADMIN_STOCK_ROLES.has(user.role)) {
      return c.json({ error: 'เฉพาะ Admin เท่านั้นที่สามารถเบิกกระจายสต็อกได้' }, 403)
    }

    let body: { serial_numbers?: unknown[]; dispatch_area?: string; note?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' }, 400)
    }

    const dispatchArea = cleanOptionalText(body.dispatch_area, 120)
    const note = cleanOptionalText(body.note, 500)
    if (!dispatchArea) {
      return c.json({ error: 'กรุณาระบุพื้นที่/ทีมปลายทาง (dispatch_area)' }, 400)
    }

    const resolved = await resolveSerialBatchItems(
      c.env.DB,
      body.serial_numbers,
      item => item.unit_type === 'new_unit' && ['in_warehouse', 'dispatched'].includes(item.status),
      (sn, item) => `${sn}${item ? ` (${item.unit_type}/${item.status})` : ' (ไม่พบในระบบ)'}`,
      'มีรายการที่ไม่สามารถเบิกกระจายได้'
    )
    if (!resolved.ok) {
      return c.json({ error: resolved.error, invalid_serials: resolved.invalid_serials }, resolved.status)
    }
    const eligible = resolved.eligible

    const docId = makeStockUniqueId('sdoc')
    const docCode = makeStockDocCode('DSP')
    const statements: StockD1PreparedStatement[] = [
      c.env.DB.prepare(`
        INSERT INTO stock_documents (id, doc_code, doc_type, destination_area, note, item_count, created_by)
        VALUES (?, ?, 'dispatch', ?, ?, ?, ?)
      `).bind(docId, docCode, dispatchArea, note, eligible.length, user.email),
    ]

    for (const item of eligible) {
      statements.push(
        c.env.DB.prepare(`
          UPDATE stock_items SET
            status = 'dispatched',
            dispatch_doc_id = ?,
            dispatch_area = ?,
            dispatched_at = datetime('now'),
            note = COALESCE(?, note),
            updated_by = ?,
            version = version + 1,
            updated_at = datetime('now')
          WHERE id = ? AND status IN ('in_warehouse', 'dispatched') AND version = ?
        `).bind(docId, dispatchArea, note, user.email, item.id, item.version),
        buildMovementInsert(c.env.DB, {
          stockItemId: item.id,
          docId,
          action: 'dispatched',
          fromStatus: item.status,
          toStatus: 'dispatched',
          actorEmail: user.email,
          note: note || `เบิกกระจายไปยัง ${dispatchArea} (${docCode})`,
        })
      )
    }

    await runBatchChunks(c.env.DB, statements, 150)

    return c.json({
      success: true,
      doc_id: docId,
      doc_code: docCode,
      count: eligible.length,
      dispatch_area: dispatchArea,
      message: `เบิกกระจาย ${eligible.length} เครื่องไปยัง ${dispatchArea} เรียบร้อย (${docCode})`,
    })
  })

  // 7. ดึงเครื่องใหม่ที่ยังไม่ได้ติดตั้งกลับเข้าคลังกลาง (Dispatched -> In Warehouse)
  stock.post('/recall', async (c) => {
    const user = c.get('user')
    if (!ADMIN_STOCK_ROLES.has(user.role)) {
      return c.json({ error: 'เฉพาะ Admin เท่านั้นที่สามารถรับคืนสต็อกกลับคลังกลางได้' }, 403)
    }

    let body: { serial_numbers?: unknown[]; note?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' }, 400)
    }

    const note = cleanOptionalText(body.note, 500) || 'รับเครื่องใหม่ที่ยังไม่ใช้งานกลับคลังกลาง'
    const resolved = await resolveSerialBatchItems(
      c.env.DB,
      body.serial_numbers,
      item => item.unit_type === 'new_unit' && item.status === 'dispatched',
      (sn, item) => `${sn}${item ? ` (${item.status})` : ' (ไม่พบในระบบ)'}`,
      'มีรายการที่ไม่อยู่ในสถานะเบิกออกพื้นที่'
    )
    if (!resolved.ok) {
      return c.json({ error: resolved.error, invalid_serials: resolved.invalid_serials }, resolved.status)
    }
    const eligible = resolved.eligible

    const docId = makeStockUniqueId('sdoc')
    const docCode = makeStockDocCode('ADJ')
    const statements: StockD1PreparedStatement[] = [
      c.env.DB.prepare(`
        INSERT INTO stock_documents (id, doc_code, doc_type, destination_area, note, item_count, created_by)
        VALUES (?, ?, 'adjustment', 'คลังกลาง SYM', ?, ?, ?)
      `).bind(docId, docCode, note, eligible.length, user.email),
    ]

    for (const item of eligible) {
      statements.push(
        c.env.DB.prepare(`
          UPDATE stock_items SET
            status = 'in_warehouse',
            dispatch_doc_id = NULL,
            dispatch_area = NULL,
            dispatched_at = NULL,
            updated_by = ?,
            version = version + 1,
            updated_at = datetime('now')
          WHERE id = ? AND status = 'dispatched' AND version = ?
        `).bind(user.email, item.id, item.version),
        buildMovementInsert(c.env.DB, {
          stockItemId: item.id,
          docId,
          action: 'adjusted',
          fromStatus: 'dispatched',
          toStatus: 'in_warehouse',
          actorEmail: user.email,
          note: `${note} (${docCode})`,
        })
      )
    }

    await runBatchChunks(c.env.DB, statements, 150)

    return c.json({
      success: true,
      doc_id: docId,
      doc_code: docCode,
      count: eligible.length,
      message: `ดึงเครื่องใหม่กลับเข้าคลังกลาง ${eligible.length} เครื่องสำเร็จ (${docCode})`,
    })
  })

  // 8. แจ้งเครื่องใหม่เสีย/ชำรุดรอเคลม Supplier (DOA Defective)
  stock.post('/doa', async (c) => {
    const user = c.get('user')
    if (!ADMIN_STOCK_ROLES.has(user.role)) {
      return c.json({ error: 'เฉพาะ Admin เท่านั้นที่สามารถแจ้งเครื่องใหม่เสีย (DOA) ได้' }, 403)
    }

    let body: { serial_numbers?: unknown[]; note?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' }, 400)
    }

    const note = cleanOptionalText(body.note, 500)
    if (!note) {
      return c.json({ error: 'กรุณาระบุอาการเสียหรือเหตุผลที่ตั้งสถานะ DOA' }, 400)
    }

    const resolved = await resolveSerialBatchItems(
      c.env.DB,
      body.serial_numbers,
      item => item.unit_type === 'new_unit' && ['in_warehouse', 'dispatched'].includes(item.status),
      (sn, item) => `${sn}${item ? ` (${item.status})` : ' (ไม่พบในระบบ)'}`,
      'มีรายการที่ไม่สามารถแจ้งเสียได้ (ต้องว่างในคลังหรือพื้นที่)'
    )
    if (!resolved.ok) {
      return c.json({ error: resolved.error, invalid_serials: resolved.invalid_serials }, resolved.status)
    }
    const eligible = resolved.eligible

    const docId = makeStockUniqueId('sdoc')
    const docCode = makeStockDocCode('DOA')
    const statements: StockD1PreparedStatement[] = [
      c.env.DB.prepare(`
        INSERT INTO stock_documents (id, doc_code, doc_type, note, item_count, created_by)
        VALUES (?, ?, 'doa_claim', ?, ?, ?)
      `).bind(docId, docCode, note, eligible.length, user.email),
    ]

    for (const item of eligible) {
      statements.push(
        c.env.DB.prepare(`
          UPDATE stock_items SET
            status = 'doa_defective',
            note = ?,
            updated_by = ?,
            version = version + 1,
            updated_at = datetime('now')
          WHERE id = ? AND status IN ('in_warehouse', 'dispatched') AND version = ?
        `).bind(note, user.email, item.id, item.version),
        buildMovementInsert(c.env.DB, {
          stockItemId: item.id,
          docId,
          action: 'marked_doa',
          fromStatus: item.status,
          toStatus: 'doa_defective',
          actorEmail: user.email,
          note: `แจ้งเสีย DOA: ${note} (${docCode})`,
        })
      )
    }

    await runBatchChunks(c.env.DB, statements, 150)

    return c.json({
      success: true,
      doc_id: docId,
      doc_code: docCode,
      count: eligible.length,
      message: `บันทึกสถานะ DOA ${eligible.length} เครื่องสำเร็จ (${docCode})`,
    })
  })

  // 9. Reverse Logistics ขาที่ 1: คลังกลาง SYM รับซากเครื่องเดิมคืนจากหน้างาน (removed_onsite -> returned_to_warehouse)
  stock.post('/old-returns/receive', async (c) => {
    const user = c.get('user')
    if (!ADMIN_STOCK_ROLES.has(user.role)) {
      return c.json({ error: 'เฉพาะ Admin เท่านั้นที่สามารถยืนยันรับซากเครื่องเดิมเข้าคลังได้' }, 403)
    }

    let body: { serial_numbers?: unknown[]; note?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' }, 400)
    }

    const note = cleanOptionalText(body.note, 500)
    const resolved = await resolveSerialBatchItems(
      c.env.DB,
      body.serial_numbers,
      item => item.unit_type === 'old_removed' && item.status === 'removed_onsite',
      (sn, item) => `${sn}${item ? ` (${item.unit_type}/${item.status})` : ' (ยังไม่ถูกบันทึกถอดเปลี่ยน)'}`,
      'มีซากเครื่องที่ไม่อยู่ในสถานะรอรับคืนคลัง'
    )
    if (!resolved.ok) {
      return c.json({ error: resolved.error, invalid_serials: resolved.invalid_serials }, resolved.status)
    }
    const eligible = resolved.eligible

    const docId = makeStockUniqueId('sdoc')
    const docCode = makeStockDocCode('RET')
    const statements: StockD1PreparedStatement[] = [
      c.env.DB.prepare(`
        INSERT INTO stock_documents (id, doc_code, doc_type, note, item_count, created_by)
        VALUES (?, ?, 'return_in', ?, ?, ?)
      `).bind(docId, docCode, note, eligible.length, user.email),
    ]

    for (const item of eligible) {
      statements.push(
        c.env.DB.prepare(`
          UPDATE stock_items SET
            status = 'returned_to_warehouse',
            return_doc_id = ?,
            returned_at = datetime('now'),
            note = COALESCE(?, note),
            updated_by = ?,
            version = version + 1,
            updated_at = datetime('now')
          WHERE id = ? AND status = 'removed_onsite' AND version = ?
        `).bind(docId, note, user.email, item.id, item.version),
        buildMovementInsert(c.env.DB, {
          stockItemId: item.id,
          docId,
          taskId: item.linked_task_id,
          branchId: item.linked_branch_id,
          action: 'returned_to_warehouse',
          fromStatus: 'removed_onsite',
          toStatus: 'returned_to_warehouse',
          actorEmail: user.email,
          note: note || `คลังกลาง SYM รับซากเครื่องเดิมเข้าคลัง (${docCode})`,
        })
      )
    }

    await runBatchChunks(c.env.DB, statements, 150)

    return c.json({
      success: true,
      doc_id: docId,
      doc_code: docCode,
      count: eligible.length,
      message: `ยืนยันรับซากเครื่องเดิมเข้าคลัง ${eligible.length} เครื่องสำเร็จ (${docCode})`,
    })
  })

  // 10. Reverse Logistics ขาที่ 2: ส่งมอบซากเครื่องเดิมคืนลูกค้า AIS / G-Able (returned_to_warehouse -> handed_over_to_customer)
  stock.post('/old-returns/handover', async (c) => {
    const user = c.get('user')
    if (!ADMIN_STOCK_ROLES.has(user.role)) {
      return c.json({ error: 'เฉพาะ Admin เท่านั้นที่สามารถส่งมอบซากเครื่องคืนลูกค้าได้' }, 403)
    }

    let body: { serial_numbers?: unknown[]; recipient_name?: string; note?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' }, 400)
    }

    const recipientName = cleanOptionalText(body.recipient_name, 160)
    const note = cleanOptionalText(body.note, 500)
    if (!recipientName) {
      return c.json({ error: 'กรุณาระบุชื่อผู้รับมอบซากเครื่องฝั่งลูกค้า/G-Able' }, 400)
    }

    const resolved = await resolveSerialBatchItems(
      c.env.DB,
      body.serial_numbers,
      item => item.unit_type === 'old_removed' && item.status === 'returned_to_warehouse',
      (sn, item) => `${sn}${item ? ` (${item.unit_type}/${item.status})` : ' (ไม่พบในคลังรับซาก)'}`,
      'มีซากเครื่องที่ยังไม่ได้รับเข้าคลังกลางหรือส่งมอบไปแล้ว'
    )
    if (!resolved.ok) {
      return c.json({ error: resolved.error, invalid_serials: resolved.invalid_serials }, resolved.status)
    }
    const eligible = resolved.eligible

    const docId = makeStockUniqueId('sdoc')
    const docCode = makeStockDocCode('HOV')
    const statements: StockD1PreparedStatement[] = [
      c.env.DB.prepare(`
        INSERT INTO stock_documents (id, doc_code, doc_type, recipient_name, note, item_count, created_by)
        VALUES (?, ?, 'handover_out', ?, ?, ?, ?)
      `).bind(docId, docCode, recipientName, note, eligible.length, user.email),
    ]

    for (const item of eligible) {
      statements.push(
        c.env.DB.prepare(`
          UPDATE stock_items SET
            status = 'handed_over_to_customer',
            handover_doc_id = ?,
            handed_over_at = datetime('now'),
            note = COALESCE(?, note),
            updated_by = ?,
            version = version + 1,
            updated_at = datetime('now')
          WHERE id = ? AND status = 'returned_to_warehouse' AND version = ?
        `).bind(docId, note, user.email, item.id, item.version),
        buildMovementInsert(c.env.DB, {
          stockItemId: item.id,
          docId,
          taskId: item.linked_task_id,
          branchId: item.linked_branch_id,
          action: 'handed_over_to_customer',
          fromStatus: 'returned_to_warehouse',
          toStatus: 'handed_over_to_customer',
          actorEmail: user.email,
          note: `ส่งมอบคืนลูกค้าให้ ${recipientName} (${docCode})${note ? ` — ${note}` : ''}`,
        })
      )
    }

    await runBatchChunks(c.env.DB, statements, 150)

    return c.json({
      success: true,
      doc_id: docId,
      doc_code: docCode,
      count: eligible.length,
      recipient_name: recipientName,
      message: `บันทึกส่งมอบซากเครื่องคืนลูกค้า ${eligible.length} เครื่องให้ ${recipientName} สำเร็จ (${docCode})`,
    })
  })

  // 11. ประวัติเอกสารรับ-จ่าย-รับซาก-ส่งมอบสต็อก
  stock.get('/documents', async (c) => {
    const user = c.get('user')
    if (!ADMIN_STOCK_ROLES.has(user.role)) {
      return c.json({ error: 'เฉพาะ Admin เท่านั้นที่สามารถดูเอกสารสต็อกได้' }, 403)
    }

    const docType = c.req.query('doc_type')?.trim()
    const search = c.req.query('search')?.trim()
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') || 50) || 50))
    const offset = Math.max(0, Number(c.req.query('offset') || 0) || 0)

    const whereParts: string[] = ['1=1']
    const params: unknown[] = []

    if (docType) {
      if (!ALLOWED_DOC_TYPES.has(docType)) {
        return c.json({ error: 'doc_type ไม่ถูกต้อง' }, 400)
      }
      whereParts.push('doc_type = ?')
      params.push(docType)
    }

    if (search) {
      whereParts.push('(doc_code LIKE ? OR lot_no LIKE ? OR destination_area LIKE ? OR recipient_name LIKE ? OR note LIKE ?)')
      const term = `%${search}%`
      params.push(term, term, term, term, term)
    }

    const whereSql = whereParts.join(' AND ')
    const [countRow, docsRes] = await Promise.all([
      c.env.DB.prepare(`SELECT COUNT(*) as total FROM stock_documents WHERE ${whereSql}`).bind(...params).first<{ total: number }>(),
      c.env.DB.prepare(`
        SELECT * FROM stock_documents
        WHERE ${whereSql}
        ORDER BY created_at DESC, rowid DESC
        LIMIT ? OFFSET ?
      `).bind(...params, limit, offset).all<Record<string, any>>(),
    ])

    return c.json({
      total: Number(countRow?.total || 0),
      limit,
      offset,
      rows: docsRes.results || [],
    })
  })

  // 12. รายละเอียดเอกสาร + รายการเครื่องในเอกสารนั้น
  stock.get('/documents/:id', async (c) => {
    const user = c.get('user')
    if (!ADMIN_STOCK_ROLES.has(user.role)) {
      return c.json({ error: 'เฉพาะ Admin เท่านั้นที่สามารถดูรายละเอียดเอกสารสต็อกได้' }, 403)
    }

    const docId = c.req.param('id')
    const doc = await c.env.DB.prepare('SELECT * FROM stock_documents WHERE id = ? OR doc_code = ?')
      .bind(docId, docId)
      .first<Record<string, any>>()
    if (!doc) {
      return c.json({ error: 'ไม่พบเอกสารสต็อกที่ระบุ' }, 404)
    }

    const movements = await c.env.DB.prepare(`
      SELECT
        m.*,
        si.serial_number,
        si.unit_type,
        si.status as current_status,
        si.brand,
        si.model_name,
        b.location_code as branch_code,
        b.loc_bld as branch_name
      FROM stock_movements m
      JOIN stock_items si ON si.id = m.stock_item_id
      LEFT JOIN branches b ON b.id = m.branch_id
      WHERE m.doc_id = ?
      ORDER BY m.rowid ASC
    `).bind(doc.id).all<Record<string, any>>()

    return c.json({
      document: doc,
      movements: movements.results || [],
    })
  })

  return stock
}
