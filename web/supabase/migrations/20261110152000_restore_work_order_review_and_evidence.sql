-- Keep the approved field closeout -> Admin acceptance -> delivery workflow.
-- An observed Serial from a different device is still registered only after
-- Admin reviews the exception.

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
    when p_closeout_at is not null
      and p_outcome in ('no_damage_found', 'different_device_found', 'target_device_not_found')
      then 'awaiting_admin_exception_review'
    when p_closeout_at is not null then 'awaiting_admin_acceptance'
    when p_status = 'blocked' then 'blocked'
    when p_status = 'completed' then 'legacy_completed'
    when p_status = 'scheduled' then 'open'
    else p_status::text
  end;
$$;

create or replace function app_private.require_task_evidence_before_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  outcome_name text;
  missing_slots text[];
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    select fv.outcome into outcome_name
    from app_private.field_visits fv where fv.task_id = new.id;
    select array_agg(required.slot order by required.slot) into missing_slots
    from unnest(array[
      case when coalesce(outcome_name, 'replaced') in ('replaced', 'no_damage_found') then 'old_serial_photo' end,
      case when coalesce(outcome_name, 'replaced') = 'replaced' then 'new_serial_photo' end,
      case when coalesce(outcome_name, 'replaced') in ('replaced', 'no_damage_found') then 'old_device_photo' end,
      case when coalesce(outcome_name, 'replaced') = 'replaced' then 'new_device_photo' end,
      case when coalesce(outcome_name, 'replaced') = 'different_device_found' then 'new_serial_photo' end,
      case when coalesce(outcome_name, 'replaced') = 'different_device_found' then 'new_device_photo' end,
      case when coalesce(outcome_name, 'replaced') = 'target_device_not_found' then 'spare_photo_1' end,
      'technician_signature', 'scanner_user_signature', 'inspector_signature'
    ]::text[]) as required(slot)
    left join app_private.replacement_task_evidence e
      on e.task_id = new.id and e.slot = required.slot and e.status = 'ready'
    left join storage.objects o on o.bucket_id = 'ais-task-evidence' and o.name = e.object_path
    where required.slot is not null and (e.task_id is null or o.id is null);
    if coalesce(cardinality(missing_slots), 0) > 0 then
      raise exception 'Required photos and signatures are missing: %', array_to_string(missing_slots, ', ')
        using errcode = '22023';
    end if;
  end if;
  return new;
end
$$;
revoke all on function app_private.require_task_evidence_before_completion() from public, anon, authenticated;

do $closeout$
declare
  signature regprocedure := 'public.ais_technician_submit_closeout(uuid,integer,text,text,text,text,text,text,text,text)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(
    definition,
    $old$  -- Evidence uploads are optional and never gate closeout.$old$,
    $new$  select pg_catalog.array_agg(required.slot order by required.slot) into missing_slots
  from pg_catalog.unnest(array[
    case when outcome_name in ('replaced', 'no_damage_found') then 'old_serial_photo' end,
    case when outcome_name = 'replaced' then 'new_serial_photo' end,
    case when outcome_name in ('replaced', 'no_damage_found') then 'old_device_photo' end,
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
    raise exception 'Save required photos and field signatures first: %', pg_catalog.array_to_string(missing_slots, ', ')
      using errcode = '22023';
  end if;$new$
  );
  if definition = original_definition then
    raise exception 'Could not restore required photos and field signatures for closeout';
  end if;

  original_definition := definition;
  definition := replace(
    definition,
    $old$  ) returning id into visit_id;

  if outcome_name = 'replaced' then
    update app_private.scanner_assets
    set com_sn = new_serial_text, updated_at = clock_timestamp()
    where id = scanner_id;
    insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
    values (actor, 'scanner_replacement_registered', 'scanner_asset', scanner_id,
      pg_catalog.jsonb_build_object('task_id', p_task_id, 'old_serial', old_serial,
        'new_serial', new_serial_text, 'actor_id', actor));
  end if;

  update app_private.replacement_tasks
  set status = case when outcome_name = 'replaced' then 'completed'::app_private.task_state else status end,
      closeout_submitted_at = clock_timestamp(), closeout_submitted_by = actor,
      resume_status = null, blocked_reason = null,
      version = version + 1, updated_at = clock_timestamp()
  where id = p_task_id and version = p_expected_version;$old$,
    $new$  ) returning id into visit_id;
  update app_private.replacement_tasks
  set closeout_submitted_at = clock_timestamp(), closeout_submitted_by = actor,
      version = version + 1, updated_at = clock_timestamp()
  where id = p_task_id and version = p_expected_version;$new$
  );
  if definition = original_definition then
    raise exception 'Could not restore Admin review before Scanner Serial changes';
  end if;

  original_definition := definition;
  definition := replace(
    definition,
    $old$    'workflow_stage', case when outcome_name = 'replaced' then 'delivered' else 'awaiting_admin_exception_review' end,$old$,
    $new$    'workflow_stage', case when outcome_name = 'replaced' then 'awaiting_admin_acceptance' else 'awaiting_admin_exception_review' end,$new$
  );
  if definition = original_definition then
    raise exception 'Could not restore the standard Admin acceptance stage';
  end if;
  execute definition;
end
$closeout$;

do $admin_acceptance$
declare
  signature regprocedure := 'public.ais_admin_accept_task(uuid,integer,boolean)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(
    definition,
    $old$  if task_status <> 'in_progress'
    or outcome_name not in ('no_damage_found', 'different_device_found', 'target_device_not_found')
    or not exists (select 1 from app_private.replacement_tasks rt where rt.id = p_task_id and rt.closeout_submitted_at is not null and rt.admin_accepted_at is null) then
    raise exception 'Only a Pending exception can be resolved by Admin' using errcode = '22023';
  end if;$old$,
    $new$  if task_status <> 'in_progress'
    or not exists (select 1 from app_private.replacement_tasks rt where rt.id = p_task_id and rt.closeout_submitted_at is not null and rt.admin_accepted_at is null) then
    raise exception 'This Scanner is not waiting for Admin acceptance' using errcode = '22023';
  end if;$new$
  );
  if definition = original_definition then
    raise exception 'Could not restore Admin acceptance for routine replacement closeouts';
  end if;

  original_definition := definition;
  definition := replace(
    definition,
    $old$  -- Admin review is authenticated and audited; signature evidence is optional.$old$,
    $new$  if not exists (
    select 1 from app_private.replacement_task_evidence e
    join storage.objects o on o.bucket_id = 'ais-task-evidence' and o.name = e.object_path
    where e.task_id = p_task_id and e.slot = 'inspector_signature' and e.status = 'ready'
      and e.uploaded_by = actor and e.signer_name is not null
  ) then
    raise exception 'A different Office Admin must save the acceptance signature' using errcode = '22023';
  end if;$new$
  );
  if definition = original_definition then
    raise exception 'Could not restore the required Admin acceptance signature';
  end if;
  definition := replace(definition, 'scanner_work_exception_resolved', 'scanner_work_admin_accepted');
  execute definition;
end
$admin_acceptance$;

-- Admin may perform the onsite evidence steps. Only the inspector signature
-- remains reserved for a different Admin after closeout.
do $admin_field_evidence$
declare
  signature regprocedure := 'public.ais_task_evidence_reserve(uuid,text,integer,text,boolean)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text;
begin
  definition := replace(
    original_definition,
    $old$  if actor_role = 'field_technician' and slot_name = 'inspector_signature' then
    raise exception 'Only Office Admin can record inspector acceptance' using errcode = '42501';
  elsif actor_role = 'admin' and slot_name <> 'inspector_signature' then
    raise exception 'Office Admin can only record the acceptance signature at this stage' using errcode = '42501';
  end if;$old$,
    $new$  if actor_role = 'field_technician' and slot_name = 'inspector_signature' then
    raise exception 'Only Office Admin can record inspector acceptance' using errcode = '42501';
  end if;$new$
  );
  if definition = original_definition then
    raise exception 'Could not allow Admin accounts to record onsite evidence';
  end if;
  execute definition;
end
$admin_field_evidence$;

comment on function public.ais_technician_submit_closeout(uuid,integer,text,text,text,text,text,text,text,text) is
  'Records onsite results and required evidence, then waits for an independent Admin acceptance. Exception outcomes remain pending for Admin review. The registered Serial changes only after acceptance.';

-- Keep all review-stage items together under Pending in the work-order filter.
do $pending_filter$
declare
  signature regprocedure := 'public.ais_branch_work_order_page(text,text,integer,integer)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text;
begin
  definition := replace(
    original_definition,
    $old$or (status_filter = 'pending' and workflow_stage in ('blocked', 'awaiting_admin_exception_review'))$old$,
    $new$or (status_filter = 'pending' and workflow_stage in ('blocked', 'awaiting_admin_acceptance', 'awaiting_admin_exception_review'))$new$
  );
  if definition = original_definition then
    raise exception 'Could not include every Admin review state in the Pending filter';
  end if;
  execute definition;
end
$pending_filter$;

-- Retain the legacy task page endpoint while accepting the current Open label.
do $open_filter$
declare
  signature regprocedure := 'public.ais_task_filtered_page(text,text,integer,integer)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(
    definition,
    $old$if status_filter not in ('all', 'scheduled', 'in_progress', 'blocked', 'completed', 'cancelled') then$old$,
    $new$if status_filter not in ('all', 'open', 'scheduled', 'in_progress', 'blocked', 'completed', 'cancelled') then$new$
  );
  definition := replace(
    definition,
    $old$where status_filter = 'all' or status::text = status_filter$old$,
    $new$where status_filter = 'all' or status::text = status_filter or (status_filter = 'open' and status = 'scheduled')$new$
  );
  if definition = original_definition then
    raise exception 'Could not map the current Open filter to legacy scheduled tasks';
  end if;
  execute definition;
end
$open_filter$;

-- The dashboard uses the same branch province displayed in work-order detail.
do $dashboard_province$
declare
  signature regprocedure := 'public.ais_dashboard()'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text;
begin
  definition := replace(
    original_definition,
    $old$b.location_code, coalesce(nullif(b.loc_bld, ''), b.location_code) as branch_name,$old$,
    $new$b.location_code, coalesce(nullif(b.loc_bld, ''), b.location_code) as branch_name, b.province,$new$
  );
  definition := replace(
    definition,
    $old$'id', task_id, 'branch_name', branch_name, 'location_code', location_code,$old$,
    $new$'id', task_id, 'branch_name', branch_name, 'location_code', location_code, 'province', province,$new$
  );
  if definition = original_definition then
    raise exception 'Could not add province to dashboard work items';
  end if;
  execute definition;
end
$dashboard_province$;
