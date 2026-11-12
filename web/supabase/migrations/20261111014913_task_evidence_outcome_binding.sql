-- Evidence captured for one closeout outcome must not satisfy another outcome.
-- Older in-flight evidence remains unbound and must be recorded again before
-- submission; completed field visits provide a reliable outcome for history.
alter table app_private.replacement_task_evidence
  add column outcome_context text;

alter table app_private.replacement_task_evidence
  add constraint replacement_task_evidence_outcome_context_check
  check (outcome_context is null or outcome_context in (
    'replaced', 'no_damage_found', 'different_device_found', 'target_device_not_found'
  ));

update app_private.replacement_task_evidence e
set outcome_context = fv.outcome::text
from app_private.field_visits fv
where fv.task_id = e.task_id
  and e.status = 'ready'
  and e.outcome_context is null;

-- Include the binding in the existing guarded evidence-list response.
do $evidence_list$
declare
  signature regprocedure := 'public.ais_task_evidence_list(uuid)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text;
begin
  definition := replace(
    original_definition,
    '''updated_at'', e.updated_at',
    '''updated_at'', e.updated_at, ''outcome_context'', e.outcome_context'
  );
  if definition = original_definition then
    raise exception 'Could not expose the evidence outcome context';
  end if;
  execute definition;
end
$evidence_list$;

-- Keep the existing quota, MIME, slot, signer-consent, reservation-token,
-- uploader, and role checks in the proven reserve function. Bind its reservation
-- to the selected outcome in the same database transaction.
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
  visit_outcome text;
  closeout_at timestamptz;
  reservation jsonb;
begin
  if p_outcome is null or p_outcome not in ('replaced', 'no_damage_found', 'different_device_found', 'target_device_not_found') then
    raise exception 'A valid closeout outcome is required' using errcode = '22023';
  end if;

  -- Run the original slot-aware authorization first. Any later validation
  -- error rolls this reservation back as part of the same transaction.
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

  return reservation;
end
$$;

revoke all on function public.ais_task_evidence_reserve(uuid, text, integer, text, boolean) from public, anon, authenticated;
revoke all on function public.ais_task_evidence_reserve_for_outcome(uuid, text, integer, text, boolean, text) from public, anon;
grant execute on function public.ais_task_evidence_reserve_for_outcome(uuid, text, integer, text, boolean, text) to authenticated;

comment on function public.ais_task_evidence_reserve_for_outcome(uuid, text, integer, text, boolean, text) is
  'Reserves guarded private evidence and binds it to the selected closeout outcome; the Admin signature must match the already submitted outcome.';

-- Enforce outcome matching at both workflow gates, independently of the UI.
do $closeout_guard$
declare
  signature regprocedure := 'public.ais_technician_submit_closeout(uuid,integer,text,text,text,text,text,text,text,text)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text;
begin
  definition := replace(
    original_definition,
    'and e.status = ''ready'' and e.uploaded_by = actor',
    'and e.status = ''ready'' and e.uploaded_by = actor and e.outcome_context = outcome_name'
  );
  if definition = original_definition then
    raise exception 'Could not bind technician closeout requirements to the selected outcome';
  end if;
  execute definition;
end
$closeout_guard$;

do $acceptance_guard$
declare
  signature regprocedure := 'public.ais_admin_accept_task(uuid,integer,boolean)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text;
begin
  definition := replace(
    original_definition,
    'e.slot = ''inspector_signature'' and e.status = ''ready''',
    'e.slot = ''inspector_signature'' and e.status = ''ready'' and e.outcome_context = outcome_name'
  );
  if definition = original_definition then
    raise exception 'Could not bind Admin acceptance signature to the reviewed outcome';
  end if;
  execute definition;
end
$acceptance_guard$;

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
    select fv.outcome::text into outcome_name
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
    left join app_private.replacement_task_evidence e on e.task_id = new.id
      and e.slot = required.slot and e.status = 'ready'
      and e.outcome_context = coalesce(outcome_name, 'replaced')
    left join storage.objects o on o.bucket_id = 'ais-task-evidence' and o.name = e.object_path
    where required.slot is not null and (e.task_id is null or o.id is null);

    if coalesce(cardinality(missing_slots), 0) > 0 then
      raise exception 'Required photos and signatures for the reviewed outcome are missing: %', array_to_string(missing_slots, ', ')
        using errcode = '22023';
    end if;
  end if;
  return new;
end
$$;

revoke all on function app_private.require_task_evidence_before_completion() from public, anon, authenticated;
