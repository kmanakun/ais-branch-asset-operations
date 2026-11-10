create or replace function public.ais_task_filtered_page(
  p_search text,
  p_status text,
  p_limit integer,
  p_offset integer
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
  search_term text := nullif(btrim(p_search), '');
  status_filter text := lower(btrim(coalesce(p_status, '')));
  result jsonb;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;

  if actor is null or actor_role is null then
    raise exception 'Application access required' using errcode = '42501';
  end if;

  if p_limit is null or p_limit not between 1 and 250
    or p_offset is null or p_offset not between 0 and 100000 then
    raise exception 'Task page limit or offset is outside the supported range' using errcode = '22023';
  end if;

  if status_filter not in ('all', 'scheduled', 'in_progress', 'blocked', 'completed', 'cancelled') then
    raise exception 'Invalid task status filter' using errcode = '22023';
  end if;

  if search_term is not null and length(search_term) > 100 then
    raise exception 'Task search is longer than the supported limit' using errcode = '22023';
  end if;

  with visible_tasks as materialized (
    select
      rt.id,
      rt.status,
      rt.scheduled_for,
      b.location_code,
      b.loc_bld,
      coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), '') as scanner_model,
      s.com_sn,
      t.team_name,
      jsonb_build_object(
        'id', rt.id,
        'branch_name', coalesce(nullif(b.loc_bld, ''), b.location_code),
        'location_code', b.location_code,
        'scanner_model', coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), ''),
        'com_sn', case when actor_role = 'viewer' then '••••••' || right(s.com_sn, 4) else s.com_sn end,
        'team_name', t.team_name,
        'team_active', coalesce(t.is_active, false),
        'scheduled_for', rt.scheduled_for,
        'task_status', rt.status::text,
        'version', rt.version,
        'blocked_reason', case when actor_role = 'viewer' then null else rt.blocked_reason end,
        'new_serial', case when actor_role = 'viewer' and visit.new_serial is not null then '••••••' || right(visit.new_serial, 4) else visit.new_serial end,
        'old_serial_snapshot', case when actor_role = 'viewer' and visit.old_serial_snapshot is not null then '••••••' || right(visit.old_serial_snapshot, 4) else visit.old_serial_snapshot end,
        'install_result', visit.install_result,
        'old_scanner_status', visit.old_scanner_status::text,
        'old_scanner_note', case when actor_role = 'viewer' then null else visit.old_scanner_note end
      ) as row_data
    from app_private.replacement_tasks rt
    join app_private.campaign_items ci on ci.id = rt.campaign_item_id
    join app_private.scanner_assets s on s.id = ci.scanner_asset_id
    join app_private.branches b on b.id = s.branch_id
    left join app_private.teams t on t.id = rt.team_id
    left join lateral (
      select fv.old_serial_snapshot, fv.new_serial, fv.install_result, fv.old_scanner_status, fv.old_scanner_note
      from app_private.field_visits fv
      where fv.task_id = rt.id
      order by fv.performed_at desc, fv.created_at desc, fv.id desc
      limit 1
    ) visit on true
    where actor_role <> 'field_technician' or exists (
      select 1
      from app_private.user_team_memberships utm
      where utm.team_id = rt.team_id and utm.user_id = actor
    )
  ), matching_tasks as materialized (
    select visible_tasks.*
    from visible_tasks
    where search_term is null
      or position(lower(search_term) in lower(coalesce(location_code, ''))) > 0
      or position(lower(search_term) in lower(coalesce(loc_bld, ''))) > 0
      or position(lower(search_term) in lower(coalesce(scanner_model, ''))) > 0
      or position(lower(search_term) in lower(coalesce(team_name, ''))) > 0
      or (actor_role <> 'viewer' and position(lower(search_term) in lower(coalesce(com_sn, ''))) > 0)
  ), filtered_tasks as materialized (
    select matching_tasks.*
    from matching_tasks
    where status_filter = 'all' or status::text = status_filter
  ), task_page as (
    select id, scheduled_for, row_data
    from filtered_tasks
    order by scheduled_for nulls last, id
    limit p_limit offset p_offset
  ), status_counts as (
    select
      count(*)::integer as total,
      count(*) filter (where status = 'scheduled')::integer as scheduled,
      count(*) filter (where status = 'in_progress')::integer as in_progress,
      count(*) filter (where status = 'blocked')::integer as blocked,
      count(*) filter (where status = 'completed')::integer as completed,
      count(*) filter (where status = 'cancelled')::integer as cancelled
    from matching_tasks
  ), filtered_count as (
    select count(*)::integer as total from filtered_tasks
  )
  select jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(row_data order by scheduled_for nulls last, id)
      from task_page
    ), '[]'::jsonb),
    'total', filtered_count.total,
    'counts', jsonb_build_object(
      'scheduled', status_counts.scheduled,
      'in_progress', status_counts.in_progress,
      'blocked', status_counts.blocked,
      'completed', status_counts.completed,
      'cancelled', status_counts.cancelled
    )
  )
  into result
  from status_counts cross join filtered_count;

  return result;
end
$$;

revoke all on function public.ais_task_filtered_page(text, text, integer, integer) from public, anon;
grant execute on function public.ais_task_filtered_page(text, text, integer, integer) to authenticated;
comment on function public.ais_task_filtered_page(text, text, integer, integer) is
  'Returns a bounded role/team-scoped task page with server-side search and status filtering; Viewer search never matches raw serial numbers.';
