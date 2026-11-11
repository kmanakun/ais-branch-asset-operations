begin;
\ir google_signin_fixture.fixture
create extension if not exists pgtap with schema extensions;

select no_plan();

select ok(has_schema_privilege('authenticated', 'app_private', 'USAGE'), 'authenticated can use the private schema for guarded Storage policy helpers');
select ok(not has_schema_privilege('anon', 'app_private', 'USAGE'), 'anonymous users cannot use the private schema');
select ok(not has_table_privilege('authenticated', 'app_private.scanner_assets', 'SELECT'), 'authenticated cannot read private tables directly');
select ok(not has_table_privilege('authenticated', 'app_private.replacement_task_evidence', 'SELECT'), 'authenticated cannot read evidence metadata directly');
select ok(not has_function_privilege('anon', 'app_private.can_upload_task_evidence_object(text,text,text,text)', 'EXECUTE'), 'anonymous users cannot call the private upload authorization helper');
select ok(
   (select count(*)::int = 7
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  'authenticated users can execute only the seven guarded private helpers and pages, including the reserved evidence-delete check'
);
select ok((select bool_and(rowsecurity) from pg_tables where schemaname = 'app_private'), 'RLS is enabled on every private table');
select ok(
  not exists (
    select 1
    from pg_tables t
    where t.schemaname = 'app_private'
      and not exists (
        select 1
        from pg_policies p
        where p.schemaname = t.schemaname
          and p.tablename = t.tablename
          and p.cmd = 'ALL'
          and p.roles @> array['anon'::name, 'authenticated'::name]
          and p.qual = 'false'
          and p.with_check = 'false'
      )
  ),
  'every private table has an explicit browser-deny policy'
);

select ok(not has_function_privilege('anon', 'public.ais_app_context()', 'EXECUTE'), 'anon cannot call app context');
select ok(not has_function_privilege('anon', 'public.ais_dashboard()', 'EXECUTE'), 'anon cannot call dashboard');
select ok(not has_function_privilege('anon', 'public.ais_list_campaigns(text)', 'EXECUTE'), 'anon cannot list campaigns');
select ok(not has_function_privilege('anon', 'public.ais_list_scanners(text)', 'EXECUTE'), 'anon cannot list scanners');
select ok(not has_function_privilege('anon', 'public.ais_task_filtered_page(text,text,integer,integer)', 'EXECUTE'), 'anon cannot list tasks');
select ok(not has_function_privilege('anon', 'public.ais_open_branch_work_order(uuid,uuid[],uuid)', 'EXECUTE'), 'anon cannot open branch work orders');
select ok(not has_function_privilege('anon', 'public.ais_branch_work_order_page(text,text,integer,integer)', 'EXECUTE'), 'anon cannot list branch work orders');
select ok(has_function_privilege('authenticated', 'public.ais_app_context()', 'EXECUTE'), 'authenticated can call app context');
select ok(has_function_privilege('authenticated', 'public.ais_dashboard()', 'EXECUTE'), 'authenticated can call dashboard');
select ok(has_function_privilege('authenticated', 'public.ais_list_campaigns(text)', 'EXECUTE'), 'authenticated can list campaigns');
select ok(has_function_privilege('authenticated', 'public.ais_list_scanners(text)', 'EXECUTE'), 'authenticated can list scanners');
select ok(not has_function_privilege('authenticated', 'public.ais_list_tasks()', 'EXECUTE'), 'authenticated cannot call the legacy unfiltered task list');
select ok(not has_function_privilege('authenticated', 'public.ais_task_page(integer,integer)', 'EXECUTE'), 'authenticated cannot call the legacy unfiltered task page');
select ok(has_function_privilege('authenticated', 'public.ais_task_filtered_page(text,text,integer,integer)', 'EXECUTE'), 'authenticated can call the guarded filtered task page');
select ok(has_function_privilege('authenticated', 'public.ais_open_branch_work_order(uuid,uuid[],uuid)', 'EXECUTE'), 'authenticated calls the Admin-guarded branch work-order opener');
select ok(has_function_privilege('authenticated', 'public.ais_branch_work_order_page(text,text,integer,integer)', 'EXECUTE'), 'authenticated can call the guarded branch work-order page');
select ok(
  not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'ais_%'
      and p.prosecdef and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  ),
  'no authenticated-callable AIS SECURITY DEFINER RPC is executable by anon'
);
select ok(
  not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'ais_%'
      and p.prosecdef and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not (p.proconfig @> array['search_path=""'])
  ),
  'all authenticated-callable AIS SECURITY DEFINER RPCs use an empty search_path'
);
select is(
  (select count(*)::int from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('ais_app_context', 'ais_dashboard', 'ais_list_campaigns', 'ais_task_filtered_page')
     and p.prosecdef
     and p.proconfig @> array['search_path=""']),
  4,
  'all four core access RPCs are SECURITY DEFINER with an empty search_path; scanner list stays SECURITY INVOKER'
);

select pg_temp.create_test_google_user('f1000000-0000-4000-8000-000000000001','admin-local@test.invalid','admin','Local Admin');
select pg_temp.create_test_google_user('f1000000-0000-4000-8000-000000000002','tech-local@test.invalid','field_technician','Local Technician');
select pg_temp.create_test_google_user('f1000000-0000-4000-8000-000000000003','inactive-local@test.invalid','field_technician','Inactive Technician');

insert into app_private.user_access (user_id, role, display_name, is_active) values
  ('f1000000-0000-4000-8000-000000000001', 'admin', 'Local Admin', true),
  ('f1000000-0000-4000-8000-000000000002', 'field_technician', 'Local Technician', true),
  ('f1000000-0000-4000-8000-000000000003', 'field_technician', 'Inactive Technician', false)
on conflict (user_id) do update set role = excluded.role, is_active = excluded.is_active;

insert into app_private.branches (id, location_code, loc_bld) values
  ('f2000000-0000-4000-8000-000000000001', 'TEST-LOCAL-A', 'Test Branch A'),
  ('f2000000-0000-4000-8000-000000000002', 'TEST-LOCAL-B', 'Test Branch B')
on conflict (id) do nothing;

insert into app_private.scanner_assets (id, branch_id, model_name, com_sn) values
  ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Test Model', 'SERIAL-SECRET-1234'),
  ('f3000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000002', 'Test Model', 'SERIAL-OTHER-5678')
on conflict (id) do nothing;

insert into app_private.teams (id, team_name) values
  ('f4000000-0000-4000-8000-000000000001', 'Local Team A'),
  ('f4000000-0000-4000-8000-000000000002', 'Local Team B')
on conflict (id) do nothing;

insert into app_private.user_team_memberships (user_id, team_id)
values ('f1000000-0000-4000-8000-000000000002', 'f4000000-0000-4000-8000-000000000001')
on conflict do nothing;

insert into app_private.campaigns (id, campaign_code, campaign_name, status)
values ('f5000000-0000-4000-8000-000000000001', 'TEST-LOCAL-CAMPAIGN', 'Local security test', 'scheduled')
on conflict (id) do nothing;

insert into app_private.campaign_items (id, campaign_id, scanner_asset_id, selection_reason) values
  ('f6000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'Local test fixture'),
  ('f6000000-0000-4000-8000-000000000002', 'f5000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000002', 'Local test fixture')
on conflict (id) do nothing;

insert into app_private.branch_work_orders (id, work_order_code, branch_id, origin, created_by) values
  ('f9000000-0000-4000-8000-000000000001', 'SECURITY-ORDER-A', 'f2000000-0000-4000-8000-000000000001', 'admin', 'f1000000-0000-4000-8000-000000000001'),
  ('f9000000-0000-4000-8000-000000000002', 'SECURITY-ORDER-B', 'f2000000-0000-4000-8000-000000000002', 'admin', 'f1000000-0000-4000-8000-000000000001')
on conflict (id) do nothing;

insert into app_private.replacement_tasks (id, campaign_item_id, team_id, status, scanner_asset_id,
  branch_work_order_id, scanner_serial_snapshot) values
  ('f7000000-0000-4000-8000-000000000001', 'f6000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'completed', 'f3000000-0000-4000-8000-000000000001', 'f9000000-0000-4000-8000-000000000001', 'SERIAL-SECRET-1234'),
  ('f7000000-0000-4000-8000-000000000002', 'f6000000-0000-4000-8000-000000000002', 'f4000000-0000-4000-8000-000000000002', 'scheduled', 'f3000000-0000-4000-8000-000000000002', 'f9000000-0000-4000-8000-000000000002', 'SERIAL-OTHER-5678')
on conflict (id) do nothing;

insert into app_private.field_visits (id, task_id, old_serial_snapshot, new_serial, install_result, old_scanner_status, performed_by) values
  ('f8000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001', 'OLD-SERIAL-1234', 'NEW-SERIAL-9876', 'success', 'returned_usable', 'f1000000-0000-4000-8000-000000000002')
on conflict (id) do nothing;

select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.ais_scanner_page('TEST-LOCAL-A', 50, 0) #>> '{rows,0,com_sn}', 'SERIAL-SECRET-1234', 'Admin sees the full scanner serial');
select is((public.ais_scanner_page('SERIAL-SECRET-1234', 50, 0)->>'total')::int, 1, 'Admin can search by a full scanner serial');
select is(
  (select task_row->>'new_serial'
   from jsonb_array_elements(public.ais_task_filtered_page('TEST-LOCAL-A', 'all', 50, 0)->'rows') as rows(task_row)
   where task_row->>'branch_name' = 'Test Branch A'),
  'NEW-SERIAL-9876',
  'Admin sees the full replacement serial'
);

select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is((public.ais_task_filtered_page('TEST-LOCAL-', 'all', 50, 0)->>'total')::int, 2, 'field technician sees every opened work order across teams');
select is((public.ais_scanner_page('TEST-LOCAL-', 50, 0)->>'total')::int, 2, 'field technician sees scanner records across teams');
select is((public.ais_task_filtered_page('SERIAL-OTHER-5678', 'all', 50, 0)->>'total')::int, 1, 'field technician can search any opened work order by its scanner serial');

select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok('select public.ais_task_filtered_page(null, ''all'', 50, 0)', '42501', 'Application access required', 'inactive users cannot list tasks');

select * from finish();
rollback;
