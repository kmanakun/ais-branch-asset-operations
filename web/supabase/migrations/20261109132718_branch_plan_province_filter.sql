begin;

-- Extend the guarded, paginated review without breaking callers that omit the
-- new optional parameter. Reuse the current definition so province grouping
-- and exact-branch device counts remain unchanged.
do $migration$
declare
  old_signature regprocedure := 'public.ais_branch_plan_page(text,text,text,integer,integer)'::regprocedure;
  original_definition text := pg_get_functiondef(old_signature);
  definition text := original_definition;
begin
  definition := replace(
    definition,
    $old$p_offset integer DEFAULT 0)$old$,
    $new$p_offset integer DEFAULT 0, p_province text DEFAULT NULL::text)$new$
  );
  definition := replace(
    definition,
    $old$team_name_filter text := nullif(btrim(p_team_name), '');$old$,
    $new$team_name_filter text := nullif(btrim(p_team_name), '');
  province_filter text := nullif(btrim(p_province), '');$new$
  );
  definition := replace(
    definition,
    $old$or (p_team_name is not null and length(p_team_name) > 100) then$old$,
    $new$or (p_team_name is not null and length(p_team_name) > 100)
      or (p_province is not null and length(p_province) > 100) then$new$
  );
  definition := replace(
    definition,
    $old$where (team_name_filter is null or team.team_name = team_name_filter)$old$,
    $new$where (team_name_filter is null or team.team_name = team_name_filter)
      and (
        province_filter is null
        or (province_filter = '__unassigned__' and nullif(btrim(branch.province), '') is null)
        or (province_filter <> '__unassigned__' and nullif(btrim(branch.province), '') = province_filter)
      )$new$
  );

  if definition = original_definition
      or strpos(definition, 'p_province text DEFAULT NULL::text') = 0
      or strpos(definition, 'province_filter text :=') = 0
      or strpos(definition, $check$province_filter = '__unassigned__' and nullif(btrim(branch.province)$check$) = 0 then
    raise exception 'Could not safely add the branch-plan province filter';
  end if;

  execute 'drop function public.ais_branch_plan_page(text, text, text, integer, integer)';
  execute definition;
end
$migration$;

revoke all on function public.ais_branch_plan_page(text, text, text, integer, integer, text) from public, anon;
grant execute on function public.ais_branch_plan_page(text, text, text, integer, integer, text) to authenticated;
comment on function public.ais_branch_plan_page(text, text, text, integer, integer, text) is
  'Read-only paginated branch-plan review for active Admin, Planner, or Data Manager users; supports exact province filtering, excludes scanner identifiers, and creates no tasks.';

commit;
