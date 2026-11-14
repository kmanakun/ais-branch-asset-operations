-- Idempotent Migration: Stock Scanner Module (Serialized Inventory, Hybrid Mode & Reverse Logistics)
-- ปลอดภัยสำหรับรันซ้ำกับ Cloudflare D1 (ais-scanner-db) โดยไม่กระทบข้อมูลใบงานเดิม

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS stock_documents (
    id TEXT PRIMARY KEY,
    doc_code TEXT NOT NULL UNIQUE,
    doc_type TEXT NOT NULL CHECK (doc_type IN ('receive', 'dispatch', 'return_in', 'handover_out', 'doa_claim', 'adjustment')),
    lot_no TEXT,
    destination_area TEXT,
    recipient_name TEXT,
    note TEXT,
    item_count INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stock_docs_type ON stock_documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_stock_docs_created ON stock_documents(created_at DESC);

CREATE TABLE IF NOT EXISTS stock_items (
    id TEXT PRIMARY KEY,
    serial_number TEXT NOT NULL UNIQUE,
    unit_type TEXT NOT NULL CHECK (unit_type IN ('new_unit', 'old_removed')),
    status TEXT NOT NULL CHECK (status IN (
        'in_warehouse',
        'dispatched',
        'allocated_to_task',
        'installed',
        'doa_defective',
        'void_hybrid',
        'removed_onsite',
        'returned_to_warehouse',
        'handed_over_to_customer',
        'cancelled_restored'
    )),
    pre_task_status TEXT CHECK (pre_task_status IS NULL OR pre_task_status IN ('in_warehouse', 'dispatched')),
    source_mode TEXT NOT NULL DEFAULT 'registered_stock' CHECK (source_mode IN ('registered_stock', 'hybrid_unregistered', 'onsite_removal')),
    brand TEXT,
    model_name TEXT,
    lot_no TEXT,
    receive_doc_id TEXT REFERENCES stock_documents(id) ON DELETE RESTRICT,
    dispatch_doc_id TEXT REFERENCES stock_documents(id) ON DELETE RESTRICT,
    dispatch_area TEXT,
    return_doc_id TEXT REFERENCES stock_documents(id) ON DELETE RESTRICT,
    handover_doc_id TEXT REFERENCES stock_documents(id) ON DELETE RESTRICT,
    linked_task_id TEXT REFERENCES replacement_tasks(id) ON DELETE RESTRICT,
    linked_branch_id TEXT REFERENCES branches(id) ON DELETE RESTRICT,
    linked_old_asset_id TEXT REFERENCES scanner_assets(id) ON DELETE RESTRICT,
    received_at TEXT,
    dispatched_at TEXT,
    allocated_at TEXT,
    installed_at TEXT,
    returned_at TEXT,
    handed_over_at TEXT,
    note TEXT,
    created_by TEXT NOT NULL,
    updated_by TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stock_items_type_status ON stock_items(unit_type, status);
CREATE INDEX IF NOT EXISTS idx_stock_items_task ON stock_items(linked_task_id);
CREATE INDEX IF NOT EXISTS idx_stock_items_branch ON stock_items(linked_branch_id);
CREATE INDEX IF NOT EXISTS idx_stock_items_old_asset ON stock_items(linked_old_asset_id);
CREATE INDEX IF NOT EXISTS idx_stock_items_lot ON stock_items(lot_no);
CREATE INDEX IF NOT EXISTS idx_stock_items_area ON stock_items(dispatch_area);

CREATE TABLE IF NOT EXISTS stock_movements (
    id TEXT PRIMARY KEY,
    stock_item_id TEXT NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
    doc_id TEXT REFERENCES stock_documents(id) ON DELETE RESTRICT,
    task_id TEXT REFERENCES replacement_tasks(id) ON DELETE RESTRICT,
    branch_id TEXT REFERENCES branches(id) ON DELETE RESTRICT,
    action TEXT NOT NULL CHECK (action IN (
        'received',
        'reconciled_hybrid',
        'dispatched',
        'allocated_to_task',
        'installed',
        'review_rejected',
        'released_from_task',
        'marked_doa',
        'voided_hybrid',
        'removed_onsite',
        'returned_to_warehouse',
        'handed_over_to_customer',
        'cancelled_restored',
        'adjusted'
    )),
    from_status TEXT,
    to_status TEXT NOT NULL,
    actor_email TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(stock_item_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_doc ON stock_movements(doc_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_task ON stock_movements(task_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_created ON stock_movements(created_at DESC);

-- Backfill เครื่องใหม่จากใบงานเปลี่ยนเครื่องที่มีอยู่แล้วในระบบ (โหมด Hybrid รอนำเข้าไฟล์ Supplier จับคู่)
INSERT OR IGNORE INTO stock_items (
    id, serial_number, unit_type, status, source_mode, model_name,
    linked_task_id, linked_branch_id, linked_old_asset_id,
    allocated_at, installed_at, note, created_by, updated_by, created_at, updated_at
)
SELECT
    'stk-mig-new-' || t.id,
    TRIM(t.new_serial_number),
    'new_unit',
    CASE WHEN t.status = 'delivered' THEN 'installed' ELSE 'allocated_to_task' END,
    'hybrid_unregistered',
    t.new_model_name,
    t.id,
    s.branch_id,
    t.scanner_asset_id,
    t.closeout_submitted_at,
    t.customer_accepted_at,
    'Backfill จากใบงานเปลี่ยนเครื่องเดิมก่อนเปิดระบบ Stock Scanner',
    COALESCE(t.closeout_submitted_by, t.started_by, 'system@migration'),
    COALESCE(t.customer_accepted_by, t.admin_accepted_by, t.closeout_submitted_by),
    COALESCE(t.closeout_submitted_at, t.updated_at),
    t.updated_at
FROM replacement_tasks t
JOIN scanner_assets s ON s.id = t.scanner_asset_id
WHERE t.outcome = 'replaced'
  AND TRIM(COALESCE(t.new_serial_number, '')) != ''
  AND TRIM(t.new_serial_number) != TRIM(COALESCE(s.com_sn, ''))
  AND t.status IN ('in_progress', 'blocked', 'awaiting_admin_acceptance', 'awaiting_customer_acceptance', 'delivered')
  AND NOT EXISTS (SELECT 1 FROM scanner_assets sa WHERE sa.com_sn = TRIM(t.new_serial_number))
ORDER BY t.updated_at DESC, t.rowid DESC;

-- Backfill ซากเครื่องเดิมที่ถูกถอดออกจากสาขาในใบงานเดิม
INSERT OR IGNORE INTO stock_items (
    id, serial_number, unit_type, status, source_mode, brand, model_name,
    linked_task_id, linked_branch_id, linked_old_asset_id,
    note, created_by, updated_by, created_at, updated_at
)
SELECT
    'stk-mig-old-' || t.id,
    TRIM(s.com_sn),
    'old_removed',
    'removed_onsite',
    'onsite_removal',
    s.brand,
    s.model_name,
    t.id,
    s.branch_id,
    s.id,
    'Backfill ซากเครื่องเดิมจากใบงานที่เปลี่ยนเครื่องแล้ว',
    COALESCE(t.closeout_submitted_by, t.started_by, 'system@migration'),
    COALESCE(t.customer_accepted_by, t.admin_accepted_by, t.closeout_submitted_by),
    COALESCE(t.closeout_submitted_at, t.updated_at),
    t.updated_at
FROM replacement_tasks t
JOIN scanner_assets s ON s.id = t.scanner_asset_id
WHERE t.outcome = 'replaced'
  AND TRIM(COALESCE(t.new_serial_number, '')) != ''
  AND TRIM(COALESCE(s.com_sn, '')) != ''
  AND t.status IN ('in_progress', 'blocked', 'awaiting_admin_acceptance', 'awaiting_customer_acceptance', 'delivered')
ORDER BY t.updated_at DESC, t.rowid DESC;

-- Backfill Ledger ประวัติตั้งต้นเฉพาะแถวที่ถูกเพิ่มเข้า stock_items จริง
INSERT OR IGNORE INTO stock_movements (
    id, stock_item_id, doc_id, task_id, branch_id, action, from_status, to_status, actor_email, note, created_at
)
SELECT
    'smv-mig-new-' || t.id,
    si.id,
    NULL,
    t.id,
    s.branch_id,
    CASE WHEN si.status = 'installed' THEN 'installed' ELSE 'allocated_to_task' END,
    NULL,
    si.status,
    si.created_by,
    'Backfill สถานะเครื่องใหม่จากใบงานเดิม',
    si.updated_at
FROM replacement_tasks t
JOIN scanner_assets s ON s.id = t.scanner_asset_id
JOIN stock_items si ON si.id = ('stk-mig-new-' || t.id);

INSERT OR IGNORE INTO stock_movements (
    id, stock_item_id, doc_id, task_id, branch_id, action, from_status, to_status, actor_email, note, created_at
)
SELECT
    'smv-mig-old-' || t.id,
    si.id,
    NULL,
    t.id,
    s.branch_id,
    'removed_onsite',
    NULL,
    si.status,
    si.created_by,
    'Backfill สถานะซากเครื่องเดิมจากใบงานเดิม',
    si.updated_at
FROM replacement_tasks t
JOIN scanner_assets s ON s.id = t.scanner_asset_id
JOIN stock_items si ON si.id = ('stk-mig-old-' || t.id);
