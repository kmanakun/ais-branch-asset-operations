-- Aggregate multi-Scanner work-order status without bypassing the required closeout,
-- evidence, and Admin acceptance workflow restored by 20261110152000.
-- A Work Order is still active when one scanner is being worked while another
-- scanner is Pending. Partial completion must not hide Open child items.
do $work_order_aggregate$
declare
  signature regprocedure := 'public.ais_branch_work_order_page(text,text,integer,integer)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(
    definition,
    $old$      case
        when bool_and(item_stage = 'cancelled') then 'cancelled'
        when count(*) filter (where item_stage not in ('delivered', 'legacy_completed', 'cancelled')) = 0
          and bool_or(item_stage = 'delivered') then 'delivered'
        when bool_or(item_stage = 'awaiting_admin_exception_review') then 'awaiting_admin_exception_review'
        when bool_or(item_stage = 'awaiting_admin_acceptance') then 'awaiting_admin_acceptance'
        when bool_or(item_stage = 'blocked') then 'blocked'
        when bool_or(item_stage = 'in_progress') then 'in_progress'
        when bool_and(item_stage = 'open') then 'open'
        else 'legacy_completed'
      end as workflow_stage,$old$,
    $new$      case
        when bool_and(item_stage = 'cancelled') then 'cancelled'
        when count(*) filter (where item_stage not in ('delivered', 'legacy_completed', 'cancelled')) = 0
          and bool_or(item_stage = 'delivered') then 'delivered'
        when bool_or(item_stage = 'in_progress') then 'in_progress'
        when bool_or(item_stage in ('awaiting_admin_exception_review', 'awaiting_admin_acceptance', 'blocked'))
          then 'awaiting_admin_exception_review'
        when bool_or(item_stage = 'open') then 'open'
        else 'legacy_completed'
      end as workflow_stage,$new$
  );
  if definition = original_definition
    and strpos(definition, 'when bool_and(item_stage = ''open'') then ''open''') > 0 then
    raise exception 'Could not correct Work Order aggregate status precedence';
  end if;
  if definition <> original_definition then execute definition; end if;
end
$work_order_aggregate$;

do $dashboard_aggregate$
declare
  signature regprocedure := 'public.ais_dashboard()'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(
    definition,
    $old$      case
        when bool_and(stage = 'cancelled') then 'cancelled'
        when count(*) filter (where stage not in ('delivered', 'legacy_completed', 'cancelled')) = 0
          and bool_or(stage = 'delivered') then 'delivered'
        when bool_or(stage = 'awaiting_admin_exception_review') then 'awaiting_admin_exception_review'
        when bool_or(stage = 'awaiting_admin_acceptance') then 'awaiting_admin_acceptance'
        when bool_or(stage = 'blocked') then 'blocked'
        when bool_or(stage = 'in_progress') then 'in_progress'
        when bool_and(stage = 'open') then 'open'
        else 'legacy_completed'
      end as workflow_stage,$old$,
    $new$      case
        when bool_and(stage = 'cancelled') then 'cancelled'
        when count(*) filter (where stage not in ('delivered', 'legacy_completed', 'cancelled')) = 0
          and bool_or(stage = 'delivered') then 'delivered'
        when bool_or(stage = 'in_progress') then 'in_progress'
        when bool_or(stage in ('awaiting_admin_exception_review', 'awaiting_admin_acceptance', 'blocked'))
          then 'awaiting_admin_exception_review'
        when bool_or(stage = 'open') then 'open'
        else 'legacy_completed'
      end as workflow_stage,$new$
  );
  if definition = original_definition
    and strpos(definition, 'when bool_and(stage = ''open'') then ''open''') > 0 then
    raise exception 'Could not correct dashboard Work Order status precedence';
  end if;
  if definition <> original_definition then execute definition; end if;
end
$dashboard_aggregate$;

comment on function public.ais_technician_submit_closeout(uuid,integer,text,text,text,text,text,text,text,text) is
  'Records field work on verified branch work orders. Closeout and required evidence remain subject to separate Admin acceptance before delivery.';
