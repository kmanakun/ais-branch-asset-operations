begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Viewer is no longer an assignable application role. Relax the constraint only
-- inside this rolled-back fixture so the historical masking branch stays tested.
alter table app_private.user_access
  drop constraint user_access_only_admin_and_field_technician;

insert into auth.users(id, aud, role, email, created_at, updated_at) values
  ('fae10000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'viewer-privacy@test.invalid', now(), now());
insert into app_private.user_access(user_id, role, display_name, is_active) values
  ('fae10000-0000-4000-8000-000000000001', 'viewer', 'Privacy Viewer', true);
insert into app_private.branches(id, location_code, loc_bld, province) values
  ('fae10000-0000-4000-8000-000000000002', 'VIEWER-PRIVACY', 'Viewer Privacy Branch', 'Bangkok');
insert into app_private.scanner_assets(id, branch_id, com_sn, model_name) values
  ('fae10000-0000-4000-8000-000000000003', 'fae10000-0000-4000-8000-000000000002', 'VIEWER-SERIAL-1234', 'Privacy Scanner');
insert into app_private.branch_work_orders(id, work_order_code, branch_id, origin, created_by) values
  ('fae10000-0000-4000-8000-000000000004', 'VIEWER-PRIVACY-WO', 'fae10000-0000-4000-8000-000000000002', 'admin', 'fae10000-0000-4000-8000-000000000001');
insert into app_private.replacement_tasks(id, status, scanner_asset_id, branch_work_order_id, scanner_serial_snapshot) values
  ('fae10000-0000-4000-8000-000000000005', 'scheduled', 'fae10000-0000-4000-8000-000000000003', 'fae10000-0000-4000-8000-000000000004', 'VIEWER-SERIAL-1234');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fae10000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fae10000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select is(
  public.ais_branch_work_order_page(null, 'all', 20, 0)->'rows'->0->'scanners'->0->>'com_sn',
  '••••••1234',
  'Viewer sees only the masked registered Serial'
);
select is(
  public.ais_branch_work_order_page(null, 'all', 20, 0)->'rows'->0->'scanners'->0->>'old_serial_snapshot',
  '••••••1234',
  'Viewer does not receive the full Serial through the pre-visit old-Serial fallback'
);
select is(
  (public.ais_branch_work_order_page('VIEWER-SERIAL-1234', 'all', 20, 0)->>'total')::integer,
  0,
  'Viewer cannot probe exact registered Serial values through work-order search totals'
);
select is(
  (public.ais_branch_work_order_page('VIEWER-SERIAL', 'all', 20, 0)->>'total')::integer,
  0,
  'Viewer cannot probe Serial prefixes through work-order search totals'
);

reset role;
select * from finish();
rollback;
