create or replace function public.ais_scanner_work_history(
  p_asset_id uuid,
  p_task_id uuid default null,
  p_limit integer default 10,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  total_rows integer;
  result_rows jsonb;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;

  if actor is null or actor_role is null then
    raise exception 'Application access required' using errcode = '42501';
  end if;
  if actor_role not in ('admin', 'field_technician') then
    raise exception 'Scanner work history access required' using errcode = '42501';
  end if;
  if p_asset_id is null or p_limit is null or p_limit not between 1 and 20
    or p_offset is null or p_offset not between 0 and 1000 then
    raise exception 'Invalid scanner work history request' using errcode = '22023';
  end if;

  select count(*)::integer into total_rows
  from app_private.replacement_tasks rt
  join app_private.campaign_items ci on ci.id = rt.campaign_item_id
  where ci.scanner_asset_id = p_asset_id
    and (p_task_id is null or rt.id = p_task_id)
    and (actor_role = 'admin' or rt.team_id is not null);

  select coalesce(jsonb_agg(history.row_data order by history.sort_performed_at desc nulls last, history.sort_updated_at desc, history.id), '[]'::jsonb)
    into result_rows
  from (
    select
      rt.id,
      visit.performed_at as sort_performed_at,
      rt.updated_at as sort_updated_at,
      jsonb_build_object(
        'id', rt.id,
        'asset_id', s.id,
        'branch_name', coalesce(nullif(b.loc_bld, ''), b.location_code),
        'location_code', b.location_code,
        'province', b.province,
        'scanner_model', coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), ''),
        'com_sn', s.com_sn,
        'team_name', t.team_name,
        'team_active', coalesce(t.is_active, false),
        'scheduled_for', rt.scheduled_for,
        'task_status', rt.status::text,
        'workflow_stage', app_private.task_workflow_stage(rt.status, rt.technician_confirmed_at, rt.closeout_submitted_at, rt.admin_accepted_at, visit.outcome),
        'workflow_outcome', visit.outcome,
        'observed_serial', visit.observed_serial,
        'exception_reason', visit.exception_reason,
        'version', rt.version,
        'blocked_reason', rt.blocked_reason,
        'new_serial', visit.new_serial,
        'old_serial_snapshot', visit.old_serial_snapshot,
        'install_result', visit.install_result,
        'old_scanner_status', visit.old_scanner_status,
        'old_scanner_note', visit.old_scanner_note,
        'performed_by_name', visit.performer_name,
        'performed_at', visit.performed_at
      ) as row_data
    from app_private.replacement_tasks rt
    join app_private.campaign_items ci on ci.id = rt.campaign_item_id
    join app_private.scanner_assets s on s.id = ci.scanner_asset_id
    join app_private.branches b on b.id = s.branch_id
    left join app_private.teams t on t.id = rt.team_id
    left join lateral (
      select
        fv.old_serial_snapshot,
        fv.new_serial,
        fv.install_result,
        fv.old_scanner_status::text as old_scanner_status,
        fv.old_scanner_note,
        fv.outcome,
        fv.observed_serial,
        fv.exception_reason,
        fv.performed_at,
        ua.display_name as performer_name
      from app_private.field_visits fv
      left join app_private.user_access ua on ua.user_id = fv.performed_by
      where fv.task_id = rt.id
      order by fv.performed_at desc, fv.created_at desc, fv.id desc
      limit 1
    ) visit on true
    where ci.scanner_asset_id = p_asset_id
      and (p_task_id is null or rt.id = p_task_id)
      and (actor_role = 'admin' or rt.team_id is not null)
    order by visit.performed_at desc nulls last, rt.updated_at desc, rt.id
    limit p_limit offset p_offset
  ) history;

  return jsonb_build_object(
    'asset_id', p_asset_id,
    'total', total_rows,
    'rows', result_rows
  );
end
$$;

revoke all on function public.ais_scanner_work_history(uuid, uuid, integer, integer) from public, anon;
grant execute on function public.ais_scanner_work_history(uuid, uuid, integer, integer) to authenticated;
comment on function public.ais_scanner_work_history(uuid, uuid, integer, integer) is
  'Returns bounded work-order history for one registered scanner, including the real technician account name and closeout timestamp; technicians can read every assigned task without team membership checks.';

-- Expose the persisted field-visit actor on normal work-order pages, and make
-- short serials unreadable to Viewer-role callers wherever that legacy role is
-- still present in the database.
do $migration$
declare
  task_signature regprocedure := 'public.ais_task_filtered_page(text,text,integer,integer)'::regprocedure;
  task_original text := pg_get_functiondef(task_signature);
  task_definition text := task_original;
  scanner_signature regprocedure := 'public.ais_scanner_page(text,integer,integer)'::regprocedure;
  scanner_original text := pg_get_functiondef(scanner_signature);
  scanner_definition text := scanner_original;
begin
  task_definition := replace(task_definition,
    '''com_sn'', case when actor_role = ''viewer'' then ''••••••'' || right(s.com_sn, 4) else s.com_sn end',
    '''com_sn'', case when actor_role <> ''viewer'' then s.com_sn when char_length(s.com_sn) > 4 then ''••••••'' || right(s.com_sn, 4) else ''••••••'' end');
  task_definition := replace(task_definition,
    '''observed_serial'', case when actor_role = ''viewer'' and visit.observed_serial is not null then ''••••••'' || right(visit.observed_serial, 4) else visit.observed_serial end',
    '''observed_serial'', case when actor_role <> ''viewer'' then visit.observed_serial when visit.observed_serial is null then null when char_length(visit.observed_serial) > 4 then ''••••••'' || right(visit.observed_serial, 4) else ''••••••'' end');
  task_definition := replace(task_definition,
    '''new_serial'', case when actor_role = ''viewer'' and visit.new_serial is not null then ''••••••'' || right(visit.new_serial, 4) else visit.new_serial end',
    '''new_serial'', case when actor_role <> ''viewer'' then visit.new_serial when visit.new_serial is null then null when char_length(visit.new_serial) > 4 then ''••••••'' || right(visit.new_serial, 4) else ''••••••'' end');
  task_definition := replace(task_definition,
    '''old_serial_snapshot'', case when actor_role = ''viewer'' and visit.old_serial_snapshot is not null then ''••••••'' || right(visit.old_serial_snapshot, 4) else visit.old_serial_snapshot end',
    '''old_serial_snapshot'', case when actor_role <> ''viewer'' then visit.old_serial_snapshot when visit.old_serial_snapshot is null then null when char_length(visit.old_serial_snapshot) > 4 then ''••••••'' || right(visit.old_serial_snapshot, 4) else ''••••••'' end');
  task_definition := replace(task_definition,
    '''old_scanner_note'', case when actor_role = ''viewer'' then null else visit.old_scanner_note end',
    '''old_scanner_note'', case when actor_role = ''viewer'' then null else visit.old_scanner_note end,
        ''performed_by_name'', case when actor_role = ''viewer'' then null else visit.performer_name end,
        ''performed_at'', visit.performed_at');
  task_definition := replace(task_definition,
    'select fv.old_serial_snapshot, fv.new_serial, fv.install_result, fv.old_scanner_status, fv.old_scanner_note, fv.outcome, fv.observed_serial, fv.exception_reason
      from app_private.field_visits fv',
    'select fv.old_serial_snapshot, fv.new_serial, fv.install_result, fv.old_scanner_status, fv.old_scanner_note, fv.outcome, fv.observed_serial, fv.exception_reason, fv.performed_at, ua.display_name as performer_name
      from app_private.field_visits fv
      left join app_private.user_access ua on ua.user_id = fv.performed_by');
  if task_definition = task_original
    or strpos(task_definition, '''performed_by_name''') = 0
    or strpos(task_definition, 'ua.display_name as performer_name') = 0
    or strpos(task_definition, 'right(visit.new_serial, 4) else visit.new_serial') > 0 then
    raise exception 'Could not safely add technician attribution and short-serial masking to %', task_signature;
  end if;
  execute task_definition;

  scanner_definition := replace(scanner_definition,
    'case when actor_role = ''viewer'' then ''••••••'' || right(s.com_sn, 4) else s.com_sn end',
    'case when actor_role <> ''viewer'' then s.com_sn when char_length(s.com_sn) > 4 then ''••••••'' || right(s.com_sn, 4) else ''••••••'' end');
  if scanner_definition = scanner_original
    or strpos(scanner_definition, 'right(s.com_sn, 4) else s.com_sn') > 0 then
    raise exception 'Could not safely update short-serial masking in %', scanner_signature;
  end if;
  execute scanner_definition;
end
$migration$;
