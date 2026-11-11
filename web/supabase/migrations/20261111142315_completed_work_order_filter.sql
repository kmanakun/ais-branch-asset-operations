-- Keep a dedicated completed-work-orders view aligned with every terminal,
-- non-cancelled work-order stage, including Admin-reviewed exceptions.
do $completed_work_order_page$
declare
  signature regprocedure := 'public.ais_branch_work_order_page(text,text,integer,integer)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
  old_filter text := $old$'awaiting_admin_exception_review', 'delivered', 'legacy_completed', 'cancelled') then$old$;
  new_filter text := $new$'awaiting_admin_exception_review', 'delivered', 'exception_resolved', 'legacy_completed', 'cancelled', 'complete') then$new$;
  old_pending text := $old$      or (status_filter = 'pending' and workflow_stage in ('blocked', 'awaiting_admin_acceptance', 'awaiting_admin_exception_review'))$old$;
  new_pending text := $new$      or (status_filter = 'pending' and workflow_stage in ('blocked', 'awaiting_admin_acceptance', 'awaiting_admin_exception_review'))
      or (status_filter = 'complete' and workflow_stage in ('delivered', 'exception_resolved', 'legacy_completed'))$new$;
  old_count text := $old$count(*) filter (where workflow_stage in ('delivered', 'legacy_completed'))::integer as completed,$old$;
  new_count text := $new$count(*) filter (where workflow_stage in ('delivered', 'exception_resolved', 'legacy_completed'))::integer as completed,$new$;
begin
  if position(old_filter in definition) = 0 then
    raise exception 'Expected work-order status validation was not found; migration stopped without changing the RPC';
  end if;
  definition := replace(definition, old_filter, new_filter);

  if position(old_pending in definition) = 0 then
    raise exception 'Expected work-order pending filter was not found; migration stopped without changing the RPC';
  end if;
  definition := replace(definition, old_pending, new_pending);

  if position(old_count in definition) = 0 then
    raise exception 'Expected completed work-order count was not found; migration stopped without changing the RPC';
  end if;
  definition := replace(definition, old_count, new_count);

  execute definition;
end
$completed_work_order_page$;
