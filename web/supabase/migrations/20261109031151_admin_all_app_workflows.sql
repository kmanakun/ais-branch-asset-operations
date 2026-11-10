-- An active Admin can perform any business workflow in this application.
-- Keep explicit NULL checks so an authenticated user without an app role is
-- still denied. Existing validation, team limits for technicians, revisions,
-- and audit writes remain in the underlying functions.
do $migration$
declare
  target record;
  definition text;
  updated_definition text;
begin
  for target in
    select * from (values
      (
        'public.ais_import_stage(jsonb)'::regprocedure,
        $old$if actor is null or actor_role is distinct from 'data_manager' then$old$,
        $new$if actor is null or actor_role is null or actor_role not in ('data_manager', 'admin') then$new$,
        'Data Manager access required'::text,
        'Data Manager or Admin access required'::text
      ),
      (
        'public.ais_import_commit(uuid)'::regprocedure,
        $old$if actor is null or actor_role is distinct from 'data_manager' then$old$,
        $new$if actor is null or actor_role is null or actor_role not in ('data_manager', 'admin') then$new$,
        'Data Manager access required'::text,
        'Data Manager or Admin access required'::text
      ),
      (
        'public.ais_incremental_import_stage(jsonb)'::regprocedure,
        $old$if auth.uid() is null or actor_role is distinct from 'data_manager' then$old$,
        $new$if auth.uid() is null or actor_role is null or actor_role not in ('data_manager', 'admin') then$new$,
        'Data Manager access required'::text,
        'Data Manager or Admin access required'::text
      ),
      (
        'public.ais_incremental_import_commit(uuid)'::regprocedure,
        $old$if actor is null or actor_role is distinct from 'data_manager' then$old$,
        $new$if actor is null or actor_role is null or actor_role not in ('data_manager', 'admin') then$new$,
        'Data Manager access required'::text,
        'Data Manager or Admin access required'::text
      ),
      (
        'public.ais_import_history(integer)'::regprocedure,
        $old$if actor is null or actor_role is distinct from 'data_manager' then$old$,
        $new$if actor is null or actor_role is null or actor_role not in ('data_manager', 'admin') then$new$,
        'Data Manager access required'::text,
        'Data Manager or Admin access required'::text
      ),
      (
        'public.ais_create_campaign(text,text,uuid[],text,date,date)'::regprocedure,
        $old$if actor is null or actor_role is distinct from 'planner' then$old$,
        $new$if actor is null or actor_role is null or actor_role not in ('planner', 'admin') then$new$,
        'Planner access required'::text,
        'Planner or Admin access required'::text
      ),
      (
        'public.ais_schedule_campaign_by_branch(uuid,jsonb)'::regprocedure,
        $old$if actor is null or actor_role is distinct from 'planner' then$old$,
        $new$if actor is null or actor_role is null or actor_role not in ('planner', 'admin') then$new$,
        'Planner access required'::text,
        'Planner or Admin access required'::text
      ),
      (
        'public.ais_field_task_action(uuid,text,integer,text,text,text,text,text)'::regprocedure,
        $old$if actor is null or actor_role is distinct from 'field_technician' then$old$,
        $new$if actor is null or actor_role is null or actor_role not in ('field_technician', 'admin') then$new$,
        'Field Technician access required'::text,
        'Field Technician or Admin access required'::text
      )
    ) as functions(signature, old_guard, new_guard, old_message, new_message)
  loop
    definition := pg_get_functiondef(target.signature);
    updated_definition := definition;

    if strpos(updated_definition, target.old_guard) > 0 then
      if cardinality(string_to_array(updated_definition, target.old_guard)) <> 2 then
        raise exception 'Unexpected number of authorization guards in %', target.signature;
      end if;
      updated_definition := replace(updated_definition, target.old_guard, target.new_guard);
    elsif strpos(updated_definition, target.new_guard) = 0 then
      raise exception 'Could not locate authorization guard in %', target.signature;
    end if;

    if strpos(updated_definition, target.old_message) > 0 then
      updated_definition := replace(updated_definition, target.old_message, target.new_message);
    elsif strpos(updated_definition, target.new_message) = 0 then
      raise exception 'Could not locate authorization message in %', target.signature;
    end if;

    if updated_definition <> definition then
      execute updated_definition;
    end if;
  end loop;
end
$migration$;

-- Admin can operate tasks for any team, including a team disabled after the
-- work was scheduled. Field Technicians remain limited to their active team.
do $migration$
declare
  signature regprocedure := 'public.ais_field_task_action(uuid,text,integer,text,text,text,text,text)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
  new_scope text := 'and (actor_role = ''admin'' or exists (select 1 from app_private.user_team_memberships utm where utm.user_id = actor and utm.team_id = rt.team_id))';
  old_team_join text := 'join app_private.teams t on t.id = rt.team_id and t.is_active';
  new_team_join text := 'join app_private.teams t on t.id = rt.team_id and (t.is_active or actor_role = ''admin'')';
begin
  definition := regexp_replace(
    definition,
    'and exists \(\s*select 1\s*from app_private\.user_team_memberships utm\s*where utm\.user_id = actor and utm\.team_id = rt\.team_id\s*\)',
    new_scope
  );
  if definition = original_definition and strpos(definition, new_scope) = 0 then
    raise exception 'Could not locate technician team scope in %', signature;
  end if;

  if strpos(definition, old_team_join) > 0 then
    if cardinality(string_to_array(definition, old_team_join)) <> 2 then
      raise exception 'Unexpected number of active team joins in %', signature;
    end if;
    definition := replace(definition, old_team_join, new_team_join);
  elsif strpos(definition, new_team_join) = 0 then
    raise exception 'Could not locate active team join in %', signature;
  end if;
  execute definition;
end
$migration$;

-- The campaign selection editor is also available to Admin in the UI.
do $migration$
declare
  signature regprocedure := 'public.ais_update_campaign_selection(uuid,timestamptz,uuid[],uuid[],text)'::regprocedure;
  definition text := pg_get_functiondef(signature);
  old_guard text := 'ua.user_id = actor and ua.is_active and ua.role = ''planner''';
  new_guard text := 'ua.user_id = actor and ua.is_active and ua.role in (''planner'', ''admin'')';
  old_message text := 'Planner access required';
  new_message text := 'Planner or Admin access required';
begin
  if strpos(definition, old_guard) > 0 then
    if cardinality(string_to_array(definition, old_guard)) <> 2 then
      raise exception 'Unexpected number of campaign selection role guards in %', signature;
    end if;
    definition := replace(definition, old_guard, new_guard);
  elsif strpos(definition, new_guard) = 0 then
    raise exception 'Could not locate campaign selection role guard in %', signature;
  end if;
  if strpos(definition, old_message) > 0 then
    definition := replace(definition, old_message, new_message);
  elsif strpos(definition, new_message) = 0 then
    raise exception 'Could not locate campaign selection role message in %', signature;
  end if;
  if definition <> pg_get_functiondef(signature) then
    execute definition;
  end if;
end
$migration$;

comment on function public.ais_import_stage(jsonb) is
  'Active Data Manager or Admin can stage approved branch and scanner fields; role checks and source redaction remain enforced.';
comment on function public.ais_import_commit(uuid) is
  'Active Data Manager or Admin can commit an owned, validated bootstrap import while registers are empty.';
comment on function public.ais_incremental_import_stage(jsonb) is
  'Active Data Manager or Admin can stage validated incremental scanner updates.';
comment on function public.ais_incremental_import_commit(uuid) is
  'Active Data Manager or Admin can atomically commit an owned incremental import.';
comment on function public.ais_import_history(integer) is
  'Active Data Manager or Admin can read import metadata without source rows.';
comment on function public.ais_create_campaign(text,text,uuid[],text,date,date) is
  'Active Planner or Admin can create campaigns with manual selection, reason, row locks, and audit.';
comment on function public.ais_schedule_campaign_by_branch(uuid,jsonb) is
  'Active Planner or Admin can schedule selected scanners using one reviewed team and date per branch.';
comment on function public.ais_update_campaign_selection(uuid,timestamptz,uuid[],uuid[],text) is
  'Active Planner or Admin can revise an unscheduled campaign selection with concurrency checks and audit.';
comment on function public.ais_field_task_action(uuid,text,integer,text,text,text,text,text) is
  'Active Field Technicians can update tasks for their active team; Admin can update any task. All changes remain revision-checked and audited.';
