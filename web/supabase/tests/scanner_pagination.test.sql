begin;
create extension if not exists pgtap with schema extensions;
select plan(7);
select ok(not has_function_privilege('anon','public.ais_scanner_page(text,integer,integer)','EXECUTE'),'anonymous pagination access denied');
insert into auth.users(id,aud,role,email,created_at,updated_at) values('fb000000-0000-4000-8000-000000000001','authenticated','authenticated','page@test.invalid',now(),now());
insert into app_private.user_access(user_id,role,display_name) values('fb000000-0000-4000-8000-000000000001','admin','Pagination Admin');
insert into app_private.branches(id,location_code,loc_bld) values('fb000000-0000-4000-8000-000000000002','PAGE-FIXTURE','Pagination Branch');
insert into app_private.scanner_assets(branch_id,com_sn,model_name)
select 'fb000000-0000-4000-8000-000000000002'::uuid,'PAGE-SECRET-'||n,'Page Model' from generate_series(1,205) n;
select set_config('request.jwt.claim.sub','fb000000-0000-4000-8000-000000000001',true);
select is((public.ais_scanner_page('PAGE-FIXTURE',50,0)->>'total')::int,205,'total includes records beyond legacy 200-row limit');
select is(jsonb_array_length(public.ais_scanner_page('PAGE-FIXTURE',50,200)->'rows'),5,'last page contains remaining assets');
select is((select count(*)::int from jsonb_array_elements(public.ais_scanner_page('PAGE-FIXTURE',50,0)->'rows') a join jsonb_array_elements(public.ais_scanner_page('PAGE-FIXTURE',50,50)->'rows') b on a->>'id'=b->>'id'),0,'adjacent pages do not overlap');
select ok(position('PAGE-SECRET' in public.ais_scanner_page('PAGE-FIXTURE')::text)>0,'Admin response includes raw serials');
select is((public.ais_scanner_page('SECRET')->>'total')::int,205,'Admin can search raw serials');
select throws_ok($$select public.ais_scanner_page(null,201,0)$$,'22023','Invalid pagination parameters','page size is bounded');
select * from finish();
rollback;
