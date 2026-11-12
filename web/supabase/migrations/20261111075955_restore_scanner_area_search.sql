-- Keep Scanner register search aligned with the imported branch-area fields
-- after the Scanner-first RPC replacement.
do $scanner_page_area_search$
declare
  signature regprocedure := 'public.ais_scanner_page(text,integer,integer)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  if position('coalesce(b.district' in original_definition) > 0 then
    return;
  end if;

  definition := replace(
    definition,
    $before$      or coalesce(b.province, '') ilike '%' || search_term || '%'
      or coalesce(s.model_name, '') ilike '%' || search_term || '%'$before$,
    $after$      or coalesce(b.province, '') ilike '%' || search_term || '%'
      or coalesce(b.district, '') ilike '%' || search_term || '%'
      or coalesce(b.subdistrict, '') ilike '%' || search_term || '%'
      or coalesce(b.high_level_location, '') ilike '%' || search_term || '%'
      or coalesce(b.ro, '') ilike '%' || search_term || '%'
      or coalesce(s.model_name, '') ilike '%' || search_term || '%'$after$
  );

  if definition = original_definition then
    raise exception 'Could not restore branch-area search fields to %', signature;
  end if;

  execute definition;
end
$scanner_page_area_search$;
