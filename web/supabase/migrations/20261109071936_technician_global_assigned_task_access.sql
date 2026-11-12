-- Access is based on whether a work order has been assigned/opened in the plan,
-- not on a technician-to-team membership row. Team labels and dates remain
-- scheduling metadata.

alter table app_private.user_access
  add constraint user_access_only_admin_and_field_technician
  check (role in ('admin', 'field_technician')) not valid;

alter table app_private.user_access
  validate constraint user_access_only_admin_and_field_technician;

-- The profile no longer exposes team memberships as a permission boundary.
create or replace function public.ais_app_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if auth.uid() is null then
    return null;
  end if;
  select jsonb_build_object(
    'role', ua.role::text,
    'display_name', ua.display_name,
    'teams', '[]'::jsonb
  )
  into result
  from app_private.user_access ua
  where ua.user_id = auth.uid() and ua.is_active;
  return result;
end
$$;

-- Admin is the sole role that can schedule plans; Field Technicians work the
-- resulting assigned tasks, while obsolete Planner roles are disallowed.
do $migration$
declare
  signature regprocedure := 'public.ais_schedule_campaign(uuid,uuid,date)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(
    definition,
    'actor_role is distinct from ''planner'' then',
    'actor_role is distinct from ''admin'' then'
  );
  if definition = original_definition then
    raise exception 'Could not update legacy scheduler role guard in %', signature;
  end if;
  execute definition;
end
$migration$;

-- Replace the historical team-membership predicate in the field action RPC.
do $migration$
declare
  signature regprocedure := 'public.ais_field_task_action(uuid,text,integer,text,text,text,text,text)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
  old_message text := 'Task does not exist or is outside your assigned team';
  new_message text := 'Task does not exist or is not assigned to a technician';
begin
  definition := regexp_replace(
    definition,
    'and \(actor_role = ''admin'' or exists \(\s*select 1\s*from app_private\.user_team_memberships utm\s*where utm\.user_id = actor and utm\.team_id = rt\.team_id\s*\)\)',
    'and (actor_role = ''admin'' or rt.team_id is not null)'
  );
  if definition = original_definition and strpos(definition, 'actor_role = ''admin'' or rt.team_id is not null') = 0 then
    raise exception 'Could not locate technician task-access predicate in %', signature;
  end if;

  definition := replace(
    definition,
    'join app_private.teams t on t.id = rt.team_id and (t.is_active or actor_role = ''admin'')',
    'join app_private.teams t on t.id = rt.team_id'
  );
  if strpos(definition, 't.is_active or actor_role') > 0 then
    raise exception 'Could not remove active-team restriction in %', signature;
  end if;

  if strpos(definition, old_message) > 0 then
    definition := replace(definition, old_message, new_message);
  end if;
  execute definition;
end
$migration$;

-- All assigned work orders are visible to active Field Technicians. Unassigned
-- campaign items remain private to Admin workflows.
do $migration$
declare
  signature regprocedure := 'public.ais_task_filtered_page(text,text,integer,integer)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := regexp_replace(
    definition,
    'where actor_role <> ''field_technician'' or exists \(\s*select 1\s*from app_private\.user_team_memberships utm\s*where utm\.team_id = rt\.team_id and utm\.user_id = actor\s*\)',
    'where actor_role <> ''field_technician'' or rt.team_id is not null'
  );
  if definition = original_definition and strpos(definition, 'rt.team_id is not null') = 0 then
    raise exception 'Could not locate technician task list scope in %', signature;
  end if;
  if strpos(definition, 'user_team_memberships') > 0 then
    raise exception 'Unexpected remaining team membership check in %', signature;
  end if;
  execute definition;
end
$migration$;

-- Legacy scanner-list RPC is not used by the UI, but keep its authenticated
-- scope consistent with the paginated scanner registry.
do $migration$
declare
  signature regprocedure := 'public.ais_list_scanners(text)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := regexp_replace(
    definition,
    'and \(actor_role <> ''field_technician'' or exists \(\s*select 1 from app_private\.campaign_items ci2\s*join app_private\.replacement_tasks rt2 on rt2\.campaign_item_id = ci2\.id\s*join app_private\.user_team_memberships utm on utm\.team_id = rt2\.team_id and utm\.user_id = actor\s*where ci2\.scanner_asset_id = s\.id\s*\)\)',
    'and (actor_role <> ''field_technician'' or exists (select 1 from app_private.campaign_items ci2 join app_private.replacement_tasks rt2 on rt2.campaign_item_id = ci2.id where ci2.scanner_asset_id = s.id and rt2.team_id is not null))'
  );
  if strpos(definition, 'user_team_memberships') > 0 or definition = original_definition then
    raise exception 'Could not replace legacy scanner team scope in %', signature;
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
  definition := regexp_replace(
    definition,
    'and \(actor_role <> ''field_technician'' or exists \(\s*select 1 from app_private\.user_team_memberships utm\s*where utm\.user_id = actor and utm\.team_id = rt\.team_id\s*\)\)',
    'and (actor_role <> ''field_technician'' or rt.team_id is not null)'
  );
  definition := regexp_replace(
    definition,
    'and \(actor_role <> ''field_technician'' or exists \(\s*select 1 from app_private\.campaign_items ci\s*join app_private\.replacement_tasks rt on rt\.campaign_item_id = ci\.id\s*join app_private\.user_team_memberships utm on utm\.team_id = rt\.team_id and utm\.user_id = actor\s*where ci\.scanner_asset_id = s\.id\s*\)\)',
    'and (actor_role <> ''field_technician'' or exists (select 1 from app_private.campaign_items ci join app_private.replacement_tasks rt on rt.campaign_item_id = ci.id where ci.scanner_asset_id = s.id and rt.team_id is not null))'
  );
  if strpos(definition, 'user_team_memberships') > 0 then
    raise exception 'Could not remove all scanner-page team membership checks in %', signature;
  end if;
  execute definition;
end
$migration$;

do $migration$
declare
  signature regprocedure := 'public.ais_list_campaigns(text)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := regexp_replace(
    definition,
    'and \(actor_role <> ''field_technician'' or exists \(\s*select 1 from app_private\.user_team_memberships utm\s*where utm\.team_id = rt\.team_id and utm\.user_id = actor\s*\)\)',
    'and (actor_role <> ''field_technician'' or rt.team_id is not null)'
  );
  definition := regexp_replace(
    definition,
    'join app_private\.user_team_memberships utm on utm\.team_id = rt2\.team_id and utm\.user_id = actor',
    'join app_private.teams assigned_team on assigned_team.id = rt2.team_id'
  );
  if strpos(definition, 'user_team_memberships') > 0 then
    raise exception 'Could not remove all campaign list team membership checks in %', signature;
  end if;
  execute definition;
end
$migration$;

-- Dashboard counts and recent/weekly task views use the same assigned-work
-- boundary, without revealing unassigned devices or campaigns to technicians.
do $migration$
declare
  signature regprocedure := 'public.ais_dashboard()'::regprocedure;
  definition text := pg_get_functiondef(signature);
begin
  definition := regexp_replace(
    definition,
    'join app_private\.user_team_memberships utm on utm\.team_id = rt\.team_id and utm\.user_id = actor',
    'join app_private.teams assigned_team on assigned_team.id = rt.team_id',
    'g'
  );
  definition := regexp_replace(
    definition,
    'join app_private\.user_team_memberships utm on utm\.team_id = rt2\.team_id and utm\.user_id = actor',
    'join app_private.teams assigned_team on assigned_team.id = rt2.team_id',
    'g'
  );
  definition := regexp_replace(
    definition,
    'select 1 from app_private\.user_team_memberships utm\s+where utm\.team_id = rt\.team_id and utm\.user_id = actor',
    'select 1 where rt.team_id is not null',
    'g'
  );
  if strpos(definition, 'user_team_memberships') > 0 then
    raise exception 'Could not remove all dashboard team membership checks in %', signature;
  end if;
  execute definition;
end
$migration$;

-- Evidence follows the same assigned-work boundary. Field Technicians can view
-- evidence for assigned work; edits remain limited to in-progress work and an
-- active, non-blocked campaign. Admin retains cross-workflow support access.
create or replace function app_private.can_edit_task_evidence(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1
    from app_private.user_access ua
    join app_private.replacement_tasks rt on rt.id = p_task_id and rt.status = 'in_progress'
    join app_private.campaign_items ci on ci.id = rt.campaign_item_id
    join app_private.campaigns c on c.id = ci.campaign_id and c.status not in ('blocked', 'cancelled')
    where ua.user_id = auth.uid()
      and ua.is_active
      and (
        ua.role = 'admin'
        or (ua.role = 'field_technician' and rt.team_id is not null)
      )
  );
$$;

create or replace function app_private.can_view_task_evidence(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1
    from app_private.user_access ua
    join app_private.replacement_tasks rt on rt.id = p_task_id
    where ua.user_id = auth.uid()
      and ua.is_active
      and (
        ua.role = 'admin'
        or (ua.role = 'field_technician' and rt.team_id is not null)
      )
  );
$$;

-- Bind every pending upload to its initiating user and a one-use reservation
-- nonce so shared technician access cannot cross-confirm or overwrite uploads.
alter table app_private.replacement_task_evidence
  add column reservation_token uuid;

update app_private.replacement_task_evidence
set reservation_token = pg_catalog.gen_random_uuid()
where status = 'pending' and reservation_token is null;

alter table app_private.replacement_task_evidence
  add constraint replacement_task_evidence_reservation_state_check
  check (
    (status = 'pending' and reservation_token is not null)
    or (status = 'ready' and reservation_token is null)
  ) not valid;

alter table app_private.replacement_task_evidence
  validate constraint replacement_task_evidence_reservation_state_check;

do $migration$
declare
  signature regprocedure := 'public.ais_task_evidence_list(uuid)'::regprocedure;
  original_definition text := pg_get_functiondef(signature);
  definition text := original_definition;
begin
  definition := replace(
    definition,
    '''updated_at'', e.updated_at',
    '''updated_at'', e.updated_at, ''can_finalize'', (e.status = ''pending'' and e.uploaded_by = auth.uid())'
  );
  if definition = original_definition then
    raise exception 'Could not add safe pending-upload retry metadata to %', signature;
  end if;
  execute definition;
end
$migration$;

drop policy if exists "AIS evidence read by assigned team or planner" on storage.objects;
drop policy if exists "AIS evidence upload for reserved task slot" on storage.objects;
drop policy if exists "AIS evidence replace for reserved task slot" on storage.objects;
revoke all on function app_private.can_upload_task_evidence_object(text, text, text) from public, anon, authenticated;
drop function app_private.can_upload_task_evidence_object(text, text, text);

create function app_private.can_upload_task_evidence_object(
  p_name text,
  p_size text,
  p_content_type text,
  p_reservation_token text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_size ~ '^[0-9]{1,6}$'
      and p_reservation_token ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then exists (
      select 1
      from app_private.replacement_task_evidence e
      where e.object_path = p_name
        and e.status = 'pending'
        and e.uploaded_by = auth.uid()
        and e.reservation_token = p_reservation_token::uuid
        and e.byte_size = p_size::integer
        and e.content_type = p_content_type
        and app_private.can_edit_task_evidence(e.task_id)
    )
    else false
  end;
$$;

grant execute on function app_private.can_upload_task_evidence_object(text, text, text, text) to authenticated;

create policy "AIS evidence read by assigned task"
on storage.objects for select to authenticated
using (
  bucket_id = 'ais-task-evidence'
  and app_private.can_access_task_evidence_object(name, 'read')
);

create policy "AIS evidence upload for owned reservation"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'ais-task-evidence'
  and app_private.can_access_task_evidence_object(name, 'write')
  and app_private.can_upload_task_evidence_object(name, metadata ->> 'size', metadata ->> 'mimetype', user_metadata ->> 'reservation_token')
);

create policy "AIS evidence replace for owned reservation"
on storage.objects for update to authenticated
using (
  bucket_id = 'ais-task-evidence'
  and app_private.can_access_task_evidence_object(name, 'write')
)
with check (
  bucket_id = 'ais-task-evidence'
  and app_private.can_access_task_evidence_object(name, 'write')
  and app_private.can_upload_task_evidence_object(name, metadata ->> 'size', metadata ->> 'mimetype', user_metadata ->> 'reservation_token')
);

create or replace function public.ais_task_evidence_reserve(
  p_task_id uuid,
  p_slot text,
  p_byte_size integer,
  p_signer_name text default null,
  p_consent_confirmed boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role app_private.app_role;
  actor_name text;
  slot_name text := lower(btrim(coalesce(p_slot, '')));
  signer text := nullif(btrim(coalesce(p_signer_name, '')), '');
  existing_size integer := 0;
  existing_status text;
  existing_uploader uuid;
  existing_updated_at timestamptz;
  reservation_token uuid := pg_catalog.gen_random_uuid();
  reserved_size bigint := 0;
  max_slot_size integer;
  path_name text;
begin
  select ua.role, ua.display_name into actor_role, actor_name
  from app_private.user_access ua
  where ua.user_id = actor and ua.is_active;

  if actor is null or actor_role is null or actor_role not in ('admin', 'field_technician') then
    raise exception 'Active Field Technician or Admin access required' using errcode = '42501';
  end if;
  perform 1
  from app_private.replacement_tasks rt
  where rt.id = p_task_id and rt.status = 'in_progress'
  for update;
  if not found then
    raise exception 'Task is no longer in progress' using errcode = '55000';
  end if;
  if p_task_id is null or not app_private.can_edit_task_evidence(p_task_id) then
    raise exception 'Task evidence is not editable' using errcode = '42501';
  end if;
  if slot_name not in (
    'old_serial_photo', 'new_serial_photo', 'old_device_photo', 'new_device_photo',
    'spare_photo_1', 'spare_photo_2',
    'technician_signature', 'scanner_user_signature', 'inspector_signature'
  ) then
    raise exception 'Unsupported task evidence slot' using errcode = '22023';
  end if;

  max_slot_size := case
    when slot_name in ('technician_signature', 'scanner_user_signature', 'inspector_signature') then 32768
    else 92160
  end;
  if p_byte_size is null or p_byte_size < 1 or p_byte_size > max_slot_size then
    raise exception 'Evidence file exceeds its slot size limit' using errcode = '22023';
  end if;

  if slot_name = 'technician_signature' then
    signer := nullif(btrim(coalesce(actor_name, '')), '');
  elsif slot_name in ('scanner_user_signature', 'inspector_signature') then
    if signer is null or length(signer) > 120 or p_consent_confirmed is distinct from true then
      raise exception 'Signer name and confirmation to store the signature are required' using errcode = '22023';
    end if;
  elsif p_signer_name is not null or p_consent_confirmed then
    raise exception 'Photo evidence cannot contain signature consent fields' using errcode = '22023';
  end if;

  if slot_name in ('technician_signature', 'scanner_user_signature', 'inspector_signature')
    and (signer is null or length(signer) > 120 or p_consent_confirmed is distinct from true) then
    raise exception 'Signature and consent confirmation are required' using errcode = '22023';
  end if;

  path_name := p_task_id::text || '/' || slot_name || '.jpg';
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ais-task-evidence-free-quota', 0));
  select coalesce(sum(e.byte_size), 0) into reserved_size
  from app_private.replacement_task_evidence e;
  select e.byte_size, e.status, e.uploaded_by, e.updated_at
    into existing_size, existing_status, existing_uploader, existing_updated_at
  from app_private.replacement_task_evidence e
  where e.task_id = p_task_id and e.slot = slot_name
  for update;

  if existing_status = 'ready'
    and existing_uploader is distinct from actor
    and actor_role <> 'admin' then
    raise exception 'Only the original uploader or Admin can replace saved evidence' using errcode = '42501';
  end if;

  if existing_status = 'pending'
    and existing_uploader is distinct from actor
    and existing_updated_at > clock_timestamp() - interval '15 minutes'
    and actor_role <> 'admin' then
    raise exception 'Evidence slot is reserved by another technician; try again later or ask Admin' using errcode = '55P03';
  end if;

  if reserved_size - coalesce(existing_size, 0) + p_byte_size > 900 * 1024 * 1024 then
    raise exception 'Evidence storage is at the free-plan safety limit; contact the system Admin' using errcode = '53100';
  end if;

  insert into app_private.replacement_task_evidence (
    task_id, slot, object_path, content_type, byte_size, status,
    signer_name, consent_confirmed, uploaded_by, reservation_token, updated_at, uploaded_at
  ) values (
    p_task_id, slot_name, path_name, 'image/jpeg', p_byte_size, 'pending',
    signer,
    slot_name in ('technician_signature', 'scanner_user_signature', 'inspector_signature'),
    actor, reservation_token, clock_timestamp(), null
  )
  on conflict (task_id, slot) do update
  set object_path = excluded.object_path,
      content_type = excluded.content_type,
      byte_size = excluded.byte_size,
      status = 'pending',
      signer_name = excluded.signer_name,
      consent_confirmed = excluded.consent_confirmed,
      uploaded_by = excluded.uploaded_by,
      reservation_token = excluded.reservation_token,
      updated_at = clock_timestamp(),
      uploaded_at = null;

  return pg_catalog.jsonb_build_object(
    'task_id', p_task_id,
    'slot', slot_name,
    'path', path_name,
    'byte_size', p_byte_size,
    'status', 'pending',
    'reservation_token', reservation_token
  );
end;
$$;

create or replace function public.ais_task_evidence_finalize(p_task_id uuid, p_slot text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  slot_name text := lower(btrim(coalesce(p_slot, '')));
  evidence app_private.replacement_task_evidence%rowtype;
  object_size bigint;
  object_type text;
  object_reservation_token text;
begin
  if not app_private.can_edit_task_evidence(p_task_id) then
    raise exception 'Task evidence is not editable' using errcode = '42501';
  end if;

  select * into evidence
  from app_private.replacement_task_evidence e
  where e.task_id = p_task_id and e.slot = slot_name
  for update;
  if not found then
    raise exception 'No reserved evidence upload exists for this slot' using errcode = 'P0002';
  end if;
  if evidence.status = 'ready' then
    return pg_catalog.jsonb_build_object('task_id', p_task_id, 'slot', slot_name, 'status', 'ready');
  end if;
  if evidence.uploaded_by is distinct from actor or evidence.reservation_token is null then
    raise exception 'Only the uploader can confirm this pending reservation' using errcode = '42501';
  end if;

  select (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype', o.user_metadata ->> 'reservation_token'
    into object_size, object_type, object_reservation_token
  from storage.objects o
  where o.bucket_id = 'ais-task-evidence' and o.name = evidence.object_path;
  if not found or object_size is distinct from evidence.byte_size::bigint
    or object_type is distinct from evidence.content_type
    or object_reservation_token is distinct from evidence.reservation_token::text then
    raise exception 'Uploaded evidence is missing or does not match the active reservation' using errcode = '55000';
  end if;

  update app_private.replacement_task_evidence e
  set status = 'ready', reservation_token = null,
      uploaded_at = coalesce(e.uploaded_at, clock_timestamp()), updated_at = clock_timestamp()
  where e.task_id = p_task_id and e.slot = slot_name;

  insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
  values (actor, 'task_evidence_saved', 'replacement_task', p_task_id,
    pg_catalog.jsonb_build_object('slot', slot_name, 'byte_size', evidence.byte_size));
  return pg_catalog.jsonb_build_object('task_id', p_task_id, 'slot', slot_name, 'status', 'ready');
end;
$$;

create or replace function public.ais_task_evidence_cancel_pending(p_task_id uuid, p_slot text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  evidence app_private.replacement_task_evidence%rowtype;
begin
  if not app_private.can_edit_task_evidence(p_task_id) then
    raise exception 'Task evidence is not editable' using errcode = '42501';
  end if;
  select * into evidence
  from app_private.replacement_task_evidence e
  where e.task_id = p_task_id and e.slot = lower(btrim(coalesce(p_slot, '')))
  for update;
  if not found or evidence.status <> 'pending' then
    raise exception 'Only an unconfirmed evidence upload can be cancelled' using errcode = '22023';
  end if;
  if evidence.uploaded_by is distinct from actor or evidence.reservation_token is null then
    raise exception 'Only the uploader can cancel this pending reservation' using errcode = '42501';
  end if;
  if exists (
    select 1 from storage.objects o
    where o.bucket_id = 'ais-task-evidence' and o.name = evidence.object_path
  ) then
    raise exception 'The file reached storage; retry confirmation instead of cancelling it' using errcode = '55000';
  end if;
  delete from app_private.replacement_task_evidence e
  where e.task_id = p_task_id and e.slot = evidence.slot;
  return pg_catalog.jsonb_build_object('task_id', p_task_id, 'slot', evidence.slot, 'status', 'cancelled');
end;
$$;

comment on table app_private.replacement_task_evidence is
  'Private work-order photos and signatures; pending uploads are bound to the initiating account and one-use token, while finished evidence remains visible to technicians and Admin on assigned work.';
comment on constraint user_access_only_admin_and_field_technician on app_private.user_access is
  'Only Office Admin and Field Technician are assignable application roles.';

comment on constraint user_access_only_admin_and_field_technician on app_private.user_access is
  'Only Office Admin and Field Technician are assignable application roles.';
