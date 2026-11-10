-- Keep private evidence metadata inaccessible through direct browser table access.
create policy replacement_task_evidence_deny_browser
  on app_private.replacement_task_evidence
  for all to anon, authenticated
  using (false)
  with check (false);

revoke all on table app_private.replacement_task_evidence
  from public, anon, authenticated;

-- The Storage policies call these SECURITY DEFINER helpers as authenticated users.
-- Remove inherited PUBLIC/anon execution and grant only the signed-in role needed by
-- the private Storage bucket policies.
revoke all on function app_private.can_edit_task_evidence(uuid)
  from public, anon, authenticated;
revoke all on function app_private.can_view_task_evidence(uuid)
  from public, anon, authenticated;
revoke all on function app_private.can_access_task_evidence_object(text, text)
  from public, anon, authenticated;
revoke all on function app_private.can_upload_task_evidence_object(text, text, text, text)
  from public, anon, authenticated;

grant execute on function app_private.can_edit_task_evidence(uuid) to authenticated;
grant execute on function app_private.can_view_task_evidence(uuid) to authenticated;
grant execute on function app_private.can_access_task_evidence_object(text, text) to authenticated;
grant execute on function app_private.can_upload_task_evidence_object(text, text, text, text) to authenticated;

-- This workflow-label helper is called only inside privileged application RPCs.
revoke all on function app_private.task_workflow_stage(
  app_private.task_state, timestamptz, timestamptz, timestamptz, text
) from public, anon, authenticated;
