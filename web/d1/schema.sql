-- Cloudflare D1 Consolidated Schema v1.0
-- AIS Scanner Replacement Project (1,992 assets, 586 branches)
-- 100% Zero-Baht Edge Architecture

PRAGMA foreign_keys = ON;

-- 1. ตารางรายชื่อที่อนุญาตให้ใช้งาน (Google Sign-In Allowlist)
CREATE TABLE IF NOT EXISTS google_signin_allowlist (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'data_manager', 'planner', 'field_technician', 'customer_reviewer', 'viewer')),
    full_name TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_allowlist_email ON google_signin_allowlist(email);

-- 2. ตารางข้อมูลสาขา (Branches)
CREATE TABLE IF NOT EXISTS branches (
    id TEXT PRIMARY KEY,
    location_code TEXT NOT NULL UNIQUE,
    subs_zn TEXT,
    loc_bld TEXT NOT NULL,
    address TEXT,
    province TEXT NOT NULL,
    district TEXT,
    subdistrict TEXT,
    postal_code TEXT,
    ro TEXT,
    high_level_location TEXT,
    phone TEXT,
    install_type TEXT,
    address_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_branches_province ON branches(province);
CREATE INDEX IF NOT EXISTS idx_branches_location_code ON branches(location_code);

-- 3. ตารางทะเบียนทรัพย์สินเดิม (Scanner Assets)
CREATE TABLE IF NOT EXISTS scanner_assets (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    hw_name TEXT,
    brand TEXT,
    model_name TEXT,
    com_id TEXT,
    com_sn TEXT NOT NULL UNIQUE,
    model_id TEXT,
    com_years TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scanner_branch_id ON scanner_assets(branch_id);
CREATE INDEX IF NOT EXISTS idx_scanner_com_sn ON scanner_assets(com_sn);

-- 4. ตารางใบงานระดับสาขา (Branch Work Orders)
CREATE TABLE IF NOT EXISTS branch_work_orders (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    work_order_code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_work_orders_branch ON branch_work_orders(branch_id);

-- 5. ตารางภารกิจเปลี่ยนอุปกรณ์รายเครื่อง (Replacement Tasks)
CREATE TABLE IF NOT EXISTS replacement_tasks (
    id TEXT PRIMARY KEY,
    branch_work_order_id TEXT NOT NULL REFERENCES branch_work_orders(id) ON DELETE RESTRICT,
    scanner_asset_id TEXT NOT NULL REFERENCES scanner_assets(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'blocked', 'awaiting_admin_acceptance', 'awaiting_customer_acceptance', 'delivered', 'pending_exception', 'cancelled')),
    outcome TEXT DEFAULT 'replaced' CHECK (outcome IN ('replaced', 'scanner_missing', 'different_device_found', 'aborted', 'no_damage_found', 'target_device_not_found')),
    observed_serial TEXT,
    new_serial_number TEXT,
    new_model_name TEXT,
    notes TEXT,
    old_device_status TEXT DEFAULT 'decommissioned',
    started_at TEXT,
    started_by TEXT,
    closeout_submitted_at TEXT,
    closeout_submitted_by TEXT,
    admin_accepted_at TEXT,
    admin_accepted_by TEXT,
    customer_accepted_at TEXT,
    customer_accepted_by TEXT,
    customer_rejected_at TEXT,
    customer_reject_reason TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_order ON replacement_tasks(branch_work_order_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON replacement_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_scanner ON replacement_tasks(scanner_asset_id);

-- 6. ตารางจัดเก็บหลักฐานภาพถ่ายและลายเซ็น (Evidence & Signatures - R2 Storage)
CREATE TABLE IF NOT EXISTS replacement_task_evidence (
    id TEXT PRIMARY KEY,
    replacement_task_id TEXT NOT NULL REFERENCES replacement_tasks(id) ON DELETE RESTRICT,
    evidence_type TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
    role_assigned TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_evidence_task ON replacement_task_evidence(replacement_task_id);

-- 7. ตารางประวัติการตรวจรับ (Task Reviews Audit Trail)
CREATE TABLE IF NOT EXISTS task_reviews (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES replacement_tasks(id) ON DELETE RESTRICT,
    stage TEXT NOT NULL CHECK (stage IN ('sym', 'customer')),
    decision TEXT NOT NULL CHECK (decision IN ('pass', 'reject')),
    reason TEXT,
    reviewer_email TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reviews_task ON task_reviews(task_id);

-- 8. ตาราง Audit Events รวมของระบบ
CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_email TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id);

-- 9. ตารางประวัติการนำเข้าไฟล์ Excel (Import Batches)
CREATE TABLE IF NOT EXISTS import_batches (
    id TEXT PRIMARY KEY,
    source_name TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    result_counts TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 10. ตารางรายงานเครื่องสแกนเนอร์นอกทะเบียน (Scanner Discovery Reports)
CREATE TABLE IF NOT EXISTS scanner_discovery_reports (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    serial_number TEXT NOT NULL,
    observed_model TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reported_by TEXT NOT NULL,
    reviewed_by TEXT,
    review_note TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_discovery_branch ON scanner_discovery_reports(branch_id);
CREATE INDEX IF NOT EXISTS idx_discovery_status ON scanner_discovery_reports(status);

