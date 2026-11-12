-- Make the private schema's browser denial explicit and cover FK lookups.
do $$
declare
  item record;
begin
  for item in
    select tablename from pg_tables where schemaname = 'app_private'
  loop
    execute format(
      'create policy deny_browser_access on app_private.%I for all to anon, authenticated using (false) with check (false)',
      item.tablename
    );
  end loop;
end
$$;

create index if not exists campaigns_created_by_idx
  on app_private.campaigns(created_by);
create index if not exists campaign_items_created_by_idx
  on app_private.campaign_items(created_by);
create index if not exists field_visits_performed_by_idx
  on app_private.field_visits(performed_by);
create index if not exists import_batches_uploaded_by_idx
  on app_private.import_batches(uploaded_by);
create index if not exists import_row_issues_batch_idx
  on app_private.import_row_issues(batch_id);
create index if not exists audit_events_actor_idx
  on app_private.audit_events(actor_id);

comment on function public.ais_app_context() is
  'Intentional SECURITY DEFINER read RPC: private tables are not exposed; requires auth.uid and active user_access; fixed search_path; returns no email.';
comment on function public.ais_dashboard() is
  'Intentional SECURITY DEFINER read RPC: private tables are not exposed; requires active role and team-scopes technicians; masks Viewer serials; fixed search_path.';
comment on function public.ais_list_campaigns(text) is
  'Intentional SECURITY DEFINER read RPC: private tables are not exposed; requires active role and team-scopes technicians; fixed search_path.';
comment on function public.ais_list_scanners(text) is
  'Intentional SECURITY DEFINER read RPC: private tables are not exposed; requires active role and team-scopes technicians; masks Viewer serials and does not search Viewer serials; fixed search_path.';
comment on function public.ais_list_tasks() is
  'Intentional SECURITY DEFINER read RPC: private tables are not exposed; requires active role and team-scopes technicians; masks Viewer serials; fixed search_path.';
