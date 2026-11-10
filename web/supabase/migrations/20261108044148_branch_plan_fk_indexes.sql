create index if not exists branch_work_plan_batches_imported_by_idx
  on app_private.branch_work_plan_batches (imported_by);

create index if not exists branch_work_plan_items_branch_id_idx
  on app_private.branch_work_plan_items (branch_id);

create index if not exists branch_work_plan_items_team_id_idx
  on app_private.branch_work_plan_items (team_id);
