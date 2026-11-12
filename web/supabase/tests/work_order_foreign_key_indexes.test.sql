begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select has_index('app_private', 'branch_work_orders', 'branch_work_orders_branch_id_idx', 'branch foreign key has a supporting index');
select has_index('app_private', 'branch_work_orders', 'branch_work_orders_created_by_idx', 'creator foreign key has a supporting index');
select has_index('app_private', 'replacement_tasks', 'replacement_tasks_campaign_item_id_idx', 'legacy campaign item foreign key has a supporting index');
select has_index('app_private', 'replacement_tasks', 'replacement_tasks_started_by_idx', 'technician starter foreign key has a supporting index');

select * from finish();
rollback;
