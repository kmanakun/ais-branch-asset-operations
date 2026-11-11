-- A failed or incomplete Storage upload is a recoverable client-side condition.
-- PostgREST maps SQLSTATE 55000 to HTTP 500, so return it as a validation error
-- instead of recording expected upload retries as server failures.
do $$
declare
  signature regprocedure := 'public.ais_task_evidence_finalize(uuid,text)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  old_error text := 'Uploaded evidence is missing or does not match the active reservation'' using errcode = ''55000'';';
  new_error text := 'Uploaded evidence is missing or does not match the active reservation'' using errcode = ''22023'';';
  updated_definition text;
begin
  if position(old_error in original_definition) = 0 then
    raise exception 'Expected evidence finalization guard was not found in %', signature;
  end if;
  updated_definition := replace(original_definition, old_error, new_error);
  if updated_definition = original_definition then
    raise exception 'Could not update evidence finalization error mapping in %', signature;
  end if;
  execute updated_definition;
end
$$;

comment on function public.ais_task_evidence_finalize(uuid,text) is
  'Confirms a reserved private evidence object. Missing or mismatched uploads return SQLSTATE 22023 so expected recovery retries do not appear as HTTP 500 server failures.';

-- Support the three foreign keys Supabase identified on scanner discovery reports.
create index if not exists scanner_discovery_reports_created_asset_id_idx
  on app_private.scanner_discovery_reports (created_asset_id);
create index if not exists scanner_discovery_reports_reported_by_idx
  on app_private.scanner_discovery_reports (reported_by);
create index if not exists scanner_discovery_reports_reviewed_by_idx
  on app_private.scanner_discovery_reports (reviewed_by);
