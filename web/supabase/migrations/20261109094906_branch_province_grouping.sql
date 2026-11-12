-- Keep branch planning and scheduling lists together by province, matching
-- the asset register and work-order lists.
do $migration$
declare
  signature regprocedure := 'public.ais_branch_plan_page(text,text,text,integer,integer)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(definition,
    $old$      branch.loc_bld as branch_name,
      team.team_name,$old$,
    $new$      branch.loc_bld as branch_name,
      branch.province,
      team.team_name,$new$);
  definition := replace(definition,
    $old$    order by planned_on nulls last, team_name, location_code, branch_name, branch_id$old$,
    $new$    order by lower(coalesce(province, '')), planned_on nulls last, team_name, location_code, branch_name, branch_id$new$);
  definition := replace(definition,
    $old$        'branch_name', page.branch_name,
        'team_name', page.team_name,$old$,
    $new$        'branch_name', page.branch_name,
        'province', page.province,
        'team_name', page.team_name,$new$);
  definition := replace(definition,
    $old$      ) order by page.planned_on nulls last, page.team_name, page.location_code, page.branch_name, page.branch_id)$old$,
    $new$      ) order by lower(coalesce(page.province, '')), page.planned_on nulls last, page.team_name, page.location_code, page.branch_name, page.branch_id)$new$);

  if definition = original_definition
      or strpos(definition, 'branch.province') = 0
      or strpos(definition, '''province'', page.province') = 0
      or strpos(definition, 'lower(coalesce(province,') = 0 then
    raise exception 'Could not safely group branch plan rows by province';
  end if;
  execute definition;
end
$migration$;

do $migration$
declare
  signature regprocedure := 'public.ais_campaign_schedule_preview(uuid)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(definition,
    $old$    'branch_name', grouped.branch_name,
    'selected_assets', grouped.selected_assets,$old$,
    $new$    'branch_name', grouped.branch_name,
    'province', grouped.province,
    'selected_assets', grouped.selected_assets,$new$);
  definition := replace(definition,
    $old$  ) order by grouped.location_code, grouped.branch_name, grouped.branch_id), '[]'::jsonb)$old$,
    $new$  ) order by lower(coalesce(grouped.province, '')), grouped.location_code, grouped.branch_name, grouped.branch_id), '[]'::jsonb)$new$);
  definition := replace(definition,
    $old$      branch.loc_bld as branch_name,
      count(item.id)::integer as selected_assets,$old$,
    $new$      branch.loc_bld as branch_name,
      branch.province,
      count(item.id)::integer as selected_assets,$new$);
  definition := replace(definition,
    $old$    group by branch.id, branch.location_code, branch.loc_bld,$old$,
    $new$    group by branch.id, branch.location_code, branch.loc_bld, branch.province,$new$);

  if definition = original_definition
      or strpos(definition, '''province'', grouped.province') = 0
      or strpos(definition, 'branch.province') = 0
      or strpos(definition, 'group by branch.id, branch.location_code, branch.loc_bld, branch.province') = 0
      or strpos(definition, 'lower(coalesce(grouped.province,') = 0 then
    raise exception 'Could not safely group scheduled branches by province';
  end if;
  execute definition;
end
$migration$;
