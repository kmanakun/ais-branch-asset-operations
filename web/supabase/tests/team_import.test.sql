begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select is(
  (select count(*)::integer from app_private.teams),
  0,
  'public source setup does not seed private workbook team data'
);
select is(
  (select count(*)::integer from app_private.audit_events
   where event_type = 'teams_imported_from_workbook'),
  0,
  'public source setup does not record a private workbook import'
);

select * from finish();
rollback;
