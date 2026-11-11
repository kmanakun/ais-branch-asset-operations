-- Let onsite staff start a linked work item by uploading its first photo or signature.
-- Opening the detail view alone does not change the work item or record an actor.

create or replace function public.ais_task_evidence_reserve_for_outcome(
  p_task_id uuid,
  p_slot text,
  p_byte_size integer,
  p_signer_name text default null,
  p_consent_confirmed boolean default false,
  p_outcome text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  slot_name text := lower(btrim(coalesce(p_slot, '')));
  task_status app_private.task_state;
  task_version integer;
  closeout_at timestamptz;
  visit_outcome text;
  started boolean := false;
  start_result jsonb;
  reservation jsonb;
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('replaced', 'no_damage_found', 'different_device_found', 'target_device_not_found') then
    raise exception 'A valid closeout outcome is required' using errcode = '22023';
  end if;

  select rt.status, rt.version
    into task_status, task_version
  from app_private.replacement_tasks rt
  where rt.id = p_task_id
  for update;
  if not found then
    raise exception 'Work item was not found' using errcode = 'P0002';
  end if;

  if task_status = 'scheduled' then
    -- This start and evidence reservation share one transaction. A reservation
    -- error rolls the start and audit event back with it.
    start_result := public.ais_field_task_action(p_task_id, 'start', task_version);
    task_version := (start_result ->> 'version')::integer;
    started := true;
  elsif task_status <> 'in_progress' then
    raise exception 'Task is no longer editable' using errcode = '55000';
  end if;

  reservation := public.ais_task_evidence_reserve(
    p_task_id, p_slot, p_byte_size, p_signer_name, p_consent_confirmed
  );

  select rt.closeout_submitted_at, fv.outcome::text
    into closeout_at, visit_outcome
  from app_private.replacement_tasks rt
  left join app_private.field_visits fv on fv.task_id = rt.id
  where rt.id = p_task_id;
  if slot_name = 'inspector_signature' then
    if closeout_at is null or visit_outcome is distinct from p_outcome then
      raise exception 'Admin signature outcome does not match the submitted work result' using errcode = '22023';
    end if;
  elsif closeout_at is not null then
    raise exception 'Field evidence is locked after closeout submission' using errcode = '55000';
  end if;

  update app_private.replacement_task_evidence e
  set outcome_context = p_outcome
  where e.task_id = p_task_id
    and e.slot = slot_name
    and e.reservation_token = (reservation ->> 'reservation_token')::uuid;
  if not found then
    raise exception 'Evidence reservation could not be bound to the closeout outcome' using errcode = '40001';
  end if;

  return reservation || pg_catalog.jsonb_build_object(
    'task_started', started,
    'task_version', task_version
  );
end
$$;

revoke all on function public.ais_task_evidence_reserve_for_outcome(uuid, text, integer, text, boolean, text) from public, anon;
grant execute on function public.ais_task_evidence_reserve_for_outcome(uuid, text, integer, text, boolean, text) to authenticated;

comment on function public.ais_task_evidence_reserve_for_outcome(uuid, text, integer, text, boolean, text) is
  'Starts an open work item when onsite evidence is first reserved, then binds the reservation to the selected closeout outcome.';
