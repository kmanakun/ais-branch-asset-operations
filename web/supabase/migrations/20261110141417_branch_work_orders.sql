-- One Admin-opened work order per branch, containing one work item per
-- registered Scanner. Existing per-Scanner tasks remain intact as legacy rows.
create table app_private.branch_work_orders (
  id uuid primary key default gen_random_uuid(),
  work_order_code text not null unique,
  branch_id uuid not null references app_private.branches(id) on delete restrict,
  origin text not null default 'admin' check (origin in ('admin', 'legacy')),
  request_id uuid unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table app_private.branch_work_orders enable row level security;
revoke all on table app_private.branch_work_orders from public, anon, authenticated;

alter table app_private.replacement_tasks
  add column scanner_asset_id uuid references app_private.scanner_assets(id) on delete restrict,
  add column branch_work_order_id uuid references app_private.branch_work_orders(id) on delete restrict,
  add column scanner_serial_snapshot text,
  add column scanner_model_snapshot text,
  add column started_at timestamptz,
  add column started_by uuid references auth.users(id) on delete set null;

alter table app_private.replacement_tasks alter column campaign_item_id drop not null;
alter table app_private.replacement_tasks drop constraint if exists replacement_tasks_campaign_item_id_key;

update app_private.replacement_tasks rt
set scanner_asset_id = ci.scanner_asset_id
from app_private.campaign_items ci
where ci.id = rt.campaign_item_id and rt.scanner_asset_id is null;

update app_private.replacement_tasks rt
set scanner_serial_snapshot = sa.com_sn,
    scanner_model_snapshot = coalesce(nullif(sa.model_name, ''), nullif(sa.hw_name, ''))
from app_private.scanner_assets sa
where sa.id = rt.scanner_asset_id;

do $backfill$
declare
  unmapped integer;
begin
  select count(*) into unmapped
  from app_private.replacement_tasks rt
  where rt.scanner_asset_id is null;
  if unmapped > 0 then
    raise exception 'Cannot link % legacy work items to a Scanner; review campaign-item references before migration', unmapped;
  end if;
end
$backfill$;

-- Keep every existing task and its exact status, version, actor, timestamps,
-- field visits, evidence, and audit events. Legacy tasks get one parent each
-- instead of being merged into a new branch order.
insert into app_private.branch_work_orders (
  id, work_order_code, branch_id, origin, created_at
)
select rt.id,
  'LEGACY-' || rt.id::text,
  sa.branch_id,
  'legacy',
  rt.created_at
from app_private.replacement_tasks rt
join app_private.scanner_assets sa on sa.id = rt.scanner_asset_id
where rt.branch_work_order_id is null
on conflict (id) do nothing;

update app_private.replacement_tasks rt
set branch_work_order_id = rt.id
where rt.branch_work_order_id is null;

alter table app_private.replacement_tasks
  add constraint replacement_tasks_source_scanner_check
  check (campaign_item_id is not null or scanner_asset_id is not null);

create index replacement_tasks_order_idx
  on app_private.replacement_tasks(branch_work_order_id, created_at, id);
create index replacement_tasks_scanner_idx
  on app_private.replacement_tasks(scanner_asset_id, created_at desc);
do $check_active_scanners$
declare duplicate_count integer;
begin
  select count(*)::integer into duplicate_count
  from (
    select scanner_asset_id
    from app_private.replacement_tasks
    where scanner_asset_id is not null and status in ('scheduled', 'in_progress', 'blocked')
    group by scanner_asset_id
    having count(*) > 1
  ) duplicates;
  if duplicate_count > 0 then
    raise exception 'Cannot enforce one open task per Scanner: % Scanner(s) already have multiple active work items; resolve overlaps before migration', duplicate_count;
  end if;
end
$check_active_scanners$;
create unique index replacement_tasks_active_scanner_uidx
  on app_private.replacement_tasks(scanner_asset_id)
  where scanner_asset_id is not null and status in ('scheduled', 'in_progress', 'blocked');

create or replace function public.ais_branch_work_order_options(
  p_search text default null,
  p_province text default null
)
returns table (
  branch_id uuid,
  location_code text,
  branch_name text,
  province text,
  scanner_count integer,
  available_count integer
)
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
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role is distinct from 'admin' then
    raise exception 'Active Admin access required to open a branch work order' using errcode = '42501';
  end if;
  if search_term is not null and length(search_term) > 100 then
    raise exception 'Branch search is longer than the supported limit' using errcode = '22023';
  end if;
  return query
  select b.id, b.location_code, coalesce(nullif(b.loc_bld, ''), b.location_code), b.province,
    count(sa.id)::integer,
    count(sa.id) filter (where not exists (
      select 1
      from app_private.replacement_tasks rt
      left join app_private.campaign_items ci on ci.id = rt.campaign_item_id
      where coalesce(rt.scanner_asset_id, ci.scanner_asset_id) = sa.id
        and rt.status in ('scheduled', 'in_progress', 'blocked')
    ))::integer
  from app_private.branches b
  join app_private.scanner_assets sa on sa.branch_id = b.id
  where (province_filter is null or b.province = province_filter)
    and (search_term is null
      or position(lower(search_term) in lower(b.location_code)) > 0
      or position(lower(search_term) in lower(coalesce(b.loc_bld, ''))) > 0
      or position(lower(search_term) in lower(coalesce(b.province, ''))) > 0)
  group by b.id, b.location_code, b.loc_bld, b.province
  order by b.province nulls last, b.location_code;
end
$$;
revoke all on function public.ais_branch_work_order_options(text, text) from public, anon;
grant execute on function public.ais_branch_work_order_options(text, text) to authenticated;

create or replace function public.ais_branch_work_order_assets(p_branch_id uuid)
returns table (
  scanner_asset_id uuid,
  com_sn text,
  model text,
  has_active_work_order boolean,
  active_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role is distinct from 'admin' then
    raise exception 'Active Admin access required to select Scanners' using errcode = '42501';
  end if;
  if p_branch_id is null then
    raise exception 'A branch is required' using errcode = '22023';
  end if;
  return query
  select sa.id, sa.com_sn, coalesce(nullif(sa.model_name, ''), nullif(sa.hw_name, ''), 'ไม่ระบุรุ่น'),
    coalesce(active_task.id is not null, false), active_task.status::text
  from app_private.scanner_assets sa
  left join lateral (
    select rt.id, rt.status
    from app_private.replacement_tasks rt
    left join app_private.campaign_items ci on ci.id = rt.campaign_item_id
    where coalesce(rt.scanner_asset_id, ci.scanner_asset_id) = sa.id
      and rt.status in ('scheduled', 'in_progress', 'blocked')
    order by rt.created_at desc, rt.id
    limit 1
  ) active_task on true
  where sa.branch_id = p_branch_id
  order by lower(btrim(sa.com_sn)), sa.id;
end
$$;
revoke all on function public.ais_branch_work_order_assets(uuid) from public, anon;
grant execute on function public.ais_branch_work_order_assets(uuid) to authenticated;

create or replace function public.ais_open_branch_work_order(
  p_branch_id uuid,
  p_scanner_asset_ids uuid[],
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  branch_code text;
  requested_count integer := coalesce(cardinality(p_scanner_asset_ids), 0);
  found_count integer;
  branch_match_count integer;
  conflicting_count integer;
  new_order_id uuid;
  new_order_code text;
  existing_order_id uuid;
  existing_branch_id uuid;
  existing_assets uuid[];
  requested_assets uuid[];
  inserted_count integer;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role is distinct from 'admin' then
    raise exception 'Active Admin access required to open a branch work order' using errcode = '42501';
  end if;
  if p_branch_id is null or p_request_id is null or requested_count not between 1 and 500
    or exists (select 1 from unnest(p_scanner_asset_ids) x where x is null)
    or requested_count <> (select count(distinct x) from unnest(p_scanner_asset_ids) x) then
    raise exception 'Select 1 to 500 distinct registered Scanners and include a request id' using errcode = '22023';
  end if;
  select array_agg(x order by x) into requested_assets from unnest(p_scanner_asset_ids) x;

  select wo.id, wo.branch_id into existing_order_id, existing_branch_id
  from app_private.branch_work_orders wo
  where wo.request_id = p_request_id
  for update;
  if found then
    select array_agg(rt.scanner_asset_id order by rt.scanner_asset_id)
    into existing_assets
    from app_private.replacement_tasks rt
    where rt.branch_work_order_id = existing_order_id;
    if existing_branch_id is distinct from p_branch_id or existing_assets is distinct from requested_assets then
      raise exception 'Request id was already used for another branch or Scanner list' using errcode = '22023';
    end if;
    return jsonb_build_object('work_order_id', existing_order_id, 'selected_scanners', cardinality(existing_assets), 'already_opened', true);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_branch_id::text, 0));
  select b.location_code into branch_code
  from app_private.branches b where b.id = p_branch_id for update;
  if not found then raise exception 'Branch was not found' using errcode = 'P0002'; end if;

  select count(*)::integer, count(*) filter (where sa.branch_id = p_branch_id)::integer
  into found_count, branch_match_count
  from app_private.scanner_assets sa
  where sa.id = any(requested_assets);
  if found_count <> requested_count or branch_match_count <> requested_count then
    raise exception 'Every selected Scanner must be registered to the selected branch' using errcode = '22023';
  end if;

  select count(distinct coalesce(rt.scanner_asset_id, ci.scanner_asset_id))::integer
  into conflicting_count
  from app_private.replacement_tasks rt
  left join app_private.campaign_items ci on ci.id = rt.campaign_item_id
  where coalesce(rt.scanner_asset_id, ci.scanner_asset_id) = any(requested_assets)
    and rt.status in ('scheduled', 'in_progress', 'blocked');
  if conflicting_count > 0 then
    raise exception 'At least one selected Scanner already has an active work item' using errcode = '55000';
  end if;

  new_order_id := gen_random_uuid();
  new_order_code := 'WO-' || branch_code || '-' || to_char(clock_timestamp(), 'YYMMDDHH24MISS') || '-' || upper(substr(new_order_id::text, 1, 6));
  insert into app_private.branch_work_orders (id, work_order_code, branch_id, origin, request_id, created_by)
  values (new_order_id, new_order_code, p_branch_id, 'admin', p_request_id, actor);

  insert into app_private.replacement_tasks (
    scanner_asset_id, branch_work_order_id, scanner_serial_snapshot, scanner_model_snapshot, status
  )
  select sa.id, new_order_id, sa.com_sn, coalesce(nullif(sa.model_name, ''), nullif(sa.hw_name, '')),
    'scheduled'::app_private.task_state
  from app_private.scanner_assets sa
  where sa.id = any(requested_assets)
  order by lower(btrim(sa.com_sn)), sa.id;
  get diagnostics inserted_count = row_count;
  if inserted_count <> requested_count then
    raise exception 'Scanner list changed while the work order was opening' using errcode = '40001';
  end if;

  insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
  values (actor, 'branch_work_order_opened', 'branch_work_order', new_order_id,
    jsonb_build_object('branch_id', p_branch_id, 'location_code', branch_code,
      'scanner_count', inserted_count, 'started_at', null, 'source', 'verified_register'));
  return jsonb_build_object('work_order_id', new_order_id, 'work_order_code', new_order_code,
    'selected_scanners', inserted_count, 'status', 'open', 'already_opened', false);
end
$$;
revoke all on function public.ais_open_branch_work_order(uuid, uuid[], uuid) from public, anon;
grant execute on function public.ais_open_branch_work_order(uuid, uuid[], uuid) to authenticated;

create or replace function public.ais_branch_work_order_page(
  p_search text,
  p_status text,
  p_limit integer,
  p_offset integer
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
  search_term text := lower(nullif(btrim(p_search), ''));
  status_filter text := lower(btrim(coalesce(p_status, 'all')));
  result jsonb;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role is null or actor_role not in ('admin', 'field_technician', 'viewer') then
    raise exception 'Application access required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 100
    or p_offset is null or p_offset not between 0 and 100000 then
    raise exception 'Work order page limit or offset is outside the supported range' using errcode = '22023';
  end if;
  if search_term is not null and length(search_term) > 100 then
    raise exception 'Work order search is longer than the supported limit' using errcode = '22023';
  end if;
  if status_filter not in ('all', 'open', 'in_progress', 'blocked', 'awaiting_admin_acceptance',
    'awaiting_admin_exception_review', 'delivered', 'legacy_completed', 'cancelled') then
    raise exception 'Invalid work order status filter' using errcode = '22023';
  end if;

  with child_rows as materialized (
    select wo.id as work_order_id, wo.work_order_code, wo.origin, wo.created_at as opened_at,
      b.location_code, coalesce(nullif(b.loc_bld, ''), b.location_code) as branch_name, b.province,
      rt.id as task_id, rt.status::text as task_status, rt.version, rt.created_at as task_created_at,
      rt.blocked_reason, rt.closeout_submitted_by, rt.closeout_submitted_at, rt.admin_accepted_at,
      s.com_sn, coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), 'ไม่ระบุรุ่น') as scanner_model,
      fv.outcome, fv.observed_serial, fv.observed_model, fv.exception_reason, fv.new_serial,
      fv.old_serial_snapshot, fv.install_result, fv.old_scanner_status::text as old_scanner_status,
      fv.old_scanner_note, fv.performed_by, ua.display_name as performed_by_name, fv.performed_at,
      app_private.task_workflow_stage(rt.status, rt.technician_confirmed_at,
        rt.closeout_submitted_at, rt.admin_accepted_at, fv.outcome) as item_stage,
      jsonb_build_object(
        'id', rt.id, 'task_id', rt.id, 'version', rt.version,
        'branch_work_order_id', wo.id, 'work_order_code', wo.work_order_code,
        'branch_name', coalesce(nullif(b.loc_bld, ''), b.location_code),
        'location_code', b.location_code, 'province', b.province,
        'scanner_model', coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), 'ไม่ระบุรุ่น'),
        'com_sn', case when actor_role = 'viewer' and char_length(coalesce(rt.scanner_serial_snapshot, s.com_sn)) > 4 then '••••••' || right(coalesce(rt.scanner_serial_snapshot, s.com_sn), 4) when actor_role = 'viewer' then '••••••' else coalesce(rt.scanner_serial_snapshot, s.com_sn) end,
        'serial', case when actor_role = 'viewer' and char_length(coalesce(rt.scanner_serial_snapshot, s.com_sn)) > 4 then '••••••' || right(coalesce(rt.scanner_serial_snapshot, s.com_sn), 4) when actor_role = 'viewer' then '••••••' else coalesce(rt.scanner_serial_snapshot, s.com_sn) end,
        'task_status', rt.status::text, 'status', rt.status::text,
        'workflow_stage', app_private.task_workflow_stage(rt.status, rt.technician_confirmed_at,
          rt.closeout_submitted_at, rt.admin_accepted_at, fv.outcome),
        'workflow_outcome', fv.outcome,
        'created_at', wo.created_at,
        'new_serial', case when actor_role = 'viewer' and fv.new_serial is not null then '••••••' || right(fv.new_serial, 4) else fv.new_serial end,
        'old_serial_snapshot', case when actor_role = 'viewer' and fv.old_serial_snapshot is not null then '••••••' || right(fv.old_serial_snapshot, 4) else coalesce(fv.old_serial_snapshot, rt.scanner_serial_snapshot, s.com_sn) end,
        'observed_serial', case when actor_role = 'viewer' and fv.observed_serial is not null then '••••••' || right(fv.observed_serial, 4) else fv.observed_serial end,
        'observed_model', fv.observed_model,
        'install_result', fv.install_result, 'old_scanner_status', fv.old_scanner_status::text,
        'old_scanner_note', case when actor_role = 'viewer' then null else fv.old_scanner_note end,
        'exception_reason', case when actor_role = 'viewer' then null else fv.exception_reason end,
        'performed_by_name', case when actor_role = 'viewer' then null else ua.display_name end,
        'performed_at', fv.performed_at,
        'can_admin_accept', actor_role = 'admin' and rt.closeout_submitted_at is not null
          and rt.admin_accepted_at is null and actor is distinct from rt.closeout_submitted_by
          and actor is distinct from fv.performed_by
      ) as item_json
    from app_private.branch_work_orders wo
    join app_private.branches b on b.id = wo.branch_id
    join app_private.replacement_tasks rt on rt.branch_work_order_id = wo.id
    left join app_private.campaign_items ci on ci.id = rt.campaign_item_id
    join app_private.scanner_assets s on s.id = coalesce(rt.scanner_asset_id, ci.scanner_asset_id)
    left join lateral (
      select v.* from app_private.field_visits v
      where v.task_id = rt.id
      order by v.performed_at desc, v.created_at desc, v.id desc limit 1
    ) fv on true
    left join app_private.user_access ua on ua.user_id = fv.performed_by
  ), order_rows as materialized (
    select work_order_id as id, work_order_code, origin, opened_at,
      min(location_code) as location_code, min(branch_name) as branch_name, min(province) as province,
      count(*)::integer as item_count,
      count(*) filter (where item_stage in ('delivered', 'legacy_completed', 'cancelled'))::integer as finished_count,
      case
        when bool_and(item_stage = 'cancelled') then 'cancelled'
        when count(*) filter (where item_stage not in ('delivered', 'legacy_completed', 'cancelled')) = 0
          and bool_or(item_stage = 'delivered') then 'delivered'
        when bool_or(item_stage = 'awaiting_admin_exception_review') then 'awaiting_admin_exception_review'
        when bool_or(item_stage = 'awaiting_admin_acceptance') then 'awaiting_admin_acceptance'
        when bool_or(item_stage = 'blocked') then 'blocked'
        when bool_or(item_stage = 'in_progress') then 'in_progress'
        when bool_and(item_stage = 'open') then 'open'
        else 'legacy_completed'
      end as workflow_stage,
      jsonb_agg(item_json order by lower(btrim(com_sn)), task_id) as scanners,
      string_agg(lower(concat_ws(' ', com_sn, scanner_model)), ' ') as serial_search
    from child_rows
    group by work_order_id, work_order_code, origin, opened_at
    having search_term is null
      or position(search_term in lower(concat_ws(' ', min(location_code), min(branch_name), min(province)))) > 0
      or bool_or(position(search_term in lower(concat_ws(' ', com_sn, scanner_model))) > 0)
  ), filtered_orders as materialized (
    select * from order_rows
    where status_filter = 'all' or workflow_stage = status_filter
  ), page_rows as (
    select * from filtered_orders
    order by opened_at desc, id
    limit p_limit offset p_offset
  ), counts as (
    select count(*)::integer as total,
      count(*) filter (where workflow_stage = 'open')::integer as open,
      count(*) filter (where workflow_stage = 'in_progress')::integer as in_progress,
      count(*) filter (where workflow_stage in ('awaiting_admin_acceptance', 'awaiting_admin_exception_review'))::integer as awaiting_review,
      count(*) filter (where workflow_stage = 'blocked')::integer as blocked,
      count(*) filter (where workflow_stage in ('delivered', 'legacy_completed'))::integer as completed,
      count(*) filter (where workflow_stage = 'cancelled')::integer as cancelled
    from order_rows
  ), filtered_total as (
    select count(*)::integer as total from filtered_orders
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'work_order_id', id, 'work_order_code', work_order_code, 'origin', origin,
      'branch_name', branch_name, 'location_code', location_code, 'province', province,
      'created_at', opened_at, 'workflow_stage', workflow_stage, 'status', workflow_stage,
      'item_count', item_count, 'finished_count', finished_count, 'scanners', scanners
    ) order by opened_at desc, id) from page_rows), '[]'::jsonb),
    'total', filtered_total.total,
    'counts', jsonb_build_object('scheduled', counts.open, 'open', counts.open,
      'in_progress', counts.in_progress, 'awaiting_review', counts.awaiting_review,
      'blocked', counts.blocked, 'completed', counts.completed, 'cancelled', counts.cancelled)
  ) into result
  from counts cross join filtered_total;
  return result;
end
$$;
revoke all on function public.ais_branch_work_order_page(text, text, integer, integer) from public, anon;
grant execute on function public.ais_branch_work_order_page(text, text, integer, integer) to authenticated;

alter table app_private.field_visits add column observed_model text;

create or replace function public.ais_field_task_action(
  p_task_id uuid,
  p_action text,
  p_expected_version integer,
  p_reason text default null,
  p_new_serial text default null,
  p_install_result text default null,
  p_old_scanner_status text default null,
  p_old_scanner_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  action_name text := lower(btrim(coalesce(p_action, '')));
  task_status app_private.task_state;
  task_version integer;
  reason_text text := nullif(btrim(coalesce(p_reason, '')), '');
  next_version integer;
  next_status app_private.task_state;
begin
  select ua.role into actor_role from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role is null or actor_role not in ('admin', 'field_technician') then
    raise exception 'Active Admin or Field Technician access required' using errcode = '42501';
  end if;
  if p_task_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'Task and current version are required' using errcode = '22023';
  end if;
  if action_name not in ('start', 'block', 'resume') then
    raise exception 'Unsupported field action' using errcode = '22023';
  end if;
  select rt.status, rt.version into task_status, task_version
  from app_private.replacement_tasks rt where rt.id = p_task_id for update;
  if not found then raise exception 'Work item was not found' using errcode = 'P0002'; end if;
  if task_version <> p_expected_version then
    raise exception 'Work item changed since it was loaded; refresh before retrying' using errcode = '40001';
  end if;
  if action_name = 'start' then
    if task_status <> 'scheduled' then raise exception 'Only an Open work item can be started' using errcode = '22023'; end if;
    next_status := 'in_progress';
    update app_private.replacement_tasks
      set status = next_status, started_at = clock_timestamp(), started_by = actor,
          version = version + 1, updated_at = clock_timestamp()
      where id = p_task_id and version = p_expected_version returning version into next_version;
  elsif action_name = 'block' then
    if task_status <> 'in_progress' or reason_text is null or length(reason_text) > 500 then
      raise exception 'A reason of 1 to 500 characters is required to pause active work' using errcode = '22023';
    end if;
    next_status := 'blocked';
    update app_private.replacement_tasks
      set status = next_status, resume_status = 'in_progress', blocked_reason = reason_text,
          version = version + 1, updated_at = clock_timestamp()
      where id = p_task_id and version = p_expected_version returning version into next_version;
  else
    if task_status <> 'blocked' then raise exception 'Only blocked work can be resumed' using errcode = '22023'; end if;
    next_status := 'in_progress';
    update app_private.replacement_tasks
      set status = next_status, resume_status = null, blocked_reason = null,
          version = version + 1, updated_at = clock_timestamp()
      where id = p_task_id and version = p_expected_version returning version into next_version;
  end if;
  insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
  values (actor,
    case action_name when 'start' then 'scanner_work_started' when 'block' then 'scanner_work_blocked' else 'scanner_work_resumed' end,
    'replacement_task', p_task_id,
    jsonb_build_object('from_status', task_status::text, 'to_status', next_status::text,
      'actor_id', actor, 'reason', case when action_name = 'block' then reason_text else null end, 'version', next_version));
  return jsonb_build_object('task_id', p_task_id, 'status', next_status::text, 'version', next_version);
end
$$;
revoke all on function public.ais_field_task_action(uuid, text, integer, text, text, text, text, text) from public, anon;
grant execute on function public.ais_field_task_action(uuid, text, integer, text, text, text, text, text) to authenticated;

create or replace function app_private.can_view_task_evidence(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from app_private.user_access ua
    join app_private.replacement_tasks rt on rt.id = p_task_id
    where ua.user_id = auth.uid() and ua.is_active
      and ua.role in ('admin', 'field_technician')
  );
$$;

create or replace function app_private.can_edit_task_evidence(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from app_private.user_access ua
    join app_private.replacement_tasks rt on rt.id = p_task_id and rt.status = 'in_progress'
    where ua.user_id = auth.uid() and ua.is_active
      and ua.role in ('admin', 'field_technician')
      and rt.closeout_submitted_at is null
  );
$$;

create or replace function app_private.can_edit_task_evidence_slot(p_task_id uuid, p_slot text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from app_private.user_access ua
    join app_private.replacement_tasks rt on rt.id = p_task_id
    where ua.user_id = auth.uid() and ua.is_active
      and (
        (p_slot = 'inspector_signature' and ua.role = 'admin'
          and rt.status = 'in_progress' and rt.closeout_submitted_at is not null
          and rt.admin_accepted_at is null
          and auth.uid() is distinct from rt.closeout_submitted_by
          and not exists (select 1 from app_private.field_visits fv where fv.task_id = rt.id and fv.performed_by = auth.uid()))
        or
        (p_slot <> 'inspector_signature' and p_slot in (
          'old_serial_photo', 'new_serial_photo', 'old_device_photo', 'new_device_photo',
          'spare_photo_1', 'spare_photo_2', 'technician_signature', 'scanner_user_signature'
        ) and ua.role in ('admin', 'field_technician')
          and rt.status = 'in_progress' and rt.closeout_submitted_at is null)
      )
  );
$$;

revoke all on function app_private.can_view_task_evidence(uuid) from public, anon, authenticated;
revoke all on function app_private.can_edit_task_evidence(uuid) from public, anon, authenticated;
revoke all on function app_private.can_edit_task_evidence_slot(uuid, text) from public, anon, authenticated;
grant execute on function app_private.can_view_task_evidence(uuid) to authenticated;
grant execute on function app_private.can_edit_task_evidence(uuid) to authenticated;
grant execute on function app_private.can_edit_task_evidence_slot(uuid, text) to authenticated;

drop function public.ais_technician_submit_closeout(uuid, integer, text, text, text, text, text, text, text);
create function public.ais_technician_submit_closeout(
  p_task_id uuid,
  p_expected_version integer,
  p_outcome text,
  p_new_serial text default null,
  p_install_result text default null,
  p_old_scanner_status text default null,
  p_old_scanner_note text default null,
  p_observed_serial text default null,
  p_observed_model text default null,
  p_exception_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  task_status app_private.task_state;
  task_version integer;
  closeout_at timestamptz;
  scanner_id uuid;
  old_serial text;
  outcome_name text := lower(btrim(coalesce(p_outcome, '')));
  new_serial_text text := nullif(btrim(coalesce(p_new_serial, '')), '');
  install_text text := nullif(btrim(coalesce(p_install_result, '')), '');
  old_note text := nullif(btrim(coalesce(p_old_scanner_note, '')), '');
  observed_text text := nullif(btrim(coalesce(p_observed_serial, '')), '');
  observed_model_text text := nullif(btrim(coalesce(p_observed_model, '')), '');
  exception_text text := nullif(btrim(coalesce(p_exception_reason, '')), '');
  old_status app_private.old_scanner_state;
  visit_id uuid;
  missing_slots text[];
begin
  select ua.role into actor_role from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role is null or actor_role not in ('admin', 'field_technician') then
    raise exception 'Active Admin or Field Technician access required to submit closeout' using errcode = '42501';
  end if;
  if p_task_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'Task and current version are required' using errcode = '22023';
  end if;
  if outcome_name not in ('replaced', 'no_damage_found', 'different_device_found', 'target_device_not_found') then
    raise exception 'Choose a valid closeout result' using errcode = '22023';
  end if;
  if install_text is null or length(install_text) > 500 then
    raise exception 'A work result of 1 to 500 characters is required' using errcode = '22023';
  end if;

  select rt.status, rt.version, rt.closeout_submitted_at, s.id,
    coalesce(rt.scanner_serial_snapshot, s.com_sn)
  into task_status, task_version, closeout_at, scanner_id, old_serial
  from app_private.replacement_tasks rt
  left join app_private.campaign_items ci on ci.id = rt.campaign_item_id
  join app_private.scanner_assets s on s.id = coalesce(rt.scanner_asset_id, ci.scanner_asset_id)
  where rt.id = p_task_id
  for update of rt, s;
  if not found then raise exception 'Scanner work item was not found' using errcode = 'P0002'; end if;
  if task_version <> p_expected_version then
    raise exception 'Work item changed since it was loaded; refresh before retrying' using errcode = '40001';
  end if;
  if task_status <> 'in_progress' or closeout_at is not null then
    raise exception 'Only active Scanner work can be closed out' using errcode = '22023';
  end if;
  if p_old_scanner_status is null or p_old_scanner_status not in (
    'returned_usable', 'returned_damaged', 'sent_for_repair', 'not_returned', 'lost', 'other'
  ) then
    raise exception 'A valid old Scanner result is required' using errcode = '22023';
  end if;
  old_status := p_old_scanner_status::app_private.old_scanner_state;
  if old_note is not null and length(old_note) > 1000 then
    raise exception 'The old Scanner note cannot exceed 1000 characters' using errcode = '22023';
  end if;
  if observed_model_text is not null and length(observed_model_text) > 100 then
    raise exception 'The observed model cannot exceed 100 characters' using errcode = '22023';
  end if;

  if outcome_name = 'replaced' then
    if new_serial_text is null or length(new_serial_text) > 100 or lower(new_serial_text) = lower(old_serial) then
      raise exception 'Replacement Serial must be 1 to 100 characters and differ from the expected Serial' using errcode = '22023';
    end if;
    if exception_text is not null or observed_text is not null or observed_model_text is not null then
      raise exception 'Replacement closeout cannot contain exception-only fields' using errcode = '22023';
    end if;
    if old_status = 'other' and old_note is null then
      raise exception 'Explain the old Scanner result' using errcode = '22023';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower(new_serial_text), 0));
    if exists (select 1 from app_private.scanner_assets s where lower(btrim(s.com_sn)) = lower(new_serial_text) and s.id <> scanner_id) then
      raise exception 'This replacement Serial is already registered' using errcode = '23505';
    end if;
  elsif outcome_name = 'no_damage_found' then
    if new_serial_text is not null or observed_text is not null or observed_model_text is not null
      or exception_text is null or length(exception_text) > 1000 then
      raise exception 'Explain why no damaged Scanner was found; replacement Serial must stay empty' using errcode = '22023';
    end if;
    old_status := 'returned_usable';
  elsif outcome_name = 'different_device_found' then
    if new_serial_text is not null or observed_text is null or length(observed_text) > 100
      or exception_text is null or length(exception_text) > 1000 then
      raise exception 'Record the Serial found and explain why it differs from the registered target' using errcode = '22023';
    end if;
    if lower(btrim(observed_text)) = lower(btrim(old_serial)) then
      raise exception 'The observed Serial matches the verified target; report the actual exception instead' using errcode = '22023';
    end if;
    old_status := 'other';
    old_note := exception_text;
  else
    if new_serial_text is not null or observed_text is not null or observed_model_text is not null
      or exception_text is null or length(exception_text) > 1000 then
      raise exception 'Explain why the expected Scanner was not found; replacement Serial must stay empty' using errcode = '22023';
    end if;
    old_status := 'not_returned';
    old_note := exception_text;
  end if;

  select pg_catalog.array_agg(required.slot order by required.slot) into missing_slots
  from pg_catalog.unnest(array[
    case when outcome_name in ('replaced', 'no_damage_found') then 'old_serial_photo' end,
    case when outcome_name = 'replaced' then 'new_serial_photo' end,
    case when outcome_name in ('replaced', 'no_damage_found') then 'old_device_photo' end,
    case when outcome_name = 'replaced' then 'new_device_photo' end,
    case when outcome_name = 'different_device_found' then 'new_serial_photo' end,
    case when outcome_name = 'different_device_found' then 'new_device_photo' end,
    case when outcome_name = 'target_device_not_found' then 'spare_photo_1' end,
    'technician_signature', 'scanner_user_signature'
  ]::text[]) as required(slot)
  left join app_private.replacement_task_evidence e
    on e.task_id = p_task_id and e.slot = required.slot and e.status = 'ready' and e.uploaded_by = actor
  left join storage.objects o on o.bucket_id = 'ais-task-evidence' and o.name = e.object_path
  where required.slot is not null and (e.task_id is null or o.id is null);
  if coalesce(pg_catalog.cardinality(missing_slots), 0) > 0 then
    raise exception 'Save required photos and field signatures first: %', pg_catalog.array_to_string(missing_slots, ', ')
      using errcode = '22023';
  end if;

  insert into app_private.field_visits (
    task_id, old_serial_snapshot, new_serial, install_result, old_scanner_status,
    old_scanner_note, performed_by, outcome, observed_serial, observed_model, exception_reason
  ) values (
    p_task_id, old_serial, new_serial_text, install_text, old_status,
    old_note, actor, outcome_name, observed_text, observed_model_text, exception_text
  ) returning id into visit_id;
  update app_private.replacement_tasks
  set closeout_submitted_at = clock_timestamp(), closeout_submitted_by = actor,
      version = version + 1, updated_at = clock_timestamp()
  where id = p_task_id and version = p_expected_version;
  insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
  values (actor, 'scanner_work_closeout_submitted', 'replacement_task', p_task_id,
    jsonb_build_object('outcome', outcome_name, 'field_visit_id', visit_id,
      'expected_serial', old_serial, 'observed_serial', observed_text, 'actor_id', actor));
  return jsonb_build_object('task_id', p_task_id, 'field_visit_id', visit_id,
    'workflow_stage', case when outcome_name = 'replaced' then 'awaiting_admin_acceptance' else 'awaiting_admin_exception_review' end,
    'performed_by', actor, 'performed_at', clock_timestamp(), 'version', p_expected_version + 1);
end
$$;
revoke all on function public.ais_technician_submit_closeout(uuid, integer, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.ais_technician_submit_closeout(uuid, integer, text, text, text, text, text, text, text, text) to authenticated;

create or replace function public.ais_admin_accept_task(
  p_task_id uuid,
  p_expected_version integer,
  p_register_observed_serial boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  task_version integer;
  task_status app_private.task_state;
  scanner_id uuid;
  target_branch_id uuid;
  new_serial_text text;
  observed_serial_text text;
  observed_model_text text;
  outcome_name text;
  performed_by_id uuid;
  closeout_by_id uuid;
  visit_id uuid;
  registered_asset_id uuid;
  registered_branch_id uuid;
  next_version integer;
  did_register boolean := false;
begin
  select ua.role into actor_role from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role is distinct from 'admin' then
    raise exception 'Office Admin access required to accept work' using errcode = '42501';
  end if;
  if p_task_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'Task and current version are required' using errcode = '22023';
  end if;
  select rt.status, rt.version, s.id, s.branch_id,
    fv.new_serial, fv.observed_serial, fv.observed_model, fv.outcome, fv.performed_by,
    rt.closeout_submitted_by, fv.id
  into task_status, task_version, scanner_id, target_branch_id,
    new_serial_text, observed_serial_text, observed_model_text, outcome_name, performed_by_id,
    closeout_by_id, visit_id
  from app_private.replacement_tasks rt
  left join app_private.campaign_items ci on ci.id = rt.campaign_item_id
  join app_private.scanner_assets s on s.id = coalesce(rt.scanner_asset_id, ci.scanner_asset_id)
  join app_private.field_visits fv on fv.task_id = rt.id
  where rt.id = p_task_id
  for update of rt, s, fv;
  if not found then raise exception 'Closeout was not found for this Scanner work item' using errcode = 'P0002'; end if;
  if task_version <> p_expected_version then
    raise exception 'Work item changed since it was loaded; refresh before retrying' using errcode = '40001';
  end if;
  if task_status <> 'in_progress'
    or not exists (select 1 from app_private.replacement_tasks rt where rt.id = p_task_id and rt.closeout_submitted_at is not null and rt.admin_accepted_at is null) then
    raise exception 'This Scanner is not waiting for Admin acceptance' using errcode = '22023';
  end if;
  if actor is not distinct from performed_by_id or actor is not distinct from closeout_by_id then
    raise exception 'The Admin who performed this work cannot accept it; another Admin must review it' using errcode = '42501';
  end if;
  if not exists (
    select 1 from app_private.replacement_task_evidence e
    join storage.objects o on o.bucket_id = 'ais-task-evidence' and o.name = e.object_path
    where e.task_id = p_task_id and e.slot = 'inspector_signature' and e.status = 'ready'
      and e.uploaded_by = actor and e.signer_name is not null
  ) then
    raise exception 'A different Office Admin must save the acceptance signature' using errcode = '22023';
  end if;

  if p_register_observed_serial and (outcome_name <> 'different_device_found' or observed_serial_text is null
    or length(btrim(observed_serial_text)) not between 1 and 100) then
    raise exception 'Only a different-device Serial confirmed by review can be registered' using errcode = '22023';
  end if;

  if outcome_name = 'different_device_found' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower(btrim(observed_serial_text)), 0));
    select asset.id, asset.branch_id into registered_asset_id, registered_branch_id
    from app_private.scanner_assets asset
    where lower(btrim(asset.com_sn)) = lower(btrim(observed_serial_text))
    for update;
    if found and registered_branch_id is distinct from target_branch_id then
      raise exception 'This Serial is already registered to another branch; resolve that record before acceptance' using errcode = '23505';
    elsif p_register_observed_serial and not found then
      insert into app_private.scanner_assets (branch_id, com_sn, model_name)
      values (target_branch_id, btrim(observed_serial_text), observed_model_text)
      returning id into registered_asset_id;
      did_register := true;
      insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
      values (actor, 'scanner_registered_after_exception_review', 'scanner_asset', registered_asset_id,
        pg_catalog.jsonb_build_object('task_id', p_task_id, 'branch_id', target_branch_id,
          'serial', btrim(observed_serial_text), 'model', observed_model_text,
          'source', 'onsite_report_reviewed_by_admin'));
    end if;
  end if;

  if outcome_name = 'replaced' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower(btrim(new_serial_text)), 0));
    if exists (select 1 from app_private.scanner_assets s where lower(btrim(s.com_sn)) = lower(btrim(new_serial_text)) and s.id <> scanner_id) then
      raise exception 'This replacement Serial is already registered' using errcode = '23505';
    end if;
    update app_private.scanner_assets set com_sn = btrim(new_serial_text), updated_at = clock_timestamp()
    where id = scanner_id;
    insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
    values (actor, 'scanner_replacement_registered', 'scanner_asset', scanner_id,
      pg_catalog.jsonb_build_object('task_id', p_task_id, 'old_serial', (select old_serial_snapshot from app_private.field_visits where id = visit_id),
        'new_serial', btrim(new_serial_text), 'actor_id', actor));
  elsif p_register_observed_serial and outcome_name <> 'different_device_found' then
    raise exception 'A found Serial can be registered only for a different-device result' using errcode = '22023';
  end if;

  update app_private.replacement_tasks
  set status = 'completed', resume_status = null, blocked_reason = null,
      admin_accepted_at = clock_timestamp(), admin_accepted_by = actor,
      version = version + 1, updated_at = clock_timestamp()
  where id = p_task_id and version = p_expected_version
  returning version into next_version;
  insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
  values (actor, 'scanner_work_admin_accepted', 'replacement_task', p_task_id,
    pg_catalog.jsonb_build_object('outcome', outcome_name, 'field_visit_id', visit_id,
      'observed_serial_registered', did_register, 'registered_asset_id', registered_asset_id));
  return pg_catalog.jsonb_build_object('task_id', p_task_id, 'status', 'completed',
    'workflow_stage', 'delivered', 'observed_serial_registered', did_register, 'version', next_version);
end
$$;
revoke all on function public.ais_admin_accept_task(uuid, integer, boolean) from public, anon;
grant execute on function public.ais_admin_accept_task(uuid, integer, boolean) to authenticated;

create or replace function public.ais_admin_accept_task(p_task_id uuid, p_expected_version integer)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.ais_admin_accept_task(p_task_id, p_expected_version, false);
$$;
revoke all on function public.ais_admin_accept_task(uuid, integer) from public, anon;
grant execute on function public.ais_admin_accept_task(uuid, integer) to authenticated;

create or replace function app_private.require_task_evidence_before_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  outcome_name text;
  missing_slots text[];
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    select fv.outcome into outcome_name from app_private.field_visits fv where fv.task_id = new.id;
    select array_agg(required.slot order by required.slot) into missing_slots
    from unnest(array[
      case when coalesce(outcome_name, 'replaced') in ('replaced', 'no_damage_found') then 'old_serial_photo' end,
      case when coalesce(outcome_name, 'replaced') = 'replaced' then 'new_serial_photo' end,
      case when coalesce(outcome_name, 'replaced') in ('replaced', 'no_damage_found') then 'old_device_photo' end,
      case when coalesce(outcome_name, 'replaced') = 'replaced' then 'new_device_photo' end,
      case when coalesce(outcome_name, 'replaced') = 'different_device_found' then 'new_serial_photo' end,
      case when coalesce(outcome_name, 'replaced') = 'different_device_found' then 'new_device_photo' end,
      case when coalesce(outcome_name, 'replaced') = 'target_device_not_found' then 'spare_photo_1' end,
      'technician_signature', 'scanner_user_signature', 'inspector_signature'
    ]::text[]) as required(slot)
    left join app_private.replacement_task_evidence e on e.task_id = new.id
      and e.slot = required.slot and e.status = 'ready'
    left join storage.objects o on o.bucket_id = 'ais-task-evidence' and o.name = e.object_path
    where required.slot is not null and (e.task_id is null or o.id is null);
    if coalesce(cardinality(missing_slots), 0) > 0 then
      raise exception 'Required photos and signatures are missing: %', array_to_string(missing_slots, ', ')
        using errcode = '22023';
    end if;
  end if;
  return new;
end
$$;

revoke all on function app_private.require_task_evidence_before_completion() from public, anon, authenticated;
revoke all on function public.ais_open_campaign_work_orders(uuid) from public, anon, authenticated;

create or replace function public.ais_cancel_task(
  p_task_id uuid,
  p_expected_version integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  reason_text text := nullif(btrim(coalesce(p_reason, '')), '');
  task_status app_private.task_state;
  task_version integer;
  next_version integer;
  work_order_id uuid;
begin
  select ua.role into actor_role from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role is distinct from 'admin' then
    raise exception 'Active Admin access required to cancel a work item' using errcode = '42501';
  end if;
  if p_task_id is null or p_expected_version is null or p_expected_version < 1
    or reason_text is null or length(reason_text) > 500 then
    raise exception 'Task, version, and a reason of 1 to 500 characters are required' using errcode = '22023';
  end if;
  select rt.status, rt.version, rt.branch_work_order_id
  into task_status, task_version, work_order_id
  from app_private.replacement_tasks rt where rt.id = p_task_id for update;
  if not found then raise exception 'Work item does not exist' using errcode = 'P0002'; end if;
  if task_version <> p_expected_version then
    raise exception 'Work item changed since it was loaded; refresh before retrying' using errcode = '40001';
  end if;
  if task_status in ('completed', 'cancelled') then
    raise exception 'A completed or cancelled work item cannot be cancelled' using errcode = '22023';
  end if;
  update app_private.replacement_tasks
  set status = 'cancelled', resume_status = null, blocked_reason = null,
      cancelled_reason = reason_text, version = version + 1, updated_at = clock_timestamp()
  where id = p_task_id and version = p_expected_version returning version into next_version;
  if next_version is null then raise exception 'Work item changed; reload before retrying' using errcode = '40001'; end if;
  insert into app_private.audit_events(actor_id, event_type, entity_type, entity_id, summary)
  values(actor, 'scanner_work_item_cancelled', 'replacement_task', p_task_id,
    jsonb_build_object('work_order_id', work_order_id, 'from_status', task_status::text,
      'to_status', 'cancelled', 'reason', reason_text, 'version', next_version));
  return jsonb_build_object('task_id', p_task_id, 'work_order_id', work_order_id,
    'status', 'cancelled', 'version', next_version);
end
$$;
revoke all on function public.ais_cancel_task(uuid, integer, text) from public, anon;
grant execute on function public.ais_cancel_task(uuid, integer, text) to authenticated;

create or replace function public.ais_scanner_work_history(
  p_asset_id uuid,
  p_task_id uuid default null,
  p_limit integer default 10,
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
  total_rows integer;
  result_rows jsonb;
begin
  select ua.role into actor_role from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role is null or actor_role not in ('admin', 'field_technician') then
    raise exception 'Active operational access required' using errcode = '42501';
  end if;
  if p_asset_id is null or p_limit is null or p_limit not between 1 and 20
    or p_offset is null or p_offset not between 0 and 1000 then
    raise exception 'Invalid Scanner work history request' using errcode = '22023';
  end if;
  select count(*)::integer into total_rows
  from app_private.replacement_tasks rt
  left join app_private.campaign_items ci on ci.id = rt.campaign_item_id
  where coalesce(rt.scanner_asset_id, ci.scanner_asset_id) = p_asset_id
    and (p_task_id is null or rt.id = p_task_id);
  select coalesce(jsonb_agg(history.row_data order by history.performed_at desc nulls last, history.created_at desc, history.id), '[]'::jsonb)
  into result_rows
  from (
    select rt.id, rt.created_at, visit.performed_at,
      jsonb_build_object(
        'id', rt.id, 'asset_id', s.id,
        'branch_name', coalesce(nullif(b.loc_bld, ''), b.location_code),
        'location_code', b.location_code, 'province', b.province,
        'scanner_model', coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), ''),
        'com_sn', coalesce(visit.old_serial_snapshot, rt.scanner_serial_snapshot, s.com_sn),
        'created_at', rt.created_at,
        'task_status', rt.status::text,
        'workflow_stage', app_private.task_workflow_stage(rt.status, rt.technician_confirmed_at,
          rt.closeout_submitted_at, rt.admin_accepted_at, visit.outcome),
        'workflow_outcome', visit.outcome,
        'observed_serial', visit.observed_serial, 'observed_model', visit.observed_model,
        'exception_reason', visit.exception_reason, 'version', rt.version,
        'blocked_reason', rt.blocked_reason, 'new_serial', visit.new_serial,
        'old_serial_snapshot', visit.old_serial_snapshot,
        'install_result', visit.install_result, 'old_scanner_status', visit.old_scanner_status,
        'old_scanner_note', visit.old_scanner_note, 'performed_by_name', visit.performer_name,
        'performed_at', visit.performed_at,
        'can_admin_accept', actor_role = 'admin' and rt.closeout_submitted_at is not null
          and rt.admin_accepted_at is null and actor is distinct from rt.closeout_submitted_by
          and actor is distinct from visit.performed_by
      ) as row_data
    from app_private.replacement_tasks rt
    left join app_private.campaign_items ci on ci.id = rt.campaign_item_id
    join app_private.scanner_assets s on s.id = coalesce(rt.scanner_asset_id, ci.scanner_asset_id)
    join app_private.branches b on b.id = s.branch_id
    left join lateral (
      select fv.old_serial_snapshot, fv.new_serial, fv.install_result,
        fv.old_scanner_status::text as old_scanner_status, fv.old_scanner_note,
        fv.outcome, fv.observed_serial, fv.observed_model, fv.exception_reason,
        fv.performed_at, fv.performed_by, ua.display_name as performer_name
      from app_private.field_visits fv
      left join app_private.user_access ua on ua.user_id = fv.performed_by
      where fv.task_id = rt.id
      order by fv.performed_at desc, fv.created_at desc, fv.id desc limit 1
    ) visit on true
    where coalesce(rt.scanner_asset_id, ci.scanner_asset_id) = p_asset_id
      and (p_task_id is null or rt.id = p_task_id)
    order by visit.performed_at desc nulls last, rt.updated_at desc, rt.id
    limit p_limit offset p_offset
  ) history;
  return jsonb_build_object('asset_id', p_asset_id, 'total', total_rows, 'rows', result_rows);
end
$$;
revoke all on function public.ais_scanner_work_history(uuid, uuid, integer, integer) from public, anon;
grant execute on function public.ais_scanner_work_history(uuid, uuid, integer, integer) to authenticated;

-- The register and dashboard must use direct Scanner work-item links for new
-- branch orders; old campaign joins alone make new orders appear unassigned.
create or replace function public.ais_scanner_page(
  p_search text default null,
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
  if search_term is not null and length(search_term) > 100 then
    raise exception 'Scanner search is longer than the supported limit' using errcode = '22023';
  end if;
  with filtered as materialized (
    select s.id, b.location_code, b.loc_bld as branch_name, b.province,
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
        select v.outcome from app_private.field_visits v
        where v.task_id = rt.id
        order by v.performed_at desc nulls last, v.created_at desc, v.id desc limit 1
      ) fv on true
      where coalesce(rt.scanner_asset_id, ci.scanner_asset_id) = s.id
      order by case when rt.status in ('scheduled', 'in_progress', 'blocked') then 0 else 1 end,
        rt.created_at desc, rt.id
      limit 1
    ) latest on true
    where (search_term is null
      or b.location_code ilike '%' || search_term || '%'
      or coalesce(b.loc_bld, '') ilike '%' || search_term || '%'
      or coalesce(b.province, '') ilike '%' || search_term || '%'
      or coalesce(s.model_name, '') ilike '%' || search_term || '%'
      or coalesce(s.hw_name, '') ilike '%' || search_term || '%'
      or (actor_role <> 'viewer' and s.com_sn ilike '%' || search_term || '%'))
  ), page as (
    select * from filtered order by location_code, branch_name, model_name, id
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'rows', coalesce((select jsonb_agg(to_jsonb(page) order by location_code, branch_name, model_name, id) from page), '[]'::jsonb)
  ) into result;
  return result;
end
$$;
revoke all on function public.ais_scanner_page(text, integer, integer) from public, anon;
grant execute on function public.ais_scanner_page(text, integer, integer) to authenticated;

create or replace function public.ais_dashboard()
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

  with item_rows as materialized (
    select wo.id as work_order_id, wo.work_order_code, wo.created_at as opened_at,
      b.location_code, coalesce(nullif(b.loc_bld, ''), b.location_code) as branch_name,
      rt.id as task_id, rt.status, rt.updated_at, rt.admin_accepted_at,
      s.com_sn, coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), 'เครื่องสแกน') as model,
      app_private.task_workflow_stage(rt.status, rt.technician_confirmed_at,
        rt.closeout_submitted_at, rt.admin_accepted_at, fv.outcome) as stage,
      case when actor_role = 'viewer' then '••••••' || right(coalesce(rt.scanner_serial_snapshot, s.com_sn), 4)
        else coalesce(rt.scanner_serial_snapshot, s.com_sn) end as display_serial
    from app_private.branch_work_orders wo
    join app_private.branches b on b.id = wo.branch_id
    join app_private.replacement_tasks rt on rt.branch_work_order_id = wo.id
    left join app_private.campaign_items ci on ci.id = rt.campaign_item_id
    join app_private.scanner_assets s on s.id = coalesce(rt.scanner_asset_id, ci.scanner_asset_id)
    left join lateral (
      select v.outcome from app_private.field_visits v
      where v.task_id = rt.id
      order by v.performed_at desc nulls last, v.created_at desc, v.id desc limit 1
    ) fv on true
  ), order_rows as materialized (
    select work_order_id, work_order_code, min(location_code) as location_code,
      min(branch_name) as branch_name, min(opened_at) as opened_at,
      count(*)::integer as total_tasks,
      count(*) filter (where stage in ('delivered', 'legacy_completed', 'cancelled'))::integer as done_tasks,
      case
        when bool_and(stage = 'cancelled') then 'cancelled'
        when count(*) filter (where stage not in ('delivered', 'legacy_completed', 'cancelled')) = 0
          and bool_or(stage = 'delivered') then 'delivered'
        when bool_or(stage = 'awaiting_admin_exception_review') then 'awaiting_admin_exception_review'
        when bool_or(stage = 'awaiting_admin_acceptance') then 'awaiting_admin_acceptance'
        when bool_or(stage = 'blocked') then 'blocked'
        when bool_or(stage = 'in_progress') then 'in_progress'
        when bool_and(stage = 'open') then 'open'
        else 'legacy_completed'
      end as workflow_stage,
      case when count(*) filter (where stage not in ('delivered', 'legacy_completed', 'cancelled')) = 0
        and bool_or(stage in ('delivered', 'legacy_completed'))
        then max(coalesce(admin_accepted_at, updated_at)) end as completed_at
    from item_rows
    group by work_order_id, work_order_code
  ), days as (
    select ((now() at time zone 'Asia/Bangkok')::date - offsets.offset_days) as day
    from generate_series(0, 6) as offsets(offset_days)
  ), weekly as (
    select days.day,
      (select count(*)::integer from app_private.branch_work_orders wo
        where wo.origin = 'admin' and (wo.created_at at time zone 'Asia/Bangkok')::date = days.day) as opened,
      (select count(*)::integer from order_rows orders
        where orders.workflow_stage = 'delivered'
          and (orders.completed_at at time zone 'Asia/Bangkok')::date = days.day) as completed
    from days
  ), recent_orders as (
    select jsonb_agg(jsonb_build_object(
      'campaign_code', work_order_code, 'campaign_name', branch_name,
      'status', workflow_stage, 'total_tasks', total_tasks,
      'done_tasks', done_tasks, 'branches', 1
    ) order by opened_at desc, work_order_id) as rows
    from (select * from order_rows order by opened_at desc, work_order_id limit 5) recent
  ), recent_tasks as (
    select jsonb_agg(jsonb_build_object(
      'id', task_id, 'branch_name', branch_name, 'location_code', location_code,
      'scanner_model', model, 'com_sn', display_serial, 'task_status', status::text,
      'workflow_stage', stage, 'work_order_code', work_order_code,
      'created_at', opened_at
    ) order by opened_at desc, task_id) as rows
    from (select * from item_rows order by opened_at desc, task_id limit 6) latest
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'branches', (select count(*)::integer from app_private.branches),
      'scanners', (select count(*)::integer from app_private.scanner_assets),
      'active_tasks', (select count(*)::integer from app_private.replacement_tasks rt where rt.status in ('scheduled', 'in_progress', 'blocked')),
      'completed_tasks', (select count(*)::integer from app_private.replacement_tasks rt where rt.status = 'completed')
    ),
    'campaigns', coalesce((select rows from recent_orders), '[]'::jsonb),
    'tasks', coalesce((select rows from recent_tasks), '[]'::jsonb),
    'weekly_activity', coalesce((select jsonb_agg(jsonb_build_object('date', day, 'opened', opened, 'completed', completed) order by day) from weekly), '[]'::jsonb)
  ) into result;
  return result;
end
$$;
revoke all on function public.ais_dashboard() from public, anon;
grant execute on function public.ais_dashboard() to authenticated;

-- New work uses one branch work order and one child task per verified Scanner.
-- Keep legacy campaign records and read RPCs for history, but close every old
-- write path that could select devices or assign teams/dates outside this flow.
revoke all on function public.ais_create_campaign(text, text, uuid[], text, date, date)
  from public, anon, authenticated;
revoke all on function public.ais_update_campaign_selection(uuid, timestamptz, uuid[], uuid[], text)
  from public, anon, authenticated;
revoke all on function public.ais_schedule_campaign(uuid, uuid, date)
  from public, anon, authenticated;
revoke all on function public.ais_schedule_campaign_by_branch(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.ais_campaign_action(uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.ais_open_campaign_work_orders(uuid)
  from public, anon, authenticated;

comment on function public.ais_create_campaign(text, text, uuid[], text, date, date) is
  'Legacy campaign creation is disabled; open new work through ais_open_branch_work_order.';
comment on function public.ais_update_campaign_selection(uuid, timestamptz, uuid[], uuid[], text) is
  'Legacy campaign editing is disabled; new work targets are fixed from the verified register at opening.';
comment on function public.ais_schedule_campaign_by_branch(uuid, jsonb) is
  'Legacy team/date assignment is disabled; new branch work orders are visible to all active field technicians.';


