-- ลบข้อมูลที่สร้างโดย scripts/test-live-flow.mjs (npm run test:e2e) ออกจาก D1
-- ขอบเขต: เฉพาะสาขาชื่อ 'AIS Shop E2E %' และทุกอย่างที่อ้างอิงสาขาเหล่านั้น
--         + ผู้ใช้ 'testtech_<ตัวเลข>@sym.co.th' + import batch 'E2E_Test_%'
-- ไม่แตะ: สาขาอื่น (เช่น BKK001), ผู้ใช้ seed, ตาราง schema
-- ลำดับลบเป็นลูก -> แม่ เพื่อเคารพ Foreign Key (ON DELETE RESTRICT)
-- ใช้: npx wrangler d1 execute ais-scanner-db --remote --file=./d1/cleanup-e2e-test-data.sql
-- หมายเหตุ: ไฟล์ภาพใน R2 (tasks/<task_id>/...) ไม่ถูกลบโดยสคริปต์นี้

DELETE FROM stock_movements WHERE
  task_id IN (
    SELECT t.id FROM replacement_tasks t
    JOIN scanner_assets s ON s.id = t.scanner_asset_id
    JOIN branches b ON b.id = s.branch_id
    WHERE b.loc_bld LIKE 'AIS Shop E2E %'
  )
  OR branch_id IN (SELECT id FROM branches WHERE loc_bld LIKE 'AIS Shop E2E %')
  OR stock_item_id IN (
    SELECT id FROM stock_items
    WHERE serial_number LIKE 'SN-STOCK-E2E-%'
       OR linked_branch_id IN (SELECT id FROM branches WHERE loc_bld LIKE 'AIS Shop E2E %')
  )
  OR doc_id IN (
    SELECT id FROM stock_documents WHERE lot_no LIKE 'LOT-E2E-%' OR note LIKE 'E2E_Test_%'
  );

DELETE FROM stock_items WHERE
  serial_number LIKE 'SN-STOCK-E2E-%'
  OR linked_branch_id IN (SELECT id FROM branches WHERE loc_bld LIKE 'AIS Shop E2E %')
  OR linked_task_id IN (
    SELECT t.id FROM replacement_tasks t
    JOIN scanner_assets s ON s.id = t.scanner_asset_id
    JOIN branches b ON b.id = s.branch_id
    WHERE b.loc_bld LIKE 'AIS Shop E2E %'
  )
  OR receive_doc_id IN (
    SELECT id FROM stock_documents WHERE lot_no LIKE 'LOT-E2E-%' OR note LIKE 'E2E_Test_%'
  )
  OR dispatch_doc_id IN (
    SELECT id FROM stock_documents WHERE lot_no LIKE 'LOT-E2E-%' OR note LIKE 'E2E_Test_%'
  )
  OR return_doc_id IN (
    SELECT id FROM stock_documents WHERE lot_no LIKE 'LOT-E2E-%' OR note LIKE 'E2E_Test_%'
  )
  OR handover_doc_id IN (
    SELECT id FROM stock_documents WHERE lot_no LIKE 'LOT-E2E-%' OR note LIKE 'E2E_Test_%'
  );

DELETE FROM stock_documents WHERE lot_no LIKE 'LOT-E2E-%' OR note LIKE 'E2E_Test_%';

DELETE FROM replacement_task_evidence WHERE replacement_task_id IN (
  SELECT t.id FROM replacement_tasks t
  JOIN scanner_assets s ON s.id = t.scanner_asset_id
  JOIN branches b ON b.id = s.branch_id
  WHERE b.loc_bld LIKE 'AIS Shop E2E %'
);

DELETE FROM task_reviews WHERE task_id IN (
  SELECT t.id FROM replacement_tasks t
  JOIN scanner_assets s ON s.id = t.scanner_asset_id
  JOIN branches b ON b.id = s.branch_id
  WHERE b.loc_bld LIKE 'AIS Shop E2E %'
);

DELETE FROM replacement_tasks WHERE scanner_asset_id IN (
  SELECT s.id FROM scanner_assets s
  JOIN branches b ON b.id = s.branch_id
  WHERE b.loc_bld LIKE 'AIS Shop E2E %'
);

DELETE FROM branch_work_orders WHERE branch_id IN (
  SELECT id FROM branches WHERE loc_bld LIKE 'AIS Shop E2E %'
);

DELETE FROM scanner_discovery_reports WHERE branch_id IN (
  SELECT id FROM branches WHERE loc_bld LIKE 'AIS Shop E2E %'
);

DELETE FROM scanner_assets WHERE branch_id IN (
  SELECT id FROM branches WHERE loc_bld LIKE 'AIS Shop E2E %'
);

DELETE FROM branches WHERE loc_bld LIKE 'AIS Shop E2E %';

DELETE FROM google_signin_allowlist WHERE email GLOB 'testtech_[0-9]*@sym.co.th';

DELETE FROM import_batches WHERE source_name LIKE 'E2E_Test_%';
