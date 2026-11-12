begin;
\ir google_signin_fixture.fixture
create extension if not exists pgtap with schema extensions;
select plan(29);
select ok(not has_function_privilege('anon','public.ais_scanner_page(text,integer,integer)','EXECUTE'),'anonymous pagination access denied');
select ok(not has_function_privilege('anon','public.ais_scanner_page_filtered(text,text,text,integer,integer)','EXECUTE'),'anonymous filtered-register access denied');
select pg_temp.create_test_google_user('fb000000-0000-4000-8000-000000000001','page@test.invalid','admin','Pagination Admin');
insert into app_private.user_access(user_id,role,display_name) values('fb000000-0000-4000-8000-000000000001','admin','Pagination Admin')
on conflict (user_id) do update set role=excluded.role,display_name=excluded.display_name,is_active=true;
insert into app_private.branches(id,location_code,loc_bld,province) values('fb000000-0000-4000-8000-000000000002','PAGE-FIXTURE','Pagination Branch','Filter Test Province');
insert into app_private.branches(id,location_code,loc_bld,province) values
('fb000000-0000-4000-8000-000000000003','PAGE-GROUP-A','Province A Branch','Filter Page A'),
('fb000000-0000-4000-8000-000000000004','PAGE-GROUP-B','Province B Branch','Filter Page B');
insert into app_private.scanner_assets(branch_id,com_sn,model_name)
select 'fb000000-0000-4000-8000-000000000002'::uuid,'PAGE-SECRET-'||n,'Page Model' from generate_series(1,205) n;
insert into app_private.scanner_assets(branch_id,com_sn,model_name)
select 'fb000000-0000-4000-8000-000000000003'::uuid,'PAGE-GROUP-A-'||n,'Page Group Model' from generate_series(1,20) n;
insert into app_private.scanner_assets(branch_id,com_sn,model_name)
select 'fb000000-0000-4000-8000-000000000004'::uuid,'PAGE-GROUP-B-'||n,'Page Group Model' from generate_series(1,30) n;
select set_config('request.jwt.claim.sub','fb000000-0000-4000-8000-000000000001',true);
select is((public.ais_scanner_page('PAGE-FIXTURE',50,0)->>'total')::int,205,'total includes records beyond legacy 200-row limit');
select is(jsonb_array_length(public.ais_scanner_page('PAGE-FIXTURE',50,200)->'rows'),5,'last page contains remaining assets');
select is((select count(*)::int from jsonb_array_elements(public.ais_scanner_page('PAGE-FIXTURE',50,0)->'rows') a join jsonb_array_elements(public.ais_scanner_page('PAGE-FIXTURE',50,50)->'rows') b on a->>'id'=b->>'id'),0,'adjacent pages do not overlap');
select ok(position('PAGE-SECRET' in public.ais_scanner_page('PAGE-FIXTURE')::text)>0,'Admin response includes raw serials');
select is((public.ais_scanner_page('SECRET')->>'total')::int,205,'Admin can search raw serials');
select throws_ok($$select public.ais_scanner_page(null,201,0)$$,'22023','Invalid scanner search or pagination request','page size is bounded');
select is(app_private.scanner_register_status_group(null),'open','Scanner without a work order is Open');
select is(app_private.scanner_register_status_group('open'),'open','work not started is Open');
select is(app_private.scanner_register_status_group('awaiting_confirmation'),'open','awaiting technician confirmation is Open');
select is(app_private.scanner_register_status_group('cancelled'),'open','cancelled work is available in the Open filter');
select is(app_private.scanner_register_status_group('in_progress'),'on_process','work in progress is On Process');
select is(app_private.scanner_register_status_group('blocked'),'on_process','blocked or Pending work remains On Process');
select is(app_private.scanner_register_status_group('awaiting_admin_acceptance'),'on_process','work awaiting Admin is On Process');
select is(app_private.scanner_register_status_group('delivered'),'complete','delivered work is Complete');
select is(app_private.scanner_register_status_group('legacy_completed'),'complete','legacy completed work is Complete');
select is((public.ais_scanner_page_filtered(null,'Filter Test Province','all',50,0)->>'total')::int,205,'exact province filter returns only its Scanner rows');
select is((public.ais_scanner_page_filtered(null,'No Such Province','all',50,0)->>'total')::int,0,'province with no matching assets returns zero rows');
select is((public.ais_scanner_page_filtered(null,'Filter Test Province','open',50,0)->>'total')::int,205,'unassigned assets appear under Open');
select is((public.ais_scanner_page_filtered(null,'Filter Test Province','on_process',50,0)->>'total')::int,0,'On Process filter excludes unassigned assets');
select is((public.ais_scanner_page_filtered(null,'Filter Test Province','complete',50,0)->>'total')::int,0,'Complete filter excludes unassigned assets');
select is((public.ais_scanner_page_filtered(null,'Filter Test Province','all',50,0)->>'province_total')::int,1,'filtered summary counts distinct provinces');
select is(app_private.scanner_register_status_group('exception_resolved'),'open','reviewing an exception does not count as completing the Scanner replacement');
select is((public.ais_scanner_page_filtered('PAGE-GROUP',null,'all',25,0)->>'total')::int,50,'group pagination counts matching scanners across both provinces');
select is(jsonb_array_length(public.ais_scanner_page_filtered('PAGE-GROUP',null,'all',25,0)->'rows'),20,'the first page ends before the next province instead of splitting it');
select is((public.ais_scanner_page_filtered('PAGE-GROUP',null,'all',25,20)->>'next_offset')::int,50,'the next page returns the whole remaining province and its continuation offset');
select throws_ok($$select public.ais_scanner_page_filtered(null,null,'unknown',50,0)$$,'22023','Invalid scanner filter or pagination request','unsupported status filters are rejected');
select throws_ok($$select public.ais_scanner_page_filtered(null,null,'all',201,0)$$,'22023','Invalid scanner filter or pagination request','filtered register keeps the page-size limit');
select * from finish();
rollback;
