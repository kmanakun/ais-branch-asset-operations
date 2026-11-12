create or replace function public.ais_campaign_action(
  p_campaign_id uuid,
  p_action text,
  p_expected_status text,
  p_reason text default null
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
  reason_text text := nullif(btrim(coalesce(p_reason, '')), '');
  campaign_status app_private.campaign_state;
  campaign_resume_status app_private.campaign_state;
  next_status app_private.campaign_state;
  task_row record;
  cancelled_task_count integer := 0;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;

  if actor is null or actor_role is null or actor_role not in ('admin', 'planner') then
    raise exception 'Admin or Planner access required' using errcode = '42501';
  end if;

  if p_campaign_id is null or p_expected_status is null or btrim(p_expected_status) = '' then
    raise exception 'Campaign and expected status are required' using errcode = '22023';
  end if;
  if action_name not in ('block', 'resume', 'cancel') then
    raise exception 'Unsupported campaign action' using errcode = '22023';
  end if;
  if action_name in ('block', 'cancel') and (reason_text is null or char_length(reason_text) > 500) then
    raise exception 'A reason of 1 to 500 characters is required for this campaign action' using errcode = '22023';
  end if;

  -- Lock child rows in a stable order before the campaign row. Technician task
  -- actions also lock a task before updating its campaign lifecycle state.
  perform rt.id
  from app_private.replacement_tasks rt
  join app_private.campaign_items ci on ci.id = rt.campaign_item_id
  where ci.campaign_id = p_campaign_id
  order by rt.id
  for update of rt nowait;

  select c.status, c.resume_status
  into campaign_status, campaign_resume_status
  from app_private.campaigns c
  where c.id = p_campaign_id
  for update;

  if not found then
    raise exception 'Campaign does not exist' using errcode = '22023';
  end if;
  if p_expected_status is distinct from campaign_status::text then
    raise exception 'Campaign changed since it was loaded; refresh before retrying' using errcode = '40001';
  end if;

  if action_name = 'block' then
    if campaign_status in ('blocked', 'completed', 'cancelled') then
      raise exception 'Only a nonterminal, unblocked campaign can be blocked' using errcode = '22023';
    end if;
    next_status := 'blocked';
    update app_private.campaigns
    set status = next_status, resume_status = campaign_status, updated_at = clock_timestamp()
    where id = p_campaign_id;
  elsif action_name = 'resume' then
    if campaign_status <> 'blocked' or campaign_resume_status is null
      or campaign_resume_status in ('blocked', 'completed', 'cancelled') then
      raise exception 'Only a blocked campaign with a resumable prior status can be resumed' using errcode = '22023';
    end if;
    next_status := campaign_resume_status;
    update app_private.campaigns
    set status = next_status, resume_status = null, updated_at = clock_timestamp()
    where id = p_campaign_id;
  else
    if campaign_status in ('completed', 'cancelled') then
      raise exception 'A completed or cancelled campaign cannot be cancelled' using errcode = '22023';
    end if;

    for task_row in
      select rt.id, rt.status
      from app_private.replacement_tasks rt
      join app_private.campaign_items ci on ci.id = rt.campaign_item_id
      where ci.campaign_id = p_campaign_id
        and rt.status not in ('completed', 'cancelled')
      order by rt.id
      for update of rt
    loop
      update app_private.replacement_tasks
      set status = 'cancelled', resume_status = null, blocked_reason = null,
          cancelled_reason = reason_text, version = version + 1,
          updated_at = clock_timestamp()
      where id = task_row.id;

      insert into app_private.audit_events(actor_id, event_type, entity_type, entity_id, summary)
      values(actor, 'task_cancelled', 'replacement_task', task_row.id,
        jsonb_build_object('from_status', task_row.status::text, 'to_status', 'cancelled', 'reason', reason_text));
      cancelled_task_count := cancelled_task_count + 1;
    end loop;

    next_status := 'cancelled';
    update app_private.campaigns
    set status = next_status, resume_status = null, cancelled_reason = reason_text,
        updated_at = clock_timestamp()
    where id = p_campaign_id;
  end if;

  insert into app_private.audit_events(actor_id, event_type, entity_type, entity_id, summary)
  values(actor,
    case action_name when 'block' then 'campaign_blocked' when 'resume' then 'campaign_resumed' else 'campaign_cancelled' end,
    'campaign', p_campaign_id,
    jsonb_build_object(
      'from_status', campaign_status::text,
      'to_status', next_status::text,
      'reason', case when action_name in ('block', 'cancel') then reason_text end,
      'cancelled_tasks', cancelled_task_count
    ));

  return jsonb_build_object(
    'campaign_id', p_campaign_id,
    'status', next_status::text,
    'cancelled_tasks', cancelled_task_count
  );
end;
$$;

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
  v_campaign_id uuid;
  campaign_status app_private.campaign_state;
  total_task_count integer;
  terminal_task_count integer;
  completed_task_count integer;
  next_version integer;
  completed_campaign_id uuid;
begin
  select ua.role into actor_role
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;

  if actor is null or actor_role is null or actor_role not in ('admin', 'planner') then
    raise exception 'Admin or Planner access required' using errcode = '42501';
  end if;

  if p_task_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'Task and current version are required' using errcode = '22023';
  end if;
  if reason_text is null or char_length(reason_text) > 500 then
    raise exception 'A reason of 1 to 500 characters is required to cancel a task' using errcode = '22023';
  end if;

  select rt.status, rt.version, ci.campaign_id
  into task_status, task_version, v_campaign_id
  from app_private.replacement_tasks rt
  join app_private.campaign_items ci on ci.id = rt.campaign_item_id
  where rt.id = p_task_id
  for update of rt;

  if not found then
    raise exception 'Task does not exist' using errcode = '22023';
  end if;
  if task_version <> p_expected_version then
    raise exception 'Task changed since it was loaded; refresh before retrying' using errcode = '40001';
  end if;
  if task_status in ('completed', 'cancelled') then
    raise exception 'A completed or cancelled task cannot be cancelled' using errcode = '22023';
  end if;

  update app_private.replacement_tasks
  set status = 'cancelled', resume_status = null, blocked_reason = null,
      cancelled_reason = reason_text, version = version + 1,
      updated_at = clock_timestamp()
  where id = p_task_id and version = p_expected_version
  returning version into next_version;

  if next_version is null then
    raise exception 'Task changed since it was loaded; refresh before retrying' using errcode = '40001';
  end if;

  insert into app_private.audit_events(actor_id, event_type, entity_type, entity_id, summary)
  values(actor, 'task_cancelled', 'replacement_task', p_task_id,
    jsonb_build_object('from_status', task_status::text, 'to_status', 'cancelled', 'version', next_version, 'reason', reason_text));

  perform 1 from app_private.campaigns c where c.id = v_campaign_id for update;
  select c.status into campaign_status
  from app_private.campaigns c
  where c.id = v_campaign_id;

  select count(*)::integer,
         count(*) filter (where rt.status in ('completed', 'cancelled'))::integer,
         count(*) filter (where rt.status = 'completed')::integer
  into total_task_count, terminal_task_count, completed_task_count
  from app_private.replacement_tasks rt
  join app_private.campaign_items ci on ci.id = rt.campaign_item_id
  where ci.campaign_id = v_campaign_id;

  if campaign_status not in ('completed', 'cancelled')
    and total_task_count > 0
    and total_task_count = terminal_task_count
    and completed_task_count > 0 then
    update app_private.campaigns
    set status = 'completed', resume_status = null, updated_at = clock_timestamp()
    where id = v_campaign_id and status not in ('completed', 'cancelled')
    returning id into completed_campaign_id;

    if completed_campaign_id is not null then
      insert into app_private.audit_events(actor_id, event_type, entity_type, entity_id, summary)
      values(actor, 'campaign_completed', 'campaign', v_campaign_id,
        jsonb_build_object('trigger_task_id', p_task_id, 'completed_tasks', completed_task_count, 'total_tasks', total_task_count));
    end if;
  end if;

  return jsonb_build_object(
    'task_id', p_task_id,
    'status', 'cancelled',
    'version', next_version,
    'campaign_status', case when completed_campaign_id is not null then 'completed' else campaign_status::text end
  );
end;
$$;

revoke all on function public.ais_campaign_action(uuid, text, text, text) from public, anon;
grant execute on function public.ais_campaign_action(uuid, text, text, text) to authenticated;
revoke all on function public.ais_cancel_task(uuid, integer, text) from public, anon;
grant execute on function public.ais_cancel_task(uuid, integer, text) to authenticated;
comment on function public.ais_campaign_action(uuid, text, text, text) is
  'Active Admin/Planner only; atomically blocks any nonterminal campaign, resumes its prior state, or cancels it and all nonterminal tasks with expected-status concurrency guard, reason validation, and audit.';
comment on function public.ais_cancel_task(uuid, integer, text) is
  'Active Admin/Planner only; cancels one nonterminal task with required reason and expected-version guard, audits the change, and completes its campaign only when all tasks are terminal and at least one is completed.';

-- Keep field task mutations inside their parent Campaign lifecycle. Preserve
-- the existing idempotent completion replay path before enforcing the guard.
do $migration$
declare
  signature regprocedure := 'public.ais_field_task_action(uuid,text,integer,text,text,text,text,text)'::regprocedure;
  definition text := pg_get_functiondef(signature);
  anchor text := $anchor$  if task_version <> p_expected_version then$anchor$;
  guard text := $guard$  perform 1 from app_private.campaigns c where c.id = v_campaign_id for update;
  if exists (
    select 1 from app_private.campaigns c
    where c.id = v_campaign_id and c.status in ('blocked', 'completed', 'cancelled')
  ) then
    raise exception 'Campaign is blocked or terminal; refresh after campaign action' using errcode = '22023';
  end if;

  if task_version <> p_expected_version then$guard$;
begin
  if strpos(definition, anchor) = 0 then
    raise exception 'Could not locate task version guard in %', signature;
  end if;
  execute replace(definition, anchor, guard);
end
$migration$;
