PRAGMA foreign_keys=OFF;

CREATE TABLE replacement_tasks_new (
    id TEXT PRIMARY KEY,
    branch_work_order_id TEXT NOT NULL REFERENCES branch_work_orders(id) ON DELETE RESTRICT,
    scanner_asset_id TEXT NOT NULL REFERENCES scanner_assets(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'blocked', 'awaiting_admin_acceptance', 'awaiting_customer_acceptance', 'delivered', 'pending_exception', 'cancelled')),
    outcome TEXT DEFAULT 'replaced' CHECK (outcome IN ('replaced', 'scanner_missing', 'different_device_found', 'aborted')),
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

INSERT INTO replacement_tasks_new SELECT * FROM replacement_tasks;

DROP TABLE replacement_tasks;

ALTER TABLE replacement_tasks_new RENAME TO replacement_tasks;

CREATE INDEX IF NOT EXISTS idx_tasks_order ON replacement_tasks(branch_work_order_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON replacement_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_scanner ON replacement_tasks(scanner_asset_id);

PRAGMA foreign_keys=ON;
