-- Preserve the approved Data Manager-only import boundary after removing the
-- client-controlled source filename from the RPC signature.
do $migration$
declare
  signature regprocedure := 'public.ais_import_stage(jsonb)'::regprocedure;
  definition text := pg_get_functiondef(signature);
  old_role_guard text := $old$if actor is null or actor_role not in ('admin', 'data_manager') then$old$;
  safe_role_guard text := $safe$if actor is null or actor_role is distinct from 'data_manager' then$safe$;
  old_payload_guard text := $old$if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 5000 then$old$;
  safe_payload_guard text := $safe$if p_rows is null or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 5000 then$safe$;
begin
  if strpos(definition, old_role_guard) > 0 then
    definition := replace(definition, old_role_guard, safe_role_guard);
  elsif strpos(definition, safe_role_guard) = 0 then
    raise exception 'Could not locate import role guard in %', signature;
  end if;

  if strpos(definition, old_payload_guard) > 0 then
    definition := replace(definition, old_payload_guard, safe_payload_guard);
  elsif strpos(definition, safe_payload_guard) = 0 then
    raise exception 'Could not locate import payload guard in %', signature;
  end if;

  execute definition;
end
$migration$;

comment on function public.ais_import_stage(jsonb) is
  'Stages approved branch and scanner fields for active Data Managers only. The RPC accepts row data only; source metadata is fixed server-side; null and invalid payloads are rejected.';
