-- Work orders are live at creation. Branch inventory provided by the owner is
-- treated as verified; field staff report only actual outcomes and exceptions.

alter table app_private.replacement_tasks
  drop constraint if exists replacement_tasks_closeout_requires_confirmation;

-- Preserve existing states and timestamps. New branch work orders use
-- `scheduled` as Open until a technician explicitly starts an item.

do $check_serials$
declare duplicate_count integer;
begin
  select count(*)::integer into duplicate_count
  from (
    select lower(btrim(com_sn))
    from app_private.scanner_assets
    group by lower(btrim(com_sn))
    having count(*) > 1
  ) duplicates;
  if duplicate_count > 0 then
    raise exception 'Cannot enforce unique Scanner Serials: % normalized duplicate value(s) exist; resolve them before applying work-order changes', duplicate_count;
  end if;
end
$check_serials$;

create unique index if not exists scanner_assets_com_sn_normalized_unique
  on app_private.scanner_assets (lower(btrim(com_sn)));

create or replace function app_private.task_workflow_stage(
  p_status app_private.task_state,
  p_confirmed_at timestamptz,
  p_closeout_at timestamptz,
  p_admin_accepted_at timestamptz,
  p_outcome text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_status = 'cancelled' then 'cancelled'
    when p_admin_accepted_at is not null then 'delivered'
    when p_closeout_at is not null and p_outcome in ('no_damage_found', 'different_device_found', 'target_device_not_found') then 'awaiting_admin_exception_review'
    when p_closeout_at is not null then 'awaiting_admin_acceptance'
    when p_status = 'blocked' then 'blocked'
    when p_status = 'completed' then 'legacy_completed'
    when p_status = 'scheduled' then 'open'
    else p_status::text
  end;
$$;

revoke all on function app_private.task_workflow_stage(
  app_private.task_state, timestamptz, timestamptz, timestamptz, text
) from public, anon, authenticated;

-- Read-only worker discovery: every opened work order is visible to every
-- active onsite technician. Team and appointment metadata stay historical only.
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
  if status_filter not in ('all', 'in_progress', 'blocked', 'completed', 'cancelled',
    'awaiting_admin_acceptance', 'awaiting_admin_exception_review', 'delivered', 'legacy_completed') then
    raise exception 'Invalid task status filter' using errcode = '22023';
  end if;
  if search_term is not null and length(search_term) > 100 then
    raise exception 'Task search is longer than the supported limit' using errcode = '22023';
  end if;

  with visible_tasks as materialized (
    select rt.id, rt.status, rt.created_at, rt.version, rt.blocked_reason,
      b.location_code, b.loc_bld, b.province,
      coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), '') as scanner_model,
      s.com_sn, rt.closeout_submitted_by, rt.closeout_submitted_at,
      rt.admin_accepted_at, visit.outcome, visit.observed_serial,
      visit.exception_reason, visit.new_serial, visit.old_serial_snapshot,
      visit.install_result, visit.old_scanner_status, visit.old_scanner_note,
      visit.performed_by, visit.performed_by_name, visit.performed_at,
      app_private.task_workflow_stage(rt.status, rt.technician_confirmed_at,
        rt.closeout_submitted_at, rt.admin_accepted_at, visit.outcome) as workflow_stage,
      jsonb_build_object(
        'id', rt.id,
        'branch_name', coalesce(nullif(b.loc_bld, ''), b.location_code),
        'location_code', b.location_code,
        'province', b.province,
        'scanner_model', coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), ''),
        'com_sn', case when actor_role = 'viewer' and char_length(s.com_sn) > 4 then '••••••' || right(s.com_sn, 4) when actor_role = 'viewer' then '••••••' else s.com_sn end,
        'team_name', null,
        'scheduled_for', null,
        'created_at', rt.created_at,
        'task_status', rt.status::text,
        'workflow_stage', app_private.task_workflow_stage(rt.status, rt.technician_confirmed_at,
          rt.closeout_submitted_at, rt.admin_accepted_at, visit.outcome),
        'workflow_outcome', visit.outcome,
        'version', rt.version,
        'blocked_reason', case when actor_role = 'viewer' then null else rt.blocked_reason end,
        'new_serial', case when actor_role = 'viewer' and visit.new_serial is not null then '••••••' || right(visit.new_serial, 4) else visit.new_serial end,
        'old_serial_snapshot', case when actor_role = 'viewer' and visit.old_serial_snapshot is not null then '••••••' || right(visit.old_serial_snapshot, 4) else visit.old_serial_snapshot end,
        'install_result', visit.install_result,
        'old_scanner_status', visit.old_scanner_status,
        'old_scanner_note', case when actor_role = 'viewer' then null else visit.old_scanner_note end,
        'observed_serial', case when actor_role = 'viewer' and visit.observed_serial is not null then '••••••' || right(visit.observed_serial, 4) else visit.observed_serial end,
        'exception_reason', case when actor_role = 'viewer' then null else visit.exception_reason end,
        'performed_by_name', case when actor_role = 'viewer' then null else visit.performed_by_name end,
        'performed_at', visit.performed_at,
        'can_admin_accept', actor_role = 'admin'
          and rt.closeout_submitted_at is not null and rt.admin_accepted_at is null
          and actor is distinct from rt.closeout_submitted_by
          and actor is distinct from visit.performed_by
      ) as row_data
    from app_private.replacement_tasks rt
    join app_private.campaign_items ci on ci.id = rt.campaign_item_id
    join app_private.scanner_assets s on s.id = ci.scanner_asset_id
    join app_private.branches b on b.id = s.branch_id
    left join lateral (
      select fv.outcome, fv.observed_serial, fv.exception_reason, fv.new_serial,
        fv.old_serial_snapshot, fv.install_result, fv.old_scanner_status::text as old_scanner_status,
        fv.old_scanner_note, fv.performed_by, ua.display_name as performed_by_name, fv.performed_at
      from app_private.field_visits fv
      left join app_private.user_access ua on ua.user_id = fv.performed_by
      where fv.task_id = rt.id
      order by fv.performed_at desc, fv.created_at desc, fv.id desc
      limit 1
    ) visit on true
  ), matching_tasks as materialized (
    select visible_tasks.* from visible_tasks
    where search_term is null
      or position(lower(search_term) in lower(coalesce(location_code, ''))) > 0
      or position(lower(search_term) in lower(coalesce(loc_bld, ''))) > 0
      or position(lower(search_term) in lower(coalesce(province, ''))) > 0
      or position(lower(search_term) in lower(coalesce(scanner_model, ''))) > 0
      or (actor_role <> 'viewer' and position(lower(search_term) in lower(coalesce(com_sn, ''))) > 0)
  ), filtered_tasks as materialized (
    select matching_tasks.* from matching_tasks
    where status_filter = 'all' or status::text = status_filter or workflow_stage = status_filter
  ), task_page as (
    select id, created_at, row_data from filtered_tasks
    order by created_at desc, id
    limit p_limit offset p_offset
  ), status_counts as (
    select count(*)::integer as total,
      0::integer as scheduled,
      count(*) filter (where workflow_stage = 'in_progress')::integer as in_progress,
      count(*) filter (where workflow_stage in ('awaiting_admin_acceptance', 'awaiting_admin_exception_review'))::integer as awaiting_review,
      count(*) filter (where status = 'blocked')::integer as blocked,
      count(*) filter (where workflow_stage in ('delivered', 'legacy_completed'))::integer as completed,
      count(*) filter (where status = 'cancelled')::integer as cancelled
    from matching_tasks
  ), filtered_count as (
    select count(*)::integer as total from filtered_tasks
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(row_data order by created_at desc, id) from task_page), '[]'::jsonb),
    'total', filtered_count.total,
    'counts', jsonb_build_object('scheduled', status_counts.scheduled,
      'in_progress', status_counts.in_progress, 'awaiting_review', status_counts.awaiting_review, 'blocked', status_counts.blocked,
      'completed', status_counts.completed, 'cancelled', status_counts.cancelled)
  ) into result
  from status_counts cross join filtered_count;
  return result;
end
$$;

revoke all on function public.ais_task_filtered_page(text, text, integer, integer) from public, anon;
grant execute on function public.ais_task_filtered_page(text, text, integer, integer) to authenticated;

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
  reason_text text := nullif(btrim(coalesce(p_reason, '')), '');
  next_version integer;
  next_status app_private.task_state;
begin
  select ua.role into actor_role from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role not in ('admin', 'field_technician') then
    raise exception 'Active Admin or Field Technician access required' using errcode = '42501';
  end if;
  if p_task_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'Task and current version are required' using errcode = '22023';
  end if;
  if action_name not in ('start', 'block', 'resume') then
    raise exception 'Unsupported field action' using errcode = '22023';
  end if;
  select rt.status, rt.resume_status, rt.version into task_status, task_resume_status, task_version
  from app_private.replacement_tasks rt where rt.id = p_task_id for update;
  if not found then raise exception 'Work order was not found' using errcode = 'P0002'; end if;
  if task_version <> p_expected_version then
    raise exception 'Task changed since it was loaded; refresh before retrying' using errcode = '40001';
  end if;
  if action_name = 'start' then
    if task_status <> 'scheduled' then
      raise exception 'Only an Open work item can be started' using errcode = '22023';
    end if;
    next_status := 'in_progress';
    update app_private.replacement_tasks
      set status = 'in_progress', resume_status = null, blocked_reason = null,
          version = version + 1, updated_at = clock_timestamp()
      where id = p_task_id and version = p_expected_version returning version into next_version;
  elsif action_name = 'block' then
    if task_status <> 'in_progress' or reason_text is null or length(reason_text) > 500 then
      raise exception 'A reason of 1 to 500 characters is required to pause an active task' using errcode = '22023';
    end if;
    next_status := 'blocked';
    update app_private.replacement_tasks
      set status = 'blocked', resume_status = 'in_progress', blocked_reason = reason_text,
          version = version + 1, updated_at = clock_timestamp()
      where id = p_task_id and version = p_expected_version returning version into next_version;
  else
    if task_status <> 'blocked' then raise exception 'Only a paused task can be resumed' using errcode = '22023'; end if;
    next_status := 'in_progress';
    update app_private.replacement_tasks
      set status = 'in_progress', resume_status = null, blocked_reason = null,
          version = version + 1, updated_at = clock_timestamp()
      where id = p_task_id and version = p_expected_version returning version into next_version;
  end if;
  insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
  values (actor, case action_name when 'start' then 'task_started' when 'block' then 'task_blocked' else 'task_resumed' end,
    'replacement_task', p_task_id,
    jsonb_build_object('from_status', task_status::text, 'to_status', next_status::text, 'version', next_version));
  return jsonb_build_object('task_id', p_task_id, 'status', next_status::text, 'version', next_version);
end
$$;

revoke all on function public.ais_field_task_action(uuid, text, integer, text, text, text, text, text) from public, anon;
grant execute on function public.ais_field_task_action(uuid, text, integer, text, text, text, text, text) to authenticated;

create or replace function public.ais_open_campaign_work_orders(p_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  campaign_status app_private.campaign_state;
  selected_count integer;
  existing_count integer;
  opened_count integer;
begin
  select ua.role into actor_role from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role is distinct from 'admin' then
    raise exception 'Active Admin access required to open work orders' using errcode = '42501';
  end if;
  if p_campaign_id is null then raise exception 'A campaign is required' using errcode = '22023'; end if;
  select c.status into campaign_status from app_private.campaigns c
  where c.id = p_campaign_id for update;
  if not found then raise exception 'Campaign was not found' using errcode = 'P0002'; end if;
  if campaign_status in ('blocked', 'cancelled', 'completed') then
    raise exception 'This campaign cannot open new work orders' using errcode = '55000';
  end if;
  select count(*)::integer into selected_count
  from app_private.campaign_items ci where ci.campaign_id = p_campaign_id;
  if selected_count not between 1 and 500 then
    raise exception 'Select between 1 and 500 verified scanners first' using errcode = '22023';
  end if;
  select count(*)::integer into existing_count
  from app_private.campaign_items ci
  join app_private.replacement_tasks rt on rt.campaign_item_id = ci.id
  where ci.campaign_id = p_campaign_id;
  if existing_count > 0 and existing_count < selected_count then
    raise exception 'Campaign has a partial work-order set; review the existing records before proceeding' using errcode = '55000';
  end if;
  if existing_count = selected_count then
    update app_private.replacement_tasks rt
    set status = case when rt.status = 'scheduled' then 'in_progress'::app_private.task_state else rt.status end,
        resume_status = case when rt.status = 'scheduled' then null else rt.resume_status end,
        version = case when rt.status = 'scheduled' then rt.version + 1 else rt.version end,
        updated_at = case when rt.status = 'scheduled' then clock_timestamp() else rt.updated_at end
    from app_private.campaign_items ci
    where ci.campaign_id = p_campaign_id and rt.campaign_item_id = ci.id and rt.status = 'scheduled';
    opened_count := 0;
  else
    insert into app_private.replacement_tasks (campaign_item_id, team_id, scheduled_for, status)
    select ci.id, null, null, 'in_progress'::app_private.task_state
    from app_private.campaign_items ci
    where ci.campaign_id = p_campaign_id
    order by ci.created_at, ci.id;
    get diagnostics opened_count = row_count;
  end if;
  update app_private.campaigns set status = 'in_progress', updated_at = clock_timestamp()
  where id = p_campaign_id;
  insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
  values (actor, 'campaign_work_orders_opened', 'campaign', p_campaign_id,
    jsonb_build_object('selected_scanners', selected_count, 'opened_work_orders', opened_count,
      'start_time', clock_timestamp(), 'team_assignment', null, 'appointment_date', null));
  return jsonb_build_object('campaign_id', p_campaign_id, 'selected_scanners', selected_count,
    'opened_work_orders', opened_count, 'status', 'in_progress', 'already_opened', opened_count = 0);
end
$$;

revoke all on function public.ais_open_campaign_work_orders(uuid) from public, anon;
grant execute on function public.ais_open_campaign_work_orders(uuid) to authenticated;
revoke all on function public.ais_schedule_campaign_by_branch(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ais_schedule_campaign(uuid, uuid, date) from public, anon, authenticated;

-- Every opened task is readable to both operational roles; evidence remains
-- private, and a reviewer must be a different Admin from the field operator.
create or replace function app_private.can_edit_task_evidence(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1
    from app_private.user_access ua
    join app_private.replacement_tasks rt on rt.id = p_task_id and rt.status = 'in_progress'
    where ua.user_id = auth.uid() and ua.is_active
      and ua.role in ('admin', 'field_technician')
      and (
        rt.closeout_submitted_at is null
        or (ua.role = 'admin'
          and auth.uid() is distinct from rt.closeout_submitted_by
          and not exists (
            select 1 from app_private.field_visits fv
            where fv.task_id = rt.id and fv.performed_by = auth.uid()
          ))
      )
  );
$$;

create or replace function app_private.can_view_task_evidence(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1
    from app_private.user_access ua
    join app_private.replacement_tasks rt on rt.id = p_task_id
    where ua.user_id = auth.uid() and ua.is_active
      and ua.role in ('admin', 'field_technician')
  );
$$;

revoke all on function app_private.can_edit_task_evidence(uuid) from public, anon, authenticated;
revoke all on function app_private.can_view_task_evidence(uuid) from public, anon, authenticated;
grant execute on function app_private.can_edit_task_evidence(uuid) to authenticated;
grant execute on function app_private.can_view_task_evidence(uuid) to authenticated;

-- Inspector signatures are reserved only by a different active Office Admin
-- after a field closeout has been submitted.
do $migration$
declare
  signature regprocedure := 'public.ais_task_evidence_reserve(uuid,text,integer,text,boolean)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
  anchor text := $anchor$  if slot_name not in (
    'old_serial_photo', 'new_serial_photo', 'old_device_photo', 'new_device_photo',
    'spare_photo_1', 'spare_photo_2',
    'technician_signature', 'scanner_user_signature', 'inspector_signature'
  ) then
    raise exception 'Unsupported task evidence slot' using errcode = '22023';
  end if;$anchor$;
  replacement text := $replacement$  if slot_name not in (
    'old_serial_photo', 'new_serial_photo', 'old_device_photo', 'new_device_photo',
    'spare_photo_1', 'spare_photo_2',
    'technician_signature', 'scanner_user_signature', 'inspector_signature'
  ) then
    raise exception 'Unsupported task evidence slot' using errcode = '22023';
  end if;
  if slot_name = 'inspector_signature' and (
    actor_role <> 'admin'
    or not exists (
      select 1
      from app_private.replacement_tasks rt
      join app_private.field_visits fv on fv.task_id = rt.id
      where rt.id = p_task_id and rt.closeout_submitted_at is not null
        and rt.admin_accepted_at is null
        and actor is distinct from rt.closeout_submitted_by
        and actor is distinct from fv.performed_by
    )
  ) then
    raise exception 'A different Office Admin must sign acceptance after field closeout' using errcode = '42501';
  end if;$replacement$;
begin
  if strpos(original_definition, anchor) = 0 then
    raise exception 'Could not locate evidence-slot validation in %', signature;
  end if;
  definition := replace(original_definition, anchor, replacement);
  execute definition;
end
$migration$;

create or replace function public.ais_technician_submit_closeout(
  p_task_id uuid,
  p_expected_version integer,
  p_outcome text,
  p_new_serial text default null,
  p_install_result text default null,
  p_old_scanner_status text default null,
  p_old_scanner_note text default null,
  p_observed_serial text default null,
  p_exception_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  task_status app_private.task_state;
  task_version integer;
  closeout_at timestamptz;
  scanner_asset_id uuid;
  old_serial text;
  campaign_id uuid;
  outcome_name text := lower(btrim(coalesce(p_outcome, '')));
  new_serial_text text := nullif(btrim(coalesce(p_new_serial, '')), '');
  install_text text := nullif(btrim(coalesce(p_install_result, '')), '');
  old_note text := nullif(btrim(coalesce(p_old_scanner_note, '')), '');
  observed_text text := nullif(btrim(coalesce(p_observed_serial, '')), '');
  exception_text text := nullif(btrim(coalesce(p_exception_reason, '')), '');
  old_status app_private.old_scanner_state;
  visit_id uuid;
  missing_slots text[];
begin
  select ua.role into actor_role
  from app_private.user_access ua where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role not in ('admin', 'field_technician') then
    raise exception 'Active Admin or Field Technician access required to submit closeout' using errcode = '42501';
  end if;
  if p_task_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'Task and current version are required' using errcode = '22023';
  end if;
  if outcome_name not in ('replaced', 'no_damage_found', 'different_device_found', 'target_device_not_found') then
    raise exception 'Choose a valid closeout result' using errcode = '22023';
  end if;
  if install_text is null or length(install_text) > 500 then
    raise exception 'A work result of 1 to 500 characters is required' using errcode = '22023';
  end if;

  select rt.status, rt.version, rt.closeout_submitted_at, s.id, s.com_sn, ci.campaign_id
  into task_status, task_version, closeout_at, scanner_asset_id, old_serial, campaign_id
  from app_private.replacement_tasks rt
  join app_private.campaign_items ci on ci.id = rt.campaign_item_id
  join app_private.scanner_assets s on s.id = ci.scanner_asset_id
  where rt.id = p_task_id
  for update of rt, s;
  if not found then raise exception 'Work order was not found' using errcode = 'P0002'; end if;
  if task_version <> p_expected_version then
    raise exception 'Task changed since it was loaded; refresh before retrying' using errcode = '40001';
  end if;
  if task_status <> 'in_progress' or closeout_at is not null then
    raise exception 'Only an open work order can be closed out' using errcode = '22023';
  end if;
  if not exists (select 1 from app_private.campaigns c where c.id = campaign_id and c.status not in ('blocked', 'cancelled')) then
    raise exception 'Campaign no longer accepts field work' using errcode = '55000';
  end if;

  if p_old_scanner_status is null or p_old_scanner_status not in (
    'returned_usable', 'returned_damaged', 'sent_for_repair', 'not_returned', 'lost', 'other'
  ) then
    raise exception 'A valid old scanner result is required' using errcode = '22023';
  end if;
  old_status := p_old_scanner_status::app_private.old_scanner_state;
  if old_note is not null and length(old_note) > 1000 then
    raise exception 'The old scanner note cannot exceed 1000 characters' using errcode = '22023';
  end if;

  if outcome_name = 'replaced' then
    if new_serial_text is null or length(new_serial_text) > 100 or lower(new_serial_text) = lower(old_serial) then
      raise exception 'Replacement Serial must be 1 to 100 characters and differ from the old Serial' using errcode = '22023';
    end if;
    if exception_text is not null or observed_text is not null then
      raise exception 'Replacement closeout cannot contain exception-only fields' using errcode = '22023';
    end if;
    if old_status = 'other' and old_note is null then
      raise exception 'Explain the old scanner result' using errcode = '22023';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower(new_serial_text), 0));
    if exists (select 1 from app_private.scanner_assets s where lower(btrim(s.com_sn)) = lower(new_serial_text) and s.id <> scanner_asset_id) then
      raise exception 'This replacement Serial is already in use' using errcode = '23505';
    end if;
  elsif outcome_name = 'no_damage_found' then
    if new_serial_text is not null or observed_text is not null or exception_text is null or length(exception_text) > 1000 then
      raise exception 'Explain why no damaged scanner was found; replacement Serial must stay empty' using errcode = '22023';
    end if;
    old_status := 'returned_usable';
  elsif outcome_name = 'different_device_found' then
    if new_serial_text is not null or observed_text is null or length(observed_text) > 100 or exception_text is null or length(exception_text) > 1000 then
      raise exception 'Record the Serial of the different device and explain the mismatch' using errcode = '22023';
    end if;
    old_status := 'other';
    old_note := exception_text;
  else
    if new_serial_text is not null or observed_text is not null or exception_text is null or length(exception_text) > 1000 then
      raise exception 'Explain why the target scanner was not found; replacement Serial must stay empty' using errcode = '22023';
    end if;
    old_status := 'not_returned';
    old_note := exception_text;
  end if;

  select pg_catalog.array_agg(required.slot order by required.slot) into missing_slots
  from pg_catalog.unnest(array[
    case when outcome_name in ('replaced', 'no_damage_found') then 'old_serial_photo' end,
    case when outcome_name in ('replaced', 'no_damage_found') then 'old_device_photo' end,
    case when outcome_name = 'replaced' then 'new_serial_photo' end,
    case when outcome_name = 'replaced' then 'new_device_photo' end,
    case when outcome_name = 'different_device_found' then 'new_serial_photo' end,
    case when outcome_name = 'different_device_found' then 'new_device_photo' end,
    case when outcome_name = 'target_device_not_found' then 'spare_photo_1' end,
    'technician_signature', 'scanner_user_signature'
  ]::text[]) as required(slot)
  left join app_private.replacement_task_evidence e
    on e.task_id = p_task_id and e.slot = required.slot and e.status = 'ready' and e.uploaded_by = actor
  left join storage.objects o on o.bucket_id = 'ais-task-evidence' and o.name = e.object_path
  where required.slot is not null and (e.task_id is null or o.id is null);
  if coalesce(pg_catalog.cardinality(missing_slots), 0) > 0 then
    raise exception 'Save the required work evidence and both field signatures first: %', pg_catalog.array_to_string(missing_slots, ', ')
      using errcode = '22023';
  end if;

  insert into app_private.field_visits (
    task_id, old_serial_snapshot, new_serial, install_result, old_scanner_status,
    old_scanner_note, performed_by, outcome, observed_serial, exception_reason
  ) values (
    p_task_id, old_serial, new_serial_text, install_text, old_status,
    old_note, actor, outcome_name, observed_text, exception_text
  ) returning id into visit_id;
  update app_private.replacement_tasks
  set closeout_submitted_at = clock_timestamp(), closeout_submitted_by = actor,
      version = version + 1, updated_at = clock_timestamp()
  where id = p_task_id and version = p_expected_version;
  insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
  values (actor, 'task_closeout_submitted', 'replacement_task', p_task_id,
    pg_catalog.jsonb_build_object('outcome', outcome_name, 'field_visit_id', visit_id));
  return pg_catalog.jsonb_build_object('task_id', p_task_id, 'field_visit_id', visit_id,
    'workflow_stage', case when outcome_name = 'replaced' then 'awaiting_admin_acceptance' else 'awaiting_admin_exception_review' end,
    'performed_by', actor, 'performed_at', clock_timestamp(), 'version', p_expected_version + 1);
end;
$$;

revoke all on function public.ais_technician_submit_closeout(uuid,integer,text,text,text,text,text,text,text) from public, anon;
grant execute on function public.ais_technician_submit_closeout(uuid,integer,text,text,text,text,text,text,text) to authenticated;

create or replace function public.ais_admin_accept_task(
  p_task_id uuid,
  p_expected_version integer,
  p_register_observed_serial boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  task_version integer;
  task_status app_private.task_state;
  campaign_id uuid;
  scanner_asset_id uuid;
  target_branch_id uuid;
  new_serial_text text;
  observed_serial_text text;
  outcome_name text;
  performed_by_id uuid;
  closeout_by_id uuid;
  visit_id uuid;
  registered_asset_id uuid;
  registered_branch_id uuid;
  next_version integer;
  did_register boolean := false;
begin
  select ua.role into actor_role from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role is distinct from 'admin' then
    raise exception 'Office Admin access required to accept work' using errcode = '42501';
  end if;
  if p_task_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'Task and current version are required' using errcode = '22023';
  end if;

  select rt.status, rt.version, ci.campaign_id, s.id, s.branch_id,
    fv.new_serial, fv.observed_serial, fv.outcome, fv.performed_by,
    rt.closeout_submitted_by, fv.id
  into task_status, task_version, campaign_id, scanner_asset_id, target_branch_id,
    new_serial_text, observed_serial_text, outcome_name, performed_by_id,
    closeout_by_id, visit_id
  from app_private.replacement_tasks rt
  join app_private.campaign_items ci on ci.id = rt.campaign_item_id
  join app_private.scanner_assets s on s.id = ci.scanner_asset_id
  join app_private.field_visits fv on fv.task_id = rt.id
  where rt.id = p_task_id
  for update of rt, s, fv;
  if not found then raise exception 'Closeout was not found for this work order' using errcode = 'P0002'; end if;
  if task_version <> p_expected_version then
    raise exception 'Task changed since it was loaded; refresh before retrying' using errcode = '40001';
  end if;
  if task_status <> 'in_progress'
    or not exists (select 1 from app_private.replacement_tasks rt where rt.id = p_task_id and rt.closeout_submitted_at is not null and rt.admin_accepted_at is null) then
    raise exception 'This task is not waiting for Admin acceptance' using errcode = '22023';
  end if;
  if actor is not distinct from performed_by_id or actor is not distinct from closeout_by_id then
    raise exception 'The Admin who performed this work cannot accept their own work; another Admin must review it' using errcode = '42501';
  end if;
  if exists (select 1 from app_private.campaigns c where c.id = campaign_id and c.status in ('blocked', 'cancelled')) then
    raise exception 'Unblock the campaign before accepting work' using errcode = '55000';
  end if;
  if not exists (
    select 1 from app_private.replacement_task_evidence e
    join storage.objects o on o.bucket_id = 'ais-task-evidence' and o.name = e.object_path
    where e.task_id = p_task_id and e.slot = 'inspector_signature' and e.status = 'ready'
      and e.uploaded_by = actor and e.signer_name is not null
  ) then
    raise exception 'A different Office Admin must save the acceptance signature' using errcode = '22023';
  end if;

  if p_register_observed_serial then
    if outcome_name <> 'different_device_found' or observed_serial_text is null or length(btrim(observed_serial_text)) not between 1 and 100 then
      raise exception 'Only a verified different-device Serial can be added to the branch register' using errcode = '22023';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower(btrim(observed_serial_text)), 0));
    select asset.id, asset.branch_id into registered_asset_id, registered_branch_id
    from app_private.scanner_assets asset
    where lower(btrim(asset.com_sn)) = lower(btrim(observed_serial_text))
    for update;
    if found and registered_branch_id is distinct from target_branch_id then
      raise exception 'This Serial is already registered to another branch; resolve its existing record before acceptance' using errcode = '23505';
    elsif not found then
      insert into app_private.scanner_assets (branch_id, com_sn)
      values (target_branch_id, btrim(observed_serial_text))
      returning id into registered_asset_id;
      did_register := true;
      insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
      values (actor, 'scanner_registered_from_work_order_review', 'scanner_asset', registered_asset_id,
        pg_catalog.jsonb_build_object('task_id', p_task_id, 'branch_id', target_branch_id,
          'serial', btrim(observed_serial_text), 'source', 'admin_reviewed_different_device'));
    end if;
  end if;

  if outcome_name = 'replaced' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower(btrim(new_serial_text)), 0));
    if exists (select 1 from app_private.scanner_assets s where lower(btrim(s.com_sn)) = lower(btrim(new_serial_text)) and s.id <> scanner_asset_id) then
      raise exception 'This replacement Serial is already in use' using errcode = '23505';
    end if;
    update app_private.scanner_assets set com_sn = btrim(new_serial_text), updated_at = clock_timestamp()
    where id = scanner_asset_id;
  elsif p_register_observed_serial and outcome_name <> 'different_device_found' then
    raise exception 'A found Serial can be registered only for a different-device outcome' using errcode = '22023';
  end if;

  update app_private.replacement_tasks
  set status = 'completed', resume_status = null, blocked_reason = null,
      admin_accepted_at = clock_timestamp(), admin_accepted_by = actor,
      version = version + 1, updated_at = clock_timestamp()
  where id = p_task_id and version = p_expected_version
  returning version into next_version;
  insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
  values (actor, 'task_admin_accepted', 'replacement_task', p_task_id,
    pg_catalog.jsonb_build_object('outcome', outcome_name, 'field_visit_id', visit_id,
      'observed_serial_registered', did_register, 'registered_asset_id', registered_asset_id));
  update app_private.campaigns c
  set status = 'completed', updated_at = clock_timestamp()
  where c.id = campaign_id and c.status in ('scheduled', 'in_progress', 'blocked')
    and not exists (
      select 1 from app_private.campaign_items ci
      left join app_private.replacement_tasks rt on rt.campaign_item_id = ci.id
      where ci.campaign_id = c.id and (rt.id is null or rt.status not in ('completed', 'cancelled'))
    );
  return pg_catalog.jsonb_build_object('task_id', p_task_id, 'status', 'completed',
    'workflow_stage', 'delivered', 'observed_serial_registered', did_register, 'version', next_version);
end;
$$;

create or replace function public.ais_admin_accept_task(p_task_id uuid, p_expected_version integer)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.ais_admin_accept_task(p_task_id, p_expected_version, false);
$$;

revoke all on function public.ais_admin_accept_task(uuid, integer, boolean) from public, anon;
revoke all on function public.ais_admin_accept_task(uuid, integer) from public, anon;
grant execute on function public.ais_admin_accept_task(uuid, integer, boolean) to authenticated;
grant execute on function public.ais_admin_accept_task(uuid, integer) to authenticated;

-- The work-order creation timestamp is the start of the process. Historical
-- team assignments and planned dates are not access controls or workflow data.
create or replace function public.ais_branch_provinces()
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
  select ua.role into actor_role from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role not in ('admin', 'field_technician') then
    raise exception 'Active application access required' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(province order by province), '[]'::jsonb)
  into result from (
    select distinct nullif(btrim(b.province), '') as province
    from app_private.branches b
    where nullif(btrim(b.province), '') is not null
  ) provinces;
  return result;
end
$$;

create or replace function public.ais_scanner_page(
  p_search text default null,
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
  search_term text := nullif(btrim(p_search), '');
  result jsonb;
begin
  select ua.role into actor_role from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role not in ('admin', 'field_technician') then
    raise exception 'Active application access required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 200
    or p_offset is null or p_offset not between 0 and 100000
    or length(coalesce(search_term, '')) > 100 then
    raise exception 'Invalid scanner search or pagination request' using errcode = '22023';
  end if;
  with filtered as materialized (
    select s.id, b.location_code, b.loc_bld as branch_name, b.province,
      coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), '') as model_name,
      s.brand,
      case when actor_role = 'viewer' and char_length(s.com_sn) > 4
        then '••••••' || right(s.com_sn, 4)
        when actor_role = 'viewer' then '••••••' else s.com_sn end as com_sn,
      s.com_years, latest.campaign_code as campaign, latest.task_status as status
    from app_private.scanner_assets s
    join app_private.branches b on b.id = s.branch_id
    left join lateral (
      select c.campaign_code, rt.status::text as task_status
      from app_private.campaign_items ci
      join app_private.campaigns c on c.id = ci.campaign_id
      left join app_private.replacement_tasks rt on rt.campaign_item_id = ci.id
      where ci.scanner_asset_id = s.id
      order by ci.created_at desc, ci.id desc
      limit 1
    ) latest on true
    where search_term is null
      or b.location_code ilike '%' || search_term || '%'
      or b.loc_bld ilike '%' || search_term || '%'
      or b.province ilike '%' || search_term || '%'
      or b.district ilike '%' || search_term || '%'
      or b.subdistrict ilike '%' || search_term || '%'
      or b.high_level_location ilike '%' || search_term || '%'
      or b.ro ilike '%' || search_term || '%'
      or s.model_name ilike '%' || search_term || '%'
      or (actor_role <> 'viewer' and s.com_sn ilike '%' || search_term || '%')
  ), page as (
    select * from filtered
    order by lower(coalesce(province, '')), location_code, branch_name, model_name, id
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'rows', coalesce((select jsonb_agg(to_jsonb(page) order by lower(coalesce(province, '')), location_code, branch_name, model_name, id) from page), '[]'::jsonb)
  ) into result;
  return result;
end
$$;

create or replace function public.ais_list_scanners(p_search text default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(result.data -> 'rows', '[]'::jsonb)
  from (select public.ais_scanner_page(p_search, 200, 0) as data) result;
$$;

revoke all on function public.ais_branch_provinces() from public, anon;
revoke all on function public.ais_scanner_page(text, integer, integer) from public, anon;
revoke all on function public.ais_list_scanners(text) from public, anon;
grant execute on function public.ais_branch_provinces() to authenticated;
grant execute on function public.ais_scanner_page(text, integer, integer) to authenticated;
grant execute on function public.ais_list_scanners(text) to authenticated;

create or replace function public.ais_list_campaigns(p_search text default null)
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
  result jsonb;
begin
  select ua.role into actor_role from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role not in ('admin', 'field_technician') then
    raise exception 'Active application access required' using errcode = '42501';
  end if;
  if length(coalesce(search_term, '')) > 100 then
    raise exception 'Campaign search is too long' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(row_data order by campaign_code), '[]'::jsonb)
  into result
  from (
    select jsonb_build_object(
      'id', c.id,
      'branches', count(distinct s.branch_id),
      'total_assets', count(distinct ci.id),
      'campaign_code', c.campaign_code,
      'campaign_name', c.campaign_name,
      'status', c.status::text,
      'total_tasks', count(rt.id),
      'done_tasks', count(rt.id) filter (where rt.status in ('completed', 'cancelled'))
    ) as row_data,
    c.campaign_code,
    count(rt.id) as task_count
    from app_private.campaigns c
    left join app_private.campaign_items ci on ci.campaign_id = c.id
    left join app_private.scanner_assets s on s.id = ci.scanner_asset_id
    left join app_private.replacement_tasks rt on rt.campaign_item_id = ci.id
    where search_term is null
      or c.campaign_code ilike '%' || search_term || '%'
      or c.campaign_name ilike '%' || search_term || '%'
    group by c.id
    having actor_role <> 'field_technician' or count(rt.id) > 0
  ) campaigns;
  return result;
end
$$;

revoke all on function public.ais_list_campaigns(text) from public, anon;
grant execute on function public.ais_list_campaigns(text) to authenticated;

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
  select ua.role into actor_role from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role not in ('admin', 'field_technician') then
    raise exception 'Active application access required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'totals', jsonb_build_object(
      'branches', (select count(*) from app_private.branches),
      'scanners', (select count(*) from app_private.scanner_assets),
      'active_tasks', (select count(*) from app_private.replacement_tasks rt where rt.status in ('scheduled', 'in_progress', 'blocked')),
      'completed_tasks', (select count(*) from app_private.replacement_tasks rt where rt.status = 'completed')
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
        ) as row_data, c.created_at
        from app_private.campaigns c
        left join app_private.campaign_items ci on ci.campaign_id = c.id
        left join app_private.replacement_tasks rt on rt.campaign_item_id = ci.id
        group by c.id
        having actor_role <> 'field_technician' or count(rt.id) > 0
        order by c.created_at desc
        limit 5
      ) recent
    ), '[]'::jsonb),
    'weekly_activity', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'date', daily.day,
        'opened', daily.opened,
        'completed', daily.completed
      ) order by daily.day), '[]'::jsonb)
      from (
        select days.day,
          count(rt.id) as opened,
          count(rt.id) filter (where rt.status = 'completed') as completed
        from (
          select (now() at time zone 'Asia/Bangkok')::date - offsets.offset_days as day
          from generate_series(0, 6) as offsets(offset_days)
        ) days
        left join app_private.replacement_tasks rt
          on rt.created_at >= (days.day::timestamp at time zone 'Asia/Bangkok')
          and rt.created_at < ((days.day + 1)::timestamp at time zone 'Asia/Bangkok')
        group by days.day
      ) daily
    ),
    'tasks', coalesce((
      select jsonb_agg(row_data order by created_at desc)
      from (
        select jsonb_build_object(
          'id', rt.id,
          'branch_name', coalesce(nullif(b.loc_bld, ''), b.location_code),
          'location_code', b.location_code,
          'province', b.province,
          'scanner_model', coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), 'เครื่องสแกน'),
          'com_sn', case when actor_role = 'viewer' and char_length(s.com_sn) > 4
            then '••••••' || right(s.com_sn, 4) when actor_role = 'viewer' then '••••••' else s.com_sn end,
          'created_at', rt.created_at,
          'task_status', rt.status::text,
          'workflow_stage', app_private.task_workflow_stage(rt.status, rt.technician_confirmed_at,
            rt.closeout_submitted_at, rt.admin_accepted_at, visit.outcome),
          'workflow_outcome', visit.outcome,
          'new_serial', visit.new_serial,
          'old_serial_snapshot', visit.old_serial_snapshot,
          'observed_serial', visit.observed_serial,
          'exception_reason', visit.exception_reason,
          'install_result', visit.install_result,
          'old_scanner_status', visit.old_scanner_status,
          'old_scanner_note', visit.old_scanner_note,
          'performed_by_name', visit.performer_name,
          'performed_at', visit.performed_at,
          'version', rt.version,
          'blocked_reason', rt.blocked_reason,
          'can_admin_accept', actor_role = 'admin'
            and rt.closeout_submitted_at is not null and rt.admin_accepted_at is null
            and actor is distinct from rt.closeout_submitted_by
            and actor is distinct from visit.performed_by
        ) as row_data,
        rt.created_at
        from app_private.replacement_tasks rt
        join app_private.campaign_items ci on ci.id = rt.campaign_item_id
        join app_private.scanner_assets s on s.id = ci.scanner_asset_id
        join app_private.branches b on b.id = s.branch_id
        left join lateral (
          select fv.outcome, fv.new_serial, fv.old_serial_snapshot, fv.observed_serial,
            fv.exception_reason, fv.install_result, fv.old_scanner_status::text as old_scanner_status,
            fv.old_scanner_note, fv.performed_by, fv.performed_at,
            ua.display_name as performer_name
          from app_private.field_visits fv
          left join app_private.user_access ua on ua.user_id = fv.performed_by
          where fv.task_id = rt.id
          order by fv.performed_at desc, fv.created_at desc, fv.id desc
          limit 1
        ) visit on true
        order by rt.created_at desc, rt.id
        limit 6
      ) recent_tasks
    ), '[]'::jsonb)
  ) into result;
  return result;
end
$$;

revoke all on function public.ais_dashboard() from public, anon;
grant execute on function public.ais_dashboard() to authenticated;

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
  select ua.role into actor_role from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role not in ('admin', 'field_technician') then
    raise exception 'Active operational access required' using errcode = '42501';
  end if;
  if p_asset_id is null or p_limit is null or p_limit not between 1 and 20
    or p_offset is null or p_offset not between 0 and 1000 then
    raise exception 'Invalid scanner work history request' using errcode = '22023';
  end if;
  select count(*)::integer into total_rows
  from app_private.replacement_tasks rt
  join app_private.campaign_items ci on ci.id = rt.campaign_item_id
  where ci.scanner_asset_id = p_asset_id and (p_task_id is null or rt.id = p_task_id);
  select coalesce(jsonb_agg(history.row_data order by history.performed_at desc nulls last, history.created_at desc, history.id), '[]'::jsonb)
  into result_rows
  from (
    select rt.id, rt.created_at, visit.performed_at,
      jsonb_build_object(
        'id', rt.id, 'asset_id', s.id,
        'branch_name', coalesce(nullif(b.loc_bld, ''), b.location_code),
        'location_code', b.location_code, 'province', b.province,
        'scanner_model', coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), ''),
        'com_sn', s.com_sn, 'created_at', rt.created_at,
        'task_status', rt.status::text,
        'workflow_stage', app_private.task_workflow_stage(rt.status, rt.technician_confirmed_at,
          rt.closeout_submitted_at, rt.admin_accepted_at, visit.outcome),
        'workflow_outcome', visit.outcome,
        'observed_serial', visit.observed_serial,
        'exception_reason', visit.exception_reason,
        'version', rt.version, 'blocked_reason', rt.blocked_reason,
        'new_serial', visit.new_serial,
        'old_serial_snapshot', visit.old_serial_snapshot,
        'install_result', visit.install_result,
        'old_scanner_status', visit.old_scanner_status,
        'old_scanner_note', visit.old_scanner_note,
        'performed_by_name', visit.performer_name,
        'performed_at', visit.performed_at,
        'can_admin_accept', actor_role = 'admin'
          and rt.closeout_submitted_at is not null and rt.admin_accepted_at is null
          and actor is distinct from rt.closeout_submitted_by
          and actor is distinct from visit.performed_by
      ) as row_data
    from app_private.replacement_tasks rt
    join app_private.campaign_items ci on ci.id = rt.campaign_item_id
    join app_private.scanner_assets s on s.id = ci.scanner_asset_id
    join app_private.branches b on b.id = s.branch_id
    left join lateral (
      select fv.old_serial_snapshot, fv.new_serial, fv.install_result,
        fv.old_scanner_status::text as old_scanner_status, fv.old_scanner_note,
        fv.outcome, fv.observed_serial, fv.exception_reason, fv.performed_at,
        fv.performed_by, ua.display_name as performer_name
      from app_private.field_visits fv
      left join app_private.user_access ua on ua.user_id = fv.performed_by
      where fv.task_id = rt.id
      order by fv.performed_at desc, fv.created_at desc, fv.id desc
      limit 1
    ) visit on true
    where ci.scanner_asset_id = p_asset_id and (p_task_id is null or rt.id = p_task_id)
    order by visit.performed_at desc nulls last, rt.created_at desc, rt.id
    limit p_limit offset p_offset
  ) history;
  return jsonb_build_object('asset_id', p_asset_id, 'total', total_rows, 'rows', result_rows);
end
$$;

revoke all on function public.ais_scanner_work_history(uuid, uuid, integer, integer) from public, anon;
grant execute on function public.ais_scanner_work_history(uuid, uuid, integer, integer) to authenticated;

-- Show unassigned opened jobs to every technician and remove the last team
-- membership gate from the campaign serial view.
do $migration$
declare
  signature regprocedure := 'app_private.ais_campaign_asset_page(uuid,integer,integer)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
  old_predicate text := '(actor_role <> ''field_technician'' or (task.id is not null and task.team_id is not null))';
  new_predicate text := '(actor_role <> ''field_technician'' or task.id is not null)';
begin
  if strpos(original_definition, old_predicate) = 0 then
    raise exception 'Could not locate technician team predicate in %', signature;
  end if;
  definition := replace(original_definition, old_predicate, new_predicate);
  execute definition;
end
$migration$;

-- After closeout, only the independent Admin reviewer may add the acceptance
-- signature. Work evidence is locked so it cannot be changed during review.
create or replace function app_private.can_edit_task_evidence_slot(p_task_id uuid, p_slot text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1
    from app_private.user_access ua
    join app_private.replacement_tasks rt on rt.id = p_task_id and rt.status = 'in_progress'
    join app_private.campaign_items ci on ci.id = rt.campaign_item_id
    join app_private.campaigns c on c.id = ci.campaign_id and c.status not in ('blocked', 'cancelled')
    where ua.user_id = auth.uid() and ua.is_active
      and (
        (ua.role in ('admin', 'field_technician') and rt.closeout_submitted_at is null)
        or (ua.role = 'admin' and lower(btrim(coalesce(p_slot, ''))) = 'inspector_signature'
          and rt.closeout_submitted_at is not null and rt.admin_accepted_at is null
          and auth.uid() is distinct from rt.closeout_submitted_by
          and not exists (select 1 from app_private.field_visits fv
            where fv.task_id = rt.id and fv.performed_by = auth.uid()))
      )
  );
$$;

revoke all on function app_private.can_edit_task_evidence_slot(uuid, text) from public, anon, authenticated;
grant execute on function app_private.can_edit_task_evidence_slot(uuid, text) to authenticated;

do $migration$
declare
  signature regprocedure;
  original_definition text;
  definition text;
begin
  foreach signature in array array[
    'public.ais_task_evidence_reserve(uuid,text,integer,text,boolean)'::regprocedure,
    'public.ais_task_evidence_finalize(uuid,text)'::regprocedure
  ] loop
    original_definition := pg_get_functiondef(signature);
    definition := replace(original_definition,
      'app_private.can_edit_task_evidence(p_task_id)',
      'app_private.can_edit_task_evidence_slot(p_task_id, slot_name)');
    if definition = original_definition then
      raise exception 'Could not add evidence-stage guard to %', signature;
    end if;
    execute definition;
  end loop;

  signature := 'public.ais_task_evidence_cancel_pending(uuid,text)'::regprocedure;
  original_definition := pg_get_functiondef(signature);
  definition := replace(original_definition,
    'app_private.can_edit_task_evidence(p_task_id)',
    'app_private.can_edit_task_evidence_slot(p_task_id, p_slot)');
  if definition = original_definition then
    raise exception 'Could not add pending-evidence guard to %', signature;
  end if;
  execute definition;
end
$migration$;

-- Exception closeouts have outcome-specific evidence. The reviewer signature
-- is still mandatory before any work order can move to the delivered state.
create or replace function app_private.require_task_evidence_before_completion()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  outcome_name text;
  missing_slots text[];
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    select fv.outcome into outcome_name from app_private.field_visits fv
    where fv.task_id = new.id;
    select array_agg(required.slot order by required.slot)
    into missing_slots
    from unnest(array[
      case when coalesce(outcome_name, 'replaced') in ('replaced', 'no_damage_found', 'different_device_found') then 'old_serial_photo' end,
      case when coalesce(outcome_name, 'replaced') = 'replaced' then 'new_serial_photo' end,
      case when coalesce(outcome_name, 'replaced') in ('replaced', 'no_damage_found', 'different_device_found', 'target_device_not_found') then 'old_device_photo' end,
      case when coalesce(outcome_name, 'replaced') = 'replaced' then 'new_device_photo' end,
      'technician_signature', 'scanner_user_signature', 'inspector_signature'
    ]::text[]) as required(slot)
    left join app_private.replacement_task_evidence e
      on e.task_id = new.id and e.slot = required.slot and e.status = 'ready'
    left join storage.objects o on o.bucket_id = 'ais-task-evidence' and o.name = e.object_path
    where required.slot is not null and (e.task_id is null or o.id is null);
    if coalesce(cardinality(missing_slots), 0) > 0 then
      raise exception 'Required photos and signatures must be saved before completing this task: %',
        array_to_string(missing_slots, ', ') using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function app_private.require_task_evidence_before_completion() from public, anon, authenticated;
