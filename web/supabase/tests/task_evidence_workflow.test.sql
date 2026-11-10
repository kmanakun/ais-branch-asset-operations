begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select ok(not has_function_privilege('anon', 'public.ais_task_evidence_list(uuid)', 'EXECUTE'), 'anonymous callers cannot list task evidence');
select ok(not has_function_privilege('anon', 'public.ais_task_evidence_reserve(uuid,text,integer,text,boolean)', 'EXECUTE'), 'anonymous callers cannot reserve task evidence');
select ok(not has_function_privilege('anon', 'public.ais_task_evidence_finalize(uuid,text)', 'EXECUTE'), 'anonymous callers cannot finalize task evidence');
select ok(not has_function_privilege('anon', 'public.ais_task_evidence_cancel_pending(uuid,text)', 'EXECUTE'), 'anonymous callers cannot cancel task evidence');
select ok(has_function_privilege('authenticated', 'public.ais_task_evidence_list(uuid)', 'EXECUTE'), 'authenticated users can reach the guarded evidence list');
select ok(has_function_privilege('authenticated', 'public.ais_task_evidence_reserve(uuid,text,integer,text,boolean)', 'EXECUTE'), 'authenticated users can reach the guarded evidence reservation');
select ok(has_function_privilege('authenticated', 'public.ais_task_evidence_finalize(uuid,text)', 'EXECUTE'), 'authenticated users can reach the guarded evidence finalizer');
select ok(has_function_privilege('authenticated', 'public.ais_task_evidence_cancel_pending(uuid,text)', 'EXECUTE'), 'authenticated users can reach the guarded evidence cancellation');

insert into auth.users(id, aud, role, email, created_at, updated_at) values
  ('fc810000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'evidence-tech-a@test.invalid', now(), now()),
  ('fc810000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'evidence-tech-b@test.invalid', now(), now()),
  ('fc810000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'evidence-admin@test.invalid', now(), now()),
  ('fc810000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'evidence-inactive@test.invalid', now(), now()),
  ('fc810000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'evidence-unprovisioned@test.invalid', now(), now()),
  ('fc810000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'evidence-reviewer@test.invalid', now(), now());

insert into app_private.user_access(user_id, role, display_name, is_active) values
  ('fc810000-0000-4000-8000-000000000001', 'field_technician', 'Evidence Tech A', true),
  ('fc810000-0000-4000-8000-000000000002', 'field_technician', 'Evidence Tech B', true),
  ('fc810000-0000-4000-8000-000000000003', 'admin', 'Evidence Admin', true),
  ('fc810000-0000-4000-8000-000000000006', 'admin', 'Evidence Reviewer', true),
  ('fc810000-0000-4000-8000-000000000004', 'field_technician', 'Inactive Evidence Tech', false);

insert into app_private.teams(id, team_name) values
  ('fc810000-0000-4000-8000-000000000010', 'Evidence Team A'),
  ('fc810000-0000-4000-8000-000000000011', 'Evidence Team B');
insert into app_private.branches(id, location_code, loc_bld) values
  ('fc810000-0000-4000-8000-000000000020', 'EVIDENCE-A', 'Evidence Branch A'),
  ('fc810000-0000-4000-8000-000000000021', 'EVIDENCE-B', 'Evidence Branch B'),
  ('fc810000-0000-4000-8000-000000000022', 'EVIDENCE-UNASSIGNED', 'Unassigned Evidence Branch');
insert into app_private.scanner_assets(id, branch_id, com_sn, model_name) values
  ('fc810000-0000-4000-8000-000000000030', 'fc810000-0000-4000-8000-000000000020', 'EVIDENCE-OLD-1', 'Evidence Test Scanner'),
  ('fc810000-0000-4000-8000-000000000031', 'fc810000-0000-4000-8000-000000000021', 'EVIDENCE-OLD-2', 'Evidence Test Scanner'),
  ('fc810000-0000-4000-8000-000000000032', 'fc810000-0000-4000-8000-000000000022', 'EVIDENCE-OLD-3', 'Evidence Test Scanner'),
  ('fc810000-0000-4000-8000-000000000035', 'fc810000-0000-4000-8000-000000000022', 'EVIDENCE-OLD-ADMIN', 'Evidence Test Scanner');
insert into app_private.campaigns(id, campaign_code, campaign_name, status) values
  ('fc810000-0000-4000-8000-000000000040', 'EVIDENCE-WORKFLOW', 'Evidence workflow tests', 'scheduled'),
  ('fc810000-0000-4000-8000-000000000041', 'EVIDENCE-UNASSIGNED', 'Unassigned evidence test', 'draft');
insert into app_private.campaign_items(id, campaign_id, scanner_asset_id, selection_reason) values
  ('fc810000-0000-4000-8000-000000000050', 'fc810000-0000-4000-8000-000000000040', 'fc810000-0000-4000-8000-000000000030', 'Local evidence fixture'),
  ('fc810000-0000-4000-8000-000000000051', 'fc810000-0000-4000-8000-000000000040', 'fc810000-0000-4000-8000-000000000031', 'Local evidence fixture'),
  ('fc810000-0000-4000-8000-000000000052', 'fc810000-0000-4000-8000-000000000041', 'fc810000-0000-4000-8000-000000000032', 'Local evidence fixture');
insert into app_private.branch_work_orders(id, work_order_code, branch_id, origin, created_by) values
  ('fc810000-0000-4000-8000-000000000080', 'EVIDENCE-WO-1', 'fc810000-0000-4000-8000-000000000020', 'admin', 'fc810000-0000-4000-8000-000000000003'),
  ('fc810000-0000-4000-8000-000000000081', 'EVIDENCE-WO-2', 'fc810000-0000-4000-8000-000000000021', 'admin', 'fc810000-0000-4000-8000-000000000003'),
  ('fc810000-0000-4000-8000-000000000082', 'EVIDENCE-WO-3', 'fc810000-0000-4000-8000-000000000022', 'admin', 'fc810000-0000-4000-8000-000000000003');
insert into app_private.replacement_tasks(id, campaign_item_id, team_id, status, scanner_asset_id,
  branch_work_order_id, scanner_serial_snapshot) values
  ('fc810000-0000-4000-8000-000000000060', 'fc810000-0000-4000-8000-000000000050', 'fc810000-0000-4000-8000-000000000010', 'scheduled', 'fc810000-0000-4000-8000-000000000030', 'fc810000-0000-4000-8000-000000000080', 'EVIDENCE-OLD-1'),
  ('fc810000-0000-4000-8000-000000000061', 'fc810000-0000-4000-8000-000000000051', 'fc810000-0000-4000-8000-000000000011', 'scheduled', 'fc810000-0000-4000-8000-000000000031', 'fc810000-0000-4000-8000-000000000081', 'EVIDENCE-OLD-2'),
  ('fc810000-0000-4000-8000-000000000062', 'fc810000-0000-4000-8000-000000000052', null, 'scheduled', 'fc810000-0000-4000-8000-000000000032', 'fc810000-0000-4000-8000-000000000082', 'EVIDENCE-OLD-3');

create temporary table evidence_test_state(reservation jsonb);
insert into evidence_test_state values (null);
grant select, update on evidence_test_state to authenticated;

create function pg_temp.save_task_evidence(
  p_task_id uuid, p_slot text, p_byte_size integer,
  p_signer_name text default null, p_consent_confirmed boolean default false
)
returns text
language plpgsql
set search_path = ''
as $function$
declare
  reservation jsonb;
begin
  reservation := public.ais_task_evidence_reserve(
    p_task_id, p_slot, p_byte_size, p_signer_name, p_consent_confirmed
  );
  insert into storage.objects(bucket_id, name, owner, owner_id, metadata, user_metadata)
  values (
    'ais-task-evidence', reservation ->> 'path', auth.uid(), auth.uid()::text,
    pg_catalog.jsonb_build_object('size', p_byte_size, 'mimetype', 'image/jpeg'),
    pg_catalog.jsonb_build_object('reservation_token', reservation ->> 'reservation_token')
  );
  return public.ais_task_evidence_finalize(p_task_id, p_slot) ->> 'status';
end;
$function$;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fc810000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc810000-0000-4000-8000-000000000002","role":"authenticated"}', true);

select is(public.ais_field_task_action('fc810000-0000-4000-8000-000000000060', 'start', 1)->>'status', 'in_progress', 'a technician without team membership can start work without confirming the verified target Serial');
select ok(app_private.can_edit_task_evidence('fc810000-0000-4000-8000-000000000060'), 'any active technician can edit evidence for an assigned in-progress work order');
select throws_ok($$select public.ais_task_evidence_reserve('fc810000-0000-4000-8000-000000000060', 'technician_signature', 8192, null, false)$$,
  '22023', 'Signature and consent confirmation are required', 'technician signature reservation requires affirmative consent');
select throws_ok($$select public.ais_task_evidence_reserve('fc810000-0000-4000-8000-000000000060', 'old_device_photo', 100000)$$,
  '22023', 'Evidence file exceeds its slot size limit', 'photo slot enforces its per-file size limit');
select throws_ok($$select public.ais_task_evidence_reserve('fc810000-0000-4000-8000-000000000060', 'old_device_photo', 64, null, true)$$,
  '22023', 'Photo evidence cannot contain signature consent fields', 'photo slots reject signature consent metadata');

update evidence_test_state
set reservation = public.ais_task_evidence_reserve('fc810000-0000-4000-8000-000000000060', 'old_serial_photo', 64);

select set_config('request.jwt.claim.sub', 'fc810000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc810000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select ok(app_private.can_access_task_evidence_object((select reservation->>'path' from evidence_test_state), 'write'), 'a second active technician may access evidence without matching a team');
select ok(not app_private.can_upload_task_evidence_object(
  (select reservation->>'path' from evidence_test_state), '64', 'image/jpeg',
  (select reservation->>'reservation_token' from evidence_test_state)
), 'a different technician cannot use another uploader reservation token');
select is(jsonb_array_length(public.ais_task_evidence_list('fc810000-0000-4000-8000-000000000060')), 1, 'a technician can view another technician evidence across teams');

select set_config('request.jwt.claim.sub', 'fc810000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc810000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok($$insert into storage.objects(bucket_id, name, owner, owner_id, metadata, user_metadata)
  select 'ais-task-evidence', reservation->>'path', auth.uid(), auth.uid()::text,
    pg_catalog.jsonb_build_object('size', 64, 'mimetype', 'image/jpeg'),
    pg_catalog.jsonb_build_object('reservation_token', reservation->>'reservation_token')
  from evidence_test_state$$, 'Storage RLS accepts the reserved JPEG and one-use uploader token');
select is(public.ais_task_evidence_finalize('fc810000-0000-4000-8000-000000000060', 'old_serial_photo')->>'status', 'ready', 'matching Storage object finalizes the evidence reservation');
select is(pg_temp.save_task_evidence('fc810000-0000-4000-8000-000000000060', 'new_serial_photo', 64), 'ready', 'routine replacement records a photo of the new Serial');
select is(pg_temp.save_task_evidence('fc810000-0000-4000-8000-000000000060', 'old_device_photo', 64), 'ready', 'routine replacement records the old device photo');
select is(pg_temp.save_task_evidence('fc810000-0000-4000-8000-000000000060', 'new_device_photo', 64), 'ready', 'routine replacement records the new device photo');
select is(pg_temp.save_task_evidence('fc810000-0000-4000-8000-000000000060', 'technician_signature', 8192, null, true), 'ready', 'routine replacement records the onsite technician signature');
select is(pg_temp.save_task_evidence('fc810000-0000-4000-8000-000000000060', 'scanner_user_signature', 8192, 'Scanner User One', true), 'ready', 'routine replacement records the Scanner user signature');
select is(public.ais_technician_submit_closeout('fc810000-0000-4000-8000-000000000060', 2, 'replaced', 'EVIDENCE-NEW-1', 'Installed and tested', 'returned_usable')->>'workflow_stage', 'awaiting_admin_acceptance', 'routine replacement closeout waits for separate Admin acceptance');
select throws_ok($$select public.ais_task_evidence_reserve('fc810000-0000-4000-8000-000000000060', 'spare_photo_1', 64)$$,
  '42501', 'Task evidence is not editable', 'technician cannot alter evidence after submitting closeout');

reset role;
select is((select status::text from app_private.replacement_tasks where id = 'fc810000-0000-4000-8000-000000000060'), 'in_progress', 'routine closeout remains open while Admin acceptance is pending');
select is((select com_sn from app_private.scanner_assets where id = 'fc810000-0000-4000-8000-000000000030'), 'EVIDENCE-OLD-1', 'the register Serial remains unchanged before Admin acceptance');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fc810000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc810000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is(pg_temp.save_task_evidence('fc810000-0000-4000-8000-000000000060', 'inspector_signature', 8192, null, true), 'ready', 'a separate Admin records the acceptance signature');
select is(public.ais_admin_accept_task('fc810000-0000-4000-8000-000000000060', 3, false)->>'workflow_stage', 'delivered', 'a separate Admin accepts the routine replacement and delivers the work');
reset role;
select is((select status::text from app_private.replacement_tasks where id = 'fc810000-0000-4000-8000-000000000060'), 'completed', 'Admin acceptance completes the work item');
select is((select com_sn from app_private.scanner_assets where id = 'fc810000-0000-4000-8000-000000000030'), 'EVIDENCE-NEW-1', 'the register Serial changes only after Admin acceptance');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fc810000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc810000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.ais_task_evidence_reserve('fc810000-0000-4000-8000-000000000060', 'spare_photo_1', 64)$$,
  '55000', 'Task is no longer in progress', 'Admin cannot add evidence after a normal replacement is completed');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fc810000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc810000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select ok(exists(select 1 from storage.objects where bucket_id = 'ais-task-evidence' and name = 'fc810000-0000-4000-8000-000000000060/old_serial_photo.jpg'), 'another active technician can read the accepted evidence after delivery');
select is(jsonb_array_length(public.ais_task_evidence_list('fc810000-0000-4000-8000-000000000060')), 7, 'all required photos and signatures remain visible after delivery');

select set_config('request.jwt.claim.sub', 'fc810000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc810000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(public.ais_field_task_action('fc810000-0000-4000-8000-000000000061', 'start', 1)->>'status', 'in_progress', 'technician starts the second assigned scanner without a duplicate target confirmation');
select is(pg_temp.save_task_evidence('fc810000-0000-4000-8000-000000000061', 'new_device_photo', 64), 'ready', 'different-device exception saves a photo of the device found');
select is(pg_temp.save_task_evidence('fc810000-0000-4000-8000-000000000061', 'new_serial_photo', 64), 'ready', 'different-device exception saves a clear photo of the observed Serial');
select is(pg_temp.save_task_evidence('fc810000-0000-4000-8000-000000000061', 'technician_signature', 8192, null, true), 'ready', 'exception closeout saves the technician signature');
select is(pg_temp.save_task_evidence('fc810000-0000-4000-8000-000000000061', 'scanner_user_signature', 8192, 'Scanner User Two', true), 'ready', 'exception closeout saves the Scanner user signature');
select throws_ok($$select public.ais_task_evidence_reserve('fc810000-0000-4000-8000-000000000061', 'inspector_signature', 8192, 'Inspector', true)$$,
  '42501', 'Task evidence is not editable', 'technician cannot sign the Admin acceptance slot');
select is(public.ais_technician_submit_closeout('fc810000-0000-4000-8000-000000000061', 2, 'different_device_found', null, 'Different device observed', 'other', null, 'OBSERVED-OTHER-2', 'Other scanner model', 'Target device did not match the assigned scanner')->>'workflow_stage', 'awaiting_admin_exception_review', 'different-device outcome records the observed Serial and is routed for Admin review');

select set_config('request.jwt.claim.sub', 'fc810000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc810000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is(pg_temp.save_task_evidence('fc810000-0000-4000-8000-000000000061', 'inspector_signature', 8192, null, true), 'ready', 'Admin signs the reviewed different-device exception');
reset role;
insert into app_private.scanner_assets (branch_id, com_sn, model_name)
values ('fc810000-0000-4000-8000-000000000020', 'OBSERVED-OTHER-2', 'Already registered elsewhere');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fc810000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc810000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.ais_admin_accept_task('fc810000-0000-4000-8000-000000000061', 3, true)$$,
  '23505', 'This Serial is already registered to another branch; resolve that record before acceptance', 'Admin cannot duplicate or move an observed Serial registered at another branch');
select throws_ok($$select public.ais_admin_accept_task('fc810000-0000-4000-8000-000000000061', 3, false)$$,
  '23505', 'This Serial is already registered to another branch; resolve that record before acceptance', 'Admin cannot bypass the cross-branch check by accepting without adding the Serial');
reset role;
select is((select status::text from app_private.replacement_tasks where id = 'fc810000-0000-4000-8000-000000000061'), 'in_progress', 'cross-branch duplicate rejection keeps the exception open for review');
select is((select com_sn from app_private.scanner_assets where id = 'fc810000-0000-4000-8000-000000000031'), 'EVIDENCE-OLD-2', 'cross-branch duplicate rejection leaves the original registered Serial unchanged');
delete from app_private.scanner_assets where com_sn = 'OBSERVED-OTHER-2' and branch_id = 'fc810000-0000-4000-8000-000000000020';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fc810000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc810000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is(public.ais_admin_accept_task('fc810000-0000-4000-8000-000000000061', 3, true)->>'workflow_stage', 'exception_resolved', 'Admin resolves the exception and registers the observed Serial without marking a replacement delivered');
reset role;
select is((select scanner.value->>'workflow_stage'
  from jsonb_array_elements(public.ais_branch_work_order_page(null, 'all', 20, 0)->'rows') as work_order(value)
  cross join lateral jsonb_array_elements(work_order.value->'scanners') as scanner(value)
  where scanner.value->>'task_id' = 'fc810000-0000-4000-8000-000000000061'),
  'exception_resolved', 'the work-order detail retains the reviewed-exception status');
select is((select work_order.value->>'workflow_stage'
  from jsonb_array_elements(public.ais_branch_work_order_page(null, 'all', 20, 0)->'rows') as work_order(value)
  where work_order.value->>'id' = 'fc810000-0000-4000-8000-000000000081'),
  'exception_resolved', 'an exception-only work order is not reported as delivered');
select is((select com_sn from app_private.scanner_assets where id = 'fc810000-0000-4000-8000-000000000031'), 'EVIDENCE-OLD-2', 'different-device acceptance preserves the registered scanner Serial');
select is((select count(*)::integer from app_private.scanner_assets where branch_id = 'fc810000-0000-4000-8000-000000000021' and com_sn = 'OBSERVED-OTHER-2'), 1, 'reviewed different-device Serial is added to the correct branch register');
select is((select outcome from app_private.field_visits where task_id = 'fc810000-0000-4000-8000-000000000061'), 'different_device_found', 'different-device result is retained in the field visit');
select is((select status::text from app_private.campaigns where id = 'fc810000-0000-4000-8000-000000000040'), 'scheduled', 'legacy campaign metadata remains unchanged because delivery is tracked by the branch work order');

insert into app_private.branch_work_orders(id, work_order_code, branch_id, origin, created_by)
values ('fc810000-0000-4000-8000-000000000070', 'EVIDENCE-ADMIN-FIELD', 'fc810000-0000-4000-8000-000000000022', 'admin', 'fc810000-0000-4000-8000-000000000003');
insert into app_private.replacement_tasks(id, campaign_item_id, team_id, status, scanner_asset_id,
  branch_work_order_id, scanner_serial_snapshot)
values ('fc810000-0000-4000-8000-000000000063', null, null, 'scheduled',
  'fc810000-0000-4000-8000-000000000035', 'fc810000-0000-4000-8000-000000000070', 'EVIDENCE-OLD-ADMIN');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fc810000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc810000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is(public.ais_field_task_action('fc810000-0000-4000-8000-000000000063', 'start', 1)->>'status', 'in_progress', 'a work order without team assignment can start using the approved onsite flow');
select is(pg_temp.save_task_evidence('fc810000-0000-4000-8000-000000000063', 'old_serial_photo', 64), 'ready', 'Admin acting onsite can record the old Serial photo');
select is(pg_temp.save_task_evidence('fc810000-0000-4000-8000-000000000063', 'new_serial_photo', 64), 'ready', 'Admin acting onsite can record the new Serial photo');
select is(pg_temp.save_task_evidence('fc810000-0000-4000-8000-000000000063', 'old_device_photo', 64), 'ready', 'Admin acting onsite can record the old device photo');
select is(pg_temp.save_task_evidence('fc810000-0000-4000-8000-000000000063', 'new_device_photo', 64), 'ready', 'Admin acting onsite can record the new device photo');
select is(pg_temp.save_task_evidence('fc810000-0000-4000-8000-000000000063', 'technician_signature', 8192, null, true), 'ready', 'Admin acting onsite can record the performer signature');
select is(pg_temp.save_task_evidence('fc810000-0000-4000-8000-000000000063', 'scanner_user_signature', 8192, 'Scanner User Three', true), 'ready', 'Admin acting onsite can record the Scanner user signature');
select is(public.ais_technician_submit_closeout('fc810000-0000-4000-8000-000000000063', 2, 'replaced', 'EVIDENCE-NEW-3', 'Installed and tested', 'returned_usable')->>'workflow_stage', 'awaiting_admin_acceptance', 'Admin can close out onsite work but must await a different Admin');
select throws_ok($$select public.ais_task_evidence_reserve('fc810000-0000-4000-8000-000000000063', 'inspector_signature', 8192, null, true)$$,
  '42501', 'Task evidence is not editable', 'the Admin who performed onsite work cannot sign its acceptance');
select throws_ok($$select public.ais_admin_accept_task('fc810000-0000-4000-8000-000000000063', 3, false)$$,
  '42501', 'The Admin who performed this work cannot accept it; another Admin must review it', 'the performing Admin cannot self-accept the work');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fc810000-0000-4000-8000-000000000006', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc810000-0000-4000-8000-000000000006","role":"authenticated"}', true);
select is(pg_temp.save_task_evidence('fc810000-0000-4000-8000-000000000063', 'inspector_signature', 8192, null, true), 'ready', 'a different Admin can sign onsite work acceptance');
select is(public.ais_admin_accept_task('fc810000-0000-4000-8000-000000000063', 3, false)->>'workflow_stage', 'delivered', 'a different Admin accepts and delivers onsite work');
reset role;
select is((select com_sn from app_private.scanner_assets where id = 'fc810000-0000-4000-8000-000000000035'), 'EVIDENCE-NEW-3', 'the register Serial updates only after separate Admin acceptance');
reset role;

insert into app_private.scanner_assets(id, branch_id, com_sn, model_name) values
  ('fc810000-0000-4000-8000-000000000033', 'fc810000-0000-4000-8000-000000000022', 'EVIDENCE-OLD-4', 'Evidence Test Scanner'),
  ('fc810000-0000-4000-8000-000000000034', 'fc810000-0000-4000-8000-000000000022', 'EVIDENCE-OLD-5', 'Evidence Test Scanner');
insert into app_private.replacement_tasks(id, campaign_item_id, team_id, status, scanner_asset_id,
  branch_work_order_id, scanner_serial_snapshot) values
  ('fc810000-0000-4000-8000-000000000064', null, null, 'scheduled', 'fc810000-0000-4000-8000-000000000033', 'fc810000-0000-4000-8000-000000000070', 'EVIDENCE-OLD-4'),
  ('fc810000-0000-4000-8000-000000000065', null, null, 'scheduled', 'fc810000-0000-4000-8000-000000000034', 'fc810000-0000-4000-8000-000000000070', 'EVIDENCE-OLD-5');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fc810000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc810000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is(public.ais_branch_work_order_page(null, 'all', 20, 0)->'rows'->0->>'workflow_stage', 'open', 'a Work Order remains Open when completed and not-yet-started scanners coexist');
select is(public.ais_field_task_action('fc810000-0000-4000-8000-000000000064', 'start', 1)->>'status', 'in_progress', 'first scanner can proceed independently');
select is(public.ais_field_task_action('fc810000-0000-4000-8000-000000000065', 'start', 1)->>'status', 'in_progress', 'second scanner can proceed independently');
select is(public.ais_field_task_action('fc810000-0000-4000-8000-000000000065', 'block', 2, 'Waiting for site access')->>'status', 'blocked', 'one scanner can be Pending without stopping another');
select is(public.ais_branch_work_order_page(null, 'all', 20, 0)->'rows'->0->>'workflow_stage', 'in_progress', 'an active scanner keeps the parent Work Order In Progress while another is Pending');
select is(public.ais_field_task_action('fc810000-0000-4000-8000-000000000064', 'block', 2, 'Waiting for site access')->>'status', 'blocked', 'the remaining active scanner can independently become Pending');
select is(public.ais_branch_work_order_page(null, 'all', 20, 0)->'rows'->0->>'workflow_stage', 'awaiting_admin_exception_review', 'a Work Order becomes Pending when every unfinished scanner is Pending');
reset role;

insert into app_private.replacement_tasks(id, campaign_item_id, team_id, status, scanner_asset_id, scanner_serial_snapshot)
values ('fc810000-0000-4000-8000-000000000066', 'fc810000-0000-4000-8000-000000000052', null, 'scheduled', null, null);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fc810000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc810000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$select public.ais_task_evidence_list('fc810000-0000-4000-8000-000000000066')$$,
  '42501', 'Task evidence is outside your assigned access', 'technicians cannot access a task that was never opened as a work order');
select throws_ok($$select public.ais_field_task_action('fc810000-0000-4000-8000-000000000066', 'start', 1)$$,
  '42501', 'Field Technicians can only access opened work orders', 'technicians cannot start an orphan task outside an opened work order');
select set_config('request.jwt.claim.sub', 'fc810000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc810000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select throws_ok($$select public.ais_task_evidence_list('fc810000-0000-4000-8000-000000000060')$$,
  '42501', 'Task evidence is outside your assigned access', 'inactive technicians cannot view evidence');
select set_config('request.jwt.claim.sub', 'fc810000-0000-4000-8000-000000000005', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fc810000-0000-4000-8000-000000000005","role":"authenticated"}', true);
select throws_ok($$select public.ais_task_evidence_list('fc810000-0000-4000-8000-000000000060')$$,
  '42501', 'Task evidence is outside your assigned access', 'unprovisioned users cannot view evidence');

reset role;
select * from finish();
rollback;
