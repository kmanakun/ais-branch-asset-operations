-- Multipart Storage authorization requests may provide contentLength, which is
-- the complete HTTP request body length rather than the uploaded file size.
-- During that preflight, size is absent. Keep the reservation, uploader,
-- workflow, MIME, and one-use token checks; ais_task_evidence_finalize verifies
-- the persisted object size and MIME before marking evidence ready.

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
    when (p_size is null or p_size ~ '^[0-9]{1,6}$')
      and p_reservation_token ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then exists (
      select 1
      from app_private.replacement_task_evidence e
      where e.object_path = p_name
        and e.status = 'pending'
        and e.uploaded_by = auth.uid()
        and e.reservation_token = p_reservation_token::uuid
        and (p_size is null or e.byte_size = p_size::integer)
        and e.content_type = p_content_type
        and app_private.can_edit_task_evidence_slot(e.task_id, e.slot)
    )
    else false
  end;
$$;

revoke all on function app_private.can_upload_task_evidence_object(text, text, text, text) from public, anon;
grant execute on function app_private.can_upload_task_evidence_object(text, text, text, text) to authenticated;

alter policy "AIS evidence upload for owned reservation"
on storage.objects
with check (
  bucket_id = 'ais-task-evidence'
  and app_private.can_access_task_evidence_object(name, 'write')
  and app_private.can_upload_task_evidence_object(
    name,
    metadata ->> 'size',
    metadata ->> 'mimetype',
    user_metadata ->> 'reservation_token'
  )
);

alter policy "AIS evidence replace for owned reservation"
on storage.objects
with check (
  bucket_id = 'ais-task-evidence'
  and app_private.can_access_task_evidence_object(name, 'write')
  and app_private.can_upload_task_evidence_object(
    name,
    metadata ->> 'size',
    metadata ->> 'mimetype',
    user_metadata ->> 'reservation_token'
  )
);

comment on function app_private.can_upload_task_evidence_object(text, text, text, text) is
  'Authorizes a pending evidence reservation. Null metadata.size is allowed only during Storage multipart preflight; finalize verifies the actual stored file size and MIME before evidence becomes ready.';
