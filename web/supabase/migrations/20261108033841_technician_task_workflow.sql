create or replace function public.ais_list_tasks()
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

  select coalesce(jsonb_agg(row_data order by scheduled_for nulls last), '[]'::jsonb)
  into result
  from (
    select jsonb_build_object(
      'id', rt.id,
      'branch_name', coalesce(nullif(b.loc_bld, ''), b.location_code),
      'location_code', b.location_code,
      'scanner_model', coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), ''),
      'com_sn', case when actor_role = 'viewer' then '••••••' || right(s.com_sn, 4) else s.com_sn end,
      'team_name', t.team_name,
      'scheduled_for', rt.scheduled_for,
      'task_status', rt.status::text,
      'version', rt.version,
      'blocked_reason', case when actor_role = 'viewer' then null else rt.blocked_reason end,
      'new_serial', case when actor_role = 'viewer' and visit.new_serial is not null then '••••••' || right(visit.new_serial, 4) else visit.new_serial end,
      'old_serial_snapshot', case when actor_role = 'viewer' and visit.old_serial_snapshot is not null then '••••••' || right(visit.old_serial_snapshot, 4) else visit.old_serial_snapshot end,
      'install_result', visit.install_result,
      'old_scanner_status', visit.old_scanner_status::text,
      'old_scanner_note', case when actor_role = 'viewer' then null else visit.old_scanner_note end
    ) as row_data,
    rt.scheduled_for
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
    order by rt.scheduled_for nulls last
    limit 250
  ) tasks;

  return result;
end
$$;

create or replace function public.ais_field_task_action(
  p_task_id uuid,
  p_action text,
  p_expected_version integer,
  p_reason text default null,
  p_new_serial text default null,
  p_install_result text default null,
  p_old_scanner_status text default null,
  p_old_scanner_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  action_name text := lower(btrim(coalesce(p_action, '')));
  task_status app_private.task_state;
  task_resume_status app_private.task_state;
  task_version integer;
  scanner_asset_id uuid;
  old_serial text;
  reason_text text := nullif(btrim(coalesce(p_reason, '')), '');
  new_serial_text text := nullif(btrim(coalesce(p_new_serial, '')), '');
  install_result_text text := nullif(btrim(coalesce(p_install_result, '')), '');
  old_note_text text := nullif(btrim(coalesce(p_old_scanner_note, '')), '');
  old_status app_private.old_scanner_state;
  next_status app_private.task_state;
  next_version integer;
  visit_id uuid;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;

  if actor is null or actor_role is distinct from 'field_technician' then
    raise exception 'Field Technician access required' using errcode = '42501';
  end if;

  if p_task_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'Task and current version are required' using errcode = '22023';
  end if;
  if action_name not in ('start', 'block', 'resume', 'complete') then
    raise exception 'Unsupported task action' using errcode = '22023';
  end if;

  select rt.status, rt.resume_status, rt.version, s.id, s.com_sn
  into task_status, task_resume_status, task_version, scanner_asset_id, old_serial
  from app_private.replacement_tasks rt
  join app_private.campaign_items ci on ci.id = rt.campaign_item_id
  join app_private.scanner_assets s on s.id = ci.scanner_asset_id
  join app_private.teams t on t.id = rt.team_id and t.is_active
  where rt.id = p_task_id
    and exists (
      select 1
      from app_private.user_team_memberships utm
      where utm.user_id = actor and utm.team_id = rt.team_id
    )
  for update of rt, s;

  if not found then
    raise exception 'Task does not exist or is outside your assigned team' using errcode = '42501';
  end if;

  if action_name = 'block' and (reason_text is null or length(reason_text) > 500) then
    raise exception 'A reason of 1 to 500 characters is required to block a task' using errcode = '22023';
  end if;

  if action_name = 'complete' then
    if new_serial_text is null or length(new_serial_text) > 100 then
      raise exception 'A new scanner serial of 1 to 100 characters is required' using errcode = '22023';
    end if;
    if install_result_text is null or length(install_result_text) > 500 then
      raise exception 'An installation result of 1 to 500 characters is required' using errcode = '22023';
    end if;
    if p_old_scanner_status is null or p_old_scanner_status not in (
      'returned_usable', 'returned_damaged', 'sent_for_repair', 'not_returned', 'lost', 'other'
    ) then
      raise exception 'A valid old scanner status is required' using errcode = '22023';
    end if;
    old_status := p_old_scanner_status::app_private.old_scanner_state;
    if old_status = 'other' and (old_note_text is null or length(old_note_text) > 1000) then
      raise exception 'A note of 1 to 1000 characters is required for other status' using errcode = '22023';
    end if;
    if old_status <> 'other' and old_note_text is not null and length(old_note_text) > 1000 then
      raise exception 'The old scanner note cannot exceed 1000 characters' using errcode = '22023';
    end if;
    if lower(new_serial_text) = lower(old_serial) then
      raise exception 'The replacement serial must differ from the old scanner serial' using errcode = '22023';
    end if;
  end if;

  -- A retry after a lost response must not create a second field visit.
  if action_name = 'complete' and task_status = 'completed' and p_expected_version < task_version and exists (
    select 1
    from app_private.field_visits fv
    where fv.task_id = p_task_id
      and fv.performed_by = actor
      and lower(btrim(fv.new_serial)) = lower(new_serial_text)
      and fv.install_result = install_result_text
      and fv.old_scanner_status = old_status
      and fv.old_scanner_note is not distinct from old_note_text
  ) then
    return jsonb_build_object('task_id', p_task_id, 'status', 'completed', 'version', task_version, 'replayed', true);
  end if;

  if task_version <> p_expected_version then
    raise exception 'Task changed since it was loaded; refresh before retrying' using errcode = '40001';
  end if;

  if action_name = 'start' then
    if task_status <> 'scheduled' then
      raise exception 'Only a scheduled task can be started' using errcode = '22023';
    end if;
    next_status := 'in_progress';
    update app_private.replacement_tasks
    set status = next_status, resume_status = null, blocked_reason = null,
        version = version + 1, updated_at = clock_timestamp()
    where id = p_task_id and version = p_expected_version
    returning version into next_version;
  elsif action_name = 'block' then
    if task_status not in ('scheduled', 'in_progress') then
      raise exception 'Only scheduled or active tasks can be blocked' using errcode = '22023';
    end if;
    next_status := 'blocked';
    update app_private.replacement_tasks
    set status = next_status, resume_status = task_status, blocked_reason = reason_text,
        version = version + 1, updated_at = clock_timestamp()
    where id = p_task_id and version = p_expected_version
    returning version into next_version;
  elsif action_name = 'resume' then
    if task_status <> 'blocked' or task_resume_status is null then
      raise exception 'Only a blocked task can be resumed' using errcode = '22023';
    end if;
    next_status := task_resume_status;
    update app_private.replacement_tasks
    set status = next_status, resume_status = null, blocked_reason = null,
        version = version + 1, updated_at = clock_timestamp()
    where id = p_task_id and version = p_expected_version
    returning version into next_version;
  else
    if task_status <> 'in_progress' then
      raise exception 'Start or resume the task before recording the result' using errcode = '22023';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower(new_serial_text), 0));
    if exists (
      select 1 from app_private.scanner_assets s
      where lower(btrim(s.com_sn)) = lower(new_serial_text) and s.id <> scanner_asset_id
    ) or exists (
      select 1 from app_private.field_visits fv
      where lower(btrim(fv.new_serial)) = lower(new_serial_text)
    ) then
      raise exception 'This replacement serial is already in use' using errcode = '23505';
    end if;

    insert into app_private.field_visits (
      task_id, old_serial_snapshot, new_serial, install_result,
      old_scanner_status, old_scanner_note, performed_by
    ) values (
      p_task_id, old_serial, new_serial_text, install_result_text,
      old_status, old_note_text, actor
    ) returning id into visit_id;

    update app_private.scanner_assets
    set com_sn = new_serial_text, updated_at = clock_timestamp()
    where id = scanner_asset_id;

    next_status := 'completed';
    update app_private.replacement_tasks
    set status = next_status, resume_status = null, blocked_reason = null,
        version = version + 1, updated_at = clock_timestamp()
    where id = p_task_id and version = p_expected_version
    returning version into next_version;
  end if;

  insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
  values (
    actor,
    case action_name when 'start' then 'task_started' when 'block' then 'task_blocked' when 'resume' then 'task_resumed' else 'task_completed' end,
    'replacement_task',
    p_task_id,
    jsonb_build_object('from_status', task_status::text, 'to_status', next_status::text, 'version', next_version)
  );

  return jsonb_build_object(
    'task_id', p_task_id,
    'status', next_status::text,
    'version', next_version,
    'field_visit_id', visit_id,
    'replayed', false
  );
end
$$;

revoke all on function public.ais_list_tasks() from public, anon;
revoke all on function public.ais_field_task_action(uuid, text, integer, text, text, text, text, text) from public, anon;
grant execute on function public.ais_list_tasks() to authenticated;
grant execute on function public.ais_field_task_action(uuid, text, integer, text, text, text, text, text) to authenticated;

comment on function public.ais_field_task_action(uuid, text, integer, text, text, text, text, text) is
  'Team-scoped field technician workflow for starting, blocking, resuming, and atomically completing one scanner task.';
