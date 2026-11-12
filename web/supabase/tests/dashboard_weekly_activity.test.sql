begin;
\ir google_signin_fixture.fixture
create extension if not exists pgtap with schema extensions;
select no_plan();

select pg_temp.create_test_google_user('fc200000-0000-4000-8000-000000000001', 'technician-aggregate@test.invalid', 'field_technician', 'Team A Technician');
select pg_temp.create_test_google_user('fc200000-0000-4000-8000-000000000002', 'planner-aggregate@test.invalid', 'admin', 'Aggregate Planner');
insert into app_private.user_access(user_id,role,display_name) values
 ('fc200000-0000-4000-8000-000000000001','field_technician','Team A Technician'),
 ('fc200000-0000-4000-8000-000000000002','admin','Aggregate Planner')
on conflict (user_id) do update set role=excluded.role, display_name=excluded.display_name, is_active=true;
insert into app_private.teams(id,team_name) values
 ('fc200000-0000-4000-8000-000000000010','Aggregate Team A'),
 ('fc200000-0000-4000-8000-000000000011','Aggregate Team B');
insert into app_private.user_team_memberships(user_id,team_id) values
 ('fc200000-0000-4000-8000-000000000001','fc200000-0000-4000-8000-000000000010');
insert into app_private.branches(id,location_code,loc_bld,province) values
 ('fc200000-0000-4000-8000-000000000020','AGGREGATE-A','Aggregate Branch A','นครศรีธรรมราช'),
 ('fc200000-0000-4000-8000-000000000021','AGGREGATE-B','Aggregate Branch B','กรุงเทพมหานคร'),
 ('fc200000-0000-4000-8000-000000000022','AGGREGATE-C','Unassigned Branch',null);
insert into app_private.branch_work_orders(id,work_order_code,branch_id,origin) values
 ('fc200000-0000-4000-8000-000000000070','WEEKLY-ORDER-A','fc200000-0000-4000-8000-000000000020','admin'),
 ('fc200000-0000-4000-8000-000000000071','WEEKLY-ORDER-B','fc200000-0000-4000-8000-000000000021','admin');
insert into app_private.scanner_assets(id,branch_id,com_sn) values
 ('fc200000-0000-4000-8000-000000000030','fc200000-0000-4000-8000-000000000020','AGGREGATE-SN-A'),
 ('fc200000-0000-4000-8000-000000000031','fc200000-0000-4000-8000-000000000021','AGGREGATE-SN-B'),
 ('fc200000-0000-4000-8000-000000000032','fc200000-0000-4000-8000-000000000022','AGGREGATE-SN-C');
insert into app_private.campaigns(id,campaign_code,campaign_name,status)
values('fc200000-0000-4000-8000-000000000040','AGGREGATE-TEST','Two-team scope check','in_progress');
insert into app_private.campaign_items(id,campaign_id,scanner_asset_id,selection_reason) values
 ('fc200000-0000-4000-8000-000000000050','fc200000-0000-4000-8000-000000000040','fc200000-0000-4000-8000-000000000030','Test team A'),
 ('fc200000-0000-4000-8000-000000000051','fc200000-0000-4000-8000-000000000040','fc200000-0000-4000-8000-000000000031','Test team B'),
 ('fc200000-0000-4000-8000-000000000052','fc200000-0000-4000-8000-000000000040','fc200000-0000-4000-8000-000000000032','Selected but not scheduled');
insert into app_private.replacement_tasks(id,campaign_item_id,team_id,status,scanner_asset_id,branch_work_order_id,closeout_submitted_at,admin_accepted_at)
values
 ('fc200000-0000-4000-8000-000000000060','fc200000-0000-4000-8000-000000000050','fc200000-0000-4000-8000-000000000010','completed','fc200000-0000-4000-8000-000000000030','fc200000-0000-4000-8000-000000000070',now(),now()),
 ('fc200000-0000-4000-8000-000000000061','fc200000-0000-4000-8000-000000000051','fc200000-0000-4000-8000-000000000011','scheduled','fc200000-0000-4000-8000-000000000031','fc200000-0000-4000-8000-000000000071',null,null);


select set_config('request.jwt.claim.sub','fc200000-0000-4000-8000-000000000001',true);
select is(jsonb_array_length(public.ais_dashboard()->'weekly_activity'), 7, 'seven days are returned');
select is((public.ais_dashboard()->'weekly_activity'->0->>'date'), ((now() at time zone 'Asia/Bangkok')::date - 6)::text, 'first date is six days before Bangkok today');
select is((public.ais_dashboard()->'weekly_activity'->6->>'date'), ((now() at time zone 'Asia/Bangkok')::date)::text, 'last date is Bangkok today');
select is((public.ais_dashboard()->'weekly_activity'->0->>'opened'), '0', 'empty date has zero opened work orders');
select is((public.ais_dashboard()->'weekly_activity'->6->>'opened'), '2', 'technician sees work orders from their opening date across teams');
select is((public.ais_dashboard()->'weekly_activity'->6->>'completed'), '1', 'technician sees completed work across teams');
select is(
  (select task->>'province' from jsonb_array_elements(public.ais_dashboard()->'tasks') as tasks(task) where task->>'location_code'='AGGREGATE-A'),
  'นครศรีธรรมราช',
  'dashboard task rows include province for province grouping'
);
select set_config('request.jwt.claim.sub','fc200000-0000-4000-8000-000000000002',true);
select is((public.ais_dashboard()->'weekly_activity'->6->>'opened'), '2', 'Admin sees opened work orders across teams');
select is((public.ais_dashboard()->'weekly_activity'->6->>'completed'), '1', 'Admin sees completed count across teams');
select * from finish();
rollback;
