begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

select ok(not has_function_privilege('anon', 'public.ais_campaign_action(uuid,text,text,text)', 'EXECUTE'), 'anonymous callers cannot change historical round states');
select ok(not has_function_privilege('authenticated', 'public.ais_campaign_action(uuid,text,text,text)', 'EXECUTE'), 'historical round actions cannot bypass per-Scanner work order states');
select ok(has_function_privilege('authenticated', 'public.ais_list_campaigns(text)', 'EXECUTE'), 'historical round summaries stay readable');
select ok(has_function_privilege('authenticated', 'public.ais_branch_work_order_page(text,text,integer,integer)', 'EXECUTE'), 'current statuses are read from branch work orders');

select * from finish();
rollback;
