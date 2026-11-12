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
    campaign.end_on, campaign.status
  into campaign_code, campaign_name, campaign_start, campaign_end, campaign_status
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
    'campaign_code', campaign_code,
    'campaign_name', campaign_name,
    'start_on', campaign_start,
    'end_on', campaign_end,
    'selected_assets', selected_asset_count,
    'branches', branch_rows
  );
end
$$;

create or replace function public.ais_schedule_campaign_by_branch(
  p_campaign_id uuid,
  p_branch_assignments jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  campaign_status app_private.campaign_state;
  campaign_start date;
  campaign_end date;
  asset_count integer;
  branch_count integer;
  assignment_count integer;
  distinct_assignment_count integer;
  scheduled_today date := (now() at time zone 'Asia/Bangkok')::date;
  inserted_count integer;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;

  if actor is null or actor_role is null or actor_role not in ('admin', 'planner') then
    raise exception 'Planner access required' using errcode = '42501';
  end if;

  if p_campaign_id is null or p_branch_assignments is null
    or jsonb_typeof(p_branch_assignments) <> 'array'
    or jsonb_array_length(p_branch_assignments) not between 1 and 500 then
    raise exception 'Campaign and 1 to 500 branch assignments are required' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_branch_assignments) assignment(value)
    where jsonb_typeof(assignment.value) <> 'object'
      or coalesce(assignment.value ->> 'branch_id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      or coalesce(assignment.value ->> 'team_id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      or coalesce(assignment.value ->> 'scheduled_on', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  ) then
    raise exception 'Each branch requires a valid team and work date' using errcode = '22023';
  end if;

  select campaign.status, campaign.start_on, campaign.end_on
  into campaign_status, campaign_start, campaign_end
  from app_private.campaigns campaign
  where campaign.id = p_campaign_id
  for update;

  if campaign_status is null then
    raise exception 'Campaign does not exist' using errcode = '22023';
  end if;
  if campaign_status not in ('selection', 'ready_to_schedule') then
    raise exception 'Campaign is not ready to schedule' using errcode = '22023';
  end if;

  select count(*)::integer, count(distinct branch.id)::integer
  into asset_count, branch_count
  from app_private.campaign_items item
  join app_private.scanner_assets asset on asset.id = item.scanner_asset_id
  join app_private.branches branch on branch.id = asset.branch_id
  where item.campaign_id = p_campaign_id;

  if asset_count not between 1 and 500 then
    raise exception 'Campaign must contain between 1 and 500 selected devices' using errcode = '22023';
  end if;

  if exists (
    select 1 from app_private.replacement_tasks task
    join app_private.campaign_items item on item.id = task.campaign_item_id
    where item.campaign_id = p_campaign_id
  ) then
    raise exception 'Campaign already has scheduled tasks' using errcode = '23505';
  end if;

  select count(*)::integer, count(distinct assignment.branch_id)::integer
  into assignment_count, distinct_assignment_count
  from jsonb_to_recordset(p_branch_assignments) as assignment(
    branch_id uuid, team_id uuid, scheduled_on date
  );

  if assignment_count <> distinct_assignment_count then
    raise exception 'Each branch must have exactly one team/date assignment' using errcode = '22023';
  end if;

  if assignment_count <> branch_count
    or exists (
      select branch.id
      from app_private.campaign_items item
      join app_private.scanner_assets asset on asset.id = item.scanner_asset_id
      join app_private.branches branch on branch.id = asset.branch_id
      where item.campaign_id = p_campaign_id
      group by branch.id
      except
      select assignment.branch_id
      from jsonb_to_recordset(p_branch_assignments) as assignment(
        branch_id uuid, team_id uuid, scheduled_on date
      )
    )
    or exists (
      select assignment.branch_id
      from jsonb_to_recordset(p_branch_assignments) as assignment(
        branch_id uuid, team_id uuid, scheduled_on date
      )
      except
      select branch.id
      from app_private.campaign_items item
      join app_private.scanner_assets asset on asset.id = item.scanner_asset_id
      join app_private.branches branch on branch.id = asset.branch_id
      where item.campaign_id = p_campaign_id
      group by branch.id
    ) then
    raise exception 'Branch assignments must cover each selected branch exactly once' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_branch_assignments) as assignment(
      branch_id uuid, team_id uuid, scheduled_on date
    )
    where assignment.scheduled_on < scheduled_today
      or (campaign_start is not null and assignment.scheduled_on < campaign_start)
      or (campaign_end is not null and assignment.scheduled_on > campaign_end)
  ) then
    raise exception 'Each work date must be current or future and inside the campaign date range' using errcode = '22023';
  end if;

  perform team.id
  from app_private.teams team
  join (
    select distinct assignment.team_id
    from jsonb_to_recordset(p_branch_assignments) as assignment(
      branch_id uuid, team_id uuid, scheduled_on date
    )
  ) selected_team on selected_team.team_id = team.id
  where team.is_active
  order by team.id
  for share of team;

  if exists (
    select 1
    from jsonb_to_recordset(p_branch_assignments) as assignment(
      branch_id uuid, team_id uuid, scheduled_on date
    )
    left join app_private.teams team on team.id = assignment.team_id and team.is_active
    where team.id is null
  ) then
    raise exception 'Each branch requires an active field team' using errcode = '22023';
  end if;

  insert into app_private.replacement_tasks(campaign_item_id, team_id, scheduled_for, status)
  select item.id, assignment.team_id,
    (assignment.scheduled_on + time '09:00') at time zone 'Asia/Bangkok',
    'scheduled'
  from app_private.campaign_items item
  join app_private.scanner_assets asset on asset.id = item.scanner_asset_id
  join jsonb_to_recordset(p_branch_assignments) as assignment(
    branch_id uuid, team_id uuid, scheduled_on date
  ) on assignment.branch_id = asset.branch_id
  where item.campaign_id = p_campaign_id;

  get diagnostics inserted_count = row_count;

  if inserted_count <> asset_count then
    raise exception 'Could not schedule every selected scanner' using errcode = '22023';
  end if;

  update app_private.campaigns
  set status = 'scheduled', updated_at = now()
  where id = p_campaign_id;

  insert into app_private.audit_events(actor_id, event_type, entity_type, entity_id, summary)
  values(actor, 'campaign_scheduled_by_branch', 'campaign', p_campaign_id, jsonb_build_object(
    'branch_count', branch_count,
    'task_count', asset_count,
    'assignments', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'branch_id', assignment.branch_id,
        'team_id', assignment.team_id,
        'team_name', team.team_name,
        'scheduled_on', assignment.scheduled_on
      ) order by branch.location_code, branch.loc_bld, branch.id), '[]'::jsonb)
      from jsonb_to_recordset(p_branch_assignments) as assignment(
        branch_id uuid, team_id uuid, scheduled_on date
      )
      join app_private.branches branch on branch.id = assignment.branch_id
      join app_private.teams team on team.id = assignment.team_id
    )
  ));

  return jsonb_build_object(
    'campaign_id', p_campaign_id,
    'branch_count', branch_count,
    'task_count', inserted_count
  );
end
$$;

revoke all on function public.ais_campaign_schedule_preview(uuid) from public, anon;
grant execute on function public.ais_campaign_schedule_preview(uuid) to authenticated;
revoke all on function public.ais_schedule_campaign_by_branch(uuid, jsonb) from public, anon;
grant execute on function public.ais_schedule_campaign_by_branch(uuid, jsonb) to authenticated;

comment on function public.ais_campaign_schedule_preview(uuid) is
  'Active Admin/Planner only; returns manually selected scanner targets grouped by exact branch, with optional branch-plan team/date suggestions.';
comment on function public.ais_schedule_campaign_by_branch(uuid, jsonb) is
  'Active Admin/Planner only; atomically schedules every manually selected scanner using one reviewed active team/date assignment per branch.';
