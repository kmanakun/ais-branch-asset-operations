begin;
create extension if not exists pgtap with schema extensions;

select plan(4);

select is(
  (select count(*)::int from pg_constraint where conrelid = 'app_private.branches'::regclass and conname = 'branches_loc_bld_required'),
  1,
  'each branch must have a non-empty branch label'
);
select is(
  (select count(*)::int from pg_indexes where schemaname = 'app_private' and indexname = 'branches_location_code_branch_name_uidx'),
  1,
  'LocationCode and normalized branch label form the branch key'
);

insert into app_private.branches (id, location_code, loc_bld) values
  ('fa000000-0000-4000-8000-000000000001', 'E2E-SHARED-CODE', 'E2E Branch One'),
  ('fa000000-0000-4000-8000-000000000002', 'E2E-SHARED-CODE', 'E2E Branch Two');

select is(
  (select count(*)::int from app_private.branches where location_code = 'E2E-SHARED-CODE'),
  2,
  'one LocationCode can retain multiple distinct branches'
);
select throws_ok(
  $$insert into app_private.branches (id, location_code, loc_bld) values ('fa000000-0000-4000-8000-000000000003', 'E2E-SHARED-CODE', ' e2e   branch one ')$$,
  '23505',
  null,
  'duplicate branch labels are rejected after whitespace and case normalization'
);

select * from finish();
rollback;
