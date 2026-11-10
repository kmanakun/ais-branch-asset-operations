-- Remove obsolete browser entry points. The active UI uses exact-row branch
-- inventory and filtered task paging instead of these legacy RPCs.
revoke execute on function public.ais_branch_plan_inventory(text) from authenticated;
revoke execute on function public.ais_list_tasks() from authenticated;
revoke execute on function public.ais_task_page(integer, integer) from authenticated;

comment on function public.ais_branch_plan_inventory(text) is
  'Legacy LocationCode lookup retained for internal compatibility; browser clients use ais_branch_plan_inventory_for_row(integer).';
comment on function public.ais_list_tasks() is
  'Legacy unfiltered task list retained for internal compatibility; browser clients use ais_task_filtered_page(text,text,integer,integer).';
comment on function public.ais_task_page(integer, integer) is
  'Internal legacy paging helper; browser clients use ais_task_filtered_page(text,text,integer,integer).';
