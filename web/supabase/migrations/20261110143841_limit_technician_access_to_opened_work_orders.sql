-- Field Technicians can act on work orders opened from the verified register.
-- Admin can still support all workflow stages, subject to the independent
-- acceptance-signature rule.

create or replace function app_private.can_view_task_evidence(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from app_private.user_access ua
    join app_private.replacement_tasks rt on rt.id = p_task_id
    where ua.user_id = auth.uid() and ua.is_active
      and ua.role in ('admin', 'field_technician')
      and (ua.role = 'admin' or rt.branch_work_order_id is not null)
  );
$$;

create or replace function app_private.can_edit_task_evidence(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from app_private.user_access ua
    join app_private.replacement_tasks rt on rt.id = p_task_id and rt.status = 'in_progress'
    where ua.user_id = auth.uid() and ua.is_active
      and ua.role in ('admin', 'field_technician')
      and (ua.role = 'admin' or rt.branch_work_order_id is not null)
      and rt.closeout_submitted_at is null
  );
$$;

create or replace function app_private.can_edit_task_evidence_slot(p_task_id uuid, p_slot text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from app_private.user_access ua
    join app_private.replacement_tasks rt on rt.id = p_task_id
    where ua.user_id = auth.uid() and ua.is_active
      and (
        (p_slot = 'inspector_signature' and ua.role = 'admin'
          and rt.status = 'in_progress' and rt.closeout_submitted_at is not null
          and rt.admin_accepted_at is null
          and auth.uid() is distinct from rt.closeout_submitted_by
          and not exists (
            select 1 from app_private.field_visits fv
            where fv.task_id = rt.id and fv.performed_by = auth.uid()
          ))
        or
        (p_slot <> 'inspector_signature' and p_slot in (
          'old_serial_photo', 'new_serial_photo', 'old_device_photo', 'new_device_photo',
          'spare_photo_1', 'spare_photo_2', 'technician_signature', 'scanner_user_signature'
        ) and ua.role in ('admin', 'field_technician')
          and (ua.role = 'admin' or rt.branch_work_order_id is not null)
          and rt.status = 'in_progress' and rt.closeout_submitted_at is null)
      )
  );
$$;

revoke all on function app_private.can_view_task_evidence(uuid) from public, anon, authenticated;
revoke all on function app_private.can_edit_task_evidence(uuid) from public, anon, authenticated;
revoke all on function app_private.can_edit_task_evidence_slot(uuid, text) from public, anon, authenticated;
grant execute on function app_private.can_view_task_evidence(uuid) to authenticated;
grant execute on function app_private.can_edit_task_evidence(uuid) to authenticated;
grant execute on function app_private.can_edit_task_evidence_slot(uuid, text) to authenticated;

do $field_action$
declare
  signature regprocedure := 'public.ais_field_task_action(uuid,text,integer,text,text,text,text,text)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(
    definition,
    $old$  task_status app_private.task_state;
  task_version integer;$old$,
    $new$  task_status app_private.task_state;
  task_version integer;
  task_work_order_id uuid;$new$
  );
  definition := replace(
    definition,
    $old$  select rt.status, rt.version into task_status, task_version
  from app_private.replacement_tasks rt where rt.id = p_task_id for update;$old$,
    $new$  select rt.status, rt.version, rt.branch_work_order_id
  into task_status, task_version, task_work_order_id
  from app_private.replacement_tasks rt where rt.id = p_task_id for update;$new$
  );
  definition := replace(
    definition,
    $old$  if not found then raise exception 'Work item was not found' using errcode = 'P0002'; end if;$old$,
    $new$  if not found then raise exception 'Work item was not found' using errcode = 'P0002'; end if;
  if actor_role = 'field_technician' and task_work_order_id is null then
    raise exception 'Field Technicians can only access opened work orders' using errcode = '42501';
  end if;$new$
  );
  if definition = original_definition then
    raise exception 'Could not restrict technician actions to opened work orders';
  end if;
  execute definition;
end
$field_action$;

do $closeout_access$
declare
  signature regprocedure := 'public.ais_technician_submit_closeout(uuid,integer,text,text,text,text,text,text,text,text)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text;
begin
  definition := replace(
    original_definition,
    $old$  if not found then raise exception 'Scanner work item was not found' using errcode = 'P0002'; end if;
  if task_version <> p_expected_version then$old$,
    $new$  if not found then raise exception 'Scanner work item was not found' using errcode = 'P0002'; end if;
  if actor_role = 'field_technician' and not exists (
    select 1 from app_private.replacement_tasks rt
    where rt.id = p_task_id and rt.branch_work_order_id is not null
  ) then
    raise exception 'Field Technicians can only submit closeout for opened work orders' using errcode = '42501';
  end if;
  if task_version <> p_expected_version then$new$
  );
  if definition = original_definition then
    raise exception 'Could not restrict technician closeout to opened work orders';
  end if;
  execute definition;
end
$closeout_access$;

do $legacy_task_page$
declare
  signature regprocedure := 'public.ais_task_filtered_page(text,text,integer,integer)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(
    definition,
    $old$if status_filter not in ('all', 'in_progress', 'blocked', 'completed', 'cancelled',$old$,
    $new$if status_filter not in ('all', 'open', 'in_progress', 'blocked', 'completed', 'cancelled',$new$
  );
  definition := replace(
    definition,
    $old$  ), matching_tasks as materialized ($old$,
    $new$    where rt.branch_work_order_id is not null
  ), matching_tasks as materialized ($new$
  );
  if definition = original_definition then
    raise exception 'Could not align the legacy task page with opened work orders';
  end if;
  execute definition;
end
$legacy_task_page$;
