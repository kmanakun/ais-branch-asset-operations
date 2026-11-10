-- Remove client-controlled filenames from the import RPC contract and persisted metadata.
-- This migration keeps the existing hourly pg_cron job and extends its cleanup function.

create or replace function app_private.ais_force_generic_import_source_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.source_name := 'import-upload';
  return new;
end
$$;

revoke all on function app_private.ais_force_generic_import_source_name() from public, anon, authenticated;

drop trigger if exists import_batches_generic_source_name on app_private.import_batches;
create trigger import_batches_generic_source_name
before insert or update of source_name on app_private.import_batches
for each row execute function app_private.ais_force_generic_import_source_name();

-- Scrub filenames already stored in import batch rows and their audit summaries.
update app_private.import_batches
set source_name = 'import-upload'
where source_name is distinct from 'import-upload';

update app_private.audit_events
set summary = summary - 'source_name'
where entity_type = 'import_batch'
  and summary ? 'source_name';

create index if not exists import_batches_created_at_retention_idx
  on app_private.import_batches(created_at);

-- Remove RPC signatures that accepted a client-provided filename.
drop function public.ais_incremental_import_stage(text, jsonb);
drop function public.ais_import_stage(text, jsonb);

create function public.ais_import_stage(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  v_batch_id uuid;
  item jsonb;
  normalized jsonb;
  source_row integer;
  rows_count integer;
  branches_count integer;
  issues_count integer;
  issues jsonb;
  field_name text;
  field_limit integer;
  field_value text;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role is distinct from 'data_manager' then
    raise exception 'Data Manager access required' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 5000 then
    raise exception 'Import must contain between 1 and 5000 rows' using errcode = '22023';
  end if;
  if octet_length(p_rows::text) > 8388608 then
    raise exception 'Import payload exceeds 8 MB' using errcode = '22023';
  end if;

  insert into app_private.import_batches (source_name, uploaded_by, status, row_count)
  values ('import-upload', actor, 'staged', jsonb_array_length(p_rows))
  returning id into v_batch_id;

  for item in select value from jsonb_array_elements(p_rows)
  loop
    source_row := greatest(1, coalesce(nullif(item->>'source_row', '')::integer, 0));
    normalized := jsonb_build_object(
      'location_code', nullif(btrim(item->>'location_code'), ''),
      'subs_zn', nullif(btrim(item->>'subs_zn'), ''),
      'loc_bld', nullif(regexp_replace(btrim(item->>'loc_bld'), '[[:space:]]+', ' ', 'g'), ''),
      'address', nullif(btrim(item->>'address'), ''),
      'province', nullif(btrim(item->>'province'), ''),
      'district', nullif(btrim(item->>'district'), ''),
      'subdistrict', nullif(btrim(item->>'subdistrict'), ''),
      'postal_code', nullif(btrim(item->>'postal_code'), ''),
      'ro', nullif(btrim(item->>'ro'), ''),
      'high_level_location', nullif(btrim(item->>'high_level_location'), ''),
      'hw_name', nullif(btrim(item->>'hw_name'), ''),
      'brand', nullif(btrim(item->>'brand'), ''),
      'model_name', nullif(btrim(item->>'model_name'), ''),
      'com_id', nullif(btrim(item->>'com_id'), ''),
      'com_sn', nullif(btrim(item->>'com_sn'), ''),
      'model_id', nullif(btrim(item->>'model_id'), ''),
      'com_years', nullif(btrim(item->>'com_years'), '')
    );
    insert into app_private.import_staging_rows (batch_id, row_number, normalized_data)
    values (v_batch_id, source_row, normalized);

    foreach field_name in array array['location_code', 'loc_bld', 'com_sn']
    loop
      if normalized->>field_name is null then
        insert into app_private.import_row_issues (batch_id, row_number, field_name, issue_code, message)
        values (v_batch_id, source_row, field_name, 'required', 'ต้องระบุข้อมูลช่องนี้');
      end if;
    end loop;

    for field_name, field_limit in
      select * from (values
        ('location_code', 80), ('subs_zn', 120), ('loc_bld', 240), ('address', 500),
        ('province', 120), ('district', 120), ('subdistrict', 120), ('postal_code', 20),
        ('ro', 120), ('high_level_location', 240), ('hw_name', 240), ('brand', 120),
        ('model_name', 240), ('com_id', 160), ('com_sn', 160), ('model_id', 120), ('com_years', 40)
      ) as limits(field_name, field_limit)
    loop
      field_value := normalized->>field_name;
      if field_value is not null and char_length(field_value) > field_limit then
        insert into app_private.import_row_issues (batch_id, row_number, field_name, issue_code, message)
        values (v_batch_id, source_row, field_name, 'too_long', 'ข้อมูลยาวเกินขนาดที่ระบบรองรับ');
      end if;
    end loop;
  end loop;

  insert into app_private.import_row_issues (batch_id, row_number, field_name, issue_code, message)
  select staged.batch_id, staged.row_number, 'com_sn', 'duplicate_in_file', 'Serial ซ้ำภายในไฟล์'
  from app_private.import_staging_rows staged
  where staged.batch_id = v_batch_id
    and normalized_data->>'com_sn' is not null
    and normalized_data->>'com_sn' in (
      select normalized_data->>'com_sn' from app_private.import_staging_rows
      where batch_id = v_batch_id and normalized_data->>'com_sn' is not null
      group by normalized_data->>'com_sn' having count(*) > 1
    );

  insert into app_private.import_row_issues (batch_id, row_number, field_name, issue_code, message)
  select staged.batch_id, staged.row_number, 'com_sn', 'serial_exists', 'Serial นี้มีอยู่ในทะเบียนแล้ว'
  from app_private.import_staging_rows staged
  join app_private.scanner_assets asset on asset.com_sn = staged.normalized_data->>'com_sn'
  where staged.batch_id = v_batch_id;

  insert into app_private.import_row_issues (batch_id, row_number, field_name, issue_code, message)
  select distinct staged.batch_id, staged.row_number, 'branch', 'branch_details_conflict', 'ข้อมูลที่อยู่ของรหัสสาขาและชื่อสาขาเดียวกันไม่ตรงกัน'
  from app_private.import_staging_rows staged
  join (
    select normalized_data->>'location_code' as location_code,
      lower(regexp_replace(btrim(normalized_data->>'loc_bld'), '[[:space:]]+', ' ', 'g')) as branch_name
    from app_private.import_staging_rows
    where batch_id = v_batch_id
    group by normalized_data->>'location_code', lower(regexp_replace(btrim(normalized_data->>'loc_bld'), '[[:space:]]+', ' ', 'g'))
    having count(distinct nullif(lower(regexp_replace(btrim(normalized_data->>'address'), '[[:space:]]+', ' ', 'g')), '')) > 1
       or count(distinct nullif(lower(btrim(normalized_data->>'province')), '')) > 1
       or count(distinct nullif(lower(btrim(normalized_data->>'district')), '')) > 1
       or count(distinct nullif(lower(btrim(normalized_data->>'subdistrict')), '')) > 1
       or count(distinct nullif(btrim(normalized_data->>'postal_code'), '')) > 1
       or count(distinct nullif(lower(regexp_replace(btrim(normalized_data->>'subs_zn'), '[[:space:]]+', ' ', 'g')), '')) > 1
       or count(distinct nullif(lower(regexp_replace(btrim(normalized_data->>'ro'), '[[:space:]]+', ' ', 'g')), '')) > 1
       or count(distinct nullif(lower(regexp_replace(btrim(normalized_data->>'high_level_location'), '[[:space:]]+', ' ', 'g')), '')) > 1
  ) conflicts on conflicts.location_code = staged.normalized_data->>'location_code'
      and conflicts.branch_name = lower(regexp_replace(btrim(staged.normalized_data->>'loc_bld'), '[[:space:]]+', ' ', 'g'))
  where staged.batch_id = v_batch_id;

  update app_private.import_batches batch
  set issue_count = (select count(*) from app_private.import_row_issues issue where issue.batch_id = batch.id)
  where batch.id = v_batch_id
  returning issue_count into issues_count;
  select coalesce(jsonb_agg(jsonb_build_object(
    'row_number', issue.row_number, 'field', issue.field_name,
    'code', issue.issue_code, 'message', issue.message
  ) order by issue.row_number, issue.field_name), '[]'::jsonb)
  into issues
  from (select * from app_private.import_row_issues where batch_id = v_batch_id
    order by row_number, field_name limit 100) issue;
  select count(*) into rows_count from app_private.import_staging_rows where batch_id = v_batch_id;
  select count(*) into branches_count from (
    select distinct normalized_data->>'location_code',
      lower(regexp_replace(btrim(normalized_data->>'loc_bld'), '[[:space:]]+', ' ', 'g'))
    from app_private.import_staging_rows where batch_id = v_batch_id
  ) distinct_branches;
  return jsonb_build_object(
    'batch_id', v_batch_id, 'status', 'staged', 'row_count', rows_count, 'branch_count', branches_count,
    'issue_count', issues_count, 'issues_truncated', issues_count > 100, 'issues', issues
  );
end
$$;

create function public.ais_incremental_import_stage(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb; batch uuid; v_issue_count integer; issues jsonb; actor_role app_private.app_role;
begin
  select role into actor_role from app_private.user_access where user_id=auth.uid() and is_active;
  if auth.uid() is null or actor_role is distinct from 'data_manager' then
    raise exception 'Data Manager access required' using errcode='42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Import must contain between 1 and 5000 rows' using errcode='22023';
  end if;
  if jsonb_array_length(p_rows) not between 1 and 5000 or octet_length(p_rows::text) > 8388608 then
    raise exception 'Import payload is empty or exceeds limits' using errcode='22023';
  end if;
  if jsonb_typeof(p_rows) = 'array' then
    select coalesce(jsonb_agg(case when jsonb_typeof(item) = 'object' and item ? 'com_sn'
      then jsonb_set(item, '{com_sn}', coalesce(to_jsonb(regexp_replace(item->>'com_sn', '^[[:space:]]+|[[:space:]]+$', '', 'g')), 'null'::jsonb))
      else item end order by ordinality), '[]'::jsonb) into p_rows
    from jsonb_array_elements(p_rows) with ordinality as rows(item, ordinality);
  end if;
  result := public.ais_import_stage(p_rows);
  batch := (result->>'batch_id')::uuid;
  update app_private.import_batches set import_mode = 'incremental' where id = batch;
  delete from app_private.import_row_issues where batch_id = batch and issue_code = 'serial_exists';
  insert into app_private.import_row_issues(batch_id,row_number,field_name,issue_code,message)
  select batch,s.row_number,'branch','branch_not_found','ไม่พบสาขาในทะเบียน' from app_private.import_staging_rows s
  where s.batch_id=batch and s.normalized_data->>'location_code' is not null and s.normalized_data->>'loc_bld' is not null
    and not exists (select 1 from app_private.branches br where br.location_code=s.normalized_data->>'location_code'
      and lower(regexp_replace(btrim(br.loc_bld),'[[:space:]]+',' ','g'))=lower(regexp_replace(btrim(s.normalized_data->>'loc_bld'),'[[:space:]]+',' ','g')));
  insert into app_private.import_row_issues(batch_id,row_number,field_name,issue_code,message)
  select batch,s.row_number,'com_sn','ambiguous_serial','Serial กำกวมในทะเบียน' from app_private.import_staging_rows s
  join app_private.scanner_assets a on regexp_replace(a.com_sn, '^[[:space:]]+|[[:space:]]+$', '', 'g')=s.normalized_data->>'com_sn' where s.batch_id=batch
  group by s.row_number having count(*)>1;
  insert into app_private.import_row_issues(batch_id,row_number,field_name,issue_code,message)
  select batch,s.row_number,'branch','serial_branch_conflict','Serial อยู่คนละสาขากับทะเบียน' from app_private.import_staging_rows s
  join app_private.scanner_assets a on regexp_replace(a.com_sn, '^[[:space:]]+|[[:space:]]+$', '', 'g')=s.normalized_data->>'com_sn'
  join app_private.branches br on br.id=a.branch_id where s.batch_id=batch and
    (br.location_code <> s.normalized_data->>'location_code' or
     lower(regexp_replace(btrim(br.loc_bld),'[[:space:]]+',' ','g')) <> lower(regexp_replace(btrim(s.normalized_data->>'loc_bld'),'[[:space:]]+',' ','g')));
  select count(*) into v_issue_count from app_private.import_row_issues where batch_id = batch;
  update app_private.import_batches b set issue_count = v_issue_count where id = batch;
  select coalesce(jsonb_agg(jsonb_build_object('row_number', i.row_number, 'field', i.field_name,
    'code', i.issue_code, 'message', i.message) order by i.row_number, i.field_name), '[]'::jsonb)
    into issues from (select * from app_private.import_row_issues where batch_id = batch order by row_number, field_name limit 100) i;
  return result || jsonb_build_object('issue_count', v_issue_count, 'issues_truncated', v_issue_count > 100, 'issues', issues);
end $$;


revoke all on function public.ais_import_stage(jsonb) from public, anon;
grant execute on function public.ais_import_stage(jsonb) to authenticated;
comment on function public.ais_import_stage(jsonb) is
  'Stages approved branch and scanner fields for active Data Managers. The RPC accepts row data only; import source metadata is fixed server-side.';

revoke all on function public.ais_incremental_import_stage(jsonb) from public, anon;
grant execute on function public.ais_incremental_import_stage(jsonb) to authenticated;
comment on function public.ais_incremental_import_stage(jsonb) is
  'Stages incremental scanner rows for active Data Managers. The RPC accepts row data only and records a server-side generic import source.';

create or replace function app_private.ais_purge_expired_import_staging()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired_batch_count integer;
  retention_cutoff timestamptz := now() - interval '1 year';
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

  -- Retain import batches and their row-free audit summaries for one year.
  -- At the exact cutoff, keep them; the next hourly run may purge them.
  delete from app_private.audit_events
  where entity_type = 'import_batch'
    and created_at < retention_cutoff;

  delete from app_private.import_batches
  where created_at < retention_cutoff;

  return expired_batch_count;
end
$$;

revoke all on function app_private.ais_purge_expired_import_staging() from public, anon, authenticated;
comment on function app_private.ais_purge_expired_import_staging() is
  'Internal hourly maintenance: removes expired staged rows/issues and import batch/audit metadata older than one year. Import metadata exactly at the one-year cutoff is retained until the next run. Not executable by browser roles.';


-- The existing hourly job already calls this function; no duplicate job is created.
