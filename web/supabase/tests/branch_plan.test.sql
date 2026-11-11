begin;
\ir google_signin_fixture.fixture
create extension if not exists pgtap with schema extensions;
select no_plan();

select ok(not has_function_privilege('anon','public.ais_branch_plan_summary()','EXECUTE'),'anonymous users cannot read branch-plan summary');
select ok(has_function_privilege('authenticated','public.ais_branch_plan_summary()','EXECUTE'),'authenticated users can call the guarded summary RPC');
select ok(not has_function_privilege('anon','public.ais_branch_plan_page(text,text,text,integer,integer,text)','EXECUTE'),'anonymous users cannot read branch-plan rows');
select ok(has_function_privilege('authenticated','public.ais_branch_plan_page(text,text,text,integer,integer,text)','EXECUTE'),'authenticated users can call the guarded branch-plan page RPC');
select ok(to_regprocedure('public.ais_branch_plan_page(text,text,text,integer,integer)') is null,'the obsolete five-argument function is removed');
select ok(not has_function_privilege('anon','public.ais_branch_plan_inventory(text)','EXECUTE'),'anonymous users cannot inspect planned-branch inventory');
select ok(not has_function_privilege('authenticated','public.ais_branch_plan_inventory(text)','EXECUTE'),'authenticated users cannot call the legacy LocationCode inventory RPC');
select ok(not has_function_privilege('anon','public.ais_branch_plan_inventory_for_row(integer)','EXECUTE'),'anonymous users cannot inspect inventory by plan row');
select ok(has_function_privilege('authenticated','public.ais_branch_plan_inventory_for_row(integer)','EXECUTE'),'authenticated users can call the guarded exact-row inventory RPC');
select throws_ok($$select public.ais_branch_plan_page()$$,'42501','Application access required','unprovisioned users cannot read branch-plan rows');
select throws_ok($$select public.ais_branch_plan_inventory('1201')$$,'42501','Application access required','unprovisioned users cannot inspect planned-branch inventory');
select throws_ok($$select public.ais_branch_plan_inventory_for_row(2)$$,'42501','Application access required','unprovisioned users cannot inspect inventory by plan row');

select pg_temp.create_test_google_user(
  'fc900000-0000-4000-8000-000000000001',
  'branch-plan-manager@test.invalid',
  'admin',
  'Branch Plan Manager'
);
insert into app_private.user_access(user_id,role,display_name,is_active)
values('fc900000-0000-4000-8000-000000000001','admin','Branch Plan Manager',true)
on conflict (user_id) do update set role=excluded.role,is_active=excluded.is_active;
insert into app_private.teams(id,team_name)
values('fc900000-0000-4000-8000-000000000010','Local Plan Team');
insert into app_private.branches(id,location_code,loc_bld,province) values
  ('fc900000-0000-4000-8000-000000000020','PLAN-TEST-DATED','Local Plan Branch Dated','กรุงเทพมหานคร'),
  ('fc900000-0000-4000-8000-000000000021','PLAN-TEST-UNDATED','Local Plan Branch Undated','ชลบุรี'),
  ('fc900000-0000-4000-8000-000000000022','DUPL1','Local Plan Branch Alpha','ชลบุรี'),
  ('fc900000-0000-4000-8000-000000000023','DUPL1','Local Plan Branch Beta','ระยอง');
insert into app_private.scanner_assets(id,branch_id,com_sn,model_name) values
  ('fc900000-0000-4000-8000-000000000030','fc900000-0000-4000-8000-000000000020','PLAN-TEST-SERIAL','Test Scanner'),
  ('fc900000-0000-4000-8000-000000000031','fc900000-0000-4000-8000-000000000022','PLAN-SRIRACHA-SERIAL','Test Scanner'),
  ('fc900000-0000-4000-8000-000000000032','fc900000-0000-4000-8000-000000000023','PLAN-BETA-SERIAL','Test Scanner');
insert into app_private.branch_work_plan_batches(
  id,source_name,source_sheet,status,imported_by,row_count,dated_branch_count,undated_branch_count,first_date,last_date
) values (
  'fc900000-0000-4000-8000-000000000040','local-test-plan.xlsx','Plan','draft',
  'fc900000-0000-4000-8000-000000000001',4,1,3,date '2026-12-01',date '2026-12-01'
);
insert into app_private.branch_work_plan_items(batch_id,branch_id,team_id,source_team2,planned_on,source_row) values
  ('fc900000-0000-4000-8000-000000000040','fc900000-0000-4000-8000-000000000020','fc900000-0000-4000-8000-000000000010','Fixture team',date '2026-12-01',2),
  ('fc900000-0000-4000-8000-000000000040','fc900000-0000-4000-8000-000000000021','fc900000-0000-4000-8000-000000000010','Fixture team',null,3),
  ('fc900000-0000-4000-8000-000000000040','fc900000-0000-4000-8000-000000000022','fc900000-0000-4000-8000-000000000010','Fixture team',null,4),
  ('fc900000-0000-4000-8000-000000000040','fc900000-0000-4000-8000-000000000023','fc900000-0000-4000-8000-000000000010','Fixture team',null,5);
insert into app_private.audit_events(actor_id,event_type,entity_type,entity_id,summary)
values (
  'fc900000-0000-4000-8000-000000000001','branch_plan_imported','branch_work_plan_batch',
  'fc900000-0000-4000-8000-000000000040',jsonb_build_object('source_name','local-test-plan.xlsx','row_count',2)
);

select is((select count(*)::integer from app_private.branch_work_plan_batches),1,'one local source-plan snapshot is present');
select is((select count(*)::integer from app_private.branch_work_plan_items),4,'all local plan rows are retained');
select is((select count(*)::integer from app_private.branch_work_plan_items where planned_on is not null),1,'dated plan row is retained');
select is((select count(*)::integer from app_private.branch_work_plan_items where planned_on is null),3,'undated plan rows are retained');
select is((select count(*)::integer from app_private.replacement_tasks),0,'draft plan entries do not create field tasks');
select is((select status from app_private.branch_work_plan_batches limit 1),'draft','local plan fixture remains a draft');
select is((select count(*)::integer from app_private.audit_events where event_type='branch_plan_imported'),1,'plan import is auditable');

select set_config('request.jwt.claim.sub','fc900000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims','{"sub":"fc900000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select is((public.ais_branch_plan_page()->>'total')::integer,4,'Data Manager can read the full fixture count');
select is(jsonb_array_length(public.ais_branch_plan_page(null,null,'all',1,0)->'rows'),1,'branch-plan page respects the requested row limit');
select ok((public.ais_branch_plan_page()->'rows'->0 ? 'registered_device_count'),'branch-plan rows include the registered-device count');
select is(public.ais_branch_plan_page()->'rows'->0->>'province','กรุงเทพมหานคร','branch plan rows include province and start in province order');
select is(public.ais_branch_plan_page()->'rows'->1->>'province','ชลบุรี','branches in the same province remain adjacent in the plan list');
select is(public.ais_branch_plan_page()->'rows'->3->>'province','ระยอง','the next province follows the complete preceding province group');
select is(
  (public.ais_branch_plan_inventory_for_row((public.ais_branch_plan_page()->'rows'->0->>'source_row')::integer)->>'registered_device_count')::integer,
  (select count(*)::integer
   from app_private.scanner_assets asset
   join app_private.branches branch on branch.id = asset.branch_id
   where branch.location_code = public.ais_branch_plan_page()->'rows'->0->>'location_code'),
  'exact plan-row inventory preview count matches registered assets at the branch'
);
select ok(jsonb_array_length(public.ais_branch_plan_inventory_for_row((public.ais_branch_plan_page()->'rows'->0->>'source_row')::integer)->'devices') <= 100,'inventory preview caps returned device details at one hundred');
select is(public.ais_branch_plan_inventory_for_row(4)->'branch'->>'branch_name','Local Plan Branch Alpha','source row 4 resolves the Alpha branch sharing a duplicate fixture code');
select is(public.ais_branch_plan_inventory_for_row(4)->'devices'->0->>'com_sn','PLAN-SRIRACHA-SERIAL','source row 4 returns only Sriracha scanner inventory');
select is(public.ais_branch_plan_inventory_for_row(5)->'branch'->>'branch_name','Local Plan Branch Beta','source row 5 resolves the Beta branch sharing a duplicate fixture code');
select is(public.ais_branch_plan_inventory_for_row(5)->'devices'->0->>'com_sn','PLAN-BETA-SERIAL','source row 5 returns only Beta scanner inventory');
select throws_ok($$select public.ais_branch_plan_inventory('DUPL1')$$,'22023','Ambiguous branch location code; use the exact plan row','legacy location-code lookup rejects duplicate fixture branches');
select is((public.ais_branch_plan_inventory_for_row(999999)->>'found'),'false','exact inventory lookup does not enumerate rows outside the latest plan');
select is((public.ais_branch_plan_inventory('not-in-latest-plan')->>'found'),'false','inventory preview does not enumerate branches outside the latest plan');
select is((public.ais_branch_plan_page(null,null,'undated',50,0)->>'total')::integer,3,'undated filter finds the local undated branches');
select throws_ok($$select public.ais_branch_plan_page(null,null,'unknown',50,0)$$,'22023','Invalid date filter','invalid plan date filters are rejected');
select throws_ok($$select public.ais_branch_plan_page(null,null,'all',101,0)$$,'22023','Invalid pagination parameters','oversized page requests are rejected');
select is((public.ais_branch_plan_page(null,null,'all',50,0,'ชลบุรี')->>'total')::integer,2,'province filter returns every matching branch across pages');
select ok(not exists(
  select 1
  from jsonb_array_elements(public.ais_branch_plan_page(null,null,'all',50,0,'ชลบุรี')->'rows') as entries(value)
  where entries.value->>'province' <> 'ชลบุรี'
),'province-filtered rows contain only the selected province');
select throws_ok($$select public.ais_branch_plan_page(null,null,'all',50,0,repeat('x',101))$$,'22023','Search filters are too long','overlong province filters are rejected');
select throws_ok($$select public.ais_branch_plan_inventory(' ')$$,'22023','Invalid branch location code','empty branch location codes are rejected');
select throws_ok($$select public.ais_branch_plan_inventory_for_row(0)$$,'22023','Invalid plan source row','invalid plan source rows are rejected');

insert into app_private.branches(id,location_code,loc_bld,province)
values('fc900000-0000-4000-8000-000000000024','PLAN-TEST-NOPROVINCE','Local Plan Branch No Province',null);
insert into app_private.branch_work_plan_items(batch_id,branch_id,team_id,source_team2,planned_on,source_row)
values('fc900000-0000-4000-8000-000000000040','fc900000-0000-4000-8000-000000000024','fc900000-0000-4000-8000-000000000010','Fixture team',null,6);
select is((public.ais_branch_plan_page(null,null,'all',50,0,'__unassigned__')->>'total')::integer,1,'unassigned-province filter finds branches without a province');
select is(public.ais_branch_plan_page(null,null,'all',50,0,'__unassigned__')->'rows'->0->>'source_row','6','unassigned-province filter returns the exact unassigned source row');

select * from finish();
rollback;
