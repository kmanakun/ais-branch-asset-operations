-- Requires operational write role guard migration 20261108173705.
alter table app_private.import_batches
  add column import_mode text not null default 'bootstrap' check (import_mode in ('bootstrap', 'incremental')),
  add column result_counts jsonb;

-- Reuse the existing validated staging pipeline; only an existing serial is allowed
-- for incremental imports. No source rows are retained after a commit.
create function public.ais_incremental_import_stage(p_source_name text, p_rows jsonb)
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
  result := public.ais_import_stage(p_source_name, p_rows);
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

create function public.ais_incremental_import_commit(p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); actor_role app_private.app_role; b app_private.import_batches%rowtype;
  inserted_branches integer; inserted_assets integer; updated_assets integer; counts jsonb;
begin
  select role into actor_role from app_private.user_access where user_id = actor and is_active;
  if actor is null or actor_role is distinct from 'data_manager' then
    raise exception 'Data Manager access required' using errcode = '42501';
  end if;
  select * into b from app_private.import_batches where id = p_batch_id and uploaded_by = actor and import_mode = 'incremental' for update;
  if not found then raise exception 'Import batch is unavailable' using errcode = '22023'; end if;
  if b.status = 'committed' then
    return jsonb_build_object('batch_id', b.id, 'status', 'committed') || coalesce(b.result_counts, '{}'::jsonb);
  end if;
  if b.status <> 'staged' or b.expires_at <= now() then raise exception 'Import batch is unavailable or expired' using errcode = '22023'; end if;
  if exists(select 1 from app_private.import_row_issues where batch_id=b.id)
     or (select count(*) from app_private.import_staging_rows where batch_id=b.id) <> b.row_count then
    raise exception 'Resolve all import validation issues before commit' using errcode = '22023';
  end if;

  -- Serialize with concurrent direct or RPC writes until validation and write finish.
  lock table app_private.branches, app_private.scanner_assets in share row exclusive mode;
  if exists (
    select 1 from app_private.import_staging_rows s
    join app_private.scanner_assets a on regexp_replace(a.com_sn, '^[[:space:]]+|[[:space:]]+$', '', 'g') = s.normalized_data->>'com_sn'
    where s.batch_id=b.id group by s.id having count(*) > 1
  ) then raise exception 'Ambiguous serial in existing register' using errcode = '22023'; end if;
  if exists (
    select 1 from app_private.import_staging_rows s
    join app_private.scanner_assets a on regexp_replace(a.com_sn, '^[[:space:]]+|[[:space:]]+$', '', 'g') = s.normalized_data->>'com_sn'
    join app_private.branches br on br.id=a.branch_id
    where s.batch_id=b.id and (br.location_code <> s.normalized_data->>'location_code'
      or lower(regexp_replace(btrim(br.loc_bld), '[[:space:]]+', ' ', 'g')) <>
         lower(regexp_replace(btrim(s.normalized_data->>'loc_bld'), '[[:space:]]+', ' ', 'g')))
  ) then raise exception 'Serial belongs to a conflicting branch' using errcode = '22023'; end if;
  if exists (
    select 1 from app_private.import_staging_rows s where s.batch_id=b.id and not exists (
      select 1 from app_private.branches br where br.location_code=s.normalized_data->>'location_code' and
       lower(regexp_replace(btrim(br.loc_bld),'[[:space:]]+',' ','g'))=lower(regexp_replace(btrim(s.normalized_data->>'loc_bld'),'[[:space:]]+',' ','g')))
  ) then raise exception 'Branch does not exist' using errcode = '22023'; end if;
  -- Identical branch keys in the staged file have already passed conflict validation.
  -- Keep existing values for blank cells and do not alter the branch key.
  update app_private.branches br set
    subs_zn=coalesce(x.subs_zn,br.subs_zn), loc_bld=coalesce(x.loc_bld,br.loc_bld), address=coalesce(x.address,br.address),
    province=coalesce(x.province,br.province), district=coalesce(x.district,br.district),
    subdistrict=coalesce(x.subdistrict,br.subdistrict), postal_code=coalesce(x.postal_code,br.postal_code),
    ro=coalesce(x.ro,br.ro), high_level_location=coalesce(x.high_level_location,br.high_level_location),
    updated_at=now()
  from (
    select d->>'location_code' location_code, lower(regexp_replace(btrim(d->>'loc_bld'),'[[:space:]]+',' ','g')) branch_name,
      max(d->>'subs_zn') subs_zn, max(d->>'loc_bld') loc_bld, max(d->>'address') address, max(d->>'province') province,
      max(d->>'district') district, max(d->>'subdistrict') subdistrict, max(d->>'postal_code') postal_code,
      max(d->>'ro') ro, max(d->>'high_level_location') high_level_location
    from app_private.import_staging_rows s cross join lateral (select s.normalized_data d) z
    where s.batch_id=b.id group by d->>'location_code', lower(regexp_replace(btrim(d->>'loc_bld'),'[[:space:]]+',' ','g'))
  ) x where br.location_code=x.location_code and lower(regexp_replace(btrim(br.loc_bld),'[[:space:]]+',' ','g'))=x.branch_name;
  inserted_branches := 0;

  update app_private.scanner_assets a set
    hw_name=coalesce(s.normalized_data->>'hw_name',a.hw_name), brand=coalesce(s.normalized_data->>'brand',a.brand),
    model_name=coalesce(s.normalized_data->>'model_name',a.model_name), com_id=coalesce(s.normalized_data->>'com_id',a.com_id),
    model_id=coalesce(s.normalized_data->>'model_id',a.model_id), com_years=coalesce(s.normalized_data->>'com_years',a.com_years), updated_at=now()
  from app_private.import_staging_rows s where s.batch_id=b.id and regexp_replace(a.com_sn, '^[[:space:]]+|[[:space:]]+$', '', 'g')=s.normalized_data->>'com_sn';
  get diagnostics updated_assets = row_count;
  insert into app_private.scanner_assets(branch_id,hw_name,brand,model_name,com_id,com_sn,model_id,com_years)
  select br.id,d->>'hw_name',d->>'brand',d->>'model_name',d->>'com_id',d->>'com_sn',d->>'model_id',d->>'com_years'
  from app_private.import_staging_rows s cross join lateral (select s.normalized_data d) x
  join app_private.branches br on br.location_code=d->>'location_code' and
    lower(regexp_replace(btrim(br.loc_bld),'[[:space:]]+',' ','g'))=lower(regexp_replace(btrim(d->>'loc_bld'),'[[:space:]]+',' ','g'))
  where s.batch_id=b.id and not exists(select 1 from app_private.scanner_assets a where regexp_replace(a.com_sn, '^[[:space:]]+|[[:space:]]+$', '', 'g')=d->>'com_sn');
  get diagnostics inserted_assets = row_count;
  counts := jsonb_build_object('branches',inserted_branches,'inserted',inserted_assets,'updated',updated_assets);
  update app_private.import_batches set status='committed', committed_at=now(), expires_at=now(), result_counts=counts where id=b.id;
  insert into app_private.audit_events(actor_id,event_type,entity_type,entity_id,summary)
    values(actor,'incremental_scanner_import_committed','import_batch',b.id,counts);
  delete from app_private.import_row_issues where batch_id=b.id;
  delete from app_private.import_staging_rows where batch_id=b.id;
  return jsonb_build_object('batch_id',b.id,'status','committed') || counts;
end $$;

create function public.ais_import_history(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := auth.uid(); actor_role app_private.app_role; result jsonb;
begin
  select role into actor_role from app_private.user_access where user_id=actor and is_active;
  if actor is null or actor_role is distinct from 'data_manager' then
    raise exception 'Data Manager access required' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc, x.id desc),'[]'::jsonb) into result from (
    select id, import_mode, status, row_count, issue_count, created_at, committed_at, result_counts
    from app_private.import_batches order by created_at desc,id desc limit greatest(1,least(coalesce(p_limit,50),100))
  ) x;
  return result;
end $$;
revoke all on function public.ais_incremental_import_stage(text,jsonb) from public, anon;
revoke all on function public.ais_incremental_import_commit(uuid) from public, anon;
revoke all on function public.ais_import_history(integer) from public, anon;
grant execute on function public.ais_incremental_import_stage(text,jsonb) to authenticated;
grant execute on function public.ais_incremental_import_commit(uuid) to authenticated;
grant execute on function public.ais_import_history(integer) to authenticated;

-- A bootstrap commit must never consume an incremental batch.
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
  if actor is null or actor_role is distinct from 'data_manager' then
    raise exception 'Data Manager access required' using errcode = '42501';
  end if;
  select * into v_batch
  from app_private.import_batches b
  where b.id = p_batch_id and b.uploaded_by = actor
  for update;
  if not found or v_batch.import_mode <> 'bootstrap' or v_batch.status <> 'staged' or v_batch.expires_at <= now() then
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

