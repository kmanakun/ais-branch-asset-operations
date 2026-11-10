-- AIS Branch & Asset Operations
-- Domain tables stay in a non-exposed schema. Browser access is limited to
-- reviewed, read-only SECURITY DEFINER RPCs with explicit user/team checks.

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

create type app_private.app_role as enum (
  'admin',
  'data_manager',
  'planner',
  'field_technician',
  'viewer'
);

create type app_private.campaign_state as enum (
  'draft',
  'selection',
  'ready_to_schedule',
  'scheduled',
  'in_progress',
  'blocked',
  'completed',
  'cancelled'
);

create type app_private.task_state as enum (
  'scheduled',
  'in_progress',
  'blocked',
  'completed',
  'cancelled'
);

create type app_private.old_scanner_state as enum (
  'returned_usable',
  'returned_damaged',
  'sent_for_repair',
  'not_returned',
  'lost',
  'other'
);

create table app_private.branches (
  id uuid primary key default gen_random_uuid(),
  location_code text not null unique check (length(trim(location_code)) > 0),
  subs_zn text,
  loc_bld text,
  address text,
  province text,
  district text,
  subdistrict text,
  postal_code text,
  ro text,
  high_level_location text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app_private.scanner_assets (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references app_private.branches(id) on delete restrict,
  hw_name text,
  brand text,
  model_name text,
  com_id text,
  com_sn text not null check (length(trim(com_sn)) > 0),
  model_id text,
  com_years text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scanner_assets_com_sn_unique unique (com_sn)
);
create index scanner_assets_branch_id_idx on app_private.scanner_assets(branch_id);

create table app_private.teams (
  id uuid primary key default gen_random_uuid(),
  team_name text not null unique check (length(trim(team_name)) > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table app_private.user_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role app_private.app_role not null,
  display_name text not null check (length(trim(display_name)) > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app_private.user_team_memberships (
  user_id uuid not null references app_private.user_access(user_id) on delete cascade,
  team_id uuid not null references app_private.teams(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (user_id, team_id)
);
create index user_team_memberships_team_idx on app_private.user_team_memberships(team_id, user_id);

create table app_private.campaigns (
  id uuid primary key default gen_random_uuid(),
  campaign_code text not null unique check (length(trim(campaign_code)) > 0),
  campaign_name text not null check (length(trim(campaign_name)) > 0),
  status app_private.campaign_state not null default 'draft',
  resume_status app_private.campaign_state,
  start_on date,
  end_on date,
  cancelled_reason text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_on is null or start_on is null or end_on >= start_on),
  check ((status <> 'cancelled') or length(trim(coalesce(cancelled_reason, ''))) > 0),
  check ((status <> 'blocked') or resume_status is not null)
);

create table app_private.campaign_items (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references app_private.campaigns(id) on delete restrict,
  scanner_asset_id uuid not null references app_private.scanner_assets(id) on delete restrict,
  selection_reason text not null check (length(trim(selection_reason)) > 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (campaign_id, scanner_asset_id)
);
create index campaign_items_scanner_idx on app_private.campaign_items(scanner_asset_id);

create table app_private.replacement_tasks (
  id uuid primary key default gen_random_uuid(),
  campaign_item_id uuid not null unique references app_private.campaign_items(id) on delete restrict,
  team_id uuid references app_private.teams(id) on delete restrict,
  scheduled_for timestamptz,
  status app_private.task_state not null default 'scheduled',
  resume_status app_private.task_state,
  blocked_reason text,
  cancelled_reason text,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status <> 'blocked') or (resume_status is not null and length(trim(coalesce(blocked_reason, ''))) > 0)),
  check ((status <> 'cancelled') or length(trim(coalesce(cancelled_reason, ''))) > 0)
);
create index replacement_tasks_team_status_idx on app_private.replacement_tasks(team_id, status, scheduled_for);

create table app_private.field_visits (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references app_private.replacement_tasks(id) on delete restrict,
  old_serial_snapshot text not null,
  new_serial text not null check (length(trim(new_serial)) > 0),
  install_result text not null check (length(trim(install_result)) > 0),
  old_scanner_status app_private.old_scanner_state not null,
  old_scanner_note text,
  performed_by uuid not null references auth.users(id) on delete restrict,
  performed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check ((old_scanner_status <> 'other') or length(trim(coalesce(old_scanner_note, ''))) > 0)
);
create index field_visits_task_performed_idx on app_private.field_visits(task_id, performed_at desc);

create table app_private.import_batches (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  uploaded_by uuid not null references auth.users(id) on delete restrict,
  status text not null check (status in ('staged', 'committed', 'rejected', 'expired')),
  row_count integer not null default 0 check (row_count >= 0),
  issue_count integer not null default 0 check (issue_count >= 0),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  committed_at timestamptz,
  created_at timestamptz not null default now()
);

create table app_private.import_staging_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references app_private.import_batches(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  normalized_data jsonb not null,
  created_at timestamptz not null default now(),
  unique (batch_id, row_number)
);
create index import_staging_expiry_idx on app_private.import_staging_rows(created_at);

create table app_private.import_row_issues (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references app_private.import_batches(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  field_name text not null,
  issue_code text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create table app_private.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_created_at_idx on app_private.audit_events(created_at desc);

-- No browser role receives direct table access. RLS is enabled as a second
-- deny-by-default boundary in case grants are expanded in a future migration.
do $$
declare
  item record;
begin
  for item in
    select tablename from pg_tables where schemaname = 'app_private'
  loop
    execute format('alter table app_private.%I enable row level security', item.tablename);
    execute format('revoke all on table app_private.%I from public, anon, authenticated', item.tablename);
  end loop;
end
$$;

create or replace function public.ais_app_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if auth.uid() is null then
    return null;
  end if;
  select jsonb_build_object(
    'role', ua.role::text,
    'display_name', ua.display_name,
    'teams', coalesce((
      select jsonb_agg(t.team_name order by t.team_name)
      from app_private.user_team_memberships utm
      join app_private.teams t on t.id = utm.team_id and t.is_active
      where utm.user_id = ua.user_id
    ), '[]'::jsonb)
  )
  into result
  from app_private.user_access ua
  where ua.user_id = auth.uid() and ua.is_active;
  return result;
end
$$;

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
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;
  if actor is null or actor_role is null then
    raise exception 'Application access required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'totals', jsonb_build_object(
      'branches', (select count(*) from app_private.branches b where actor_role <> 'field_technician' or exists (
        select 1 from app_private.scanner_assets s
        join app_private.campaign_items ci on ci.scanner_asset_id = s.id
        join app_private.replacement_tasks rt on rt.campaign_item_id = ci.id
        join app_private.user_team_memberships utm on utm.team_id = rt.team_id and utm.user_id = actor
        where s.branch_id = b.id
      )),
      'scanners', (select count(*) from app_private.scanner_assets s where actor_role <> 'field_technician' or exists (
        select 1 from app_private.campaign_items ci
        join app_private.replacement_tasks rt on rt.campaign_item_id = ci.id
        join app_private.user_team_memberships utm on utm.team_id = rt.team_id and utm.user_id = actor
        where ci.scanner_asset_id = s.id
      )),
      'active_tasks', (select count(*) from app_private.replacement_tasks rt
        join app_private.campaign_items ci on ci.id = rt.campaign_item_id
        where rt.status in ('scheduled', 'in_progress', 'blocked')
          and (actor_role <> 'field_technician' or exists (
            select 1 from app_private.user_team_memberships utm where utm.team_id = rt.team_id and utm.user_id = actor
          ))),
      'completed_tasks', (select count(*) from app_private.replacement_tasks rt
        join app_private.campaign_items ci on ci.id = rt.campaign_item_id
        where rt.status = 'completed'
          and (actor_role <> 'field_technician' or exists (
            select 1 from app_private.user_team_memberships utm where utm.team_id = rt.team_id and utm.user_id = actor
          )))
    ),
    'campaigns', coalesce((
      select jsonb_agg(row_data order by created_at desc)
      from (
        select jsonb_build_object(
          'campaign_code', c.campaign_code,
          'campaign_name', c.campaign_name,
          'status', c.status::text,
          'total_tasks', count(rt.id),
          'done_tasks', count(rt.id) filter (where rt.status in ('completed', 'cancelled'))
        ) as row_data, c.created_at
        from app_private.campaigns c
        left join app_private.campaign_items ci on ci.campaign_id = c.id
        left join app_private.replacement_tasks rt on rt.campaign_item_id = ci.id
        where actor_role <> 'field_technician' or exists (
          select 1 from app_private.campaign_items ci2
          join app_private.replacement_tasks rt2 on rt2.campaign_item_id = ci2.id
          join app_private.user_team_memberships utm on utm.team_id = rt2.team_id and utm.user_id = actor
          where ci2.campaign_id = c.id
        )
        group by c.id
        order by c.created_at desc
        limit 5
      ) recent
    ), '[]'::jsonb),
    'tasks', coalesce((
      select jsonb_agg(row_data order by scheduled_for nulls last)
      from (
        select jsonb_build_object(
          'id', rt.id,
          'branch_name', coalesce(nullif(b.loc_bld, ''), b.location_code),
          'location_code', b.location_code,
          'scanner_model', coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), 'เครื่องสแกน'),
          'com_sn', case when actor_role = 'viewer' then '••••••' || right(s.com_sn, 4) else s.com_sn end,
          'team_name', t.team_name,
          'scheduled_for', rt.scheduled_for,
          'task_status', rt.status::text
        ) as row_data, rt.scheduled_for
        from app_private.replacement_tasks rt
        join app_private.campaign_items ci on ci.id = rt.campaign_item_id
        join app_private.scanner_assets s on s.id = ci.scanner_asset_id
        join app_private.branches b on b.id = s.branch_id
        left join app_private.teams t on t.id = rt.team_id
        where (actor_role <> 'field_technician' or exists (
          select 1 from app_private.user_team_memberships utm where utm.team_id = rt.team_id and utm.user_id = actor
        ))
        order by rt.scheduled_for nulls last
        limit 6
      ) upcoming
    ), '[]'::jsonb)
  )
  into result;
  return result;
end
$$;

create or replace function public.ais_list_campaigns(p_search text default null)
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
  select coalesce(jsonb_agg(row_data order by campaign_code), '[]'::jsonb) into result
  from (
    select jsonb_build_object(
      'campaign_code', c.campaign_code,
      'campaign_name', c.campaign_name,
      'status', c.status::text,
      'start_on', c.start_on,
      'end_on', c.end_on,
      'total_tasks', count(rt.id),
      'done_tasks', count(rt.id) filter (where rt.status in ('completed', 'cancelled'))
    ) as row_data, c.campaign_code
    from app_private.campaigns c
    left join app_private.campaign_items ci on ci.campaign_id = c.id
    left join app_private.replacement_tasks rt on rt.campaign_item_id = ci.id
    where (coalesce(trim(p_search), '') = '' or c.campaign_code ilike '%' || left(trim(p_search), 100) || '%' or c.campaign_name ilike '%' || left(trim(p_search), 100) || '%')
      and (actor_role <> 'field_technician' or exists (
        select 1 from app_private.campaign_items ci2
        join app_private.replacement_tasks rt2 on rt2.campaign_item_id = ci2.id
        join app_private.user_team_memberships utm on utm.team_id = rt2.team_id and utm.user_id = actor
        where ci2.campaign_id = c.id
      ))
    group by c.id
  ) campaigns;
  return result;
end
$$;

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

create or replace function public.ais_list_tasks()
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
  select coalesce(jsonb_agg(row_data order by scheduled_for nulls last), '[]'::jsonb) into result
  from (
    select jsonb_build_object(
      'id', rt.id,
      'branch_name', coalesce(nullif(b.loc_bld, ''), b.location_code),
      'location_code', b.location_code,
      'scanner_model', coalesce(nullif(s.model_name, ''), nullif(s.hw_name, ''), ''),
      'com_sn', case when actor_role = 'viewer' then '••••••' || right(s.com_sn, 4) else s.com_sn end,
      'team_name', t.team_name,
      'scheduled_for', rt.scheduled_for,
      'task_status', rt.status::text,
      'new_serial', case when actor_role = 'viewer' and visit.new_serial is not null then '••••••' || right(visit.new_serial, 4) else visit.new_serial end,
      'install_result', visit.install_result,
      'old_scanner_status', visit.old_scanner_status::text
    ) as row_data, rt.scheduled_for
    from app_private.replacement_tasks rt
    join app_private.campaign_items ci on ci.id = rt.campaign_item_id
    join app_private.scanner_assets s on s.id = ci.scanner_asset_id
    join app_private.branches b on b.id = s.branch_id
    left join app_private.teams t on t.id = rt.team_id
    left join lateral (
      select fv.new_serial, fv.install_result, fv.old_scanner_status
      from app_private.field_visits fv
      where fv.task_id = rt.id
      order by fv.performed_at desc
      limit 1
    ) visit on true
    where actor_role <> 'field_technician' or exists (
      select 1 from app_private.user_team_memberships utm
      where utm.team_id = rt.team_id and utm.user_id = actor
    )
    order by rt.scheduled_for nulls last
    limit 250
  ) tasks;
  return result;
end
$$;

revoke all on function public.ais_app_context() from public, anon;
revoke all on function public.ais_dashboard() from public, anon;
revoke all on function public.ais_list_campaigns(text) from public, anon;
revoke all on function public.ais_list_scanners(text) from public, anon;
revoke all on function public.ais_list_tasks() from public, anon;
grant execute on function public.ais_app_context() to authenticated;
grant execute on function public.ais_dashboard() to authenticated;
grant execute on function public.ais_list_campaigns(text) to authenticated;
grant execute on function public.ais_list_scanners(text) to authenticated;
grant execute on function public.ais_list_tasks() to authenticated;

comment on schema app_private is 'AIS operational domain tables; intentionally not exposed through the Supabase Data API.';
