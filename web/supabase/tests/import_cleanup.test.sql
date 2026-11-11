begin;
\ir google_signin_fixture.fixture
create extension if not exists pgtap with schema extensions;

select plan(21);

select is((select count(*)::int from pg_extension where extname = 'pg_cron'), 1, 'pg_cron is enabled');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'ais_purge_expired_import_staging'
     and p.prosecdef and p.proconfig @> array['search_path=""']),
  1,
  'cleanup function is SECURITY DEFINER with an empty search_path'
);
select ok(not has_function_privilege('anon', 'app_private.ais_purge_expired_import_staging()', 'EXECUTE'), 'anon cannot invoke cleanup');
select ok(not has_function_privilege('authenticated', 'app_private.ais_purge_expired_import_staging()', 'EXECUTE'), 'authenticated cannot invoke cleanup');
select is((select count(*)::int from cron.job where jobname = 'ais-purge-expired-import-staging'), 1, 'one hourly cleanup job is scheduled');

select pg_temp.create_test_google_user(
  'f9000000-0000-4000-8000-000000000001',
  'cleanup-local@test.invalid',
  'admin',
  'Cleanup Test Admin'
);

insert into app_private.import_batches (id, source_name, uploaded_by, status, row_count, issue_count, expires_at) values
  ('f9100000-0000-4000-8000-000000000001', 'expired-test.xlsx', 'f9000000-0000-4000-8000-000000000001', 'staged', 1, 1, now() - interval '1 hour'),
  ('f9100000-0000-4000-8000-000000000002', 'active-test.xlsx', 'f9000000-0000-4000-8000-000000000001', 'staged', 1, 1, now() + interval '1 day'),
  ('f9100000-0000-4000-8000-000000000003', 'committed-test.xlsx', 'f9000000-0000-4000-8000-000000000001', 'committed', 1, 0, now() - interval '1 hour');

insert into app_private.import_batches (id, source_name, uploaded_by, status, row_count, issue_count, expires_at, created_at) values
  ('f9100000-0000-4000-8000-000000000004', 'old-import.xlsx', 'f9000000-0000-4000-8000-000000000001', 'committed', 1, 0, now() - interval '2 days', now() - interval '1 year' - interval '1 microsecond'),
  ('f9100000-0000-4000-8000-000000000005', 'cutoff-import.xlsx', 'f9000000-0000-4000-8000-000000000001', 'committed', 1, 0, now() - interval '2 days', now() - interval '1 year'),
  ('f9100000-0000-4000-8000-000000000006', 'recent-import.xlsx', 'f9000000-0000-4000-8000-000000000001', 'committed', 1, 0, now() - interval '2 days', now() - interval '1 year' + interval '1 microsecond');

insert into app_private.import_staging_rows (id, batch_id, row_number, normalized_data) values
  ('f9200000-0000-4000-8000-000000000001', 'f9100000-0000-4000-8000-000000000001', 1, '{"location_code":"EXPIRED"}'),
  ('f9200000-0000-4000-8000-000000000002', 'f9100000-0000-4000-8000-000000000002', 1, '{"location_code":"ACTIVE"}'),
  ('f9200000-0000-4000-8000-000000000003', 'f9100000-0000-4000-8000-000000000003', 1, '{"location_code":"COMMITTED"}'),
  ('f9200000-0000-4000-8000-000000000004', 'f9100000-0000-4000-8000-000000000004', 1, '{"location_code":"OLD"}');

insert into app_private.import_row_issues (id, batch_id, row_number, field_name, issue_code, message) values
  ('f9300000-0000-4000-8000-000000000001', 'f9100000-0000-4000-8000-000000000001', 1, 'location_code', 'invalid_test', 'expired fixture'),
  ('f9300000-0000-4000-8000-000000000002', 'f9100000-0000-4000-8000-000000000002', 1, 'location_code', 'invalid_test', 'active fixture'),
  ('f9300000-0000-4000-8000-000000000003', 'f9100000-0000-4000-8000-000000000004', 1, 'location_code', 'invalid_test', 'old fixture');

insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary, created_at) values
  ('f9000000-0000-4000-8000-000000000001', 'incremental_scanner_import_committed', 'import_batch', 'f9100000-0000-4000-8000-000000000004', '{"inserted":1}', now() - interval '1 year' - interval '1 microsecond'),
  ('f9000000-0000-4000-8000-000000000001', 'incremental_scanner_import_committed', 'import_batch', 'f9100000-0000-4000-8000-000000000005', '{"inserted":1}', now() - interval '1 year'),
  ('f9000000-0000-4000-8000-000000000001', 'incremental_scanner_import_committed', 'import_batch', 'f9100000-0000-4000-8000-000000000006', '{"inserted":1}', now() - interval '1 year' + interval '1 microsecond');

select is(app_private.ais_purge_expired_import_staging(), 1, 'cleanup reports one expired batch');
select is((select status from app_private.import_batches where id = 'f9100000-0000-4000-8000-000000000001'), 'expired', 'expired batch metadata is retained and marked expired');
select is((select count(*)::int from app_private.import_staging_rows where batch_id = 'f9100000-0000-4000-8000-000000000001'), 0, 'expired staged rows are removed');
select is((select count(*)::int from app_private.import_row_issues where batch_id = 'f9100000-0000-4000-8000-000000000001'), 0, 'expired validation messages are removed');
select is((select status from app_private.import_batches where id = 'f9100000-0000-4000-8000-000000000002'), 'staged', 'unexpired batch remains staged');
select is((select count(*)::int from app_private.import_staging_rows where batch_id = 'f9100000-0000-4000-8000-000000000002'), 1, 'unexpired staged rows remain available');
select is((select status from app_private.import_batches where id = 'f9100000-0000-4000-8000-000000000003'), 'committed', 'committed batch is never expired');
select is((select count(*)::int from app_private.import_batches where id = 'f9100000-0000-4000-8000-000000000004'), 0, 'metadata older than one year is purged');
select is((select count(*)::int from app_private.import_staging_rows where batch_id = 'f9100000-0000-4000-8000-000000000004'), 0, 'expired metadata purge cascades to old staged rows');
select is((select count(*)::int from app_private.import_row_issues where batch_id = 'f9100000-0000-4000-8000-000000000004'), 0, 'expired metadata purge cascades to old validation messages');
select is((select count(*)::int from app_private.audit_events where entity_type = 'import_batch' and entity_id = 'f9100000-0000-4000-8000-000000000004'), 0, 'audit summaries older than one year are purged');
select is((select count(*)::int from app_private.import_batches where id = 'f9100000-0000-4000-8000-000000000005'), 1, 'metadata exactly at the one-year cutoff remains retained');
select is((select count(*)::int from app_private.audit_events where entity_type = 'import_batch' and entity_id = 'f9100000-0000-4000-8000-000000000005'), 1, 'audit summary exactly at the one-year cutoff remains retained');
select is((select count(*)::int from app_private.import_batches where id = 'f9100000-0000-4000-8000-000000000006'), 1, 'metadata newer than one year remains retained');
select is((select count(*)::int from app_private.audit_events where entity_type = 'import_batch' and entity_id = 'f9100000-0000-4000-8000-000000000006'), 1, 'audit summary newer than one year remains retained');
select is(app_private.ais_purge_expired_import_staging(), 0, 'repeated cleanup is idempotent');

select * from finish();
rollback;
