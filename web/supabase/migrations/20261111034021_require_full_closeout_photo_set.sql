-- Match the onsite evidence contract: 4 photos of the old Scanner, 6 of the
-- replacement Scanner, two optional spare photos, and three separate signatures.
-- Exceptions keep their outcome-specific evidence requirements.

alter table app_private.replacement_task_evidence
  drop constraint replacement_task_evidence_slot_check;
alter table app_private.replacement_task_evidence
  add constraint replacement_task_evidence_slot_check check (slot in (
    'old_serial_photo', 'old_device_photo', 'old_condition_photo', 'old_branch_sticker_photo',
    'new_serial_photo', 'new_front_photo', 'new_side_photo', 'new_com_serial_photo',
    'new_device_photo', 'new_cable_management_photo', 'spare_photo_1', 'spare_photo_2',
    'technician_signature', 'scanner_user_signature', 'inspector_signature'
  ));

-- Update the existing allow-list rather than replacing the secured RPC, which
-- preserves its version, consent, reservation, and free-plan quota checks.
do $reserve_slots$
declare
  signature regprocedure := 'public.ais_task_evidence_reserve(uuid,text,integer,text,boolean)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
  old_slots text := $old$  if slot_name not in (
    'old_serial_photo', 'new_serial_photo', 'old_device_photo', 'new_device_photo',
    'spare_photo_1', 'spare_photo_2',
    'technician_signature', 'scanner_user_signature', 'inspector_signature'
  ) then$old$;
  new_slots text := $new$  if slot_name not in (
    'old_serial_photo', 'old_device_photo', 'old_condition_photo', 'old_branch_sticker_photo',
    'new_serial_photo', 'new_front_photo', 'new_side_photo', 'new_com_serial_photo',
    'new_device_photo', 'new_cable_management_photo', 'spare_photo_1', 'spare_photo_2',
    'technician_signature', 'scanner_user_signature', 'inspector_signature'
  ) then$new$;
begin
  if (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, old_slots, '')))
      / pg_catalog.length(old_slots) <> 1 then
    raise exception 'Could not locate the evidence reservation slot allow-list';
  end if;
  definition := pg_catalog.replace(definition, old_slots, new_slots);
  execute definition;
end
$reserve_slots$;

do $editable_slots$
declare
  signature regprocedure := 'app_private.can_edit_task_evidence_slot(uuid,text)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
  old_slots text := $old$          'old_serial_photo', 'new_serial_photo', 'old_device_photo', 'new_device_photo',
          'spare_photo_1', 'spare_photo_2', 'technician_signature', 'scanner_user_signature'$old$;
  new_slots text := $new$          'old_serial_photo', 'old_device_photo', 'old_condition_photo', 'old_branch_sticker_photo',
          'new_serial_photo', 'new_front_photo', 'new_side_photo', 'new_com_serial_photo',
          'new_device_photo', 'new_cable_management_photo', 'spare_photo_1', 'spare_photo_2',
          'technician_signature', 'scanner_user_signature'$new$;
begin
  if (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, old_slots, '')))
      / pg_catalog.length(old_slots) <> 1 then
    raise exception 'Could not locate the editable evidence slot allow-list';
  end if;
  definition := pg_catalog.replace(definition, old_slots, new_slots);
  execute definition;
end
$editable_slots$;

-- Closeout is accepted only when each outcome has its required evidence saved
-- under the same result context as the closeout being submitted.
do $closeout_requirements$
declare
  signature regprocedure := 'public.ais_technician_submit_closeout(uuid,integer,text,text,text,text,text,text,text,text)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
  old_old_device text := $old$    case when outcome_name in ('replaced', 'no_damage_found') then 'old_device_photo' end,$old$;
  new_old_device text := $new$    case when outcome_name in ('replaced', 'no_damage_found') then 'old_device_photo' end,
    case when outcome_name in ('replaced', 'no_damage_found') then 'old_condition_photo' end,
    case when outcome_name in ('replaced', 'no_damage_found') then 'old_branch_sticker_photo' end,$new$;
  old_new_device text := $old$    case when outcome_name = 'replaced' then 'new_device_photo' end,$old$;
  new_new_device text := $new$    case when outcome_name = 'replaced' then 'new_front_photo' end,
    case when outcome_name = 'replaced' then 'new_side_photo' end,
    case when outcome_name = 'replaced' then 'new_com_serial_photo' end,
    case when outcome_name = 'replaced' then 'new_device_photo' end,
    case when outcome_name = 'replaced' then 'new_cable_management_photo' end,$new$;
begin
  if (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, old_old_device, '')))
      / pg_catalog.length(old_old_device) <> 1
    or (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, old_new_device, '')))
      / pg_catalog.length(old_new_device) <> 1 then
    raise exception 'Could not locate the closeout evidence requirements';
  end if;
  definition := pg_catalog.replace(definition, old_old_device, new_old_device);
  definition := pg_catalog.replace(definition, old_new_device, new_new_device);
  if definition = original_definition then
    raise exception 'Closeout evidence requirements were not updated';
  end if;
  execute definition;
end
$closeout_requirements$;

-- The final completion trigger independently verifies all 10 core photos,
-- both field signatures, and the separate Admin acceptance signature.
do $completion_requirements$
declare
  signature regprocedure := 'app_private.require_task_evidence_before_completion()'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
  old_old_device text := $old$      case when coalesce(outcome_name, 'replaced') in ('replaced', 'no_damage_found') then 'old_device_photo' end,$old$;
  new_old_device text := $new$      case when coalesce(outcome_name, 'replaced') in ('replaced', 'no_damage_found') then 'old_device_photo' end,
      case when coalesce(outcome_name, 'replaced') in ('replaced', 'no_damage_found') then 'old_condition_photo' end,
      case when coalesce(outcome_name, 'replaced') in ('replaced', 'no_damage_found') then 'old_branch_sticker_photo' end,$new$;
  old_new_device text := $old$      case when coalesce(outcome_name, 'replaced') = 'replaced' then 'new_device_photo' end,$old$;
  new_new_device text := $new$      case when coalesce(outcome_name, 'replaced') = 'replaced' then 'new_front_photo' end,
      case when coalesce(outcome_name, 'replaced') = 'replaced' then 'new_side_photo' end,
      case when coalesce(outcome_name, 'replaced') = 'replaced' then 'new_com_serial_photo' end,
      case when coalesce(outcome_name, 'replaced') = 'replaced' then 'new_device_photo' end,
      case when coalesce(outcome_name, 'replaced') = 'replaced' then 'new_cable_management_photo' end,$new$;
begin
  if (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, old_old_device, '')))
      / pg_catalog.length(old_old_device) <> 1
    or (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, old_new_device, '')))
      / pg_catalog.length(old_new_device) <> 1 then
    raise exception 'Could not locate the completion evidence requirements';
  end if;
  definition := pg_catalog.replace(definition, old_old_device, new_old_device);
  definition := pg_catalog.replace(definition, old_new_device, new_new_device);
  if definition = original_definition then
    raise exception 'Completion evidence requirements were not updated';
  end if;
  execute definition;
end
$completion_requirements$;

comment on constraint replacement_task_evidence_slot_check
  on app_private.replacement_task_evidence is
  'Allows the 10 core replacement photos, 2 optional spare photos, and 3 separate work-order signatures.';
