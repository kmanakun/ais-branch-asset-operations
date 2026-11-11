-- Return the same non-delivery status that the task and work-order readers use.
do $accept_result$
declare
  signature regprocedure := 'public.ais_admin_accept_task(uuid,integer,boolean)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text;
begin
  definition := replace(
    original_definition,
    $old$'workflow_stage', 'delivered', 'observed_serial_registered', did_register,$old$,
    $new$'workflow_stage', case
      when outcome_name in ('no_damage_found', 'different_device_found', 'target_device_not_found')
        then 'exception_resolved'
      else 'delivered'
    end, 'observed_serial_registered', did_register,$new$
  );
  if definition = original_definition then
    raise exception 'Could not return the reviewed-exception state from Admin acceptance';
  end if;
  execute definition;
end
$accept_result$;
