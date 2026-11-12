create or replace function public.ais_branch_plan_page(
  p_search text default null,
  p_team_name text default null,
  p_date_filter text default 'all',
  p_limit integer default 50,
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
  search_text text := nullif(btrim(p_search), '');
  team_name_filter text := nullif(btrim(p_team_name), '');
  result jsonb;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;

  if actor is null or actor_role is null or actor_role not in ('admin', 'planner', 'data_manager') then
    raise exception 'Application access required' using errcode = '42501';
  end if;

  if p_limit is null or p_limit not between 1 and 100
      or p_offset is null or p_offset not between 0 and 1000000 then
    raise exception 'Invalid pagination parameters' using errcode = '22023';
  end if;
  if (p_search is not null and length(p_search) > 100)
      or (p_team_name is not null and length(p_team_name) > 100) then
    raise exception 'Search filters are too long' using errcode = '22023';
  end if;
  if p_date_filter is null or p_date_filter not in ('all', 'dated', 'undated') then
    raise exception 'Invalid date filter' using errcode = '22023';
  end if;

  with latest_batch as materialized (
    select batch.id
    from app_private.branch_work_plan_batches batch
    order by batch.imported_at desc, batch.id desc
    limit 1
  ), filtered as materialized (
    select
      item.source_row,
      branch.id as branch_id,
      branch.location_code,
      branch.loc_bld as branch_name,
      team.team_name,
      item.planned_on,
      item.source_team2,
      (select count(*)::integer
       from app_private.scanner_assets asset
       where asset.branch_id = branch.id) as registered_device_count
    from latest_batch latest
    join app_private.branch_work_plan_items item on item.batch_id = latest.id
    join app_private.branches branch on branch.id = item.branch_id
    join app_private.teams team on team.id = item.team_id
    where (team_name_filter is null or team.team_name = team_name_filter)
      and (p_date_filter = 'all'
        or (p_date_filter = 'dated' and item.planned_on is not null)
        or (p_date_filter = 'undated' and item.planned_on is null))
      and (search_text is null
        or branch.location_code ilike '%' || search_text || '%'
        or coalesce(branch.loc_bld, '') ilike '%' || search_text || '%')
  ), page as (
    select *
    from filtered
    order by planned_on nulls last, team_name, location_code, branch_name, branch_id
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'has_plan', exists(select 1 from latest_batch),
    'total', (select count(*)::integer from filtered),
    'limit', p_limit,
    'offset', p_offset,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'source_row', page.source_row,
        'location_code', page.location_code,
        'branch_name', page.branch_name,
        'team_name', page.team_name,
        'planned_on', page.planned_on,
        'source_team2', page.source_team2,
        'registered_device_count', page.registered_device_count
      ) order by page.planned_on nulls last, page.team_name, page.location_code, page.branch_name, page.branch_id)
      from page
    ), '[]'::jsonb)
  ) into result;

  return result;
end
$$;

create or replace function public.ais_branch_plan_inventory(p_location_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  requested_location_code text := nullif(btrim(p_location_code), '');
  planned_branch_id uuid;
  plan_branch jsonb;
  registered_device_count integer := 0;
  devices jsonb := '[]'::jsonb;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;

  if actor is null or actor_role is null or actor_role not in ('admin', 'planner', 'data_manager') then
    raise exception 'Application access required' using errcode = '42501';
  end if;

  if requested_location_code is null or length(requested_location_code) > 100 then
    raise exception 'Invalid branch location code' using errcode = '22023';
  end if;

  with latest_batch as materialized (
    select batch.id
    from app_private.branch_work_plan_batches batch
    order by batch.imported_at desc, batch.id desc
    limit 1
  )
  select
    branch.id,
    jsonb_build_object(
      'source_row', item.source_row,
      'location_code', branch.location_code,
      'branch_name', branch.loc_bld,
      'team_name', team.team_name,
      'planned_on', item.planned_on,
      'source_team2', item.source_team2
    )
  into planned_branch_id, plan_branch
  from latest_batch latest
  join app_private.branch_work_plan_items item on item.batch_id = latest.id
  join app_private.branches branch on branch.id = item.branch_id
  join app_private.teams team on team.id = item.team_id
  where branch.location_code = requested_location_code
  limit 1;

  if planned_branch_id is null then
    return jsonb_build_object(
      'found', false,
      'branch', null,
      'registered_device_count', 0,
      'devices_truncated', false,
      'devices', '[]'::jsonb
    );
  end if;

  select count(*)::integer
  into registered_device_count
  from app_private.scanner_assets asset
  where asset.branch_id = planned_branch_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'brand', device.brand,
    'hw_name', device.hw_name,
    'model_name', device.model_name,
    'com_sn', device.com_sn
  ) order by coalesce(nullif(device.model_name, ''), nullif(device.hw_name, ''), ''), device.com_sn), '[]'::jsonb)
  into devices
  from (
    select asset.brand, asset.hw_name, asset.model_name, asset.com_sn
    from app_private.scanner_assets asset
    where asset.branch_id = planned_branch_id
    order by coalesce(nullif(asset.model_name, ''), nullif(asset.hw_name, ''), ''), asset.com_sn
    limit 100
  ) device;

  return jsonb_build_object(
    'found', true,
    'branch', plan_branch,
    'registered_device_count', registered_device_count,
    'devices_truncated', registered_device_count > 100,
    'devices', devices
  );
end
$$;

revoke all on function public.ais_branch_plan_page(text, text, text, integer, integer) from public, anon;
grant execute on function public.ais_branch_plan_page(text, text, text, integer, integer) to authenticated;
comment on function public.ais_branch_plan_page(text, text, text, integer, integer) is
  'Read-only paginated branch-plan review with registered device counts for active Admin, Planner, or Data Manager users; creates no tasks.';

revoke all on function public.ais_branch_plan_inventory(text) from public, anon;
grant execute on function public.ais_branch_plan_inventory(text) to authenticated;
comment on function public.ais_branch_plan_inventory(text) is
  'Read-only inventory preview for a branch in the latest plan; returns limited registered device identifiers and creates no tasks.';
