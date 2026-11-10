-- Safe, one-time bootstrap import for the reviewed Detail1 workbook.
-- All writes stay behind authenticated RPCs; private tables remain unexposed.
create or replace function public.ais_import_stage(p_source_name text, p_rows jsonb)
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
  if actor is null or actor_role not in ('admin', 'data_manager') then
    raise exception 'Data Manager access required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 5000 then
    raise exception 'Import must contain between 1 and 5000 rows' using errcode = '22023';
  end if;
  if octet_length(p_rows::text) > 8388608 then
    raise exception 'Import payload exceeds 8 MB' using errcode = '22023';
  end if;

  insert into app_private.import_batches (source_name, uploaded_by, status, row_count)
  values (left(regexp_replace(coalesce(nullif(btrim(p_source_name), ''), 'workbook.xlsx'), '[\\/].*$', ''), 160), actor, 'staged', jsonb_array_length(p_rows))
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

create or replace function public.ais_import_commit(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  v_batch app_private.import_batches%rowtype;
  inserted_branches integer;
  inserted_assets integer;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role not in ('admin', 'data_manager') then
    raise exception 'Data Manager access required' using errcode = '42501';
  end if;
  select * into v_batch
  from app_private.import_batches b
  where b.id = p_batch_id and b.uploaded_by = actor
  for update;
  if not found or v_batch.status <> 'staged' or v_batch.expires_at <= now() then
    raise exception 'Import batch is unavailable or expired' using errcode = '22023';
  end if;
  if exists (select 1 from app_private.import_row_issues issue where issue.batch_id = v_batch.id) then
    raise exception 'Resolve all import validation issues before commit' using errcode = '22023';
  end if;
  if exists (select 1 from app_private.branches) or exists (select 1 from app_private.scanner_assets) then
    raise exception 'Initial workbook import is allowed only when branch and scanner registers are empty' using errcode = '55000';
  end if;
  if (select count(*) from app_private.import_staging_rows staged where staged.batch_id = v_batch.id) <> v_batch.row_count then
    raise exception 'Staged row count does not match the batch' using errcode = '22023';
  end if;

  insert into app_private.branches (
    location_code, subs_zn, loc_bld, address, province, district,
    subdistrict, postal_code, ro, high_level_location
  )
  select distinct on (
    data->>'location_code',
    lower(regexp_replace(btrim(data->>'loc_bld'), '[[:space:]]+', ' ', 'g'))
  )
    data->>'location_code', data->>'subs_zn', data->>'loc_bld', data->>'address',
    data->>'province', data->>'district', data->>'subdistrict', data->>'postal_code',
    data->>'ro', data->>'high_level_location'
  from app_private.import_staging_rows
  cross join lateral (select normalized_data as data) row_data
  where app_private.import_staging_rows.batch_id = v_batch.id
  order by data->>'location_code', lower(regexp_replace(btrim(data->>'loc_bld'), '[[:space:]]+', ' ', 'g')), row_number;
  get diagnostics inserted_branches = row_count;

  insert into app_private.scanner_assets (
    branch_id, hw_name, brand, model_name, com_id, com_sn, model_id, com_years
  )
  select branch.id, data->>'hw_name', data->>'brand', data->>'model_name',
    data->>'com_id', data->>'com_sn', data->>'model_id', data->>'com_years'
  from app_private.import_staging_rows staged
  cross join lateral (select staged.normalized_data as data) row_data
  join app_private.branches branch
    on branch.location_code = data->>'location_code'
   and lower(regexp_replace(btrim(branch.loc_bld), '[[:space:]]+', ' ', 'g'))
       = lower(regexp_replace(btrim(data->>'loc_bld'), '[[:space:]]+', ' ', 'g'))
  where staged.batch_id = v_batch.id
  order by staged.row_number;
  get diagnostics inserted_assets = row_count;

  update app_private.import_batches
  set status = 'committed', committed_at = now(), expires_at = now()
  where id = v_batch.id;
  insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
  values (actor, 'branch_scanner_import_committed', 'import_batch', v_batch.id,
    jsonb_build_object('branches', inserted_branches, 'scanners', inserted_assets, 'source_name', v_batch.source_name));
  delete from app_private.import_row_issues where batch_id = v_batch.id;
  delete from app_private.import_staging_rows where batch_id = v_batch.id;
  return jsonb_build_object('batch_id', v_batch.id, 'status', 'committed',
    'branches', inserted_branches, 'scanners', inserted_assets);
end
$$;

revoke all on function public.ais_import_stage(text, jsonb) from public, anon;
revoke all on function public.ais_import_commit(uuid) from public, anon;
grant execute on function public.ais_import_stage(text, jsonb) to authenticated;
grant execute on function public.ais_import_commit(uuid) to authenticated;
comment on function public.ais_import_stage(text, jsonb) is
  'Stages only approved branch and scanner fields for an active admin/data_manager; validates rows server-side and keeps workbook PII columns out of staging.';
comment on function public.ais_import_commit(uuid) is
  'Atomically commits a validated one-time initial register import; requires batch ownership and admin/data_manager role; target registers must be empty.';
