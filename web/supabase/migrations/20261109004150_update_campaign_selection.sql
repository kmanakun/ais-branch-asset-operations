create or replace function public.ais_campaign_schedule_preview(p_campaign_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  campaign_code text;
  campaign_name text;
  campaign_start date;
  campaign_end date;
  campaign_updated_at timestamptz;
  campaign_status app_private.campaign_state;
  latest_batch_id uuid;
  selected_asset_count integer;
  branch_rows jsonb;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;

  if actor is null or actor_role is null or actor_role not in ('admin', 'planner') then
    raise exception 'Planner access required' using errcode = '42501';
  end if;

  if p_campaign_id is null then
    raise exception 'A schedulable campaign is required' using errcode = '22023';
  end if;

  select campaign.campaign_code, campaign.campaign_name, campaign.start_on,
    campaign.end_on, campaign.status, campaign.updated_at
  into campaign_code, campaign_name, campaign_start, campaign_end, campaign_status, campaign_updated_at
  from app_private.campaigns campaign
  where campaign.id = p_campaign_id;

  if campaign_status is null or campaign_status not in ('selection', 'ready_to_schedule') then
    raise exception 'Campaign is not ready to schedule' using errcode = '22023';
  end if;

  if exists (
    select 1
    from app_private.replacement_tasks task
    join app_private.campaign_items item on item.id = task.campaign_item_id
    where item.campaign_id = p_campaign_id
  ) then
    raise exception 'Campaign already has scheduled tasks' using errcode = '22023';
  end if;

  select count(*)::integer into selected_asset_count
  from app_private.campaign_items item
  where item.campaign_id = p_campaign_id;

  if selected_asset_count not between 1 and 500 then
    raise exception 'Campaign must contain between 1 and 500 selected devices' using errcode = '22023';
  end if;

  select batch.id into latest_batch_id
  from app_private.branch_work_plan_batches batch
  order by batch.imported_at desc, batch.id desc
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'branch_id', grouped.branch_id,
    'location_code', grouped.location_code,
    'branch_name', grouped.branch_name,
    'selected_assets', grouped.selected_assets,
    'plan_source_row', grouped.plan_source_row,
    'plan_team_id', grouped.plan_team_id,
    'plan_team_name', grouped.plan_team_name,
    'planned_on', grouped.planned_on,
    'devices', grouped.devices
  ) order by grouped.location_code, grouped.branch_name, grouped.branch_id), '[]'::jsonb)
  into branch_rows
  from (
    select
      branch.id as branch_id,
      branch.location_code,
      branch.loc_bld as branch_name,
      count(item.id)::integer as selected_assets,
      plan.source_row as plan_source_row,
      case when plan_team.is_active then plan_team.id end as plan_team_id,
      case when plan_team.is_active then plan_team.team_name end as plan_team_name,
      plan.planned_on,
      jsonb_agg(jsonb_build_object(
        'id', item.id,
        'asset_id', asset.id,
        'serial', asset.com_sn,
        'model', coalesce(nullif(asset.model_name, ''), nullif(asset.hw_name, ''), 'เครื่องสแกน')
      ) order by coalesce(nullif(asset.model_name, ''), nullif(asset.hw_name, ''), ''), asset.com_sn) as devices
    from app_private.campaign_items item
    join app_private.scanner_assets asset on asset.id = item.scanner_asset_id
    join app_private.branches branch on branch.id = asset.branch_id
    left join app_private.branch_work_plan_items plan
      on plan.branch_id = branch.id and plan.batch_id = latest_batch_id
    left join app_private.teams plan_team on plan_team.id = plan.team_id
    where item.campaign_id = p_campaign_id
    group by branch.id, branch.location_code, branch.loc_bld,
      plan.source_row, plan.planned_on, plan_team.id, plan_team.team_name, plan_team.is_active
  ) grouped;

  return jsonb_build_object(
    'campaign_id', p_campaign_id,
    'updated_at', campaign_updated_at,
    'campaign_code', campaign_code,
    'campaign_name', campaign_name,
    'start_on', campaign_start,
    'end_on', campaign_end,
    'selected_assets', selected_asset_count,
    'branches', branch_rows
  );
end
$$;

create or replace function public.ais_update_campaign_selection(
  p_campaign_id uuid,
  p_expected_updated_at timestamptz,
  p_add_asset_ids uuid[],
  p_remove_asset_ids uuid[],
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  reason_text text := nullif(regexp_replace(p_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  change_ids uuid[];
  campaign_status app_private.campaign_state;
  campaign_updated_at timestamptz;
  final_count integer;
  removed_items jsonb;
begin
  if not exists (
    select 1 from app_private.user_access ua
    where ua.user_id = actor and ua.is_active and ua.role = 'planner'
  ) then
    raise exception 'Planner access required' using errcode = '42501';
  end if;
  if p_campaign_id is null or p_expected_updated_at is null or reason_text is null or length(reason_text) > 1000 then
    raise exception 'Campaign, current revision and a reason of 1 to 1000 characters are required' using errcode = '22023';
  end if;
  if p_add_asset_ids is null or p_remove_asset_ids is null
    or array_ndims(p_add_asset_ids) > 1 or array_ndims(p_remove_asset_ids) > 1
    or cardinality(p_add_asset_ids) > 500 or cardinality(p_remove_asset_ids) > 500 then
    raise exception 'Provide distinct scanner IDs to add or remove' using errcode = '22023';
  end if;
  change_ids := p_add_asset_ids || p_remove_asset_ids;
  if cardinality(change_ids) = 0
    or (select count(distinct id) from unnest(change_ids) ids(id)) <> cardinality(change_ids) then
    raise exception 'Provide distinct scanner IDs to add or remove' using errcode = '22023';
  end if;

  -- Scheduling locks this same row before creating tasks.
  select c.status, c.updated_at into campaign_status, campaign_updated_at
  from app_private.campaigns c where c.id = p_campaign_id for update;
  if not found then
    raise exception 'Campaign does not exist' using errcode = '22023';
  end if;
  if campaign_updated_at <> p_expected_updated_at then
    raise exception 'Campaign changed since it was loaded; refresh before retrying' using errcode = '40001';
  end if;
  if campaign_status not in ('selection', 'ready_to_schedule') or exists (
    select 1 from app_private.replacement_tasks rt
    join app_private.campaign_items ci on ci.id = rt.campaign_item_id
    where ci.campaign_id = p_campaign_id
  ) then
    raise exception 'Only an unscheduled selection can be changed' using errcode = '22023';
  end if;

  -- Use the same row locks and UUID order as ais_create_campaign. Check other
  -- campaigns after acquiring them so a competing committed selection is visible.
  perform s.id from app_private.scanner_assets s
  where s.id = any(change_ids) order by s.id for update;
  if (select count(*) from app_private.scanner_assets s where s.id = any(change_ids)) <> cardinality(change_ids) then
    raise exception 'One or more selected assets do not exist' using errcode = '22023';
  end if;
  if exists (
    select 1 from app_private.campaign_items ci
    join app_private.campaigns c on c.id = ci.campaign_id
    where ci.scanner_asset_id = any(p_add_asset_ids) and c.status not in ('completed', 'cancelled')
  ) then
    raise exception 'A selected asset already belongs to an active campaign' using errcode = '23505';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'asset_id', ci.scanner_asset_id, 'previous_reason', ci.selection_reason,
    'selected_by', ci.created_by, 'selected_at', ci.created_at
  ) order by ci.scanner_asset_id), '[]'::jsonb)
  into removed_items
  from app_private.campaign_items ci
  where ci.campaign_id = p_campaign_id and ci.scanner_asset_id = any(p_remove_asset_ids);
  if jsonb_array_length(removed_items) <> cardinality(p_remove_asset_ids) then
    raise exception 'A scanner to remove does not belong to this campaign' using errcode = '22023';
  end if;
  select count(*) + cardinality(p_add_asset_ids) - cardinality(p_remove_asset_ids)
  into final_count from app_private.campaign_items ci where ci.campaign_id = p_campaign_id;
  if final_count not between 1 and 500 then
    raise exception 'Keep between 1 and 500 selected devices' using errcode = '22023';
  end if;

  delete from app_private.campaign_items
  where campaign_id = p_campaign_id and scanner_asset_id = any(p_remove_asset_ids);
  insert into app_private.campaign_items(campaign_id, scanner_asset_id, selection_reason, created_by)
  select p_campaign_id, id, reason_text, actor from unnest(p_add_asset_ids) ids(id);
  update app_private.campaigns
  set updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
  where id = p_campaign_id returning updated_at into campaign_updated_at;
  insert into app_private.audit_events(actor_id, event_type, entity_type, entity_id, summary)
  values (actor, 'campaign_selection_updated', 'campaign', p_campaign_id, jsonb_build_object(
    'added_asset_ids', p_add_asset_ids, 'removed_items', removed_items,
    'reason', reason_text, 'selected_assets', final_count, 'updated_at', campaign_updated_at
  ));
  return jsonb_build_object('campaign_id', p_campaign_id, 'updated_at', campaign_updated_at,
    'selected_assets', final_count, 'added_count', cardinality(p_add_asset_ids), 'removed_count', cardinality(p_remove_asset_ids));
end
$$;

revoke all on function public.ais_update_campaign_selection(uuid, timestamptz, uuid[], uuid[], text) from public, anon;
grant execute on function public.ais_update_campaign_selection(uuid, timestamptz, uuid[], uuid[], text) to authenticated;
comment on function public.ais_update_campaign_selection(uuid, timestamptz, uuid[], uuid[], text) is
  'Planner-only, revision-checked selection edit before scheduling. Preserves original selection details and records a reason for each change.';
