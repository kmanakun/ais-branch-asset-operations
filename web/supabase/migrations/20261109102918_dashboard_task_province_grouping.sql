-- Include branch province in recent dashboard work orders so the shared task
-- table can render the same province groups as the schedule and asset lists.
do $migration$
declare
  signature regprocedure := 'public.ais_dashboard()'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(definition,
    $old$'location_code', b.location_code,$old$,
    $new$'location_code', b.location_code,
          'province', b.province,$new$);

  if definition = original_definition
    or strpos(definition, '''province'', b.province') = 0 then
    raise exception 'Could not safely add province to dashboard task rows';
  end if;

  execute definition;
end
$migration$;
