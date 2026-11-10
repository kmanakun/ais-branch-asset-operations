begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select ok(to_regprocedure('public.ais_incremental_import_stage(text,jsonb)') is null, 'incremental staging RPC no longer accepts a client filename');
select ok(to_regprocedure('public.ais_import_stage(text,jsonb)') is null, 'bootstrap staging RPC no longer accepts a client filename');
insert into auth.users(id,aud,role,email,created_at,updated_at) values
('fa500000-0000-4000-8000-000000000001','authenticated','authenticated','incremental@test.invalid',now(),now()),
('fa500000-0000-4000-8000-000000000002','authenticated','authenticated','incremental-viewer@test.invalid',now(),now());
insert into app_private.user_access(user_id,role,display_name) values
('fa500000-0000-4000-8000-000000000001','admin','Import Manager'),
('fa500000-0000-4000-8000-000000000002','field_technician','Viewer');
insert into app_private.branches(id,location_code,loc_bld,province) values
('fa500000-0000-4000-8000-000000000010','INCREMENTAL-A','Branch A','Bangkok');
insert into app_private.scanner_assets(id,branch_id,com_sn,brand,model_name) values
('fa500000-0000-4000-8000-000000000020','fa500000-0000-4000-8000-000000000010','  Case-SN  ','Original','Old');
create temporary table incremental_results(kind text primary key, payload jsonb);
select set_config('request.jwt.claim.sub','fa500000-0000-4000-8000-000000000001',true);
insert into incremental_results values ('bootstrap', public.ais_import_stage('[
 {"source_row":2,"location_code":"INCREMENTAL-A","loc_bld":"Branch A","com_sn":"BOOTSTRAP-REDACT"}
]'::jsonb));
select is((select source_name from app_private.import_batches where id=(select (payload->>'batch_id')::uuid from incremental_results where kind='bootstrap')),'import-upload','bootstrap stage stores only fixed generic source name');
update app_private.import_batches set source_name='Employee Name <employee@example.invalid>.xlsx'
where id=(select (payload->>'batch_id')::uuid from incremental_results where kind='bootstrap');
select is((select source_name from app_private.import_batches where id=(select (payload->>'batch_id')::uuid from incremental_results where kind='bootstrap')),'import-upload','database trigger redacts source names even on direct writes');
insert into incremental_results values ('success', public.ais_incremental_import_stage('[
 {"source_row":2,"location_code":"INCREMENTAL-A","loc_bld":"Branch A","province":"Bangkok","address":"New address","com_sn":" case-sn ","brand":" ","model_name":"New"},
 {"source_row":3,"location_code":"INCREMENTAL-A","loc_bld":"Branch A","com_sn":"NEW-SN","brand":"New brand"}
]'::jsonb));
select is((select source_name from app_private.import_batches where id=(select (payload->>'batch_id')::uuid from incremental_results where kind='success')),'import-upload','incremental import records only the server-side generic source name');
select is((select (payload->>'issue_count')::int from incremental_results where kind='success'),0,'existing normalized Serial accepted and a different registered Serial can be added');
select is((public.ais_incremental_import_commit((select (payload->>'batch_id')::uuid from incremental_results where kind='success'))->>'status'),'committed','valid batch commits');
select is((select address from app_private.branches where id='fa500000-0000-4000-8000-000000000010'),'New address','branch allow-list updates nonempty value');
select is((select brand from app_private.scanner_assets where id='fa500000-0000-4000-8000-000000000020'),'Original','blank preserves old value');
select is((select model_name from app_private.scanner_assets where id='fa500000-0000-4000-8000-000000000020'),'New','nonempty allowed field updates');
select is((select count(*)::integer from app_private.scanner_assets where lower(btrim(com_sn))='case-sn'),1,'case-insensitive normalized Serial matches the existing registered asset');
select is((select com_sn from app_private.scanner_assets where id='fa500000-0000-4000-8000-000000000020'),'  Case-SN  ','matching import preserves the registered Serial value');
select is((select count(*)::integer from app_private.scanner_assets where lower(btrim(com_sn))='new-sn'),1,'new Serial inserts once');
select is((public.ais_incremental_import_commit((select (payload->>'batch_id')::uuid from incremental_results where kind='success'))->>'inserted'),'1','retry returns original result');
select is((select count(*)::integer from app_private.scanner_assets where lower(btrim(com_sn))='new-sn'),1,'retry inserts no duplicate');
select is((select count(*)::integer from app_private.import_staging_rows where batch_id=(select (payload->>'batch_id')::uuid from incremental_results where kind='success')),0,'committed staging rows removed');
select ok(not (public.ais_import_history(50)::text like '%private-name.xlsx%'),'history hides source filename');
select ok(not (public.ais_import_history(50)::text like '%Case-SN%'),'history hides source rows');
insert into incremental_results values ('duplicate',public.ais_incremental_import_stage('[
 {"source_row":2,"location_code":"INCREMENTAL-A","loc_bld":"Branch A","com_sn":"DUP"},
 {"source_row":3,"location_code":"INCREMENTAL-A","loc_bld":"Branch A","com_sn":" dup "}
]'::jsonb));
select is((select (payload->>'issue_count')::int from incremental_results where kind='duplicate'),2,'case-insensitive trimmed duplicate rejected');
select throws_ok(format('select public.ais_incremental_import_commit(%L::uuid)',(select payload->>'batch_id' from incremental_results where kind='duplicate')),'22023','Resolve all import validation issues before commit','duplicate batch cannot commit');
insert into incremental_results values ('conflict',public.ais_incremental_import_stage('[
 {"source_row":2,"location_code":"INCREMENTAL-A","loc_bld":"Branch A","com_sn":"Case-SN","province":"Bangkok","model_name":"Must rollback"},
 {"source_row":3,"location_code":"INCREMENTAL-A","loc_bld":"Branch A","province":"Wrong","com_sn":"Other"}
]'::jsonb));
select throws_ok(format('select public.ais_incremental_import_commit(%L::uuid)',(select payload->>'batch_id' from incremental_results where kind='conflict')),'22023','Resolve all import validation issues before commit','branch conflict rejects batch');
select is((select model_name from app_private.scanner_assets where id='fa500000-0000-4000-8000-000000000020'),'New','rejection preserves prior scanner');
select is((select count(*)::int from app_private.scanner_assets where com_sn='Other'),0,'rejection inserts nothing');
select is((select province from app_private.branches where id='fa500000-0000-4000-8000-000000000010'),'Bangkok','blank branch fields preserve existing data');
insert into incremental_results values ('missing',public.ais_incremental_import_stage('[{"source_row":2,"location_code":"INCREMENTAL-A","loc_bld":"Branch A","com_sn":" "}]'::jsonb));
select ok((select (payload->>'issue_count')::int from incremental_results where kind='missing')>0,'missing serial yields issue');
insert into incremental_results values ('unknown',public.ais_incremental_import_stage('[{"source_row":2,"location_code":"NOT-IN-REGISTER","loc_bld":"Missing","com_sn":"BRANCH-NEW"}]'::jsonb));
select ok((select payload->'issues' @> '[{"code":"branch_not_found"}]'::jsonb from incremental_results where kind='unknown'),'unknown branch produces preview issue');
select throws_ok(format('select public.ais_incremental_import_commit(%L::uuid)',(select payload->>'batch_id' from incremental_results where kind='unknown')),'22023','Resolve all import validation issues before commit','unknown branch cannot commit');
insert into app_private.branches(id,location_code,loc_bld) values ('fa500000-0000-4000-8000-000000000011','INCREMENTAL-B','Branch B');
insert into incremental_results values ('move',public.ais_incremental_import_stage('[{"source_row":2,"location_code":"INCREMENTAL-B","loc_bld":"Branch B","com_sn":"Case-SN"}]'::jsonb));
select ok((select payload->'issues' @> '[{"code":"serial_branch_conflict"}]'::jsonb from incremental_results where kind='move'),'serial mapped to another branch produces issue');
select throws_ok($$insert into app_private.scanner_assets(branch_id,com_sn) values ('fa500000-0000-4000-8000-000000000010','Case-SN')$$,
  '23505', 'duplicate key value violates unique constraint "scanner_assets_com_sn_normalized_unique"', 'normalized Serial uniqueness prevents ambiguous duplicate register entries');
select set_config('request.jwt.claim.sub','fa500000-0000-4000-8000-000000000002',true);
select throws_ok($$select public.ais_incremental_import_stage('[]'::jsonb)$$,'42501','Data Manager or Admin access required','viewer cannot stage');
select throws_ok($$select public.ais_import_history(50)$$,'42501','Data Manager or Admin access required','viewer cannot read history');
select throws_ok($$select public.ais_incremental_import_commit('00000000-0000-4000-8000-000000000000')$$,'42501','Data Manager or Admin access required','viewer cannot commit incremental');
insert into auth.users(id,aud,role,email,created_at,updated_at) values ('fa500000-0000-4000-8000-000000000003','authenticated','authenticated','no-access@test.invalid',now(),now());
select set_config('request.jwt.claim.sub','fa500000-0000-4000-8000-000000000003',true);
select throws_ok($$select public.ais_import_stage('[]'::jsonb)$$,'42501','Data Manager or Admin access required','unassigned user cannot stage bootstrap');
select throws_ok($$select public.ais_import_commit('00000000-0000-4000-8000-000000000000')$$,'42501','Data Manager or Admin access required','unassigned user cannot commit bootstrap');
select throws_ok($$select public.ais_incremental_import_stage('[]'::jsonb)$$,'42501','Data Manager or Admin access required','unassigned user cannot stage incremental');
select throws_ok($$select public.ais_incremental_import_commit('00000000-0000-4000-8000-000000000000')$$,'42501','Data Manager or Admin access required','unassigned user cannot commit incremental');
select throws_ok($$select public.ais_import_history(50)$$,'42501','Data Manager or Admin access required','unassigned user cannot read history');
insert into app_private.user_access(user_id,role,display_name,is_active) values ('fa500000-0000-4000-8000-000000000003','admin','Disabled Manager',false);
select throws_ok($$select public.ais_import_stage('[]'::jsonb)$$,'42501','Data Manager or Admin access required','disabled manager cannot stage bootstrap');
select throws_ok($$select public.ais_import_commit('00000000-0000-4000-8000-000000000000')$$,'42501','Data Manager or Admin access required','disabled manager cannot commit bootstrap');
select throws_ok($$select public.ais_incremental_import_stage('[]'::jsonb)$$,'42501','Data Manager or Admin access required','disabled manager cannot stage incremental');
select throws_ok($$select public.ais_incremental_import_commit('00000000-0000-4000-8000-000000000000')$$,'42501','Data Manager or Admin access required','disabled manager cannot commit incremental');
select throws_ok($$select public.ais_import_history(50)$$,'42501','Data Manager or Admin access required','disabled manager cannot read history');
insert into auth.users(id,aud,role,email,created_at,updated_at) values ('fa500000-0000-4000-8000-000000000004','authenticated','authenticated','admin-incremental@test.invalid',now(),now());
insert into app_private.user_access(user_id,role,display_name,is_active) values ('fa500000-0000-4000-8000-000000000004','admin','Admin',true);
select set_config('request.jwt.claim.sub','fa500000-0000-4000-8000-000000000004',true);
insert into incremental_results values ('admin_bootstrap',public.ais_import_stage('[{"source_row":2,"location_code":"INCREMENTAL-A","loc_bld":"Branch A","com_sn":"ADMIN-BOOTSTRAP"}]'::jsonb));
select is((select (payload->>'row_count')::int from incremental_results where kind='admin_bootstrap'),1,'Admin can stage the bootstrap import workflow');
select throws_ok(format('select public.ais_import_commit(%L::uuid)',(select payload->>'batch_id' from incremental_results where kind='admin_bootstrap')),'55000','Initial workbook import is allowed only when branch and scanner registers are empty','Admin cannot bypass the one-time bootstrap boundary');
insert into incremental_results values ('admin_incremental',public.ais_incremental_import_stage('[{"source_row":2,"location_code":"INCREMENTAL-A","loc_bld":"Branch A","com_sn":"case-sn","brand":"Admin brand"}]'::jsonb));
select is((select (payload->>'issue_count')::int from incremental_results where kind='admin_incremental'),0,'Admin can stage a valid incremental update');
select is((public.ais_incremental_import_commit((select (payload->>'batch_id')::uuid from incremental_results where kind='admin_incremental'))->>'status'),'committed','Admin can commit the incremental update');
select is((select brand from app_private.scanner_assets where lower(btrim(com_sn))='case-sn'),'Admin brand','Admin incremental changes are applied to the registered Serial regardless of casing');
select ok(jsonb_array_length(public.ais_import_history(50)) > 0,'Admin can read import history');
select * from finish();
rollback;
