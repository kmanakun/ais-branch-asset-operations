-- Align the active branch work-order workflow with the approved process:
-- routine replacements complete immediately; exceptions remain pending for Admin.

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
    when p_status = 'scheduled' then 'open'
    when p_status = 'in_progress' and p_closeout_at is null then 'in_progress'
    when p_status = 'in_progress'
      and p_outcome in ('no_damage_found', 'different_device_found', 'target_device_not_found')
      then 'awaiting_admin_exception_review'
    when p_status = 'in_progress' and p_closeout_at is not null then 'awaiting_admin_acceptance'
    when p_status = 'completed' and (p_admin_accepted_at is not null or p_outcome = 'replaced') then 'delivered'
    when p_status = 'completed' then 'legacy_completed'
    else p_status::text
  end;
$$;

-- Photos and signatures remain available as optional evidence. A valid field
-- visit is still required before a task can be marked complete.
create or replace function app_private.require_task_evidence_before_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed'
    and not exists (select 1 from app_private.field_visits fv where fv.task_id = new.id) then
    raise exception 'A recorded field visit is required before completing Scanner work'
      using errcode = '22023';
  end if;
  return new;
end
$$;
revoke all on function app_private.require_task_evidence_before_completion() from public, anon, authenticated;

-- Patch the existing closeout RPC without changing its input validation or its
-- caller-identity checks. It writes the replacement Serial and audit in the
-- same transaction as the field visit and task completion.
do $closeout$
declare
  signature regprocedure := 'public.ais_technician_submit_closeout(uuid,integer,text,text,text,text,text,text,text,text)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(
    definition,
    $old$  select pg_catalog.array_agg(required.slot order by required.slot) into missing_slots
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
  end if;$old$,
    $new$  -- Evidence uploads are optional and never gate closeout.$new$
  );
  if definition = original_definition then
    raise exception 'Could not remove mandatory evidence checks from technician closeout';
  end if;

  original_definition := definition;
  definition := replace(
    definition,
    $old$  ) returning id into visit_id;
  update app_private.replacement_tasks
  set closeout_submitted_at = clock_timestamp(), closeout_submitted_by = actor,
      version = version + 1, updated_at = clock_timestamp()
  where id = p_task_id and version = p_expected_version;$old$,
    $new$  ) returning id into visit_id;

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
  where id = p_task_id and version = p_expected_version;$new$
  );
  if definition = original_definition then
    raise exception 'Could not add atomic replacement registration and immediate completion';
  end if;

  original_definition := definition;
  definition := replace(
    definition,
    $old$    'workflow_stage', case when outcome_name = 'replaced' then 'awaiting_admin_acceptance' else 'awaiting_admin_exception_review' end,$old$,
    $new$    'workflow_stage', case when outcome_name = 'replaced' then 'delivered' else 'awaiting_admin_exception_review' end,$new$
  );
  if definition = original_definition then
    raise exception 'Could not return the immediate completion or Pending stage';
  end if;
  execute definition;
end
$closeout$;

-- Restrict the old acceptance endpoint to Admin resolution of exception items.
-- It no longer handles routine replacement closeouts and does not require a signature.
do $admin_resolution$
declare
  signature regprocedure := 'public.ais_admin_accept_task(uuid,integer,boolean)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(
    definition,
    $old$  if task_status <> 'in_progress'
    or not exists (select 1 from app_private.replacement_tasks rt where rt.id = p_task_id and rt.closeout_submitted_at is not null and rt.admin_accepted_at is null) then
    raise exception 'This Scanner is not waiting for Admin acceptance' using errcode = '22023';
  end if;$old$,
    $new$  if task_status <> 'in_progress'
    or outcome_name not in ('no_damage_found', 'different_device_found', 'target_device_not_found')
    or not exists (select 1 from app_private.replacement_tasks rt where rt.id = p_task_id and rt.closeout_submitted_at is not null and rt.admin_accepted_at is null) then
    raise exception 'Only a Pending exception can be resolved by Admin' using errcode = '22023';
  end if;$new$
  );
  if definition = original_definition then
    raise exception 'Could not limit Admin resolution to Pending exceptions';
  end if;

  original_definition := definition;
  definition := replace(
    definition,
    $old$  if not exists (
    select 1 from app_private.replacement_task_evidence e
    join storage.objects o on o.bucket_id = 'ais-task-evidence' and o.name = e.object_path
    where e.task_id = p_task_id and e.slot = 'inspector_signature' and e.status = 'ready'
      and e.uploaded_by = actor and e.signer_name is not null
  ) then
    raise exception 'A different Office Admin must save the acceptance signature' using errcode = '22023';
  end if;$old$,
    $new$  -- Admin review is authenticated and audited; signature evidence is optional.$new$
  );
  if definition = original_definition then
    raise exception 'Could not remove the mandatory Admin signature check';
  end if;
  definition := replace(definition, 'scanner_work_admin_accepted', 'scanner_work_exception_resolved');
  execute definition;
end
$admin_resolution$;

-- Accept the unified Pending filter while preserving legacy internal status names.
do $work_order_filter$
declare
  signature regprocedure := 'public.ais_branch_work_order_page(text,text,integer,integer)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(
    definition,
    $old$  if status_filter not in ('all', 'open', 'in_progress', 'blocked', 'awaiting_admin_acceptance',$old$,
    $new$  if status_filter not in ('all', 'open', 'in_progress', 'pending', 'blocked', 'awaiting_admin_acceptance',$new$
  );
  definition := replace(
    definition,
    $old$    where status_filter = 'all' or workflow_stage = status_filter$old$,
    $new$    where status_filter = 'all' or workflow_stage = status_filter
      or (status_filter = 'pending' and workflow_stage in ('blocked', 'awaiting_admin_exception_review'))$new$
  );
  if definition = original_definition then
    raise exception 'Could not add the unified Pending work-order filter';
  end if;
  execute definition;
end
$work_order_filter$;

comment on function public.ais_technician_submit_closeout(uuid,integer,text,text,text,text,text,text,text,text) is
  'Records field work. A normal replacement updates the register and completes immediately; exception outcomes remain pending for Admin review. Evidence is optional.';
