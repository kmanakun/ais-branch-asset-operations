-- Separate technician closeout from Office Admin acceptance, preserve the
-- scanner master until acceptance, and route exception outcomes for review.

alter table app_private.replacement_tasks
  add column technician_confirmed_at timestamptz,
  add column technician_confirmed_by uuid references auth.users(id) on delete set null,
  add column closeout_submitted_at timestamptz,
  add column closeout_submitted_by uuid references auth.users(id) on delete set null,
  add column admin_accepted_at timestamptz,
  add column admin_accepted_by uuid references auth.users(id) on delete set null;

-- Existing in-progress work has already passed technician confirmation. Keep
-- its stage usable while marking finished pre-workflow rows as legacy.
update app_private.replacement_tasks
set technician_confirmed_at = coalesce(technician_confirmed_at, updated_at)
where status in ('in_progress', 'completed') and technician_confirmed_at is null;

alter table app_private.replacement_tasks
  add constraint replacement_tasks_closeout_requires_confirmation
    check (closeout_submitted_at is null or technician_confirmed_at is not null),
  add constraint replacement_tasks_acceptance_requires_closeout
    check (admin_accepted_at is null or (closeout_submitted_at is not null and status = 'completed'));

alter table app_private.field_visits
  add column outcome text not null default 'replaced'
    check (outcome in ('replaced', 'no_damage_found', 'different_device_found', 'target_device_not_found')),
  add column observed_serial text,
  add column exception_reason text;

alter table app_private.field_visits alter column new_serial drop not null;
alter table app_private.field_visits drop constraint field_visits_new_serial_check;
alter table app_private.field_visits
  add constraint field_visits_outcome_details_check check (
    (outcome = 'replaced'
      and nullif(btrim(new_serial), '') is not null
      and observed_serial is null
      and exception_reason is null)
    or (outcome = 'no_damage_found'
      and new_serial is null
      and observed_serial is null
      and nullif(btrim(exception_reason), '') is not null)
    or (outcome = 'different_device_found'
      and new_serial is null
      and nullif(btrim(observed_serial), '') is not null
      and nullif(btrim(exception_reason), '') is not null)
    or (outcome = 'target_device_not_found'
      and new_serial is null
      and observed_serial is null
      and nullif(btrim(exception_reason), '') is not null)
  );
create unique index field_visits_one_closeout_per_task_idx
  on app_private.field_visits(task_id);
create unique index field_visits_replacement_serial_unique_idx
  on app_private.field_visits(lower(btrim(new_serial)))
  where outcome = 'replaced';

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
    when p_status = 'scheduled' and p_confirmed_at is null then 'awaiting_confirmation'
    when p_status = 'scheduled' then 'confirmed'
    when p_status = 'in_progress' and p_closeout_at is null then 'in_progress'
    when p_status = 'in_progress' and p_outcome in ('no_damage_found', 'different_device_found', 'target_device_not_found') then 'awaiting_admin_exception_review'
    when p_status = 'in_progress' and p_closeout_at is not null then 'awaiting_admin_acceptance'
    when p_status = 'completed' and p_admin_accepted_at is not null then 'delivered'
    when p_status = 'completed' then 'legacy_completed'
    else p_status::text
  end;
$$;

-- The old completion endpoint must not bypass Office Admin acceptance.
do $migration$
declare
  signature regprocedure := 'public.ais_field_task_action(uuid,text,integer,text,text,text,text,text)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(definition,
    $old$  task_status app_private.task_state;$old$,
    $new$  task_status app_private.task_state;
  task_confirmed_at timestamptz;$new$);
  definition := replace(definition,
    $old$if action_name not in ('start', 'block', 'resume', 'complete') then$old$,
    $new$if action_name not in ('confirm', 'start', 'block', 'resume') then$new$);
  definition := replace(definition,
    $old$select rt.status, rt.resume_status, rt.version, s.id, s.com_sn, ci.campaign_id
  into task_status, task_resume_status, task_version, scanner_asset_id, old_serial, v_campaign_id$old$,
    $new$select rt.status, rt.resume_status, rt.version, rt.technician_confirmed_at, s.id, s.com_sn, ci.campaign_id
  into task_status, task_resume_status, task_version, task_confirmed_at, scanner_asset_id, old_serial, v_campaign_id$new$);
  definition := replace(definition,
    $old$  if action_name = 'start' then
    if task_status <> 'scheduled' then$old$,
    $new$  if action_name = 'confirm' then
    if task_status <> 'scheduled' then
      raise exception 'Only a scheduled task can be confirmed' using errcode = '22023';
    end if;
    if task_confirmed_at is not null then
      raise exception 'Task is already confirmed' using errcode = '22023';
    end if;
    update app_private.replacement_tasks
    set technician_confirmed_at = clock_timestamp(), technician_confirmed_by = actor,
        version = version + 1, updated_at = clock_timestamp()
    where id = p_task_id and version = p_expected_version
    returning version into next_version;
    next_status := task_status;
  elsif action_name = 'start' then
    if task_status <> 'scheduled' then$new$);
  definition := replace(definition,
    $old$    if task_status <> 'scheduled' then
      raise exception 'Only a scheduled task can be started' using errcode = '22023';
    end if;$old$,
    $new$    if task_status <> 'scheduled' or task_confirmed_at is null then
      raise exception 'Confirm the work order before starting it' using errcode = '22023';
    end if;$new$);
  definition := replace(definition,
    $old$elsif action_name = 'block' then
    if task_status not in ('scheduled', 'in_progress') then$old$,
    $new$elsif action_name = 'block' then
    if exists (select 1 from app_private.replacement_tasks rt where rt.id = p_task_id and rt.closeout_submitted_at is not null) then
      raise exception 'A submitted closeout must be reviewed by Office Admin' using errcode = '22023';
    end if;
    if task_status not in ('scheduled', 'in_progress') then$new$);
  definition := replace(definition,
    $old$case action_name when 'start' then 'task_started' when 'block' then 'task_blocked' when 'resume' then 'task_resumed' else 'task_completed' end$old$,
    $new$case action_name when 'confirm' then 'task_confirmed' when 'start' then 'task_started' when 'block' then 'task_blocked' when 'resume' then 'task_resumed' else 'task_completed' end$new$);
  if definition = original_definition
    or strpos(definition, '''confirm'', ''start''') = 0
    or strpos(definition, 'technician_confirmed_at') = 0
    or strpos(definition, 'task_confirmed') = 0 then
    raise exception 'Could not safely replace the legacy task completion path';
  end if;
  execute definition;
end;
$migration$;

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
    join app_private.campaign_items ci on ci.id = rt.campaign_item_id
    join app_private.campaigns c on c.id = ci.campaign_id and c.status not in ('blocked', 'cancelled')
    where ua.user_id = auth.uid()
      and ua.is_active
      and (
        (ua.role = 'field_technician' and rt.team_id is not null and rt.closeout_submitted_at is null)
        or (ua.role = 'admin' and rt.closeout_submitted_at is not null and rt.admin_accepted_at is null)
      )
  );
$$;

-- Reserve only the evidence appropriate for the actor at this workflow stage.
do $migration$
declare
  signature regprocedure := 'public.ais_task_evidence_reserve(uuid,text,integer,text,boolean)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(definition,
    $old$  max_slot_size := case$old$,
    $new$  if actor_role = 'field_technician' and slot_name = 'inspector_signature' then
    raise exception 'Only Office Admin can record inspector acceptance' using errcode = '42501';
  elsif actor_role = 'admin' and slot_name <> 'inspector_signature' then
    raise exception 'Office Admin can only record the acceptance signature at this stage' using errcode = '42501';
  end if;

  max_slot_size := case$new$);
  definition := replace(definition,
    $old$  elsif slot_name in ('scanner_user_signature', 'inspector_signature') then
    if signer is null or length(signer) > 120 or p_consent_confirmed is distinct from true then
      raise exception 'Signer name and confirmation to store the signature are required' using errcode = '22023';
    end if;$old$,
    $new$  elsif slot_name = 'scanner_user_signature' then
    if signer is null or length(signer) > 120 or p_consent_confirmed is distinct from true then
      raise exception 'Signer name and confirmation to store the signature are required' using errcode = '22023';
    end if;
  elsif slot_name = 'inspector_signature' then
    if actor_role <> 'admin' then
      raise exception 'Only Office Admin can record inspector acceptance' using errcode = '42501';
    end if;
    signer := nullif(btrim(coalesce(actor_name, '')), '');
    if signer is null or length(signer) > 120 or p_consent_confirmed is distinct from true then
      raise exception 'Admin signature confirmation is required' using errcode = '22023';
    end if;$new$);
  if definition = original_definition
    or strpos(definition, 'Only Office Admin can record inspector acceptance') = 0
    or strpos(definition, 'elsif slot_name = ''scanner_user_signature''') = 0 then
    raise exception 'Could not safely restrict evidence reservation slots';
  end if;
  execute definition;
end;
$migration$;

create or replace function app_private.require_task_evidence_before_completion()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  missing_slots text[];
  task_outcome text;
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    select fv.outcome into task_outcome
    from app_private.field_visits fv
    where fv.task_id = new.id;

    select pg_catalog.array_agg(required.slot order by required.slot)
    into missing_slots
    from pg_catalog.unnest(array[
      'old_device_photo',
      case when task_outcome <> 'target_device_not_found' then 'old_serial_photo' end,
      case when task_outcome = 'replaced' then 'new_serial_photo' end,
      case when task_outcome = 'replaced' then 'new_device_photo' end,
      'technician_signature', 'scanner_user_signature', 'inspector_signature'
    ]::text[]) as required(slot)
    left join app_private.replacement_task_evidence e
      on e.task_id = new.id and e.slot = required.slot and e.status = 'ready'
    left join storage.objects o
      on o.bucket_id = 'ais-task-evidence' and o.name = e.object_path
    where required.slot is not null and (e.task_id is null or o.id is null);

    if coalesce(pg_catalog.cardinality(missing_slots), 0) > 0 then
      raise exception 'Required photos and signatures must be saved before delivering this task: %',
        pg_catalog.array_to_string(missing_slots, ', ')
        using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

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
  confirmed_at timestamptz;
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
  if actor is null or actor_role is distinct from 'field_technician' then
    raise exception 'Field Technician access required to submit closeout' using errcode = '42501';
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

  select rt.status, rt.version, rt.technician_confirmed_at, rt.closeout_submitted_at,
         s.id, s.com_sn, ci.campaign_id
  into task_status, task_version, confirmed_at, closeout_at, scanner_asset_id, old_serial, campaign_id
  from app_private.replacement_tasks rt
  join app_private.campaign_items ci on ci.id = rt.campaign_item_id
  join app_private.scanner_assets s on s.id = ci.scanner_asset_id
  where rt.id = p_task_id and rt.team_id is not null
  for update of rt, s;
  if not found then
    raise exception 'Assigned work order was not found' using errcode = 'P0002';
  end if;
  if task_version <> p_expected_version then
    raise exception 'Task changed since it was loaded; refresh before retrying' using errcode = '40001';
  end if;
  if task_status <> 'in_progress' or confirmed_at is null or closeout_at is not null then
    raise exception 'Only a confirmed task in progress can be closed out' using errcode = '22023';
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
  if old_status = 'other' and (old_note is null or length(old_note) > 1000) then
    raise exception 'A note of 1 to 1000 characters is required for other status' using errcode = '22023';
  end if;
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
    if lower(old_status::text) = 'other' and old_note is null then
      raise exception 'Explain the old scanner result' using errcode = '22023';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower(new_serial_text), 0));
    if exists (select 1 from app_private.scanner_assets s where lower(btrim(s.com_sn)) = lower(new_serial_text) and s.id <> scanner_asset_id) then
      raise exception 'This replacement Serial is already in use' using errcode = '23505';
    end if;
    if old_status = 'other' and old_note is null then
      raise exception 'Explain the old scanner result' using errcode = '22023';
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
    'old_device_photo',
    case when outcome_name <> 'target_device_not_found' then 'old_serial_photo' end,
    'technician_signature', 'scanner_user_signature'
  ]::text[]) as required(slot)
  left join app_private.replacement_task_evidence e
    on e.task_id = p_task_id and e.slot = required.slot and e.status = 'ready' and e.uploaded_by = actor
  left join storage.objects o on o.bucket_id = 'ais-task-evidence' and o.name = e.object_path
  where e.task_id is null or o.id is null;
  if outcome_name = 'replaced' then
    select coalesce(missing_slots, '{}'::text[]) || coalesce(array_agg(required.slot order by required.slot), '{}'::text[])
      into missing_slots
    from pg_catalog.unnest(array['new_serial_photo', 'new_device_photo']::text[]) as required(slot)
    left join app_private.replacement_task_evidence e
      on e.task_id = p_task_id and e.slot = required.slot and e.status = 'ready' and e.uploaded_by = actor
    left join storage.objects o on o.bucket_id = 'ais-task-evidence' and o.name = e.object_path
    where e.task_id is null or o.id is null;
  end if;
  if coalesce(pg_catalog.cardinality(missing_slots), 0) > 0 then
    raise exception 'Save the required work photos and both field signatures first: %', pg_catalog.array_to_string(missing_slots, ', ')
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
    'version', p_expected_version + 1);
end;
$$;

create or replace function public.ais_admin_accept_task(p_task_id uuid, p_expected_version integer)
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
  new_serial_text text;
  outcome_name text;
  visit_id uuid;
  next_version integer;
begin
  select ua.role into actor_role from app_private.user_access ua where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role is distinct from 'admin' then
    raise exception 'Office Admin access required to accept work' using errcode = '42501';
  end if;
  if p_task_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'Task and current version are required' using errcode = '22023';
  end if;

  select rt.status, rt.version, ci.campaign_id, s.id, fv.new_serial, fv.outcome, fv.id
    into task_status, task_version, campaign_id, scanner_asset_id, new_serial_text, outcome_name, visit_id
  from app_private.replacement_tasks rt
  join app_private.campaign_items ci on ci.id = rt.campaign_item_id
  join app_private.scanner_assets s on s.id = ci.scanner_asset_id
  join app_private.field_visits fv on fv.task_id = rt.id
  where rt.id = p_task_id and rt.team_id is not null
  for update of rt, s, fv;
  if not found then
    raise exception 'Closeout was not found for this work order' using errcode = 'P0002';
  end if;
  if task_version <> p_expected_version then
    raise exception 'Task changed since it was loaded; refresh before retrying' using errcode = '40001';
  end if;
  if task_status <> 'in_progress'
    or not exists (select 1 from app_private.replacement_tasks rt where rt.id = p_task_id and rt.closeout_submitted_at is not null and rt.admin_accepted_at is null) then
    raise exception 'This task is not waiting for Admin acceptance' using errcode = '22023';
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
    raise exception 'Office Admin acceptance signature is required' using errcode = '22023';
  end if;
  if outcome_name = 'replaced' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower(new_serial_text), 0));
    if exists (select 1 from app_private.scanner_assets s where lower(btrim(s.com_sn)) = lower(new_serial_text) and s.id <> scanner_asset_id) then
      raise exception 'This replacement Serial is already in use' using errcode = '23505';
    end if;
    update app_private.scanner_assets set com_sn = new_serial_text, updated_at = clock_timestamp() where id = scanner_asset_id;
  end if;

  update app_private.replacement_tasks
  set status = 'completed', resume_status = null, blocked_reason = null,
      admin_accepted_at = clock_timestamp(), admin_accepted_by = actor,
      version = version + 1, updated_at = clock_timestamp()
  where id = p_task_id and version = p_expected_version
  returning version into next_version;

  insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
  values (actor, 'task_admin_accepted', 'replacement_task', p_task_id,
    pg_catalog.jsonb_build_object('outcome', outcome_name, 'field_visit_id', visit_id));

  update app_private.campaigns c
  set status = 'completed', updated_at = clock_timestamp()
  where c.id = campaign_id and c.status in ('scheduled', 'in_progress', 'blocked')
    and not exists (
      select 1 from app_private.campaign_items ci
      left join app_private.replacement_tasks rt on rt.campaign_item_id = ci.id
      where ci.campaign_id = c.id and (rt.id is null or rt.status not in ('completed', 'cancelled'))
    );

  return pg_catalog.jsonb_build_object('task_id', p_task_id, 'status', 'completed',
    'workflow_stage', 'delivered', 'version', next_version);
end;
$$;

revoke all on function public.ais_technician_submit_closeout(uuid,integer,text,text,text,text,text,text,text) from public, anon;
revoke all on function public.ais_admin_accept_task(uuid,integer) from public, anon;
grant execute on function public.ais_technician_submit_closeout(uuid,integer,text,text,text,text,text,text,text) to authenticated;
grant execute on function public.ais_admin_accept_task(uuid,integer) to authenticated;

-- Expose operational workflow stage on each work order and allow the list to
-- route technicians/Admins into the correct queue. Preserve global tech scope.
do $migration$
declare
  signature regprocedure := 'public.ais_task_filtered_page(text,text,integer,integer)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(definition,
    $old$      rt.status,$old$,
    $new$      rt.status,
      rt.technician_confirmed_at,
      rt.closeout_submitted_at,
      rt.admin_accepted_at,
      visit.outcome as workflow_outcome,$new$);
  definition := replace(definition,
    $old$if status_filter not in ('all', 'scheduled', 'in_progress', 'blocked', 'completed', 'cancelled') then$old$,
    $new$if status_filter not in ('all', 'scheduled', 'in_progress', 'blocked', 'completed', 'cancelled', 'awaiting_confirmation', 'confirmed', 'awaiting_admin_acceptance', 'awaiting_admin_exception_review', 'delivered', 'legacy_completed') then$new$);
  definition := replace(definition,
    $old$        'task_status', rt.status::text,$old$,
    $new$        'task_status', rt.status::text,
        'workflow_stage', app_private.task_workflow_stage(rt.status, rt.technician_confirmed_at, rt.closeout_submitted_at, rt.admin_accepted_at, visit.outcome),
        'workflow_outcome', visit.outcome,
        'observed_serial', case when actor_role = 'viewer' and visit.observed_serial is not null then '••••••' || right(visit.observed_serial, 4) else visit.observed_serial end,
        'exception_reason', case when actor_role = 'viewer' then null else visit.exception_reason end,$new$);
  definition := replace(definition,
    $old$select fv.old_serial_snapshot, fv.new_serial, fv.install_result, fv.old_scanner_status, fv.old_scanner_note$old$,
    $new$select fv.old_serial_snapshot, fv.new_serial, fv.install_result, fv.old_scanner_status, fv.old_scanner_note, fv.outcome, fv.observed_serial, fv.exception_reason$new$);
  definition := replace(definition,
    $old$where status_filter = 'all' or status::text = status_filter$old$,
    $new$where status_filter = 'all' or status::text = status_filter
      or app_private.task_workflow_stage(status, technician_confirmed_at, closeout_submitted_at, admin_accepted_at, workflow_outcome) = status_filter$new$);
  if definition = original_definition
    or strpos(definition, '''workflow_stage''') = 0
    or strpos(definition, 'awaiting_admin_exception_review') = 0
    or strpos(definition, 'workflow_outcome') = 0
    or strpos(definition, 'user_team_memberships') > 0 then
    raise exception 'Could not safely add workflow stages to the task list';
  end if;
  execute definition;
end;
$migration$;

comment on function public.ais_technician_submit_closeout(uuid,integer,text,text,text,text,text,text,text) is
  'Records one technician closeout for a confirmed one-scanner task without changing the master inventory serial.';
comment on function public.ais_admin_accept_task(uuid,integer) is
  'Office Admin acceptance records delivery; only accepted normal replacements update the scanner master serial.';
