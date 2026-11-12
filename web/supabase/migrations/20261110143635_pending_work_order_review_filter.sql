-- Show every order that still needs follow-up under one Pending filter.
-- This migration intentionally leaves field evidence, the independent Admin
-- acceptance signature, and Serial-register updates behind Admin acceptance.

do $work_order_filter$
declare
  signature regprocedure := 'public.ais_branch_work_order_page(text,text,integer,integer)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(
    definition,
    $old$if status_filter not in ('all', 'open', 'in_progress', 'blocked', 'awaiting_admin_acceptance',
    'awaiting_admin_exception_review', 'delivered', 'legacy_completed', 'cancelled') then$old$,
    $new$if status_filter not in ('all', 'open', 'in_progress', 'blocked', 'pending', 'awaiting_admin_acceptance',
    'awaiting_admin_exception_review', 'delivered', 'legacy_completed', 'cancelled') then$new$
  );
  definition := replace(
    definition,
    $old$where status_filter = 'all' or workflow_stage = status_filter$old$,
    $new$where status_filter = 'all' or workflow_stage = status_filter
      or (status_filter = 'pending' and workflow_stage in ('blocked', 'awaiting_admin_acceptance', 'awaiting_admin_exception_review'))$new$
  );
  if definition = original_definition then
    raise exception 'Could not add the unified Pending work-order filter';
  end if;
  execute definition;
end
$work_order_filter$;

comment on function public.ais_branch_work_order_page(text,text,integer,integer) is
  'Pages verified branch work orders. Pending groups blocked and Admin-review stages without changing required evidence or acceptance controls.';
