-- Expire abandoned import batches hourly while retaining the batch audit row.
-- Raw staged rows and validation messages are removed after their 24-hour TTL.
create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create or replace function app_private.ais_purge_expired_import_staging()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired_batch_count integer;
begin
  delete from app_private.import_staging_rows staged
  using app_private.import_batches batch
  where staged.batch_id = batch.id
    and batch.status = 'staged'
    and batch.expires_at <= now();

  delete from app_private.import_row_issues issue
  using app_private.import_batches batch
  where issue.batch_id = batch.id
    and batch.status = 'staged'
    and batch.expires_at <= now();

  update app_private.import_batches batch
  set status = 'expired'
  where batch.status = 'staged'
    and batch.expires_at <= now();

  get diagnostics expired_batch_count = row_count;
  return expired_batch_count;
end
$$;

revoke all on function app_private.ais_purge_expired_import_staging() from public, anon, authenticated;

comment on function app_private.ais_purge_expired_import_staging() is
  'Internal hourly maintenance: removes rows and validation messages from expired staged imports, preserves batch metadata, and is not executable by browser roles.';

do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid from cron.job where jobname = 'ais-purge-expired-import-staging'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;

  perform cron.schedule(
    'ais-purge-expired-import-staging',
    '17 * * * *',
    'select app_private.ais_purge_expired_import_staging();'
  );
end
$$;
