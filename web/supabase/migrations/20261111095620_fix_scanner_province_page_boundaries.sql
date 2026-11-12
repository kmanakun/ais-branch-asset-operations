create or replace function public.ais_scanner_page_filtered(
  p_search text default null,
  p_province text default null,
  p_status text default 'all',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  search_term text := nullif(btrim(p_search), '');
  province_filter text := nullif(btrim(p_province), '');
  status_filter text := coalesce(nullif(lower(btrim(p_status)), ''), 'all');
  result jsonb;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;

  if actor is null or actor_role is null then
    raise exception 'Application access required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 200 or p_offset is null or p_offset < 0
    or length(coalesce(search_term, '')) > 100
    or length(coalesce(province_filter, '')) > 100
    or status_filter not in ('all', 'open', 'on_process', 'complete') then
    raise exception 'Invalid scanner filter or pagination request' using errcode = '22023';
  end if;

  with scoped as materialized (
    select s.id, b.id as branch_id, b.location_code, b.loc_bld as branch_name,
      b.province,
      coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), '') as model_name,
      s.brand,
      case when actor_role = 'viewer' then '••••••' || right(s.com_sn, 4) else s.com_sn end as com_sn,
      s.com_years, latest.work_order_code as campaign, latest.workflow_stage as status
    from app_private.scanner_assets s
    join app_private.branches b on b.id = s.branch_id
    left join lateral (
      select coalesce(wo.work_order_code, c.campaign_code) as work_order_code,
        app_private.task_workflow_stage(rt.status, rt.technician_confirmed_at,
          rt.closeout_submitted_at, rt.admin_accepted_at, fv.outcome) as workflow_stage
      from app_private.replacement_tasks rt
      left join app_private.campaign_items ci on ci.id = rt.campaign_item_id
      left join app_private.branch_work_orders wo on wo.id = rt.branch_work_order_id
      left join app_private.campaigns c on c.id = ci.campaign_id
      left join lateral (
        select v.outcome
        from app_private.field_visits v
        where v.task_id = rt.id
        order by v.performed_at desc nulls last, v.created_at desc, v.id desc
        limit 1
      ) fv on true
      where coalesce(rt.scanner_asset_id, ci.scanner_asset_id) = s.id
      order by case when rt.status in ('scheduled', 'in_progress', 'blocked') then 0 else 1 end,
        rt.created_at desc, rt.id desc
      limit 1
    ) latest on true
    where (search_term is null
      or b.location_code ilike '%' || search_term || '%'
      or coalesce(b.loc_bld, '') ilike '%' || search_term || '%'
      or coalesce(b.province, '') ilike '%' || search_term || '%'
      or coalesce(s.model_name, '') ilike '%' || search_term || '%'
      or coalesce(s.hw_name, '') ilike '%' || search_term || '%'
      or (actor_role <> 'viewer' and s.com_sn ilike '%' || search_term || '%'))
      and (province_filter is null or nullif(btrim(b.province), '') = province_filter)
  ), classified as materialized (
    select scoped.*, app_private.scanner_register_status_group(scoped.status) as status_group
    from scoped
  ), filtered as materialized (
    select * from classified
    where status_filter = 'all' or status_group = status_filter
  ), numbered as materialized (
    select filtered.*,
      row_number() over (order by lower(coalesce(province, '')), location_code, branch_name, model_name, id) as row_number,
      count(*) over ()::integer as total_rows,
      coalesce(nullif(btrim(province), ''), 'ไม่ระบุจังหวัด') as province_group
    from filtered
  ), bounds as (
    select max(row_number) filter (where row_number <= p_offset + p_limit) as requested_end,
      coalesce(max(total_rows), 0)::integer as total_rows
    from numbered
  ), target_province as (
    select province_group
    from numbered
    where row_number = (select requested_end from bounds)
  ), target_group as (
    select numbered.province_group, min(numbered.row_number) as first_row, max(numbered.row_number) as last_row
    from numbered
    join target_province using (province_group)
    group by numbered.province_group
  ), page_bounds as (
    select bounds.total_rows,
      case
        when bounds.total_rows <= p_offset then p_offset
        when bounds.total_rows <= p_offset + p_limit then bounds.total_rows
        when target_group.first_row <= p_offset + 1 then target_group.last_row
        when target_group.first_row is not null then target_group.first_row - 1
        else bounds.total_rows
      end::integer as end_row
    from bounds left join target_group on true
  ), page as (
    select numbered.*
    from numbered cross join page_bounds
    where numbered.row_number > p_offset and numbered.row_number <= page_bounds.end_row
  )
  select jsonb_build_object(
    'total', page_bounds.total_rows,
    'province_total', (select count(distinct nullif(btrim(province), '')) from filtered),
    'next_offset', page_bounds.end_row,
    'has_more', page_bounds.end_row < page_bounds.total_rows,
    'rows', coalesce((
      select jsonb_agg(to_jsonb(page) - array['row_number', 'total_rows', 'province_group']::text[]
        order by lower(coalesce(province, '')), location_code, branch_name, model_name, id)
      from page
    ), '[]'::jsonb)
  ) into result
  from page_bounds;

  return result;
end
$$;
revoke all on function public.ais_scanner_page_filtered(text, text, text, integer, integer) from public, anon;
grant execute on function public.ais_scanner_page_filtered(text, text, text, integer, integer) to authenticated;
comment on function public.ais_scanner_page_filtered(text, text, text, integer, integer) is
  'Authenticated filtered Scanner register; pages end at province boundaries and expose the next row offset. Viewer serials remain masked.';

