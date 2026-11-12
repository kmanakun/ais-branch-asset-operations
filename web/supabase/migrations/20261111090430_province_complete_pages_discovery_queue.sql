create or replace function app_private.scanner_register_status_group(p_stage text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when p_stage in ('delivered', 'legacy_completed', 'completed') then 'complete'
    when p_stage is null or p_stage in (
      'open', 'scheduled', 'awaiting_confirmation', 'confirmed', 'cancelled',
      'draft', 'ready_to_schedule', 'exception_resolved'
    ) then 'open'
    else 'on_process'
  end;
$$;
revoke all on function app_private.scanner_register_status_group(text) from public, anon, authenticated;

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
  ), target_group as (
    select province_group, min(row_number) as first_row, max(row_number) as last_row
    from numbered
    where row_number = (select requested_end from bounds)
    group by province_group
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

create or replace function public.ais_dashboard_province_summary()
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
  if actor is null or actor_role not in ('admin', 'field_technician') then
    raise exception 'Active application access required' using errcode = '42501';
  end if;

  with scanner_state as (
    select s.id as asset_id, s.branch_id,
      app_private.scanner_register_status_group(latest.workflow_stage) as state
    from app_private.scanner_assets s
    left join lateral (
      select app_private.task_workflow_stage(rt.status, rt.technician_confirmed_at,
          rt.closeout_submitted_at, rt.admin_accepted_at, fv.outcome) as workflow_stage
      from app_private.replacement_tasks rt
      left join app_private.campaign_items ci on ci.id = rt.campaign_item_id
      left join lateral (
        select v.outcome from app_private.field_visits v
        where v.task_id = rt.id
        order by v.performed_at desc nulls last, v.created_at desc, v.id desc
        limit 1
      ) fv on true
      where coalesce(rt.scanner_asset_id, ci.scanner_asset_id) = s.id
      order by case when rt.status in ('scheduled', 'in_progress', 'blocked') then 0 else 1 end,
        rt.created_at desc, rt.id desc
      limit 1
    ) latest on true
  ), branch_state as (
    select b.id as branch_id,
      coalesce(nullif(btrim(b.province), ''), 'ไม่ระบุจังหวัด') as province,
      count(ss.asset_id)::integer as scanners_total,
      count(ss.asset_id) filter (where ss.state = 'open')::integer as scanners_open,
      count(ss.asset_id) filter (where ss.state = 'on_process')::integer as scanners_on_process,
      count(ss.asset_id) filter (where ss.state = 'complete')::integer as scanners_complete
    from app_private.branches b
    left join scanner_state ss on ss.branch_id = b.id
    group by b.id, coalesce(nullif(btrim(b.province), ''), 'ไม่ระบุจังหวัด')
  ), province_state as (
    select bs.province,
      count(*)::integer as branches_total,
      count(*) filter (where bs.scanners_total > 0 and bs.scanners_complete = bs.scanners_total)::integer as branches_complete,
      (count(*) - count(*) filter (where bs.scanners_total > 0 and bs.scanners_complete = bs.scanners_total))::integer as branches_remaining,
      sum(bs.scanners_total)::integer as scanners_total,
      sum(bs.scanners_open)::integer as scanners_open,
      sum(bs.scanners_on_process)::integer as scanners_on_process,
      sum(bs.scanners_complete)::integer as scanners_complete
    from branch_state bs
    group by bs.province
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'branches_total', coalesce(sum(ps.branches_total), 0),
      'branches_complete', coalesce(sum(ps.branches_complete), 0),
      'branches_remaining', coalesce(sum(ps.branches_remaining), 0),
      'scanners_total', coalesce(sum(ps.scanners_total), 0),
      'scanners_open', coalesce(sum(ps.scanners_open), 0),
      'scanners_on_process', coalesce(sum(ps.scanners_on_process), 0),
      'scanners_complete', coalesce(sum(ps.scanners_complete), 0)
    ),
    'provinces', coalesce(jsonb_agg(jsonb_build_object(
      'province', ps.province,
      'branches_total', ps.branches_total,
      'branches_complete', ps.branches_complete,
      'branches_remaining', ps.branches_remaining,
      'scanners_total', ps.scanners_total,
      'scanners_open', ps.scanners_open,
      'scanners_on_process', ps.scanners_on_process,
      'scanners_complete', ps.scanners_complete
    ) order by ps.province), '[]'::jsonb)
  ) into result from province_state ps;
  return result;
end
$$;
revoke all on function public.ais_dashboard_province_summary() from public, anon;
grant execute on function public.ais_dashboard_province_summary() to authenticated;
comment on function public.ais_dashboard_province_summary() is
  'Province replacement progress; an exception review is not a completed scanner replacement.';

create or replace function public.ais_scanner_discovery_queue(p_limit integer default 50, p_offset integer default 0)
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
  if actor is null or actor_role is distinct from 'admin' then
    raise exception 'Active Admin access required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000 then
    raise exception 'Discovery queue page limit or offset is outside the supported range' using errcode = '22023';
  end if;
  select jsonb_build_object(
    'total', (select count(*) from app_private.scanner_discovery_reports r where r.status = 'pending'),
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'branch_id', r.branch_id, 'location_code', b.location_code,
      'branch_name', coalesce(nullif(b.loc_bld, ''), b.location_code), 'province', b.province,
      'serial_number', r.serial_number, 'observed_model', r.observed_model,
      'notes', r.notes, 'reported_by', ua.display_name, 'created_at', r.created_at
    ) order by r.created_at, r.id), '[]'::jsonb)
  ) into result
  from (
    select pending.* from app_private.scanner_discovery_reports pending
    where pending.status = 'pending'
    order by pending.created_at, pending.id
    limit p_limit offset p_offset
  ) r
  join app_private.branches b on b.id = r.branch_id
  left join app_private.user_access ua on ua.user_id = r.reported_by;
  return result;
end
$$;
revoke all on function public.ais_scanner_discovery_queue(integer, integer) from public, anon;
grant execute on function public.ais_scanner_discovery_queue(integer, integer) to authenticated;
comment on function public.ais_scanner_discovery_queue(integer, integer) is
  'Admin-only paginated queue of scanner discovery reports, separate from the primary asset register.';
