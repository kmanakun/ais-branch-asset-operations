begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

select ok(not has_function_privilege('authenticated', 'public.ais_create_campaign(text,text,uuid[],text,date,date)', 'EXECUTE'), 'legacy round creation cannot create work outside a branch order');
select ok(not has_function_privilege('authenticated', 'public.ais_update_campaign_selection(uuid,timestamptz,uuid[],uuid[],text)', 'EXECUTE'), 'legacy target editing is disabled after a work order is opened');
select ok(not has_function_privilege('authenticated', 'public.ais_schedule_campaign(uuid,uuid,date)', 'EXECUTE'), 'legacy single-team scheduling is disabled');
select ok(not has_function_privilege('authenticated', 'public.ais_schedule_campaign_by_branch(uuid,jsonb)', 'EXECUTE'), 'legacy team and appointment scheduling is disabled');
select ok(not has_function_privilege('authenticated', 'public.ais_campaign_action(uuid,text,text,text)', 'EXECUTE'), 'legacy round status changes cannot bypass Scanner work-item steps');
select ok(not has_function_privilege('authenticated', 'public.ais_open_campaign_work_orders(uuid)', 'EXECUTE'), 'legacy campaign opening cannot create duplicate work items');
select ok(has_function_privilege('authenticated', 'public.ais_list_campaigns(text)', 'EXECUTE'), 'historical round data remains available for read-only review');
select ok(has_function_privilege('authenticated', 'public.ais_open_branch_work_order(uuid,uuid[],uuid)', 'EXECUTE'), 'new work uses the guarded branch work-order API');

select * from finish();
rollback;
