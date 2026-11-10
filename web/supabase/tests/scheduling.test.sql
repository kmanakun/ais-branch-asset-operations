begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

select ok(not has_function_privilege('anon', 'public.ais_schedule_campaign(uuid,uuid,date)', 'EXECUTE'), 'anonymous callers cannot use legacy scheduling');
select ok(not has_function_privilege('authenticated', 'public.ais_schedule_campaign(uuid,uuid,date)', 'EXECUTE'), 'signed-in users cannot assign one team or appointment date to a legacy round');
select ok(not has_function_privilege('authenticated', 'public.ais_schedule_campaign_by_branch(uuid,jsonb)', 'EXECUTE'), 'signed-in users cannot assign teams and dates by branch');
select ok(has_function_privilege('authenticated', 'public.ais_branch_work_order_options(text,text)', 'EXECUTE'), 'Admin can use the branch selector through its guarded RPC');
select ok(has_function_privilege('authenticated', 'public.ais_open_branch_work_order(uuid,uuid[],uuid)', 'EXECUTE'), 'Admin opens new work directly from the verified branch register');

select * from finish();
rollback;
