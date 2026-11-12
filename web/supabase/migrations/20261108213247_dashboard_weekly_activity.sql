create or replace function public.ais_dashboard()
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

  if actor is null or actor_role is null then
    raise exception 'Application access required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'totals', jsonb_build_object(
      'branches', (select count(*) from app_private.branches b where actor_role <> 'field_technician' or exists (
        select 1 from app_private.scanner_assets s
        join app_private.campaign_items ci on ci.scanner_asset_id = s.id
        join app_private.replacement_tasks rt on rt.campaign_item_id = ci.id
        join app_private.user_team_memberships utm on utm.team_id = rt.team_id and utm.user_id = actor
        where s.branch_id = b.id
      )),
      'scanners', (select count(*) from app_private.scanner_assets s where actor_role <> 'field_technician' or exists (
        select 1 from app_private.campaign_items ci
        join app_private.replacement_tasks rt on rt.campaign_item_id = ci.id
        join app_private.user_team_memberships utm on utm.team_id = rt.team_id and utm.user_id = actor
        where ci.scanner_asset_id = s.id
      )),
      'active_tasks', (select count(*) from app_private.replacement_tasks rt
        join app_private.campaign_items ci on ci.id = rt.campaign_item_id
        where rt.status in ('scheduled', 'in_progress', 'blocked')
          and (actor_role <> 'field_technician' or exists (
            select 1 from app_private.user_team_memberships utm where utm.team_id = rt.team_id and utm.user_id = actor
          ))),
      'completed_tasks', (select count(*) from app_private.replacement_tasks rt
        join app_private.campaign_items ci on ci.id = rt.campaign_item_id
        where rt.status = 'completed'
          and (actor_role <> 'field_technician' or exists (
            select 1 from app_private.user_team_memberships utm where utm.team_id = rt.team_id and utm.user_id = actor
          )))
    ),
    'campaigns', coalesce((
      select jsonb_agg(row_data order by created_at desc)
      from (
        select jsonb_build_object(
          'campaign_code', c.campaign_code,
          'campaign_name', c.campaign_name,
          'status', c.status::text,
          'total_tasks', count(rt.id),
          'done_tasks', count(rt.id) filter (where rt.status in ('completed', 'cancelled'))
        ) as row_data,
        c.created_at
        from app_private.campaigns c
        left join app_private.campaign_items ci on ci.campaign_id = c.id
        left join app_private.replacement_tasks rt
          on rt.campaign_item_id = ci.id
          and (actor_role <> 'field_technician' or exists (
            select 1 from app_private.user_team_memberships utm
            where utm.team_id = rt.team_id and utm.user_id = actor
          ))
        where actor_role <> 'field_technician' or exists (
          select 1
          from app_private.campaign_items ci2
          join app_private.replacement_tasks rt2 on rt2.campaign_item_id = ci2.id
          join app_private.user_team_memberships utm on utm.team_id = rt2.team_id and utm.user_id = actor
          where ci2.campaign_id = c.id
        )
        group by c.id
        order by c.created_at desc
        limit 5
      ) recent
    ), '[]'::jsonb),
    -- Group by Bangkok scheduled date; completed is a subset of scheduled.
    'weekly_activity', (
      select jsonb_agg(jsonb_build_object(
        'date', counts.day,
        'scheduled', counts.scheduled,
        'completed', counts.completed
      ) order by counts.day)
      from (
        select days.day, count(rt.id) as scheduled,
          count(rt.id) filter (where rt.status = 'completed') as completed
        from (
          select (now() at time zone 'Asia/Bangkok')::date - offset_days as day
          from generate_series(0, 6) as offsets(offset_days)
        ) days
        left join app_private.replacement_tasks rt
          on rt.scheduled_for >= (days.day::timestamp at time zone 'Asia/Bangkok')
          and rt.scheduled_for < ((days.day + 1)::timestamp at time zone 'Asia/Bangkok')
          and (actor_role <> 'field_technician' or exists (
            select 1 from app_private.user_team_memberships utm
            where utm.team_id = rt.team_id and utm.user_id = actor
          ))
        group by days.day
      ) counts
    ),
    'tasks', coalesce((
      select jsonb_agg(row_data order by scheduled_for nulls last)
      from (
        select jsonb_build_object(
          'id', rt.id,
          'branch_name', coalesce(nullif(b.loc_bld, ''), b.location_code),
          'location_code', b.location_code,
          'scanner_model', coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), 'เครื่องสแกน'),
          'com_sn', case when actor_role = 'viewer' then '••••••' || right(s.com_sn, 4) else s.com_sn end,
          'team_name', t.team_name,
          'scheduled_for', rt.scheduled_for,
          'task_status', rt.status::text
        ) as row_data,
        rt.scheduled_for
        from app_private.replacement_tasks rt
        join app_private.campaign_items ci on ci.id = rt.campaign_item_id
        join app_private.scanner_assets s on s.id = ci.scanner_asset_id
        join app_private.branches b on b.id = s.branch_id
        left join app_private.teams t on t.id = rt.team_id
        where actor_role <> 'field_technician' or exists (
          select 1 from app_private.user_team_memberships utm where utm.team_id = rt.team_id and utm.user_id = actor
        )
        order by rt.scheduled_for nulls last
        limit 6
      ) upcoming
    ), '[]'::jsonb)
  ) into result;

  return result;
end
$$;

