begin;
\ir google_signin_fixture.fixture
create extension if not exists pgtap with schema extensions;
select plan(10);

select ok(not has_function_privilege('anon', 'public.ais_scanner_work_history(uuid,uuid,integer,integer)', 'EXECUTE'), 'anonymous users cannot read scanner work history');
select ok(has_function_privilege('authenticated', 'public.ais_scanner_work_history(uuid,uuid,integer,integer)', 'EXECUTE'), 'authenticated users can call the guarded scanner work history RPC');

select pg_temp.create_test_google_user('fb110000-0000-4000-8000-000000000001','history-admin@test.invalid','admin','History Admin');
select pg_temp.create_test_google_user('fb110000-0000-4000-8000-000000000002','history-tech-a@test.invalid','field_technician','Technician A');
select pg_temp.create_test_google_user('fb110000-0000-4000-8000-000000000003','history-tech-b@test.invalid','field_technician','Technician B');
insert into app_private.user_access(user_id, role, display_name) values
  ('fb110000-0000-4000-8000-000000000001', 'admin', 'History Admin'),
  ('fb110000-0000-4000-8000-000000000002', 'field_technician', 'Technician A'),
  ('fb110000-0000-4000-8000-000000000003', 'field_technician', 'Technician B')
on conflict (user_id) do update set role=excluded.role,display_name=excluded.display_name,is_active=true;
insert into app_private.teams(id, team_name) values
  ('fb110000-0000-4000-8000-000000000010', 'History Team A'),
  ('fb110000-0000-4000-8000-000000000011', 'History Team B');
insert into app_private.branches(id, location_code, loc_bld, province) values
  ('fb110000-0000-4000-8000-000000000020', 'HISTORY-1', 'History Branch', 'Bangkok'),
  ('fb110000-0000-4000-8000-000000000021', 'HISTORY-2', 'Unassigned Branch', 'Bangkok');
insert into app_private.scanner_assets(id, branch_id, com_sn, model_name) values
  ('fb110000-0000-4000-8000-000000000030', 'fb110000-0000-4000-8000-000000000020', 'HISTORY-OLD-SN', 'History Scanner'),
  ('fb110000-0000-4000-8000-000000000031', 'fb110000-0000-4000-8000-000000000021', 'HISTORY-UNASSIGNED-SN', 'Unassigned Scanner');
insert into app_private.campaigns(id, campaign_code, campaign_name, status) values
  ('fb110000-0000-4000-8000-000000000040', 'HISTORY-A', 'History Campaign A', 'scheduled'),
  ('fb110000-0000-4000-8000-000000000041', 'HISTORY-B', 'History Campaign B', 'scheduled'),
  ('fb110000-0000-4000-8000-000000000042', 'HISTORY-U', 'Unassigned Campaign', 'scheduled');
insert into app_private.campaign_items(id, campaign_id, scanner_asset_id, selection_reason) values
  ('fb110000-0000-4000-8000-000000000050', 'fb110000-0000-4000-8000-000000000040', 'fb110000-0000-4000-8000-000000000030', 'Scanner replacement test'),
  ('fb110000-0000-4000-8000-000000000051', 'fb110000-0000-4000-8000-000000000041', 'fb110000-0000-4000-8000-000000000030', 'Second scanner replacement test'),
  ('fb110000-0000-4000-8000-000000000052', 'fb110000-0000-4000-8000-000000000042', 'fb110000-0000-4000-8000-000000000031', 'Unassigned scanner test');
insert into app_private.replacement_tasks(id, campaign_item_id, team_id, status, updated_at) values
  ('fb110000-0000-4000-8000-000000000060', 'fb110000-0000-4000-8000-000000000050', 'fb110000-0000-4000-8000-000000000010', 'completed', '2026-11-08 10:00:00+00'),
  ('fb110000-0000-4000-8000-000000000061', 'fb110000-0000-4000-8000-000000000051', 'fb110000-0000-4000-8000-000000000011', 'completed', '2026-11-09 10:00:00+00'),
  ('fb110000-0000-4000-8000-000000000062', 'fb110000-0000-4000-8000-000000000052', null, 'scheduled', now());
insert into app_private.field_visits(
  id, task_id, old_serial_snapshot, new_serial, install_result, old_scanner_status,
  performed_by, performed_at, outcome
) values
  ('fb110000-0000-4000-8000-000000000070', 'fb110000-0000-4000-8000-000000000060', 'HISTORY-OLD-SN', 'HISTORY-NEW-SN-A', 'Passed', 'returned_usable', 'fb110000-0000-4000-8000-000000000002', '2026-11-08 09:00:00+00', 'replaced'),
  ('fb110000-0000-4000-8000-000000000071', 'fb110000-0000-4000-8000-000000000061', 'HISTORY-NEW-SN-A', 'HISTORY-NEW-SN-B', 'Passed', 'returned_usable', 'fb110000-0000-4000-8000-000000000003', '2026-11-09 09:00:00+00', 'replaced');

select set_config('request.jwt.claim.sub', 'fb110000-0000-4000-8000-000000000001', true);
select is((public.ais_scanner_work_history('fb110000-0000-4000-8000-000000000030')->>'total')::integer, 2, 'Admin can read all work orders for one scanner');
select is(public.ais_scanner_work_history('fb110000-0000-4000-8000-000000000030')->'rows'->0->>'id', 'fb110000-0000-4000-8000-000000000061', 'history is ordered by latest field visit first');
select is(public.ais_scanner_work_history('fb110000-0000-4000-8000-000000000030')->'rows'->0->>'performed_by_name', 'Technician B', 'history resolves the real technician display name');
select is((public.ais_scanner_work_history('fb110000-0000-4000-8000-000000000030')->'rows'->0->>'performed_at')::timestamptz, '2026-11-09 09:00:00+00'::timestamptz, 'history includes the recorded field visit time');

select set_config('request.jwt.claim.sub', 'fb110000-0000-4000-8000-000000000003', true);
select is((public.ais_scanner_work_history('fb110000-0000-4000-8000-000000000030')->>'total')::integer, 2, 'a technician can see every assigned scanner task without team membership');
select is((public.ais_scanner_work_history('fb110000-0000-4000-8000-000000000031')->>'total')::integer, 1, 'technicians can see work history across teams, including open items');
select is((public.ais_scanner_work_history('fb110000-0000-4000-8000-000000000030', 'fb110000-0000-4000-8000-000000000062')->>'total')::integer, 0, 'a task ID for another scanner does not disclose its work order');
select throws_ok($$select public.ais_scanner_work_history('fb110000-0000-4000-8000-000000000030', null, 21, 0)$$, '22023', 'Invalid scanner work history request', 'history page size is bounded');

select * from finish();
rollback;
