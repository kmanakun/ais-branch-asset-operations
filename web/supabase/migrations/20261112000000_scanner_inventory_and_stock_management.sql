-- Scanner Inventory & Stock Management
-- Allows tracking of newly received scanner batches, dispatching hardware to onsite teams,
-- and calculating stock balances against actual field replacements.

create table if not exists app_private.scanner_stock_batches (
  id uuid primary key default gen_random_uuid(),
  batch_code text not null unique check (length(trim(batch_code)) > 0),
  model_name text not null check (length(trim(model_name)) > 0),
  quantity integer not null check (quantity > 0),
  received_date date not null default current_date,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table app_private.scanner_stock_batches enable row level security;
revoke all on table app_private.scanner_stock_batches from public, anon, authenticated;

create table if not exists app_private.scanner_stock_dispatches (
  id uuid primary key default gen_random_uuid(),
  dispatch_code text not null unique check (length(trim(dispatch_code)) > 0),
  team_name text not null check (length(trim(team_name)) > 0),
  model_name text not null check (length(trim(model_name)) > 0),
  quantity integer not null check (quantity > 0),
  batch_code text,
  status text not null default 'dispatched' check (status in ('dispatched', 'acknowledged', 'cancelled')),
  dispatched_by uuid references auth.users(id) on delete set null,
  dispatched_at timestamptz not null default now()
);

alter table app_private.scanner_stock_dispatches enable row level security;
revoke all on table app_private.scanner_stock_dispatches from public, anon, authenticated;

-- Function: ais_stock_list()
-- Returns summarized stock by model, dispatched units, and recent dispatch records.
create or replace function public.ais_stock_list()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role app_private.app_role;
  result jsonb;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = auth.uid() and ua.is_active = true;

  if actor_role is null then
    raise exception 'Unauthorized' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'models', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'model', m.model_name,
          'total_received', coalesce(b.total_qty, 0),
          'dispatched_to_techs', coalesce(d.dispatched_qty, 0),
          'in_stock', greatest(0, coalesce(b.total_qty, 0) - coalesce(d.dispatched_qty, 0)),
          'installed', coalesce(r.installed_qty, 0),
          'returned_damaged', coalesce(r.damaged_qty, 0),
          'returned_usable', coalesce(r.usable_qty, 0),
          'last_batch', b.latest_batch,
          'last_received_date', b.latest_date
        )
      )
      from (
        select distinct model_name from (
          select model_name from app_private.scanner_stock_batches
          union
          select 'Zebra DS9308'
          union
          select 'Honeywell HF680'
          union
          select 'Datalogic Gryphon GFS4400'
        ) all_models
      ) m
      left join (
        select
          model_name,
          sum(quantity)::integer as total_qty,
          max(batch_code) as latest_batch,
          max(received_date)::text as latest_date
        from app_private.scanner_stock_batches
        group by model_name
      ) b on b.model_name = m.model_name
      left join (
        select
          model_name,
          sum(quantity)::integer as dispatched_qty
        from app_private.scanner_stock_dispatches
        where status <> 'cancelled'
        group by model_name
      ) d on d.model_name = m.model_name
      left join (
        select
          coalesce(nullif(sa.model_name, ''), 'Zebra DS9308') as model_name,
          count(*) filter (where fv.install_result = 'success')::integer as installed_qty,
          count(*) filter (where fv.old_scanner_status = 'returned_damaged')::integer as damaged_qty,
          count(*) filter (where fv.old_scanner_status = 'returned_usable')::integer as usable_qty
        from app_private.field_visits fv
        left join app_private.replacement_tasks rt on rt.id = fv.task_id
        left join app_private.scanner_assets sa on sa.id = rt.scanner_asset_id
        group by coalesce(nullif(sa.model_name, ''), 'Zebra DS9308')
      ) r on r.model_name = m.model_name
    ), '[]'::jsonb),
    'dispatches', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', sd.dispatch_code,
          'date', sd.dispatched_at::date::text,
          'team', sd.team_name,
          'model', sd.model_name,
          'quantity', sd.quantity,
          'batch', coalesce(sd.batch_code, '—'),
          'status', sd.status
        ) order by sd.dispatched_at desc
      )
      from (
        select * from app_private.scanner_stock_dispatches order by dispatched_at desc limit 25
      ) sd
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

-- Function: ais_stock_receive_batch()
-- Records incoming scanner hardware batch. Restricted to admin.
create or replace function public.ais_stock_receive_batch(
  p_batch_code text,
  p_model_name text,
  p_quantity integer,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role app_private.app_role;
  clean_batch text := trim(coalesce(p_batch_code, ''));
  clean_model text := trim(coalesce(p_model_name, ''));
  new_id uuid;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = auth.uid() and ua.is_active = true;

  if actor_role is null or actor_role <> 'admin' then
    raise exception 'Unauthorized: Only Admin can receive stock batches' using errcode = '42501';
  end if;

  if clean_batch = '' or clean_model = '' or p_quantity is null or p_quantity <= 0 then
    raise exception 'Invalid stock batch parameters' using errcode = '22023';
  end if;

  insert into app_private.scanner_stock_batches (
    batch_code, model_name, quantity, notes, created_by
  ) values (
    clean_batch, clean_model, p_quantity, nullif(trim(coalesce(p_notes, '')), ''), auth.uid()
  ) returning id into new_id;

  return jsonb_build_object('success', true, 'batch_id', new_id, 'batch_code', clean_batch);
end;
$$;

-- Function: ais_stock_dispatch_team()
-- Issues scanner units to a field technician team. Restricted to admin.
create or replace function public.ais_stock_dispatch_team(
  p_team_name text,
  p_model_name text,
  p_quantity integer,
  p_batch_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role app_private.app_role;
  clean_team text := trim(coalesce(p_team_name, ''));
  clean_model text := trim(coalesce(p_model_name, ''));
  disp_code text;
  new_id uuid;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = auth.uid() and ua.is_active = true;

  if actor_role is null or actor_role <> 'admin' then
    raise exception 'Unauthorized: Only Admin can dispatch stock' using errcode = '42501';
  end if;

  if clean_team = '' or clean_model = '' or p_quantity is null or p_quantity <= 0 then
    raise exception 'Invalid dispatch parameters' using errcode = '22023';
  end if;

  disp_code := 'DISP-' || to_char(clock_timestamp(), 'YYYYMMDD-HH24MISS') || '-' || substr(md5(random()::text), 1, 4);

  insert into app_private.scanner_stock_dispatches (
    dispatch_code, team_name, model_name, quantity, batch_code, dispatched_by
  ) values (
    disp_code, clean_team, clean_model, p_quantity, nullif(trim(coalesce(p_batch_code, '')), ''), auth.uid()
  ) returning id into new_id;

  return jsonb_build_object('success', true, 'dispatch_id', new_id, 'dispatch_code', disp_code);
end;
$$;
