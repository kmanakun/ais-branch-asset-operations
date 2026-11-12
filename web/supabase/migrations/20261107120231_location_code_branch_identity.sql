-- The source workbook reuses several LocationCodes for distinct branch labels.
-- Preserve each physical branch as a distinct record instead of merging assets.
alter table app_private.branches
  drop constraint if exists branches_location_code_key;

alter table app_private.branches
  add constraint branches_loc_bld_required
  check (nullif(btrim(loc_bld), '') is not null);

create unique index branches_location_code_branch_name_uidx
  on app_private.branches (
    location_code,
    lower(regexp_replace(btrim(loc_bld), '[[:space:]]+', ' ', 'g'))
  );

create or replace function public.ais_list_scanners(p_search text default null)
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
  select ua.role into actor_role from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role is null then
    raise exception 'Application access required' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(row_data order by location_code, model_name), '[]'::jsonb) into result
  from (
    select jsonb_build_object(
      'id', s.id,
      'location_code', b.location_code,
      'branch_name', coalesce(nullif(b.loc_bld, ''), b.location_code),
      'model_name', coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), ''),
      'brand', s.brand,
      'com_sn', case when actor_role = 'viewer' then '••••••' || right(s.com_sn, 4) else s.com_sn end,
      'com_years', s.com_years,
      'campaign', c.campaign_code,
      'status', rt.status::text
    ) as row_data, b.location_code, s.model_name
    from app_private.scanner_assets s
    join app_private.branches b on b.id = s.branch_id
    left join app_private.campaign_items ci on ci.scanner_asset_id = s.id
    left join app_private.campaigns c on c.id = ci.campaign_id
    left join app_private.replacement_tasks rt on rt.campaign_item_id = ci.id
    where (coalesce(trim(p_search), '') = '' or b.location_code ilike '%' || left(trim(p_search), 100) || '%' or coalesce(b.loc_bld, '') ilike '%' || left(trim(p_search), 100) || '%' or coalesce(s.model_name, '') ilike '%' || left(trim(p_search), 100) || '%' or (actor_role <> 'viewer' and s.com_sn ilike '%' || left(trim(p_search), 100) || '%'))
      and (actor_role <> 'field_technician' or exists (
        select 1 from app_private.campaign_items ci2
        join app_private.replacement_tasks rt2 on rt2.campaign_item_id = ci2.id
        join app_private.user_team_memberships utm on utm.team_id = rt2.team_id and utm.user_id = actor
        where ci2.scanner_asset_id = s.id
      ))
    limit 200
  ) scanners;
  return result;
end
$$;

revoke all on function public.ais_list_scanners(text) from public, anon;
grant execute on function public.ais_list_scanners(text) to authenticated;

comment on function public.ais_list_scanners(text) is
  'Intentional SECURITY DEFINER read RPC: private tables are not exposed; requires active user access; team-scopes technicians; masks Viewer serials and returns scanner UUIDs for stable row identity; fixed search_path.';
