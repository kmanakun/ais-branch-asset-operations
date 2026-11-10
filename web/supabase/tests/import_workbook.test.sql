begin;
create extension if not exists pgtap with schema extensions;

select plan(21);

select ok(to_regprocedure('public.ais_import_stage(text,jsonb)') is null, 'staging RPC no longer accepts a client filename');
select ok(not has_function_privilege('anon', 'public.ais_import_stage(jsonb)', 'EXECUTE'), 'anonymous users cannot stage imports');
select ok(not has_function_privilege('anon', 'public.ais_import_commit(uuid)', 'EXECUTE'), 'anonymous users cannot commit imports');
select ok(has_function_privilege('authenticated', 'public.ais_import_stage(jsonb)', 'EXECUTE'), 'signed-in users reach the role-checked staging RPC');
select ok(has_function_privilege('authenticated', 'public.ais_import_commit(uuid)', 'EXECUTE'), 'signed-in users reach the role-checked commit RPC');

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('f9000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'manager-import@test.invalid', '', now(), now(), now()),
  ('f9000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'viewer-import@test.invalid', '', now(), now(), now())
on conflict (id) do nothing;
insert into app_private.user_access (user_id, role, display_name, is_active) values
  ('f9000000-0000-4000-8000-000000000001', 'admin', 'Import Manager', true),
  ('f9000000-0000-4000-8000-000000000002', 'field_technician', 'Import Viewer', true)
on conflict (user_id) do update set role = excluded.role, is_active = excluded.is_active;

create temporary table import_test_result (kind text primary key, payload jsonb not null);
select set_config('request.jwt.claim.sub', 'f9000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"f9000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

insert into import_test_result
select 'valid', public.ais_import_stage('[
  {"source_row":2,"location_code":"IMPORT-SHARED","loc_bld":"Import Branch A","com_sn":"IMPORT-SN-A","com_id":"IMPORT-ID-A","emp_mail":"private@example.invalid","note":"do not stage"},
  {"source_row":3,"location_code":"IMPORT-SHARED","loc_bld":"Import Branch B","com_sn":"IMPORT-SN-B","com_id":"IMPORT-ID-B"}
]'::jsonb);
select is((select source_name from app_private.import_batches where id = (select (payload->>'batch_id')::uuid from import_test_result where kind = 'valid')), 'import-upload', 'base import records only the server-side generic source name');
select is((select (payload->>'row_count')::int from import_test_result where kind = 'valid'), 2, 'valid source rows are staged');
select is((select (payload->>'branch_count')::int from import_test_result where kind = 'valid'), 2, 'branch preview counts separate names under one code');
select is((select (payload->>'issue_count')::int from import_test_result where kind = 'valid'), 0, 'distinct branches sharing a code pass validation');
select is((select count(*)::int from app_private.import_staging_rows staged
  where staged.batch_id = (select (payload->>'batch_id')::uuid from import_test_result where kind = 'valid')
    and (normalized_data ? 'emp_mail' or normalized_data ? 'note')), 0, 'PII and free-text notes are excluded from staging');
select is((public.ais_import_commit((select (payload->>'batch_id')::uuid from import_test_result where kind = 'valid'))->>'status'), 'committed', 'valid batch commits atomically');
select is((select count(*)::int from app_private.branches where location_code = 'IMPORT-SHARED'), 2, 'same code branches remain separate');
select is((select count(*)::int from app_private.scanner_assets asset join app_private.branches branch on branch.id = asset.branch_id where branch.location_code = 'IMPORT-SHARED'), 2, 'all scanner records link to the correct branch');
select is((select status from app_private.import_batches where id = (select (payload->>'batch_id')::uuid from import_test_result where kind = 'valid')), 'committed', 'batch metadata records the committed state');
select is((select count(*)::int from app_private.audit_events where event_type = 'branch_scanner_import_committed'), 1, 'commit produces an audit record');
select is((select summary->>'source_name' from app_private.audit_events where entity_type = 'import_batch'
  and entity_id = (select (payload->>'batch_id')::uuid from import_test_result where kind = 'valid')),
  'import-upload', 'import audit summary contains only the generic source label');
select is((select count(*)::int from app_private.import_staging_rows where batch_id = (select (payload->>'batch_id')::uuid from import_test_result where kind = 'valid')), 0, 'staged details are removed after commit');

insert into import_test_result
select 'duplicate', public.ais_import_stage('[
  {"source_row":8,"location_code":"IMPORT-DUP","loc_bld":"Duplicate Branch","com_sn":"IMPORT-DUP-SN"},
  {"source_row":9,"location_code":"IMPORT-DUP","loc_bld":"Duplicate Branch","com_sn":"IMPORT-DUP-SN"}
]'::jsonb);
select is((select (payload->>'issue_count')::int from import_test_result where kind = 'duplicate'), 2, 'duplicate serials flag every conflicting source row');
select throws_ok(format('select public.ais_import_commit(%L::uuid)', (select payload->>'batch_id' from import_test_result where kind = 'duplicate')),
  '22023', 'Resolve all import validation issues before commit', 'invalid batch cannot commit');
select is((select count(*)::int from app_private.scanner_assets), 2, 'rejected batch leaves the committed register unchanged');

select set_config('request.jwt.claim.sub', 'f9000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"f9000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.ais_import_stage('[{"source_row":2,"location_code":"X","loc_bld":"X","com_sn":"X"}]'::jsonb)$$,
  '42501', 'Data Manager or Admin access required', 'Viewer cannot stage imports');

select * from finish();
rollback;
