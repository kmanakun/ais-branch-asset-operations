-- Keep the normalized Serial identity consistent across the register, import,
-- work-order exceptions, and the evidence review workflow.

drop policy if exists "Explicit browser deny branch work orders" on app_private.branch_work_orders;
create policy "Explicit browser deny branch work orders"
on app_private.branch_work_orders
for all to anon, authenticated
using (false)
with check (false);

-- The Admin reviewer has a narrow exception to the normal evidence lock:
-- after technician closeout, they may upload only their own inspector signature.
create or replace function app_private.can_access_task_evidence_object(p_name text, p_operation text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app_private.replacement_task_evidence e
    where e.object_path = p_name
      and (
        (p_operation = 'write' and e.status = 'pending'
          and app_private.can_edit_task_evidence_slot(e.task_id, e.slot))
        or
        (p_operation = 'read' and e.status in ('pending', 'ready')
          and (
            app_private.can_view_task_evidence(e.task_id)
            or app_private.can_edit_task_evidence(e.task_id)
          ))
      )
  );
$$;
revoke all on function app_private.can_access_task_evidence_object(text, text) from public, anon;
grant execute on function app_private.can_access_task_evidence_object(text, text) to authenticated;

create or replace function app_private.can_upload_task_evidence_object(
  p_name text,
  p_size text,
  p_content_type text,
  p_reservation_token text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_size ~ '^[0-9]{1,6}$'
      and p_reservation_token ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then exists (
      select 1
      from app_private.replacement_task_evidence e
      where e.object_path = p_name
        and e.status = 'pending'
        and e.uploaded_by = auth.uid()
        and e.reservation_token = p_reservation_token::uuid
        and e.byte_size = p_size::integer
        and e.content_type = p_content_type
        and app_private.can_edit_task_evidence_slot(e.task_id, e.slot)
    )
    else false
  end;
$$;
revoke all on function app_private.can_upload_task_evidence_object(text, text, text, text) from public, anon;
grant execute on function app_private.can_upload_task_evidence_object(text, text, text, text) to authenticated;

-- Restore the area fields used by the Scanner register search after the
-- branch-work-order query replaced the older list function.
do $scanner_search$
declare
  signature regprocedure := 'public.ais_scanner_page(text,integer,integer)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  if position('coalesce(b.district' in original_definition) > 0 then
    return;
  end if;
  definition := replace(
    definition,
    $before$      or coalesce(b.province, '') ilike '%' || search_term || '%'
      or coalesce(s.model_name, '') ilike '%' || search_term || '%'$before$,
    $after$      or coalesce(b.province, '') ilike '%' || search_term || '%'
      or coalesce(b.district, '') ilike '%' || search_term || '%'
      or coalesce(b.subdistrict, '') ilike '%' || search_term || '%'
      or coalesce(b.high_level_location, '') ilike '%' || search_term || '%'
      or coalesce(b.ro, '') ilike '%' || search_term || '%'
      or coalesce(s.model_name, '') ilike '%' || search_term || '%'$after$
  );
  if definition = original_definition then
    raise exception 'Could not restore all branch-area search fields to %', signature;
  end if;
  execute definition;
end
$scanner_search$;

-- Serial uniqueness is lower(trim(Serial)); align incremental import validation
-- and writes with the same key so case-only variants cannot create a collision.
do $incremental_import$
declare
  signature regprocedure;
  original_definition text;
  definition text;
begin
  signature := 'public.ais_incremental_import_stage(jsonb)'::regprocedure;
  original_definition := pg_get_functiondef(signature);
  definition := replace(
    original_definition,
    $old$regexp_replace(a.com_sn, '^[[:space:]]+|[[:space:]]+$', '', 'g')=s.normalized_data->>'com_sn'$old$,
    $new$lower(btrim(a.com_sn))=lower(btrim(s.normalized_data->>'com_sn'))$new$
  );
  definition := replace(
    definition,
    $old$  delete from app_private.import_row_issues where batch_id = batch and issue_code = 'serial_exists';$old$,
    $new$  delete from app_private.import_row_issues where batch_id = batch and issue_code = 'serial_exists';
  delete from app_private.import_row_issues where batch_id = batch and issue_code = 'duplicate_in_file';
  insert into app_private.import_row_issues(batch_id,row_number,field_name,issue_code,message)
  select batch, staged.row_number, 'com_sn', 'duplicate_in_file', 'Serial ซ้ำภายในไฟล์'
  from app_private.import_staging_rows staged
  join (
    select lower(btrim(normalized_data->>'com_sn')) as serial_key
    from app_private.import_staging_rows
    where batch_id = batch and nullif(btrim(normalized_data->>'com_sn'), '') is not null
    group by lower(btrim(normalized_data->>'com_sn'))
    having count(*) > 1
  ) duplicates on duplicates.serial_key = lower(btrim(staged.normalized_data->>'com_sn'))
  where staged.batch_id = batch;$new$
  );
  if definition = original_definition then
    raise exception 'Could not align incremental import staging with normalized Serial identity';
  end if;
  execute definition;

  signature := 'public.ais_incremental_import_commit(uuid)'::regprocedure;
  original_definition := pg_get_functiondef(signature);
  definition := original_definition;
  definition := replace(
    definition,
    $old$regexp_replace(a.com_sn, '^[[:space:]]+|[[:space:]]+$', '', 'g') = s.normalized_data->>'com_sn'$old$,
    $new$lower(btrim(a.com_sn)) = lower(btrim(s.normalized_data->>'com_sn'))$new$
  );
  definition := replace(
    definition,
    $old$regexp_replace(a.com_sn, '^[[:space:]]+|[[:space:]]+$', '', 'g')=s.normalized_data->>'com_sn'$old$,
    $new$lower(btrim(a.com_sn))=lower(btrim(s.normalized_data->>'com_sn'))$new$
  );
  definition := replace(
    definition,
    $old$regexp_replace(a.com_sn, '^[[:space:]]+|[[:space:]]+$', '', 'g')=d->>'com_sn'$old$,
    $new$lower(btrim(a.com_sn))=lower(btrim(d->>'com_sn'))$new$
  );
  if definition = original_definition then
    raise exception 'Could not align incremental import commit with normalized Serial identity';
  end if;
  execute definition;
end
$incremental_import$;

