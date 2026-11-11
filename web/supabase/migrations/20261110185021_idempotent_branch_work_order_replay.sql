-- A network retry can reach this RPC while an earlier transaction with the
-- same request id is still creating its work order. The unique request_id
-- constraint is the concurrency arbiter; convert that collision into the
-- same idempotent response returned by the earlier lookup path.
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

  -- Serialize retries using the same request id before checking for an existing
  -- order. The branch lock alone is too late: a retry can pass this lookup,
  -- wait for the branch lock, then mistake the first retry's active task for a
  -- conflicting work order.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ais_open_work_order_request:' || p_request_id::text, 0)
  );

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
  begin
    insert into app_private.branch_work_orders (id, work_order_code, branch_id, origin, request_id, created_by)
    values (new_order_id, new_order_code, p_branch_id, 'admin', p_request_id, actor);
  exception when unique_violation then
    -- A concurrent retry may have inserted the same request after the lookup
    -- above. If this was a work-order-code collision instead, keep the error.
    select wo.id, wo.branch_id into existing_order_id, existing_branch_id
    from app_private.branch_work_orders wo
    where wo.request_id = p_request_id;
    if not found then raise; end if;

    select array_agg(rt.scanner_asset_id order by rt.scanner_asset_id)
    into existing_assets
    from app_private.replacement_tasks rt
    where rt.branch_work_order_id = existing_order_id;
    if existing_branch_id is distinct from p_branch_id or existing_assets is distinct from requested_assets then
      raise exception 'Request id was already used for another branch or Scanner list' using errcode = '22023';
    end if;
    return jsonb_build_object('work_order_id', existing_order_id, 'selected_scanners', cardinality(existing_assets), 'already_opened', true);
  end;

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
