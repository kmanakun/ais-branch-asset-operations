create or replace function public.ais_campaign_asset_page(
  p_campaign_id uuid,
  p_limit integer default 25,
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

  if actor_role not in ('admin', 'data_manager', 'planner', 'field_technician', 'viewer') then
    raise exception 'Campaign read access required' using errcode = '42501';
  end if;

  if p_campaign_id is null or p_limit is null or p_limit not between 1 and 100
    or p_offset is null or p_offset < 0 or p_offset > 100000 then
    raise exception 'Invalid campaign page request' using errcode = '22023';
  end if;

  if not exists (
    select 1 from app_private.campaigns campaign where campaign.id = p_campaign_id
  ) then
    raise exception 'Campaign not found' using errcode = '22023';
  end if;

  select count(*)::integer into total_rows
  from app_private.campaign_items item
  join app_private.scanner_assets asset on asset.id = item.scanner_asset_id
  join app_private.branches branch on branch.id = asset.branch_id
  left join app_private.replacement_tasks task on task.campaign_item_id = item.id
  where item.campaign_id = p_campaign_id
    and (actor_role <> 'field_technician' or (task.id is not null and task.team_id is not null));

  select coalesce(jsonb_agg(page.row_data order by page.province_sort, page.location_code, page.branch_name, page.serial_sort), '[]'::jsonb)
    into result_rows
  from (
    select
      jsonb_build_object(
        'asset_id', case when actor_role = 'viewer' then null else asset.id end,
        'task_id', case when actor_role = 'viewer' then null else task.id end,
        'serial', case
          when actor_role = 'viewer' then '••••••' || right(asset.com_sn, 4)
          else asset.com_sn
        end,
        'can_navigate', actor_role <> 'viewer',
        'model', coalesce(nullif(asset.model_name, ''), nullif(asset.hw_name, ''), 'เครื่องสแกน'),
        'location_code', branch.location_code,
        'branch_name', coalesce(branch.loc_bld, branch.location_code),
        'province', branch.province,
        'task_status', task.status::text
      ) as row_data,
      lower(coalesce(branch.province, '')) as province_sort,
      branch.location_code,
      coalesce(branch.loc_bld, branch.location_code) as branch_name,
      asset.com_sn as serial_sort
    from app_private.campaign_items item
    join app_private.scanner_assets asset on asset.id = item.scanner_asset_id
    join app_private.branches branch on branch.id = asset.branch_id
    left join app_private.replacement_tasks task on task.campaign_item_id = item.id
    where item.campaign_id = p_campaign_id
      and (actor_role <> 'field_technician' or (task.id is not null and task.team_id is not null))
    order by lower(coalesce(branch.province, '')), branch.location_code,
      coalesce(branch.loc_bld, branch.location_code), asset.com_sn
    limit p_limit offset p_offset
  ) page;

  return jsonb_build_object(
    'campaign_id', p_campaign_id,
    'total', total_rows,
    'rows', result_rows
  );
end
$$;

revoke all on function public.ais_campaign_asset_page(uuid, integer, integer) from public, anon;
grant execute on function public.ais_campaign_asset_page(uuid, integer, integer) to authenticated;

comment on function public.ais_campaign_asset_page(uuid, integer, integer) is
  'Returns paginated scanner serials and work-order status for campaign details; field technicians see assigned jobs and viewers receive masked serials.';
