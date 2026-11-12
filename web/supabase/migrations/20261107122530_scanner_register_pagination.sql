create or replace function public.ais_scanner_page(p_search text default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  result jsonb;
begin
  select ua.role into actor_role from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role is null then
    raise exception 'Application access required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 200 or p_offset is null or p_offset < 0 then
    raise exception 'Invalid pagination parameters' using errcode = '22023';
  end if;
  with filtered as materialized (
    select s.id, b.location_code, b.loc_bld as branch_name,
      coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), '') as model_name,
      s.brand, case when actor_role = 'viewer' then '••••••' || right(s.com_sn, 4) else s.com_sn end as com_sn,
      s.com_years, latest.campaign_code as campaign, latest.task_status as status
    from app_private.scanner_assets s
    join app_private.branches b on b.id = s.branch_id
    left join lateral (
      select c.campaign_code, rt.status::text as task_status
      from app_private.campaign_items ci
      join app_private.campaigns c on c.id = ci.campaign_id
      left join app_private.replacement_tasks rt on rt.campaign_item_id = ci.id
      where ci.scanner_asset_id = s.id
        and (actor_role <> 'field_technician' or exists (
          select 1 from app_private.user_team_memberships utm
          where utm.user_id = actor and utm.team_id = rt.team_id
        ))
      order by ci.created_at desc, ci.id
      limit 1
    ) latest on true
    where (coalesce(trim(p_search), '') = ''
      or b.location_code ilike '%' || left(trim(p_search), 100) || '%'
      or b.loc_bld ilike '%' || left(trim(p_search), 100) || '%'
      or s.model_name ilike '%' || left(trim(p_search), 100) || '%'
      or (actor_role <> 'viewer' and s.com_sn ilike '%' || left(trim(p_search), 100) || '%'))
      and (actor_role <> 'field_technician' or exists (
        select 1 from app_private.campaign_items ci
        join app_private.replacement_tasks rt on rt.campaign_item_id = ci.id
        join app_private.user_team_memberships utm on utm.team_id = rt.team_id and utm.user_id = actor
        where ci.scanner_asset_id = s.id
      ))
  ), page as (
    select * from filtered order by location_code, branch_name, model_name, id
    limit p_limit offset p_offset
  )
  select jsonb_build_object('total', (select count(*) from filtered),
    'rows', coalesce((select jsonb_agg(to_jsonb(page) order by location_code, branch_name, model_name, id) from page), '[]'::jsonb))
  into result;
  return result;
end
$$;
revoke all on function public.ais_scanner_page(text,integer,integer) from public, anon;
grant execute on function public.ais_scanner_page(text,integer,integer) to authenticated;
comment on function public.ais_scanner_page(text,integer,integer) is
  'Paginated private register RPC: active-user check, technician team scope, Viewer serial masking and search restrictions; stable UUID ordering; one row per asset.';
