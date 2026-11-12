-- A reviewed observed Serial is valid registration input only for a
-- different-device outcome; it must not be rejected by the replacement path.
do $exception_acceptance$
declare
  signature regprocedure := 'public.ais_admin_accept_task(uuid,integer,boolean)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text;
begin
  if position('elsif p_register_observed_serial and outcome_name <> ''different_device_found'' then' in original_definition) > 0 then
    return;
  end if;
  definition := replace(
    original_definition,
    $old$  elsif p_register_observed_serial then$old$,
    $new$  elsif p_register_observed_serial and outcome_name <> 'different_device_found' then$new$
  );
  if definition = original_definition then
    raise exception 'Could not preserve the Admin-reviewed different-device registration branch';
  end if;
  execute definition;
end
$exception_acceptance$;
