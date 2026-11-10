create unique index if not exists branch_work_plan_items_batch_source_row_uidx
  on app_private.branch_work_plan_items(batch_id, source_row);

create or replace function public.ais_branch_plan_inventory_for_row(p_source_row integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  requested_source_row integer := p_source_row;
  latest_batch_id uuid;
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

  if requested_source_row is null or requested_source_row not between 1 and 1000000 then
    raise exception 'Invalid plan source row' using errcode = '22023';
  end if;

  select batch.id into latest_batch_id
  from app_private.branch_work_plan_batches batch
  order by batch.imported_at desc, batch.id desc
  limit 1;

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
  from app_private.branch_work_plan_items item
  join app_private.branches branch on branch.id = item.branch_id
  join app_private.teams team on team.id = item.team_id
  where item.batch_id = latest_batch_id
    and item.source_row = requested_source_row;

  if planned_branch_id is null then
    return jsonb_build_object(
      'found', false,
      'branch', null,
      'registered_device_count', 0,
      'devices_truncated', false,
      'devices', '[]'::jsonb
    );
  end if;

  select count(*)::integer into registered_device_count
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
  latest_batch_id uuid;
  matching_rows integer := 0;
  requested_source_row integer;
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

  select batch.id into latest_batch_id
  from app_private.branch_work_plan_batches batch
  order by batch.imported_at desc, batch.id desc
  limit 1;

  select count(*)::integer, min(item.source_row)
  into matching_rows, requested_source_row
  from app_private.branch_work_plan_items item
  join app_private.branches branch on branch.id = item.branch_id
  where item.batch_id = latest_batch_id
    and branch.location_code = requested_location_code;

  if matching_rows > 1 then
    raise exception 'Ambiguous branch location code; use the exact plan row' using errcode = '22023';
  end if;

  if matching_rows = 0 then
    return jsonb_build_object(
      'found', false,
      'branch', null,
      'registered_device_count', 0,
      'devices_truncated', false,
      'devices', '[]'::jsonb
    );
  end if;

  return public.ais_branch_plan_inventory_for_row(requested_source_row);
end
$$;

revoke all on function public.ais_branch_plan_inventory_for_row(integer) from public, anon;
grant execute on function public.ais_branch_plan_inventory_for_row(integer) to authenticated;
revoke all on function public.ais_branch_plan_inventory(text) from public, anon;
grant execute on function public.ais_branch_plan_inventory(text) to authenticated;

comment on function public.ais_branch_plan_inventory_for_row(integer) is
  'Returns a bounded registered-inventory preview for the exact source row in the latest plan; active Admin, Planner, or Data Manager only.';
comment on function public.ais_branch_plan_inventory(text) is
  'Legacy LocationCode lookup; rejects ambiguous codes and directs callers to exact source-row lookup.';
