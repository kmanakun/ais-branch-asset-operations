-- Return the province choices that the current role may browse.
create or replace function public.ais_branch_provinces()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  result jsonb;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;

  if actor is null or actor_role is null then
    raise exception 'Application access required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(provinces.province order by provinces.province), '[]'::jsonb)
  into result
  from (
    select distinct nullif(trim(branch.province), '') as province
    from app_private.branches branch
    where nullif(trim(branch.province), '') is not null
      and (actor_role <> 'field_technician' or exists (
        select 1
        from app_private.scanner_assets scanner
        join app_private.campaign_items item on item.scanner_asset_id = scanner.id
        join app_private.replacement_tasks task on task.campaign_item_id = item.id
        where scanner.branch_id = branch.id
          and task.team_id is not null
      ))
  ) provinces;

  return result;
end
$$;

revoke all on function public.ais_branch_provinces() from public, anon;
grant execute on function public.ais_branch_provinces() to authenticated;
comment on function public.ais_branch_provinces() is
  'Returns distinct branches provinces; field technicians see only provinces with opened assigned work orders.';
