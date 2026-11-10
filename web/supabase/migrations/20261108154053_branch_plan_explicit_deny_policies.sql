-- Keep the branch-plan tables explicitly closed to browser roles in addition to
-- RLS default-deny and the absence of table grants.
alter table app_private.branch_work_plan_batches enable row level security;
alter table app_private.branch_work_plan_items enable row level security;

revoke all on table app_private.branch_work_plan_batches from public, anon, authenticated;
revoke all on table app_private.branch_work_plan_items from public, anon, authenticated;

-- These tables already have explicit per-table deny policies from the schema
-- migration; avoid creating duplicate permissive policies with the same effect.
drop policy if exists deny_browser_access on app_private.branch_work_plan_batches;
drop policy if exists deny_browser_access on app_private.branch_work_plan_items;
