-- Prevent read-only Viewer responses from exposing the full registered Serial
-- through the pre-visit fallback or by probing the work-order search count.
do $viewer_serial_privacy$
declare
  signature regprocedure := 'public.ais_branch_work_order_page(text,text,integer,integer)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
  masked_definition text;
begin
  definition := replace(
    definition,
    $old$'old_serial_snapshot', case when actor_role = 'viewer' and fv.old_serial_snapshot is not null then '••••••' || right(fv.old_serial_snapshot, 4) else coalesce(fv.old_serial_snapshot, rt.scanner_serial_snapshot, s.com_sn) end,$old$,
    $new$'old_serial_snapshot', case
          when actor_role = 'viewer' then
            case when char_length(coalesce(fv.old_serial_snapshot, rt.scanner_serial_snapshot, s.com_sn)) > 4
              then '••••••' || right(coalesce(fv.old_serial_snapshot, rt.scanner_serial_snapshot, s.com_sn), 4)
              else '••••••' end
          else coalesce(fv.old_serial_snapshot, rt.scanner_serial_snapshot, s.com_sn)
        end,$new$
  );
  if definition = original_definition then
    raise exception 'Could not mask the Viewer old Serial fallback';
  end if;
  masked_definition := definition;
  definition := replace(
    definition,
    $old$or bool_or(position(search_term in lower(concat_ws(' ', com_sn, scanner_model))) > 0)$old$,
    $new$or (actor_role <> 'viewer' and bool_or(position(search_term in lower(concat_ws(' ', com_sn, scanner_model))) > 0))$new$
  );
  if definition = masked_definition then
    raise exception 'Could not disable Viewer work-order Serial search';
  end if;
  execute definition;
end
$viewer_serial_privacy$;
