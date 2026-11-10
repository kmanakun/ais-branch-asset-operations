-- A reviewed mismatch is closed for this target, but it is not a replacement
-- delivery. Keep that state distinct in scanner details and work-order totals.

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
    when p_status = 'scheduled' then 'open'
    when p_status = 'in_progress' and p_closeout_at is null then 'in_progress'
    when p_status = 'in_progress'
      and p_outcome in ('no_damage_found', 'different_device_found', 'target_device_not_found')
      then 'awaiting_admin_exception_review'
    when p_status = 'in_progress' and p_closeout_at is not null then 'awaiting_admin_acceptance'
    when p_status = 'completed'
      and p_admin_accepted_at is not null
      and p_outcome in ('no_damage_found', 'different_device_found', 'target_device_not_found')
      then 'exception_resolved'
    when p_status = 'completed' and (p_admin_accepted_at is not null or p_outcome = 'replaced') then 'delivered'
    when p_status = 'completed' then 'legacy_completed'
    else p_status::text
  end;
$$;

do $work_order_status$
declare
  signature regprocedure := 'public.ais_branch_work_order_page(text,text,integer,integer)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(
    definition,
    $old$if status_filter not in ('all', 'open', 'in_progress', 'blocked', 'awaiting_admin_acceptance',
    'awaiting_admin_exception_review', 'delivered', 'legacy_completed', 'cancelled') then$old$,
    $new$if status_filter not in ('all', 'open', 'in_progress', 'blocked', 'awaiting_admin_acceptance',
    'awaiting_admin_exception_review', 'delivered', 'exception_resolved', 'legacy_completed', 'cancelled') then$new$
  );
  definition := replace(
    definition,
    $old$count(*) filter (where item_stage in ('delivered', 'legacy_completed', 'cancelled'))::integer as finished_count,$old$,
    $new$count(*) filter (where item_stage in ('delivered', 'exception_resolved', 'legacy_completed', 'cancelled'))::integer as finished_count,$new$
  );
  definition := replace(
    definition,
    $old$      case
        when bool_and(item_stage = 'cancelled') then 'cancelled'
        when count(*) filter (where item_stage not in ('delivered', 'legacy_completed', 'cancelled')) = 0
          and bool_or(item_stage = 'delivered') then 'delivered'
        when bool_or(item_stage = 'in_progress') then 'in_progress'
        when bool_or(item_stage in ('awaiting_admin_exception_review', 'awaiting_admin_acceptance', 'blocked'))
          then 'awaiting_admin_exception_review'
        when bool_or(item_stage = 'open') then 'open'
        else 'legacy_completed'
      end as workflow_stage,$old$,
    $new$      case
        when bool_and(item_stage = 'cancelled') then 'cancelled'
        when count(*) filter (where item_stage not in ('delivered', 'exception_resolved', 'legacy_completed', 'cancelled')) = 0
          and bool_or(item_stage = 'exception_resolved') then 'exception_resolved'
        when count(*) filter (where item_stage not in ('delivered', 'exception_resolved', 'legacy_completed', 'cancelled')) = 0
          and bool_or(item_stage = 'delivered') then 'delivered'
        when bool_or(item_stage = 'in_progress') then 'in_progress'
        when bool_or(item_stage in ('awaiting_admin_exception_review', 'awaiting_admin_acceptance', 'blocked'))
          then 'awaiting_admin_exception_review'
        when bool_or(item_stage = 'open') then 'open'
        else 'legacy_completed'
      end as workflow_stage,$new$
  );
  if definition = original_definition then
    raise exception 'Could not add the reviewed-exception work-order state';
  end if;
  execute definition;
end
$work_order_status$;

do $dashboard_status$
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
        when bool_or(stage = 'in_progress') then 'in_progress'
        when bool_or(stage in ('awaiting_admin_exception_review', 'awaiting_admin_acceptance', 'blocked'))
          then 'awaiting_admin_exception_review'
        when bool_or(stage = 'open') then 'open'
        else 'legacy_completed'
      end as workflow_stage,$old$,
    $new$      case
        when bool_and(stage = 'cancelled') then 'cancelled'
        when count(*) filter (where stage not in ('delivered', 'exception_resolved', 'legacy_completed', 'cancelled')) = 0
          and bool_or(stage = 'exception_resolved') then 'exception_resolved'
        when count(*) filter (where stage not in ('delivered', 'exception_resolved', 'legacy_completed', 'cancelled')) = 0
          and bool_or(stage = 'delivered') then 'delivered'
        when bool_or(stage = 'in_progress') then 'in_progress'
        when bool_or(stage in ('awaiting_admin_exception_review', 'awaiting_admin_acceptance', 'blocked'))
          then 'awaiting_admin_exception_review'
        when bool_or(stage = 'open') then 'open'
        else 'legacy_completed'
      end as workflow_stage,$new$
  );
  if definition = original_definition then
    raise exception 'Could not add the reviewed-exception dashboard state';
  end if;
  execute definition;
end
$dashboard_status$;

comment on function app_private.task_workflow_stage(app_private.task_state, timestamptz, timestamptz, timestamptz, text) is
  'Separates Admin-reviewed exceptions from work that was actually replaced and delivered.';
