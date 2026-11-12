-- The replacement project treats the opening of a work order as the start of
-- the operation. Actual onsite work and its operator are still recorded by
-- field evidence/closeout; legacy rows without a known opener keep started_by
-- null rather than inventing an actor.

do $update_open_rpc$
declare
  function_signature regprocedure := 'public.ais_open_branch_work_order(uuid,uuid[],uuid)'::regprocedure;
  original_definition text := pg_catalog.pg_get_functiondef(function_signature);
  definition text := original_definition;
begin
  if pg_catalog.strpos(definition, $new$
  insert into app_private.replacement_tasks (
    scanner_asset_id, branch_work_order_id, scanner_serial_snapshot, scanner_model_snapshot,
    status, started_at, started_by
  )
  select sa.id, new_order_id, sa.com_sn, coalesce(nullif(sa.model_name, ''), nullif(sa.hw_name, '')),
    'in_progress'::app_private.task_state, work_started_at, actor$new$) > 0
    and pg_catalog.strpos(definition, $new$'selected_scanners', inserted_count, 'status', 'in_progress', 'already_opened', false$new$) > 0 then
    -- The RPC was already updated outside the migration ledger. Keep the
    -- migration safe to apply and record without replacing its body again.
    null;
  elsif pg_catalog.strpos(definition, '  inserted_count integer;') = 0
    or pg_catalog.strpos(definition, '  new_order_id := gen_random_uuid();') = 0
    or pg_catalog.strpos(definition, $old$
  insert into app_private.replacement_tasks (
    scanner_asset_id, branch_work_order_id, scanner_serial_snapshot, scanner_model_snapshot, status
  )
  select sa.id, new_order_id, sa.com_sn, coalesce(nullif(sa.model_name, ''), nullif(sa.hw_name, '')),
    'scheduled'::app_private.task_state$old$) = 0
    or pg_catalog.strpos(definition, $old$'scanner_count', inserted_count, 'started_at', null, 'source', 'verified_register'$old$) = 0
    or pg_catalog.strpos(definition, $old$'selected_scanners', inserted_count, 'status', 'open', 'already_opened', false$old$) = 0 then
    raise exception 'Unexpected ais_open_branch_work_order definition; refusing an incomplete forward update';
  else
  definition := pg_catalog.replace(definition,
    '  inserted_count integer;',
    E'  inserted_count integer;\n  work_started_at timestamptz;');
  definition := pg_catalog.replace(definition,
    '  new_order_id := gen_random_uuid();',
    E'  work_started_at := clock_timestamp();\n  new_order_id := gen_random_uuid();');
  definition := pg_catalog.replace(definition,
    $old$
  insert into app_private.replacement_tasks (
    scanner_asset_id, branch_work_order_id, scanner_serial_snapshot, scanner_model_snapshot, status
  )
  select sa.id, new_order_id, sa.com_sn, coalesce(nullif(sa.model_name, ''), nullif(sa.hw_name, '')),
    'scheduled'::app_private.task_state$old$,
    $new$
  insert into app_private.replacement_tasks (
    scanner_asset_id, branch_work_order_id, scanner_serial_snapshot, scanner_model_snapshot,
    status, started_at, started_by
  )
  select sa.id, new_order_id, sa.com_sn, coalesce(nullif(sa.model_name, ''), nullif(sa.hw_name, '')),
    'in_progress'::app_private.task_state, work_started_at, actor$new$);
  definition := pg_catalog.replace(definition,
    $old$'scanner_count', inserted_count, 'started_at', null, 'source', 'verified_register'$old$,
    $new$'scanner_count', inserted_count, 'started_at', work_started_at, 'source', 'verified_register'$new$);
  definition := pg_catalog.replace(definition,
    $old$'selected_scanners', inserted_count, 'status', 'open', 'already_opened', false$old$,
    $new$'selected_scanners', inserted_count, 'status', 'in_progress', 'already_opened', false$new$);

  execute definition;
  end if;
end
$update_open_rpc$;

with transitioned as (
  update app_private.replacement_tasks rt
  set status = 'in_progress'::app_private.task_state,
      started_at = coalesce(rt.started_at, wo.created_at, rt.created_at),
      version = rt.version + 1,
      updated_at = clock_timestamp()
  from app_private.branch_work_orders wo
  where wo.id = rt.branch_work_order_id
    and rt.status = 'scheduled'
  returning rt.id, rt.branch_work_order_id, rt.started_at, rt.version
)
insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
select null, 'work_order_activated_on_open', 'replacement_task', transitioned.id,
  jsonb_build_object(
    'work_order_id', transitioned.branch_work_order_id,
    'from_status', 'scheduled',
    'to_status', 'in_progress',
    'started_at', transitioned.started_at,
    'version', transitioned.version,
    'actor_attribution', 'unavailable_for_legacy_work_order',
    'source', 'forward_migration'
  )
from transitioned;

comment on function public.ais_open_branch_work_order(uuid, uuid[], uuid) is
  'Creates a branch work order whose items are immediately in progress; the opener and opening timestamp are retained, with actual onsite operator recorded in field evidence.';
