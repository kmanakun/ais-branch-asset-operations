begin;
\ir google_signin_fixture.fixture
create extension if not exists pgtap with schema extensions;
select no_plan();

select ok(not has_function_privilege('anon', 'public.ais_field_task_action(uuid,text,integer,text,text,text,text,text)', 'EXECUTE'), 'anonymous users cannot change field tasks');
select ok(not has_function_privilege('anon', 'public.ais_task_page(integer,integer)', 'EXECUTE'), 'anonymous users cannot read field task pages');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.ais_task_page(integer,integer)'::regprocedure), 'task page RPC is SECURITY DEFINER with an empty search_path');
select ok(not has_function_privilege('anon', 'public.ais_task_filtered_page(text,text,integer,integer)', 'EXECUTE'), 'anonymous users cannot search field task pages');
select ok(has_function_privilege('authenticated', 'public.ais_task_filtered_page(text,text,integer,integer)', 'EXECUTE'), 'authenticated users can search guarded task pages');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.ais_task_filtered_page(text,text,integer,integer)'::regprocedure), 'filtered task page RPC is SECURITY DEFINER with an empty search_path');

select pg_temp.create_test_google_user('fc200000-0000-4000-8000-000000000001','tech-a-workflow@test.invalid','field_technician','Workflow Tech A');
select pg_temp.create_test_google_user('fc200000-0000-4000-8000-000000000002','tech-b-workflow@test.invalid','field_technician','Workflow Tech B');
select pg_temp.create_test_google_user('fc200000-0000-4000-8000-000000000003','viewer-workflow@test.invalid','field_technician','Workflow Viewer');

insert into app_private.user_access(user_id, role, display_name) values
  ('fc200000-0000-4000-8000-000000000001', 'field_technician', 'Workflow Tech A'),
  ('fc200000-0000-4000-8000-000000000002', 'field_technician', 'Workflow Tech B'),
  ('fc200000-0000-4000-8000-000000000003', 'field_technician', 'Workflow Viewer')
on conflict (user_id) do update set role=excluded.role,display_name=excluded.display_name,is_active=true;

insert into app_private.teams(id, team_name) values
  ('fc200000-0000-4000-8000-000000000010', 'Workflow Team A'),
  ('fc200000-0000-4000-8000-000000000011', 'Workflow Team B');
insert into app_private.user_team_memberships(user_id, team_id) values
  ('fc200000-0000-4000-8000-000000000001', 'fc200000-0000-4000-8000-000000000010'),
  ('fc200000-0000-4000-8000-000000000002', 'fc200000-0000-4000-8000-000000000011');

insert into app_private.branches(id, location_code, loc_bld) values
  ('fc200000-0000-4000-8000-000000000020', 'WORKFLOW-A', 'Workflow Branch A'),
  ('fc200000-0000-4000-8000-000000000021', 'WORKFLOW-B', 'Workflow Branch B');
insert into app_private.scanner_assets(id, branch_id, com_sn, model_name) values
  ('fc200000-0000-4000-8000-000000000030', 'fc200000-0000-4000-8000-000000000020', ' WORKFLOW-OLD-1 ', 'Test Scanner'),
  ('fc200000-0000-4000-8000-000000000031', 'fc200000-0000-4000-8000-000000000021', 'WORKFLOW-OLD-2', 'Test Scanner'),
  ('fc200000-0000-4000-8000-000000000032', 'fc200000-0000-4000-8000-000000000020', 'WORKFLOW-OLD-3', 'Test Scanner');

insert into app_private.campaigns(id, campaign_code, campaign_name, status) values
  ('fc200000-0000-4000-8000-000000000040', 'WORKFLOW-TEST', 'Field task workflow test', 'scheduled');
insert into app_private.campaign_items(id, campaign_id, scanner_asset_id, selection_reason) values
  ('fc200000-0000-4000-8000-000000000050', 'fc200000-0000-4000-8000-000000000040', 'fc200000-0000-4000-8000-000000000030', 'Local workflow fixture'),
  ('fc200000-0000-4000-8000-000000000051', 'fc200000-0000-4000-8000-000000000040', 'fc200000-0000-4000-8000-000000000031', 'Local workflow fixture'),
  ('fc200000-0000-4000-8000-000000000052', 'fc200000-0000-4000-8000-000000000040', 'fc200000-0000-4000-8000-000000000032', 'Local workflow fixture');
insert into app_private.branch_work_orders(id, work_order_code, branch_id, origin) values
  ('fc200000-0000-4000-8000-000000000080', 'WORKFLOW-ORDER-A1', 'fc200000-0000-4000-8000-000000000020', 'admin'),
  ('fc200000-0000-4000-8000-000000000081', 'WORKFLOW-ORDER-B', 'fc200000-0000-4000-8000-000000000021', 'admin'),
  ('fc200000-0000-4000-8000-000000000082', 'WORKFLOW-ORDER-A2', 'fc200000-0000-4000-8000-000000000020', 'admin');
insert into app_private.replacement_tasks(id, campaign_item_id, team_id, status, scanner_asset_id,
  branch_work_order_id, scanner_serial_snapshot) values
  ('fc200000-0000-4000-8000-000000000060', 'fc200000-0000-4000-8000-000000000050', 'fc200000-0000-4000-8000-000000000010', 'scheduled', 'fc200000-0000-4000-8000-000000000030', 'fc200000-0000-4000-8000-000000000080', ' WORKFLOW-OLD-1 '),
  ('fc200000-0000-4000-8000-000000000061', 'fc200000-0000-4000-8000-000000000051', 'fc200000-0000-4000-8000-000000000011', 'scheduled', 'fc200000-0000-4000-8000-000000000031', 'fc200000-0000-4000-8000-000000000081', 'WORKFLOW-OLD-2'),
  ('fc200000-0000-4000-8000-000000000062', 'fc200000-0000-4000-8000-000000000052', 'fc200000-0000-4000-8000-000000000010', 'scheduled', 'fc200000-0000-4000-8000-000000000032', 'fc200000-0000-4000-8000-000000000082', 'WORKFLOW-OLD-3');

select set_config('request.jwt.claim.sub', 'fc200000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc200000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select throws_ok($$select public.ais_field_task_action('fc200000-0000-4000-8000-000000000060', 'start', 1)$$, '42501', 'Active Admin or Field Technician access required', 'unprovisioned users cannot act on tasks');
select throws_ok($$select public.ais_task_page(50, 0)$$, '42501', 'Application access required', 'unprovisioned users cannot read task pages');

select set_config('request.jwt.claim.sub', 'fc200000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc200000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.ais_field_task_action('fc200000-0000-4000-8000-000000000060', 'confirm', 1)$$, '22023', 'Unsupported field action', 'the redundant target-confirmation action is removed');
select is(public.ais_field_task_action('fc200000-0000-4000-8000-000000000060', 'start', 1)->>'version', '2', 'any active technician can start the verified target directly');
select is(public.ais_task_filtered_page(null,'all',50,0)->>'total', '3', 'technician without a team membership sees every assigned work order');
select is(public.ais_task_filtered_page('WORKFLOW-A','all',50,0)->>'total','2','technician can search tasks across all assigned branches');
select is(public.ais_task_filtered_page('WORKFLOW-OLD-1','all',50,0)->>'total','1','technician can search any task by its raw scanner serial');

select set_config('request.jwt.claim.sub', 'fc200000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc200000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(public.ais_field_task_action('fc200000-0000-4000-8000-000000000061', 'start', 1)->>'status', 'in_progress', 'a technician can start another team work order without assignment or reconfirmation');
select is(public.ais_task_filtered_page(null,'all',50,0)->>'total', '3', 'technician sees every opened work order across teams');
select is(public.ais_task_filtered_page('WORKFLOW-A','all',50,0)->>'total','2','technician search is not limited to a team');
select is(public.ais_task_filtered_page('WORKFLOW-B','all',50,0)->>'total','1','technician can search another team branch');

select set_config('request.jwt.claim.sub', 'fc200000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc200000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.ais_task_filtered_page(null, 'all', 1, 0)->>'total', '3', 'filtered task page total includes all assigned tasks');
select is(jsonb_array_length(public.ais_task_filtered_page(null, 'all', 1, 0)->'rows'), 1, 'filtered task page respects the requested row limit');
select is(jsonb_array_length(public.ais_task_filtered_page(null, 'all', 1, 3)->'rows'), 0, 'filtered task page returns no rows beyond the last page');
select throws_ok($$select public.ais_task_filtered_page(null, 'all', 0, 0)$$, '22023', 'Task page limit or offset is outside the supported range', 'filtered task page rejects an invalid limit');
select is(public.ais_task_filtered_page('WORKFLOW-OLD-1','all',50,0)->>'total','1','technician can search by the old scanner serial');
select is(public.ais_task_filtered_page(null,'open',50,0)->>'total','1','status filter returns the remaining Open work item');
select throws_ok($$select public.ais_task_filtered_page(null,'unknown',50,0)$$,'22023','Invalid task status filter','filtered task page rejects unknown status filters');
select throws_ok($$select public.ais_task_filtered_page(repeat('x',101),'all',50,0)$$,'22023','Task search is longer than the supported limit','filtered task page rejects oversized search strings');
update app_private.teams set is_active = false where id = 'fc200000-0000-4000-8000-000000000010';
select is(public.ais_task_page(50, 0)->'rows'->0->>'team_active', 'false', 'inactive assigned teams are identified in task rows');
select is((select status::text from app_private.replacement_tasks where id='fc200000-0000-4000-8000-000000000060'), 'in_progress', 'inactive team metadata does not block a started work item');
select is((select status::text from app_private.campaigns where id = 'fc200000-0000-4000-8000-000000000040'), 'scheduled', 'legacy campaign metadata does not drive the branch work-order process');
select is((select version from app_private.replacement_tasks where id = 'fc200000-0000-4000-8000-000000000060'), 2, 'starting once increments the task version once');
select throws_ok($$select public.ais_field_task_action('fc200000-0000-4000-8000-000000000060', 'block', 2)$$, '22023', 'A reason of 1 to 500 characters is required to pause active work', 'blocking requires a reason');
select is(public.ais_field_task_action('fc200000-0000-4000-8000-000000000060', 'block', 2, 'Store was closed')->>'status', 'blocked', 'technician can block with a reason');
select is((select resume_status::text from app_private.replacement_tasks where id = 'fc200000-0000-4000-8000-000000000060'), 'in_progress', 'blocking preserves the prior state for resume');
select is(public.ais_field_task_action('fc200000-0000-4000-8000-000000000060', 'resume', 3)->>'status', 'in_progress', 'technician can resume the prior state');
select throws_ok($$select public.ais_field_task_action('fc200000-0000-4000-8000-000000000060', 'start', 1)$$, '40001', 'Work item changed since it was loaded; refresh before retrying', 'stale task version is rejected');

select throws_ok($$select public.ais_field_task_action('fc200000-0000-4000-8000-000000000060', 'complete', 5, null, 'WORKFLOW-NEW-1', 'Installed and tested', 'returned_usable')$$, '22023', 'Unsupported field action', 'legacy completion is disabled; successful closeout uses the guarded closeout RPC');
select is((select com_sn from app_private.scanner_assets where id = 'fc200000-0000-4000-8000-000000000030'), ' WORKFLOW-OLD-1 ', 'scanner register serial remains unchanged until Office Admin accepts the closeout');
select is((select count(*)::int from app_private.field_visits where task_id = 'fc200000-0000-4000-8000-000000000060'), 0, 'legacy completion did not create a field visit');

select is(public.ais_field_task_action('fc200000-0000-4000-8000-000000000062', 'start', 1)->>'status', 'in_progress', 'technician starts a second Scanner directly');
select throws_ok($$select public.ais_field_task_action('fc200000-0000-4000-8000-000000000062', 'complete', 3, null, 'WORKFLOW-NEW-2', 'Installed and tested', 'returned_usable')$$, '22023', 'Unsupported field action', 'legacy completion is disabled for every scanner task');
select is((select status::text from app_private.campaigns where id = 'fc200000-0000-4000-8000-000000000040'), 'scheduled', 'the legacy campaign status does not track branch work-order closeout');

select set_config('request.jwt.claim.sub', 'fc200000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc200000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is((select status::text from app_private.replacement_tasks where id='fc200000-0000-4000-8000-000000000061'), 'in_progress', 'cross-team work remains available after the technician started it');
select is((select started_by from app_private.replacement_tasks where id='fc200000-0000-4000-8000-000000000061'), 'fc200000-0000-4000-8000-000000000002', 'the work item records the technician who started it');
select is((select status::text from app_private.campaigns where id = 'fc200000-0000-4000-8000-000000000040'), 'scheduled', 'the new workflow lifecycle is tracked by branch work orders, not legacy campaign metadata');
select is((select count(*)::int from app_private.audit_events where entity_type = 'replacement_task'), 5, 'each successful task state change is audited once');

select * from finish();
rollback;
