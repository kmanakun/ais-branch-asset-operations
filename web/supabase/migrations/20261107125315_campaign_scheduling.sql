create or replace function public.ais_list_active_teams()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  result jsonb;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;

  if actor is null or actor_role is null or actor_role not in ('admin', 'planner') then
    raise exception 'Planner access required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'team_name', t.team_name) order by t.team_name), '[]'::jsonb)
  into result
  from app_private.teams t
  where t.is_active;

  return result;
end
$$;

create or replace function public.ais_list_schedulable_campaigns()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  result jsonb;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;

  if actor is null or actor_role is null or actor_role not in ('admin', 'planner') then
    raise exception 'Planner access required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(row_data order by campaign_code), '[]'::jsonb)
  into result
  from (
    select jsonb_build_object(
      'id', c.id,
      'campaign_code', c.campaign_code,
      'campaign_name', c.campaign_name,
      'start_on', c.start_on,
      'end_on', c.end_on,
      'selected_assets', count(ci.id)
    ) as row_data, c.campaign_code
    from app_private.campaigns c
    join app_private.campaign_items ci on ci.campaign_id = c.id
    where c.status in ('selection', 'ready_to_schedule')
      and not exists (
        select 1
        from app_private.replacement_tasks rt
        join app_private.campaign_items existing_item on existing_item.id = rt.campaign_item_id
        where existing_item.campaign_id = c.id
      )
    group by c.id
  ) campaigns;

  return result;
end
$$;

create or replace function public.ais_schedule_campaign(
  p_campaign_id uuid,
  p_team_id uuid,
  p_scheduled_on date
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
  team_name text;
  asset_count integer;
  existing_task_count integer;
  scheduled_at timestamptz;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;

  if actor is null or actor_role is null or actor_role not in ('admin', 'planner') then
    raise exception 'Planner access required' using errcode = '42501';
  end if;

  if p_campaign_id is null or p_team_id is null or p_scheduled_on is null
    or p_scheduled_on < (now() at time zone 'Asia/Bangkok')::date then
    raise exception 'Campaign, active team and a non-past date are required' using errcode = '22023';
  end if;

  select c.status, c.start_on, c.end_on
  into campaign_status, campaign_start, campaign_end
  from app_private.campaigns c
  where c.id = p_campaign_id
  for update;

  if campaign_status is null then
    raise exception 'Campaign does not exist' using errcode = '22023';
  end if;
  if campaign_status not in ('selection', 'ready_to_schedule') then
    raise exception 'Campaign is not ready to schedule' using errcode = '22023';
  end if;
  if (campaign_start is not null and p_scheduled_on < campaign_start)
    or (campaign_end is not null and p_scheduled_on > campaign_end) then
    raise exception 'Scheduled date must be inside the campaign date range' using errcode = '22023';
  end if;

  select t.team_name into team_name
  from app_private.teams t
  where t.id = p_team_id and t.is_active
  for share;

  if team_name is null then
    raise exception 'Active team does not exist' using errcode = '22023';
  end if;

  select count(*)::integer into asset_count
  from app_private.campaign_items ci
  where ci.campaign_id = p_campaign_id;

  select count(*)::integer into existing_task_count
  from app_private.replacement_tasks rt
  join app_private.campaign_items ci on ci.id = rt.campaign_item_id
  where ci.campaign_id = p_campaign_id;

  if asset_count not between 1 and 500 then
    raise exception 'Campaign must contain between 1 and 500 selected devices' using errcode = '22023';
  end if;
  if existing_task_count > 0 then
    raise exception 'Campaign already has scheduled tasks' using errcode = '23505';
  end if;

  scheduled_at := (p_scheduled_on + time '09:00') at time zone 'Asia/Bangkok';

  insert into app_private.replacement_tasks(campaign_item_id, team_id, scheduled_for, status)
  select ci.id, p_team_id, scheduled_at, 'scheduled'
  from app_private.campaign_items ci
  where ci.campaign_id = p_campaign_id;

  update app_private.campaigns
  set status = 'scheduled', updated_at = now()
  where id = p_campaign_id;

  insert into app_private.audit_events(actor_id, event_type, entity_type, entity_id, summary)
  values(actor, 'campaign_scheduled', 'campaign', p_campaign_id, jsonb_build_object(
    'team_id', p_team_id,
    'team_name', team_name,
    'scheduled_on', p_scheduled_on,
    'task_count', asset_count
  ));

  return jsonb_build_object(
    'campaign_id', p_campaign_id,
    'team_id', p_team_id,
    'team_name', team_name,
    'scheduled_on', p_scheduled_on,
    'task_count', asset_count
  );
end
$$;

revoke all on function public.ais_list_active_teams() from public, anon;
revoke all on function public.ais_list_schedulable_campaigns() from public, anon;
revoke all on function public.ais_schedule_campaign(uuid, uuid, date) from public, anon;
grant execute on function public.ais_list_active_teams() to authenticated;
grant execute on function public.ais_list_schedulable_campaigns() to authenticated;
grant execute on function public.ais_schedule_campaign(uuid, uuid, date) to authenticated;

comment on function public.ais_schedule_campaign(uuid, uuid, date) is
  'Active Admin/Planner only; atomically assigns every selected campaign item to one active team and Bangkok work date, advances campaign state and records an audit event.';
