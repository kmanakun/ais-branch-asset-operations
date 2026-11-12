-- Seed initial user allowlist for dev/testing
INSERT OR IGNORE INTO google_signin_allowlist (id, email, role, full_name, is_active)
VALUES 
  ('usr-time-01', 'karunyaphasmanakun@gmail.com', 'admin', 'ทาม (Project Owner)', 1),
  ('usr-admin-01', 'admin@sym.co.th', 'admin', 'SYM Administrator', 1),
  ('usr-tech-01', 'tech1@sym.co.th', 'field_technician', 'ช่างเทคนิค 1 (SYM)', 1),
  ('usr-tech-02', 'tech2@sym.co.th', 'field_technician', 'ช่างเทคนิค 2 (SYM)', 1),
  ('usr-gable-01', 'reviewer@gable.co.th', 'customer_reviewer', 'ผู้ตรวจรับงาน (Gable)', 1),
  ('usr-viewer-01', 'viewer@ais.co.th', 'viewer', 'ผู้เข้าชม (AIS)', 1);
