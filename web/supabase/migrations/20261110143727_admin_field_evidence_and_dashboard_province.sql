-- Preserve the approved evidence and independent acceptance controls.
-- Admin may perform the onsite steps, but cannot sign off their own work.

do $workflow_invariants$
declare
  closeout_definition text := pg_get_functiondef(
    'public.ais_technician_submit_closeout(uuid,integer,text,text,text,text,text,text,text,text)'::regprocedure
  );
  acceptance_definition text := pg_get_functiondef(
    'public.ais_admin_accept_task(uuid,integer,boolean)'::regprocedure
  );
begin
  if position('Save required photos and field signatures first' in closeout_definition) = 0
    or position('awaiting_admin_acceptance' in closeout_definition) = 0
    or position('update app_private.scanner_assets' in lower(closeout_definition)) > 0 then
    raise exception 'Closeout must retain required evidence, wait for Admin, and leave the register unchanged';
  end if;
  if position('A different Office Admin must save the acceptance signature' in acceptance_definition) = 0
    or position('cannot accept it; another Admin must review it' in acceptance_definition) = 0 then
    raise exception 'Acceptance must require an independent Admin signature';
  end if;
end
$workflow_invariants$;

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

-- Include the branch province with recent Scanner activity in the dashboard.
do $dashboard_province$
declare
  signature regprocedure := 'public.ais_dashboard()'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(
    definition,
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

comment on function public.ais_technician_submit_closeout(uuid,integer,text,text,text,text,text,text,text,text) is
  'Records onsite results and required evidence. A separate Admin acceptance signature is required before delivery or Scanner Serial updates.';
