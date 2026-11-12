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
insert into app_private.branches(id,location_code,loc_bld) values
 ('fc200000-0000-4000-8000-000000000020','AGGREGATE-A','Aggregate Branch A'),
 ('fc200000-0000-4000-8000-000000000021','AGGREGATE-B','Aggregate Branch B'),
 ('fc200000-0000-4000-8000-000000000022','AGGREGATE-C','Unassigned Branch');
insert into app_private.branch_work_orders(id,work_order_code,branch_id,origin) values
 ('fc200000-0000-4000-8000-000000000070','AGGREGATE-ORDER-A','fc200000-0000-4000-8000-000000000020','admin'),
 ('fc200000-0000-4000-8000-000000000071','AGGREGATE-ORDER-B','fc200000-0000-4000-8000-000000000021','admin');
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
insert into app_private.replacement_tasks(id,campaign_item_id,team_id,status,scanner_asset_id,branch_work_order_id)
values
 ('fc200000-0000-4000-8000-000000000060','fc200000-0000-4000-8000-000000000050','fc200000-0000-4000-8000-000000000010','completed','fc200000-0000-4000-8000-000000000030','fc200000-0000-4000-8000-000000000070'),
 ('fc200000-0000-4000-8000-000000000061','fc200000-0000-4000-8000-000000000051','fc200000-0000-4000-8000-000000000011','scheduled','fc200000-0000-4000-8000-000000000031','fc200000-0000-4000-8000-000000000071');

select set_config('request.jwt.claim.sub','fc200000-0000-4000-8000-000000000001',true);
select is(
  (select item->>'branches' from jsonb_array_elements(public.ais_list_campaigns(null)) as items(item) where item->>'campaign_code'='AGGREGATE-TEST'),
  '3',
  'legacy campaign summaries no longer hide selections based on team'
);
select is(
  (select item->>'total_assets' from jsonb_array_elements(public.ais_list_campaigns(null)) as items(item) where item->>'campaign_code'='AGGREGATE-TEST'),
  '3',
  'technician can inspect the full legacy campaign selection list'
);
select is(
  (select item->>'total_tasks' from jsonb_array_elements(public.ais_list_campaigns(null)) as items(item) where item->>'campaign_code'='AGGREGATE-TEST'),
  '2',
  'technician sees tasks from every team'
);
select is(
  (select item->>'done_tasks' from jsonb_array_elements(public.ais_list_campaigns(null)) as items(item) where item->>'campaign_code'='AGGREGATE-TEST'),
  '1',
  'technician completion count includes every team'
);
select is(
  (select item->>'total_tasks' from jsonb_array_elements(public.ais_dashboard()->'campaigns') as items(item) where item->>'campaign_code'='AGGREGATE-ORDER-A'),
  '1',
  'technician dashboard includes the direct branch work-order task'
);
select is(
  (select item->>'done_tasks' from jsonb_array_elements(public.ais_dashboard()->'campaigns') as items(item) where item->>'campaign_code'='AGGREGATE-ORDER-A'),
  '1',
  'technician dashboard completion aggregate includes every team'
);
select is(jsonb_array_length(public.ais_dashboard()->'tasks'),2,'technician dashboard task list includes every opened branch work order');
select is((public.ais_branch_work_order_page(null,'all',50,0)->>'total'),'2','every active technician sees all opened work orders regardless of team');

select set_config('request.jwt.claim.sub','fc200000-0000-4000-8000-000000000002',true);
select is(
  (select item->>'branches' from jsonb_array_elements(public.ais_list_campaigns(null)) as items(item) where item->>'campaign_code'='AGGREGATE-TEST'),
  '3',
  'Admin retains full campaign branch totals'
);
select is(
  (select item->>'total_assets' from jsonb_array_elements(public.ais_list_campaigns(null)) as items(item) where item->>'campaign_code'='AGGREGATE-TEST'),
  '3',
  'Admin retains all selected asset counts including unscheduled assets'
);
select is(
  (select item->>'total_tasks' from jsonb_array_elements(public.ais_list_campaigns(null)) as items(item) where item->>'campaign_code'='AGGREGATE-TEST'),
  '2',
  'Admin retains all-team task totals'
);
select is(
  (select item->>'total_tasks' from jsonb_array_elements(public.ais_dashboard()->'campaigns') as items(item) where item->>'campaign_code'='AGGREGATE-ORDER-A'),
  '1',
  'Admin dashboard includes the same opened branch work order'
);

select * from finish();
rollback;
