-- Change only the authorization guard, retaining callable signatures, grants,
-- locking, validation and audit behavior of the existing implementations.
do $migration$
declare
  target record;
  definition text;
  old_guard text;
  new_guard text;
begin
  for target in
    select * from (values
      ('public.ais_import_stage(text,jsonb)'::regprocedure, $roles$'admin', 'data_manager'$roles$, 'data_manager'),
      ('public.ais_import_commit(uuid)'::regprocedure, $roles$'admin', 'data_manager'$roles$, 'data_manager'),
      ('public.ais_create_campaign(text,text,uuid[],text,date,date)'::regprocedure, $roles$'admin','planner'$roles$, 'planner'),
      ('public.ais_schedule_campaign_by_branch(uuid,jsonb)'::regprocedure, $roles$'admin', 'planner'$roles$, 'planner'),
      ('public.ais_schedule_campaign(uuid,uuid,date)'::regprocedure, $roles$'admin', 'planner'$roles$, 'planner')
    ) as functions(signature, previous_roles, required_role)
  loop
    definition := pg_get_functiondef(target.signature);
    old_guard := 'if actor is null or actor_role is null or actor_role not in (' || target.previous_roles || ') then';
    new_guard := format('if actor is null or actor_role is distinct from %L then', target.required_role);
    if strpos(definition, new_guard) > 0 and strpos(definition, old_guard) = 0 then
      continue;
    end if;
    if cardinality(string_to_array(definition, old_guard)) <> 2 then
      raise exception 'Unexpected authorization guard in %', target.signature;
    end if;
    execute replace(definition, old_guard, new_guard);
  end loop;
end
$migration$;

comment on function public.ais_import_stage(text, jsonb) is
  'An active Data Manager can stage and validate approved Branch/Scanner register fields.';
comment on function public.ais_import_commit(uuid) is
  'An active Data Manager can atomically commit an owned, validated initial import into empty registers.';
comment on function public.ais_create_campaign(text, text, uuid[], text, date, date) is
  'An active Planner can create a campaign with a manual selection, rationale, ordered asset locks and audit.';
comment on function public.ais_schedule_campaign_by_branch(uuid, jsonb) is
  'An active Planner can atomically schedule selected scanners using one reviewed team and work date per branch.';
