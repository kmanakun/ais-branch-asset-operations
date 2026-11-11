begin;
\ir google_signin_fixture.fixture
create extension if not exists pgtap with schema extensions;
select no_plan();

select ok(not has_function_privilege('anon','public.ais_branch_provinces()','EXECUTE'),'anonymous users cannot list provinces');
select ok(has_function_privilege('authenticated','public.ais_branch_provinces()','EXECUTE'),'authenticated users can call the guarded province list');
select throws_ok($$select public.ais_branch_provinces()$$,'42501','Active application access required','unprovisioned users cannot list provinces');

select pg_temp.create_test_google_user('fc300000-0000-4000-8000-000000000001','province-admin@test.invalid','admin','Province Admin');
select pg_temp.create_test_google_user('fc300000-0000-4000-8000-000000000002','province-tech@test.invalid','field_technician','Province Technician');
insert into app_private.user_access(user_id,role,display_name) values
 ('fc300000-0000-4000-8000-000000000001','admin','Province Admin'),
 ('fc300000-0000-4000-8000-000000000002','field_technician','Province Technician')
on conflict (user_id) do update set role=excluded.role, display_name=excluded.display_name, is_active=true;
insert into app_private.teams(id,team_name) values
 ('fc300000-0000-4000-8000-000000000010','Province Team A'),
 ('fc300000-0000-4000-8000-000000000011','Province Team B');
insert into app_private.user_team_memberships(user_id,team_id) values
 ('fc300000-0000-4000-8000-000000000002','fc300000-0000-4000-8000-000000000010');
insert into app_private.branches(id,location_code,loc_bld,province) values
 ('fc300000-0000-4000-8000-000000000020','PROVINCE-A','Province Branch A','เชียงใหม่'),
 ('fc300000-0000-4000-8000-000000000021','PROVINCE-B','Province Branch B','กรุงเทพมหานคร'),
 ('fc300000-0000-4000-8000-000000000022','PROVINCE-C','Province Branch C','ชลบุรี');
insert into app_private.scanner_assets(id,branch_id,com_sn) values
 ('fc300000-0000-4000-8000-000000000030','fc300000-0000-4000-8000-000000000020','PROVINCE-SN-A'),
 ('fc300000-0000-4000-8000-000000000031','fc300000-0000-4000-8000-000000000021','PROVINCE-SN-B'),
 ('fc300000-0000-4000-8000-000000000032','fc300000-0000-4000-8000-000000000022','PROVINCE-SN-C');
insert into app_private.campaigns(id,campaign_code,campaign_name,status)
values('fc300000-0000-4000-8000-000000000040','PROVINCE-TEST','Province selector test','in_progress');
insert into app_private.campaign_items(id,campaign_id,scanner_asset_id,selection_reason) values
 ('fc300000-0000-4000-8000-000000000050','fc300000-0000-4000-8000-000000000040','fc300000-0000-4000-8000-000000000030','Test Chiang Mai'),
 ('fc300000-0000-4000-8000-000000000051','fc300000-0000-4000-8000-000000000040','fc300000-0000-4000-8000-000000000031','Test Bangkok');
insert into app_private.replacement_tasks(id,campaign_item_id,team_id,status) values
 ('fc300000-0000-4000-8000-000000000060','fc300000-0000-4000-8000-000000000050','fc300000-0000-4000-8000-000000000010','scheduled'),
 ('fc300000-0000-4000-8000-000000000061','fc300000-0000-4000-8000-000000000051','fc300000-0000-4000-8000-000000000011','scheduled');

select set_config('request.jwt.claim.sub','fc300000-0000-4000-8000-000000000001',true);
select ok(public.ais_branch_provinces() @> '["เชียงใหม่","กรุงเทพมหานคร","ชลบุรี"]'::jsonb,'Admin can choose every registered province');
select set_config('request.jwt.claim.sub','fc300000-0000-4000-8000-000000000002',true);
select ok(public.ais_branch_provinces() @> '["เชียงใหม่","กรุงเทพมหานคร","ชลบุรี"]'::jsonb,'technician province choices come from the shared verified branch register');
select ok(public.ais_branch_provinces() @> '["ชลบุรี"]'::jsonb,'province options remain available even when no open work currently exists there');

select * from finish();
rollback;
