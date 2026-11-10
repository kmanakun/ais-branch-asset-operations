begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, aud, role, created_at, updated_at) values
  ('fa710000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', now(), now()),
  ('fa710000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', now(), now()),
  ('fa710000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', now(), now());
insert into app_private.user_access (user_id, role, display_name) values
  ('fa710000-0000-4000-8000-000000000001', 'admin', 'Matrix Admin'),
  ('fa710000-0000-4000-8000-000000000002', 'field_technician', 'Matrix Technician'),
  ('fa710000-0000-4000-8000-000000000003', 'admin', 'Matrix Admin Importer');

create temporary table matrix_fixture (
  workbook jsonb, bootstrap_batch uuid, incremental_result jsonb, incremental_batch uuid,
  scanner_id uuid, branch_id uuid, open_result jsonb, work_order_id uuid, task_id uuid, start_result jsonb
);
insert into matrix_fixture (workbook)
values ('[{"source_row":2,"location_code":"ROLE-MATRIX","loc_bld":"Matrix branch","com_sn":"ROLE-MATRIX-01","model_name":"Role Matrix Model"}]');
grant select, update on matrix_fixture to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fa710000-0000-4000-8000-000000000003', true);
update matrix_fixture set bootstrap_batch = (public.ais_import_stage(workbook)->>'batch_id')::uuid;
select ok((select bootstrap_batch is not null from matrix_fixture), 'Admin can stage the initial register');
select is((select public.ais_import_commit(bootstrap_batch)->>'status' from matrix_fixture), 'committed', 'Admin can commit the initial register');

select set_config('request.jwt.claim.sub', 'fa710000-0000-4000-8000-000000000001', true);
update matrix_fixture set incremental_result = public.ais_incremental_import_stage(workbook);
update matrix_fixture set incremental_batch = (incremental_result->>'batch_id')::uuid;
select is((select incremental_result->>'issue_count' from matrix_fixture), '0', 'Admin can stage an incremental import with no validation issues');
select is((select public.ais_incremental_import_commit(incremental_batch)->>'status' from matrix_fixture), 'committed', 'Admin can commit the reviewed incremental import');
select ok(jsonb_array_length(public.ais_import_history(50)) > 0, 'Admin can review import history');
update matrix_fixture set scanner_id = (public.ais_scanner_page('ROLE-MATRIX-01') #>> '{rows,0,id}')::uuid;
reset role;
update matrix_fixture set branch_id = (select branch_id from app_private.scanner_assets where id = scanner_id);

select ok(not has_function_privilege('authenticated', 'public.ais_create_campaign(text,text,uuid[],text,date,date)', 'EXECUTE'), 'legacy campaign creation cannot bypass the branch work-order process');
select ok(not has_function_privilege('authenticated', 'public.ais_schedule_campaign_by_branch(uuid,jsonb)', 'EXECUTE'), 'legacy team and appointment scheduling is disabled');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fa710000-0000-4000-8000-000000000002', true);
select throws_ok($$select public.ais_open_branch_work_order(branch_id, array[scanner_id], gen_random_uuid()) from matrix_fixture$$,
  '42501', 'Active Admin access required to open a branch work order', 'Field Technician cannot create an Admin-opened work order');
select throws_ok($$select public.ais_incremental_import_stage(workbook) from matrix_fixture$$,
  '42501', 'Data Manager or Admin access required', 'Field Technician cannot stage a registry import');

select set_config('request.jwt.claim.sub', 'fa710000-0000-4000-8000-000000000001', true);
update matrix_fixture set open_result = public.ais_open_branch_work_order(branch_id, array[scanner_id], gen_random_uuid());
update matrix_fixture set work_order_id = (open_result->>'work_order_id')::uuid;
select is((select open_result->>'status' from matrix_fixture), 'open', 'Admin opens the work order immediately with no appointment date');
select is((select open_result->>'selected_scanners' from matrix_fixture), '1', 'Admin opens a work order for the selected verified Scanner');

reset role;
update matrix_fixture set task_id = (select id from app_private.replacement_tasks where branch_work_order_id = work_order_id);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fa710000-0000-4000-8000-000000000001', true);
update matrix_fixture set start_result = public.ais_field_task_action(task_id, 'start', 1);
select is((select start_result->>'status' from matrix_fixture), 'in_progress', 'Admin can perform the onsite start process');
reset role;
select is((select started_by from app_private.replacement_tasks where id = (select task_id from matrix_fixture)), 'fa710000-0000-4000-8000-000000000001', 'the audit record identifies the Admin who performed the field work');

select is((select count(*)::int from app_private.audit_events where event_type='scanner_work_started' and entity_id=(select task_id from matrix_fixture)), 1, 'Admin onsite actions are audited once');
select * from finish();
rollback;
