-- Keep history lookups efficient as task and evidence records grow.
create index if not exists replacement_task_evidence_uploaded_by_idx
  on app_private.replacement_task_evidence(uploaded_by);

create index if not exists replacement_tasks_technician_confirmed_by_idx
  on app_private.replacement_tasks(technician_confirmed_by);

create index if not exists replacement_tasks_closeout_submitted_by_idx
  on app_private.replacement_tasks(closeout_submitted_by);

create index if not exists replacement_tasks_admin_accepted_by_idx
  on app_private.replacement_tasks(admin_accepted_by);
