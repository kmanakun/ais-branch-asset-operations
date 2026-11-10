create table app_private.branch_work_plan_batches (
  id uuid primary key default gen_random_uuid(),
  source_name text not null check (length(btrim(source_name)) > 0),
  source_sheet text not null check (length(btrim(source_sheet)) > 0),
  status text not null default 'draft' check (status in ('draft', 'approved', 'archived')),
  imported_by uuid references auth.users(id) on delete set null,
  imported_at timestamptz not null default now(),
  row_count integer not null default 0 check (row_count >= 0),
  dated_branch_count integer not null default 0 check (dated_branch_count >= 0),
  undated_branch_count integer not null default 0 check (undated_branch_count >= 0),
  first_date date,
  last_date date,
  summary jsonb not null default '{}'::jsonb,
  check (row_count = dated_branch_count + undated_branch_count),
  check (last_date is null or first_date is null or last_date >= first_date)
);

create table app_private.branch_work_plan_items (
  batch_id uuid not null references app_private.branch_work_plan_batches(id) on delete restrict,
  branch_id uuid not null references app_private.branches(id) on delete restrict,
  team_id uuid not null references app_private.teams(id) on delete restrict,
  source_team2 text,
  planned_on date,
  source_row integer not null check (source_row > 0),
  created_at timestamptz not null default now(),
  primary key (batch_id, branch_id)
);

create index branch_work_plan_items_team_date_idx
  on app_private.branch_work_plan_items(batch_id, team_id, planned_on);

alter table app_private.branch_work_plan_batches enable row level security;
alter table app_private.branch_work_plan_items enable row level security;
create policy branch_work_plan_batches_deny_browser
  on app_private.branch_work_plan_batches for all to anon, authenticated
  using (false) with check (false);
create policy branch_work_plan_items_deny_browser
  on app_private.branch_work_plan_items for all to anon, authenticated
  using (false) with check (false);
revoke all on app_private.branch_work_plan_batches from public, anon, authenticated;
revoke all on app_private.branch_work_plan_items from public, anon, authenticated;

create or replace function public.ais_branch_plan_summary()
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

  if actor is null or actor_role is null or actor_role not in ('admin', 'planner', 'data_manager') then
    raise exception 'Application access required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'has_plan', true,
    'id', b.id,
    'source_name', b.source_name,
    'source_sheet', b.source_sheet,
    'status', b.status,
    'imported_at', b.imported_at,
    'row_count', b.row_count,
    'dated_branch_count', b.dated_branch_count,
    'undated_branch_count', b.undated_branch_count,
    'first_date', b.first_date,
    'last_date', b.last_date,
    'team_counts', coalesce((
      select jsonb_agg(team_row order by team_name)
      from (
        select t.team_name,
          jsonb_build_object(
            'team_name', t.team_name,
            'branch_count', count(*)::integer,
            'dated_branch_count', (count(*) filter (where pi.planned_on is not null))::integer
          ) as team_row
        from app_private.branch_work_plan_items pi
        join app_private.teams t on t.id = pi.team_id
        where pi.batch_id = b.id
        group by t.team_name
      ) team_summary
    ), '[]'::jsonb)
  ) into result
  from (
    select batch.*
    from app_private.branch_work_plan_batches batch
    order by batch.imported_at desc, batch.id
    limit 1
  ) b;

  return coalesce(result, jsonb_build_object('has_plan', false));
end
$$;

revoke all on function public.ais_branch_plan_summary() from public, anon;
grant execute on function public.ais_branch_plan_summary() to authenticated;
comment on function public.ais_branch_plan_summary() is
  'Active Admin, Planner, or Data Manager only; read-only summary of the latest branch-level plan snapshot. Draft plan rows do not create replacement tasks.';
