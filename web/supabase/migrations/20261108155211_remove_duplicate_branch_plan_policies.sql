-- The schema migration already added branch-specific deny policies. Remove the
-- redundant generic policies while preserving RLS and the existing restrictions.
drop policy if exists deny_browser_access on app_private.branch_work_plan_batches;
drop policy if exists deny_browser_access on app_private.branch_work_plan_items;
