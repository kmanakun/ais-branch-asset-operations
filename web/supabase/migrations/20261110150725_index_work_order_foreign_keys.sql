-- Add indexes for the four work-order foreign keys identified by Supabase's
-- performance advisor. These child tables are small today, but are expected to
-- grow as one task is recorded for each Scanner replacement.
create index if not exists branch_work_orders_branch_id_idx
  on app_private.branch_work_orders (branch_id);

create index if not exists branch_work_orders_created_by_idx
  on app_private.branch_work_orders (created_by);

create index if not exists replacement_tasks_campaign_item_id_idx
  on app_private.replacement_tasks (campaign_item_id);

create index if not exists replacement_tasks_started_by_idx
  on app_private.replacement_tasks (started_by);
