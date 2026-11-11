-- Move daily operations to a Scanner-first register while keeping all historical
-- records and the existing evidence / independent Admin acceptance workflow.

alter table app_private.branch_work_orders
  drop constraint if exists branch_work_orders_origin_check;
alter table app_private.branch_work_orders
  add constraint branch_work_orders_origin_check
  check (origin in ('admin', 'legacy', 'scanner_detail'));

create table app_private.scanner_discovery_reports (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references app_private.branches(id) on delete restrict,
  serial_number text not null check (length(btrim(serial_number)) between 1 and 100),
  observed_model text check (observed_model is null or length(btrim(observed_model)) <= 160),
  notes text check (notes is null or length(btrim(notes)) <= 1000),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'duplicate')),
  reported_by uuid not null references auth.users(id) on delete restrict,
  reviewed_by uuid references auth.users(id) on delete set null,
  review_note text check (review_note is null or length(btrim(review_note)) <= 1000),
  created_asset_id uuid references app_private.scanner_assets(id) on delete set null,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  check ((status = 'pending' and reviewed_by is null and reviewed_at is null)
    or (status <> 'pending' and reviewed_by is not null and reviewed_at is not null))
);

alter table app_private.scanner_discovery_reports enable row level security;
create policy scanner_discovery_reports_deny_browser
  on app_private.scanner_discovery_reports for all to anon, authenticated
  using (false) with check (false);
revoke all on table app_private.scanner_discovery_reports from public, anon, authenticated;
create index scanner_discovery_reports_branch_created_idx
  on app_private.scanner_discovery_reports (branch_id, created_at desc);
create index scanner_discovery_reports_pending_created_idx
  on app_private.scanner_discovery_reports (created_at, id) where status = 'pending';
create unique index scanner_discovery_reports_pending_serial_uidx
  on app_private.scanner_discovery_reports (lower(btrim(serial_number))) where status = 'pending';

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
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role not in ('admin', 'field_technician') then
    raise exception 'Active application access required' using errcode = '42501';
  end if;

  with scanner_state as (
    select s.id as asset_id, s.branch_id,
      case
        when latest.workflow_stage in ('delivered', 'exception_resolved', 'legacy_completed') then 'complete'
        when latest.task_status in ('scheduled', 'in_progress', 'blocked') then 'on_process'
        else 'open'
      end as state
    from app_private.scanner_assets s
    left join lateral (
      select rt.status::text as task_status,
        app_private.task_workflow_stage(rt.status, rt.technician_confirmed_at,
          rt.closeout_submitted_at, rt.admin_accepted_at, fv.outcome) as workflow_stage
      from app_private.replacement_tasks rt
      left join app_private.campaign_items ci on ci.id = rt.campaign_item_id
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
  ) into result
  from province_state ps;
  return result;
end
$$;
revoke all on function public.ais_dashboard_province_summary() from public, anon;
grant execute on function public.ais_dashboard_province_summary() to authenticated;

create or replace function public.ais_start_scanner_replacement(
  p_scanner_asset_id uuid,
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
  branch_id uuid;
  branch_code text;
  scanner_serial text;
  scanner_model text;
  order_id uuid;
  order_origin text;
  order_code text;
  task_id uuid;
  task_version integer;
  existing_actor uuid;
  existing_scanner uuid;
  existing_status text;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role not in ('admin', 'field_technician') then
    raise exception 'Active Admin or Field Technician access required' using errcode = '42501';
  end if;
  if p_scanner_asset_id is null or p_request_id is null then
    raise exception 'Scanner and request id are required' using errcode = '22023';
  end if;

  select wo.id, wo.branch_id, wo.created_by, wo.origin into order_id, branch_id, existing_actor, order_origin
  from app_private.branch_work_orders wo where wo.request_id = p_request_id for update;
  if found then
    if order_origin <> 'scanner_detail' or existing_actor is distinct from actor then
      raise exception 'Request id was already used for another account or workflow' using errcode = '22023';
    end if;
    select rt.id, coalesce(rt.scanner_asset_id, ci.scanner_asset_id), rt.version, rt.status::text
    into task_id, existing_scanner, task_version, existing_status
    from app_private.replacement_tasks rt
    left join app_private.campaign_items ci on ci.id = rt.campaign_item_id
    where rt.branch_work_order_id = order_id
      and coalesce(rt.scanner_asset_id, ci.scanner_asset_id) = p_scanner_asset_id;
    if task_id is null then
      raise exception 'Request id was already used for another Scanner' using errcode = '22023';
    end if;
    return jsonb_build_object('work_order_id', order_id, 'task_id', task_id,
      'scanner_asset_id', existing_scanner, 'status', existing_status,
      'version', task_version, 'already_started', true);
  end if;

  select s.branch_id, b.location_code, s.com_sn,
    coalesce(nullif(btrim(s.model_name), ''), nullif(btrim(s.hw_name), ''), 'เครื่องสแกน')
  into branch_id, branch_code, scanner_serial, scanner_model
  from app_private.scanner_assets s
  join app_private.branches b on b.id = s.branch_id
  where s.id = p_scanner_asset_id
  for update of s;
  if not found then raise exception 'Registered Scanner was not found' using errcode = 'P0002'; end if;

  if exists (
    select 1 from app_private.replacement_tasks rt
    left join app_private.campaign_items ci on ci.id = rt.campaign_item_id
    where coalesce(rt.scanner_asset_id, ci.scanner_asset_id) = p_scanner_asset_id
      and rt.status in ('scheduled', 'in_progress', 'blocked')
  ) then
    raise exception 'This Scanner already has active work' using errcode = '55000';
  end if;

  order_id := gen_random_uuid();
  order_code := 'SW-' || branch_code || '-' || to_char(clock_timestamp(), 'YYMMDDHH24MISS') || '-' || upper(substr(order_id::text, 1, 6));
  insert into app_private.branch_work_orders (id, work_order_code, branch_id, origin, request_id, created_by)
  values (order_id, order_code, branch_id, 'scanner_detail', p_request_id, actor);

  insert into app_private.replacement_tasks (
    scanner_asset_id, branch_work_order_id, scanner_serial_snapshot, scanner_model_snapshot,
    status, started_at, started_by
  ) values (
    p_scanner_asset_id, order_id, scanner_serial, scanner_model,
    'in_progress', clock_timestamp(), actor
  ) returning id, version into task_id, task_version;

  insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
  values (actor, 'scanner_work_started', 'replacement_task', task_id,
    jsonb_build_object('branch_id', branch_id, 'location_code', branch_code,
      'scanner_asset_id', p_scanner_asset_id, 'serial_snapshot', scanner_serial,
      'source', 'scanner_detail', 'started_at', clock_timestamp(), 'version', task_version));

  return jsonb_build_object('work_order_id', order_id, 'work_order_code', order_code,
    'task_id', task_id, 'scanner_asset_id', p_scanner_asset_id,
    'status', 'in_progress', 'version', task_version, 'already_started', false);
end
$$;
revoke all on function public.ais_start_scanner_replacement(uuid, uuid) from public, anon;
grant execute on function public.ais_start_scanner_replacement(uuid, uuid) to authenticated;

create or replace function public.ais_report_unregistered_scanner(
  p_branch_id uuid,
  p_serial_number text,
  p_observed_model text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  serial_value text := nullif(btrim(coalesce(p_serial_number, '')), '');
  model_value text := nullif(btrim(coalesce(p_observed_model, '')), '');
  note_value text := nullif(btrim(coalesce(p_notes, '')), '');
  report_id uuid;
begin
  select ua.role into actor_role from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role not in ('admin', 'field_technician') then
    raise exception 'Active Admin or Field Technician access required' using errcode = '42501';
  end if;
  if p_branch_id is null or serial_value is null or length(serial_value) > 100
    or (model_value is not null and length(model_value) > 160)
    or (note_value is not null and length(note_value) > 1000) then
    raise exception 'Branch, serial, and valid optional details are required' using errcode = '22023';
  end if;
  if not exists (select 1 from app_private.branches b where b.id = p_branch_id) then
    raise exception 'Branch was not found' using errcode = 'P0002';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower(serial_value), 0));
  if exists (select 1 from app_private.scanner_assets s where lower(btrim(s.com_sn)) = lower(serial_value)) then
    raise exception 'Serial is already present in the Scanner register; submit it as a work-order exception for review' using errcode = '23505';
  end if;
  insert into app_private.scanner_discovery_reports (branch_id, serial_number, observed_model, notes, reported_by)
  values (p_branch_id, serial_value, model_value, note_value, actor)
  returning id into report_id;
  insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
  values (actor, 'scanner_discovery_reported', 'scanner_discovery_report', report_id,
    jsonb_build_object('branch_id', p_branch_id, 'serial_number', serial_value));
  return jsonb_build_object('report_id', report_id, 'status', 'pending');
end
$$;
revoke all on function public.ais_report_unregistered_scanner(uuid, text, text, text) from public, anon;
grant execute on function public.ais_report_unregistered_scanner(uuid, text, text, text) to authenticated;

create or replace function public.ais_list_scanner_discovery_reports(p_limit integer default 50)
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
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Limit must be between 1 and 100' using errcode = '22023';
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
    order by pending.created_at, pending.id limit p_limit
  ) r
  join app_private.branches b on b.id = r.branch_id
  left join app_private.user_access ua on ua.user_id = r.reported_by;
  return result;
end
$$;
revoke all on function public.ais_list_scanner_discovery_reports(integer) from public, anon;
grant execute on function public.ais_list_scanner_discovery_reports(integer) to authenticated;

create or replace function public.ais_admin_review_scanner_discovery(
  p_report_id uuid,
  p_decision text,
  p_review_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  decision_value text := lower(btrim(coalesce(p_decision, '')));
  note_value text := nullif(btrim(coalesce(p_review_note, '')), '');
  report_row app_private.scanner_discovery_reports%rowtype;
  created_asset uuid;
  inserted_count integer;
begin
  select ua.role into actor_role from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role is distinct from 'admin' then
    raise exception 'Active Admin access required' using errcode = '42501';
  end if;
  if p_report_id is null or decision_value not in ('approve', 'reject')
    or (note_value is not null and length(note_value) > 1000) then
    raise exception 'Valid report and review decision are required' using errcode = '22023';
  end if;

  select r.* into report_row from app_private.scanner_discovery_reports r
  where r.id = p_report_id for update;
  if not found then raise exception 'Scanner report was not found' using errcode = 'P0002'; end if;
  if report_row.status <> 'pending' then
    if (decision_value = 'approve' and report_row.status in ('approved', 'duplicate'))
      or (decision_value = 'reject' and report_row.status = 'rejected') then
      return jsonb_build_object('report_id', report_row.id, 'status', report_row.status,
        'scanner_asset_id', report_row.created_asset_id, 'already_reviewed', true);
    end if;
    raise exception 'This report has already been reviewed' using errcode = '55000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower(btrim(report_row.serial_number)), 0));
  if decision_value = 'reject' then
    update app_private.scanner_discovery_reports
    set status = 'rejected', reviewed_by = actor, reviewed_at = clock_timestamp(), review_note = note_value
    where id = report_row.id;
    insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
    values (actor, 'scanner_discovery_rejected', 'scanner_discovery_report', report_row.id,
      jsonb_build_object('branch_id', report_row.branch_id, 'serial_number', report_row.serial_number, 'review_note', note_value));
    return jsonb_build_object('report_id', report_row.id, 'status', 'rejected');
  end if;

  insert into app_private.scanner_assets (branch_id, com_sn, model_name, hw_name)
  select report_row.branch_id, report_row.serial_number, report_row.observed_model, report_row.observed_model
  where not exists (
    select 1 from app_private.scanner_assets s where lower(btrim(s.com_sn)) = lower(btrim(report_row.serial_number))
  )
  on conflict do nothing
  returning id into created_asset;
  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then
    update app_private.scanner_discovery_reports
    set status = 'duplicate', reviewed_by = actor, reviewed_at = clock_timestamp(),
      review_note = coalesce(note_value, 'Serial ถูกเพิ่มเข้าทะเบียนแล้ว จึงไม่ได้สร้างรายการซ้ำ')
    where id = report_row.id;
    insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
    values (actor, 'scanner_discovery_duplicate', 'scanner_discovery_report', report_row.id,
      jsonb_build_object('branch_id', report_row.branch_id, 'serial_number', report_row.serial_number));
    return jsonb_build_object('report_id', report_row.id, 'status', 'duplicate');
  end if;

  update app_private.scanner_discovery_reports
  set status = 'approved', reviewed_by = actor, reviewed_at = clock_timestamp(),
    review_note = note_value, created_asset_id = created_asset
  where id = report_row.id;
  insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
  values (actor, 'scanner_discovery_approved', 'scanner_discovery_report', report_row.id,
    jsonb_build_object('branch_id', report_row.branch_id, 'serial_number', report_row.serial_number, 'scanner_asset_id', created_asset));
  return jsonb_build_object('report_id', report_row.id, 'status', 'approved', 'scanner_asset_id', created_asset);
end
$$;
revoke all on function public.ais_admin_review_scanner_discovery(uuid, text, text) from public, anon;
grant execute on function public.ais_admin_review_scanner_discovery(uuid, text, text) to authenticated;

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
  if actor is null or actor_role not in ('admin', 'field_technician') then
    raise exception 'Active application access required' using errcode = '42501';
  end if;
  if p_asset_id is null or p_limit is null or p_limit not between 1 and 20
    or p_offset is null or p_offset not between 0 and 1000 then
    raise exception 'Invalid scanner work history request' using errcode = '22023';
  end if;

  select count(*)::integer into total_rows
  from app_private.replacement_tasks rt
  left join app_private.campaign_items ci on ci.id = rt.campaign_item_id
  where coalesce(rt.scanner_asset_id, ci.scanner_asset_id) = p_asset_id
    and (p_task_id is null or rt.id = p_task_id);

  select coalesce(jsonb_agg(history.row_data order by history.sort_performed_at desc nulls last,
    history.sort_updated_at desc, history.id desc), '[]'::jsonb)
  into result_rows
  from (
    select rt.id, visit.performed_at as sort_performed_at, rt.updated_at as sort_updated_at,
      jsonb_build_object(
        'id', rt.id, 'asset_id', s.id, 'branch_name', coalesce(nullif(b.loc_bld, ''), b.location_code),
        'location_code', b.location_code, 'province', b.province,
        'scanner_model', coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), ''),
        'com_sn', s.com_sn, 'work_order_code', wo.work_order_code,
        'team_name', t.team_name, 'team_active', coalesce(t.is_active, false),
        'scheduled_for', rt.scheduled_for, 'created_at', rt.created_at,
        'started_at', rt.started_at, 'started_by', rt.started_by,
        'closeout_submitted_at', rt.closeout_submitted_at,
        'closeout_submitted_by', rt.closeout_submitted_by,
        'admin_accepted_at', rt.admin_accepted_at,
        'admin_accepted_by', rt.admin_accepted_by,
        'task_status', rt.status::text,
        'workflow_stage', app_private.task_workflow_stage(rt.status, rt.technician_confirmed_at,
          rt.closeout_submitted_at, rt.admin_accepted_at, visit.outcome),
        'workflow_outcome', visit.outcome, 'observed_serial', visit.observed_serial,
        'observed_model', visit.observed_model, 'exception_reason', visit.exception_reason,
        'version', rt.version, 'blocked_reason', rt.blocked_reason,
        'new_serial', visit.new_serial, 'old_serial_snapshot', visit.old_serial_snapshot,
        'install_result', visit.install_result, 'old_scanner_status', visit.old_scanner_status,
        'old_scanner_note', visit.old_scanner_note, 'performed_by_name', visit.performer_name,
        'performed_at', visit.performed_at, 'can_admin_accept',
          actor_role = 'admin' and rt.closeout_submitted_at is not null
          and rt.admin_accepted_at is null and actor is distinct from rt.closeout_submitted_by
          and actor is distinct from visit.performed_by
      ) as row_data
    from app_private.replacement_tasks rt
    left join app_private.campaign_items ci on ci.id = rt.campaign_item_id
    join app_private.scanner_assets s on s.id = coalesce(rt.scanner_asset_id, ci.scanner_asset_id)
    join app_private.branches b on b.id = s.branch_id
    left join app_private.branch_work_orders wo on wo.id = rt.branch_work_order_id
    left join app_private.teams t on t.id = rt.team_id
    left join lateral (
      select fv.old_serial_snapshot, fv.new_serial, fv.install_result,
        fv.old_scanner_status::text as old_scanner_status, fv.old_scanner_note,
        fv.outcome, fv.observed_serial, fv.observed_model, fv.exception_reason, fv.performed_at,
        ua.display_name as performer_name, fv.performed_by
      from app_private.field_visits fv
      left join app_private.user_access ua on ua.user_id = fv.performed_by
      where fv.task_id = rt.id
      order by fv.performed_at desc, fv.created_at desc, fv.id desc limit 1
    ) visit on true
    where coalesce(rt.scanner_asset_id, ci.scanner_asset_id) = p_asset_id
      and (p_task_id is null or rt.id = p_task_id)
    order by visit.performed_at desc nulls last, rt.updated_at desc, rt.id desc
    limit p_limit offset p_offset
  ) history;
  return jsonb_build_object('asset_id', p_asset_id, 'total', total_rows, 'rows', result_rows);
end
$$;
revoke all on function public.ais_scanner_work_history(uuid, uuid, integer, integer) from public, anon;
grant execute on function public.ais_scanner_work_history(uuid, uuid, integer, integer) to authenticated;

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
  if p_limit is null or p_limit not between 1 and 200 or p_offset is null or p_offset < 0
    or length(coalesce(search_term, '')) > 100 then
    raise exception 'Invalid scanner search or pagination request' using errcode = '22023';
  end if;
  with filtered as materialized (
    select s.id, b.id as branch_id, b.location_code, b.loc_bld as branch_name, b.province,
      coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), '') as model_name, s.brand,
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
        select v.outcome from app_private.field_visits v where v.task_id = rt.id
        order by v.performed_at desc nulls last, v.created_at desc, v.id desc limit 1
      ) fv on true
      where coalesce(rt.scanner_asset_id, ci.scanner_asset_id) = s.id
      order by case when rt.status in ('scheduled', 'in_progress', 'blocked') then 0 else 1 end,
        rt.created_at desc, rt.id desc limit 1
    ) latest on true
    where search_term is null
      or b.location_code ilike '%' || search_term || '%'
      or coalesce(b.loc_bld, '') ilike '%' || search_term || '%'
      or coalesce(b.province, '') ilike '%' || search_term || '%'
      or coalesce(s.model_name, '') ilike '%' || search_term || '%'
      or coalesce(s.hw_name, '') ilike '%' || search_term || '%'
      or (actor_role <> 'viewer' and s.com_sn ilike '%' || search_term || '%')
  ), page as (
    select * from filtered order by lower(coalesce(province, '')), location_code, branch_name, model_name, id
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'rows', coalesce((select jsonb_agg(to_jsonb(page) order by lower(coalesce(province, '')), location_code, branch_name, model_name, id) from page), '[]'::jsonb)
  ) into result;
  return result;
end
$$;
revoke all on function public.ais_scanner_page(text, integer, integer) from public, anon;
grant execute on function public.ais_scanner_page(text, integer, integer) to authenticated;

comment on table app_private.scanner_discovery_reports is
  'Admin-reviewed reports for Scanner units found onsite but not present in the registered branch inventory.';
comment on function public.ais_start_scanner_replacement(uuid, uuid) is
  'Starts one registered Scanner replacement directly from its details page, atomically creating the internal work record and recording the initiating user.';
comment on function public.ais_dashboard_province_summary() is
  'Returns province totals for branches and Scanner replacement progress to active Admin and field technician users.';
