-- Supabase Storage's standard-upload authorization probe supplies the incoming
-- file size as metadata.contentLength. Persisted storage.objects rows use size.
-- Accept both shapes while retaining the reservation, identity, MIME, and slot
-- checks enforced by can_upload_task_evidence_object.

alter policy "AIS evidence upload for owned reservation"
on storage.objects
with check (
  bucket_id = 'ais-task-evidence'
  and app_private.can_access_task_evidence_object(name, 'write')
  and app_private.can_upload_task_evidence_object(
    name,
    coalesce(metadata ->> 'size', metadata ->> 'contentLength'),
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
    coalesce(metadata ->> 'size', metadata ->> 'contentLength'),
    metadata ->> 'mimetype',
    user_metadata ->> 'reservation_token'
  )
);
