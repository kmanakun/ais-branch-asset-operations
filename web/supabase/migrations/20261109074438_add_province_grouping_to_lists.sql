-- Return province on the scanner and work-order DTOs, and keep each province
-- together when paging so the client can render stable province sections.
do $migration$
declare
  signature regprocedure := 'public.ais_task_filtered_page(text,text,integer,integer)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(definition,
    $old$      b.loc_bld,$old$,
    $new$      b.loc_bld,
      b.province,$new$);
  definition := replace(definition,
    $old$        'location_code', b.location_code,$old$,
    $new$        'location_code', b.location_code,
        'province', b.province,$new$);
  definition := replace(definition,
    $old$      or position(lower(search_term) in lower(coalesce(loc_bld, ''))) > 0$old$,
    $new$      or position(lower(search_term) in lower(coalesce(loc_bld, ''))) > 0
      or position(lower(search_term) in lower(coalesce(province, ''))) > 0$new$);
  definition := replace(definition,
    $old$    select id, scheduled_for, row_data
    from filtered_tasks
    order by scheduled_for nulls last, id$old$,
    $new$    select id, province, scheduled_for, row_data
    from filtered_tasks
    order by lower(coalesce(province, '')), scheduled_for nulls last, id$new$);
  definition := replace(definition,
    $old$jsonb_agg(row_data order by scheduled_for nulls last, id)$old$,
    $new$jsonb_agg(row_data order by lower(coalesce(province, '')), scheduled_for nulls last, id)$new$);

  if definition = original_definition
    or strpos(definition, '''province'', b.province') = 0
    or strpos(definition, 'coalesce(province,') = 0
    or strpos(definition, 'user_team_memberships') > 0 then
    raise exception 'Could not safely add province to %', signature;
  end if;
  execute definition;
end
$migration$;

do $migration$
declare
  signature regprocedure := 'public.ais_scanner_page(text,integer,integer)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(definition,
    $old$    select s.id, b.location_code, b.loc_bld as branch_name,$old$,
    $new$    select s.id, b.location_code, b.loc_bld as branch_name, b.province,$new$);
  definition := replace(definition,
    $old$select * from filtered order by location_code, branch_name, model_name, id$old$,
    $new$select * from filtered order by lower(coalesce(province, '')), location_code, branch_name, model_name, id$new$);
  definition := replace(definition,
    $old$jsonb_agg(to_jsonb(page) order by location_code, branch_name, model_name, id)$old$,
    $new$jsonb_agg(to_jsonb(page) order by lower(coalesce(province, '')), location_code, branch_name, model_name, id)$new$);

  if definition = original_definition
    or strpos(definition, 'b.province') = 0
    or strpos(definition, 'user_team_memberships') > 0 then
    raise exception 'Could not safely add province to %', signature;
  end if;
  execute definition;
end
$migration$;
