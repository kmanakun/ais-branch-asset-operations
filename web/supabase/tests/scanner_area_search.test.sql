begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, aud, role, created_at, updated_at) values
  ('fa900000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', now(), now()),
  ('fa900000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', now(), now());
insert into app_private.user_access (user_id, role, display_name) values
  ('fa900000-0000-4000-8000-000000000001', 'field_technician', 'Area search viewer'),
  ('fa900000-0000-4000-8000-000000000002', 'field_technician', 'Area search technician');
insert into app_private.branches
  (id, location_code, loc_bld, province, district, subdistrict, high_level_location, ro)
values
  ('fa900000-0000-4000-8000-000000000010', 'AREA-001', 'Fixture A', 'จังหวัดทดสอบพื้นที่', 'District-Alpha', 'ตำบลทดสอบพื้นที่', 'Regional-Hub-Alpha', 'RO-Area-Pilot'),
  ('fa900000-0000-4000-8000-000000000011', 'AREA-002', 'Fixture B', 'จังหวัดทดสอบพื้นที่', null, null, null, null);
insert into app_private.scanner_assets (id, branch_id, com_sn) values
  ('fa900000-0000-4000-8000-000000000020', 'fa900000-0000-4000-8000-000000000010', 'AREA-PRIVATE-7711'),
  ('fa900000-0000-4000-8000-000000000021', 'fa900000-0000-4000-8000-000000000011', 'AREA-PRIVATE-7712');
insert into app_private.teams (id, team_name) values
  ('fa900000-0000-4000-8000-000000000030', 'Area search team A'),
  ('fa900000-0000-4000-8000-000000000031', 'Area search team B');
insert into app_private.user_team_memberships (user_id, team_id) values
  ('fa900000-0000-4000-8000-000000000002', 'fa900000-0000-4000-8000-000000000030');
insert into app_private.campaigns (id, campaign_code, campaign_name) values
  ('fa900000-0000-4000-8000-000000000040', 'AREA-SEARCH-TEST', 'Area search teams');
insert into app_private.campaign_items (id, campaign_id, scanner_asset_id, selection_reason) values
  ('fa900000-0000-4000-8000-000000000050', 'fa900000-0000-4000-8000-000000000040', 'fa900000-0000-4000-8000-000000000020', 'Team A fixture'),
  ('fa900000-0000-4000-8000-000000000051', 'fa900000-0000-4000-8000-000000000040', 'fa900000-0000-4000-8000-000000000021', 'Team B fixture');
insert into app_private.replacement_tasks (campaign_item_id, team_id) values
  ('fa900000-0000-4000-8000-000000000050', 'fa900000-0000-4000-8000-000000000030'),
  ('fa900000-0000-4000-8000-000000000051', 'fa900000-0000-4000-8000-000000000031');

select ok(not has_function_privilege('anon', 'public.ais_scanner_page(text,integer,integer)', 'execute'), 'anonymous execution remains denied');
select ok(has_function_privilege('authenticated', 'public.ais_scanner_page(text,integer,integer)', 'execute'), 'authenticated role retains execution');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fa900000-0000-4000-8000-000000000001', true);
select is((public.ais_scanner_page(term)->>'total')::int, expected, label)
from (values
  ('  จังหวัดทดสอบพื้นที่  ', 2, 'province search trims surrounding whitespace'),
  ('district-alp', 1, 'district search is case insensitive and matches substrings'),
  ('ตำบลทดสอบ', 1, 'subdistrict search matches Thai text'),
  ('hub-alpha', 1, 'high-level location search matches substrings'),
  ('ro-area-pil', 1, 'RO search matches its mixed-case value')
) as searches(term, expected, label);

select is(public.ais_scanner_page('จังหวัดทดสอบพื้นที่', 1, 0) #>> '{rows,0,com_sn}', 'AREA-PRIVATE-7711', 'field technician sees the scanner serial');
select is((public.ais_scanner_page('AREA-PRIVATE-7711')->>'total')::int, 1, 'field technician can filter by a full serial');
select is(public.ais_scanner_page('จังหวัดทดสอบพื้นที่', 1, 1) #>> '{rows,0,location_code}', 'AREA-002', 'second page returns the next branch');
select is(public.ais_scanner_page('จังหวัดทดสอบพื้นที่', 1, 2), '{"total":2,"rows":[]}'::jsonb, 'offset past the final match preserves the filtered total');

select set_config('request.jwt.claim.sub', 'fa900000-0000-4000-8000-000000000002', true);
select is((public.ais_scanner_page('จังหวัดทดสอบพื้นที่')->>'total')::int, 2, 'area search includes every assigned work order');
select is(public.ais_scanner_page('จังหวัดทดสอบพื้นที่') #>> '{rows,0,com_sn}', 'AREA-PRIVATE-7711', 'technician sees full serial across teams');
select is((public.ais_scanner_page('AREA-PRIVATE-7712')->>'total')::int, 1, 'technician can find another team asset by serial');
select * from finish();
rollback;
