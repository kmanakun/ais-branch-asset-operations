-- Private work-order evidence for replacement photos and handwritten signatures.
-- The app uses Supabase Auth and RLS; no service-role key is exposed to clients.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ais-task-evidence',
  'AIS Task Evidence',
  false,
  131072,
  array['image/jpeg']::text[]
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types,
    updated_at = clock_timestamp();

create table app_private.replacement_task_evidence (
  task_id uuid not null references app_private.replacement_tasks(id) on delete restrict,
  slot text not null check (slot in (
    'old_serial_photo', 'new_serial_photo', 'old_device_photo', 'new_device_photo',
    'spare_photo_1', 'spare_photo_2',
    'technician_signature', 'scanner_user_signature', 'inspector_signature'
  )),
  object_path text not null unique,
  content_type text not null default 'image/jpeg' check (content_type = 'image/jpeg'),
  byte_size integer not null check (byte_size between 1 and 131072),
  status text not null default 'pending' check (status in ('pending', 'ready')),
  signer_name text,
  consent_confirmed boolean not null default false,
  uploaded_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  uploaded_at timestamptz,
  primary key (task_id, slot),
  check (
    object_path = task_id::text || '/' || slot || '.jpg'
  ),
  check (
    (slot in ('technician_signature', 'scanner_user_signature', 'inspector_signature')
      and signer_name is not null and length(btrim(signer_name)) between 1 and 120
      and consent_confirmed)
    or
    (slot not in ('technician_signature', 'scanner_user_signature', 'inspector_signature')
      and signer_name is null and not consent_confirmed)
  ),
  check (
    (status = 'pending' and uploaded_at is null)
    or (status = 'ready' and uploaded_at is not null)
  )
);

alter table app_private.replacement_task_evidence enable row level security;
revoke all on table app_private.replacement_task_evidence from public, anon, authenticated;
create index replacement_task_evidence_status_idx
  on app_private.replacement_task_evidence(status, updated_at);

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
    join app_private.teams t on t.id = rt.team_id
    where ua.user_id = auth.uid()
      and ua.is_active
      and (
        ua.role = 'admin'
        or (
          ua.role = 'field_technician'
          and t.is_active
          and exists (
            select 1 from app_private.user_team_memberships utm
            where utm.user_id = ua.user_id and utm.team_id = rt.team_id
          )
        )
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
    join app_private.teams t on t.id = rt.team_id
    where ua.user_id = auth.uid()
      and ua.is_active
      and (
        ua.role in ('admin', 'planner')
        or (
          ua.role = 'field_technician'
          and t.is_active
          and exists (
            select 1 from app_private.user_team_memberships utm
            where utm.user_id = ua.user_id and utm.team_id = rt.team_id
          )
        )
      )
  );
$$;

create or replace function app_private.can_access_task_evidence_object(p_name text, p_operation text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app_private.replacement_task_evidence e
    where e.object_path = p_name
      and (
        (p_operation = 'write' and e.status = 'pending'
          and app_private.can_edit_task_evidence(e.task_id))
        or
        (p_operation = 'read' and e.status in ('pending', 'ready')
          and (
            app_private.can_view_task_evidence(e.task_id)
            or app_private.can_edit_task_evidence(e.task_id)
          ))
      )
  );
$$;

create or replace function app_private.can_upload_task_evidence_object(
  p_name text,
  p_size text,
  p_content_type text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_size ~ '^[0-9]{1,6}$' then exists (
        select 1
        from app_private.replacement_task_evidence e
        where e.object_path = p_name
          and e.status = 'pending'
          and e.byte_size = p_size::integer
          and e.content_type = p_content_type
          and app_private.can_edit_task_evidence(e.task_id)
      )
    else false
  end;
$$;

revoke all on function app_private.can_edit_task_evidence(uuid) from public, anon;
revoke all on function app_private.can_view_task_evidence(uuid) from public, anon;
revoke all on function app_private.can_access_task_evidence_object(text, text) from public, anon;
revoke all on function app_private.can_upload_task_evidence_object(text, text, text) from public, anon;
grant usage on schema app_private to authenticated;
grant execute on function app_private.can_edit_task_evidence(uuid) to authenticated;
grant execute on function app_private.can_view_task_evidence(uuid) to authenticated;
grant execute on function app_private.can_access_task_evidence_object(text, text) to authenticated;
grant execute on function app_private.can_upload_task_evidence_object(text, text, text) to authenticated;

create policy "AIS evidence read by assigned team or planner"
on storage.objects for select to authenticated
using (
  bucket_id = 'ais-task-evidence'
  and app_private.can_access_task_evidence_object(name, 'read')
);

create policy "AIS evidence upload for reserved task slot"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'ais-task-evidence'
  and app_private.can_access_task_evidence_object(name, 'write')
  and app_private.can_upload_task_evidence_object(name, metadata ->> 'size', metadata ->> 'mimetype')
);

create policy "AIS evidence replace for reserved task slot"
on storage.objects for update to authenticated
using (
  bucket_id = 'ais-task-evidence'
  and app_private.can_access_task_evidence_object(name, 'write')
)
with check (
  bucket_id = 'ais-task-evidence'
  and app_private.can_access_task_evidence_object(name, 'write')
  and app_private.can_upload_task_evidence_object(name, metadata ->> 'size', metadata ->> 'mimetype')
);

create or replace function public.ais_task_evidence_list(p_task_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app_private.can_view_task_evidence(p_task_id) then
    raise exception 'Task evidence is outside your assigned access' using errcode = '42501';
  end if;

  return (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'slot', e.slot,
          'status', e.status,
          'path', e.object_path,
          'byte_size', e.byte_size,
          'signer_name', e.signer_name,
          'uploaded_at', e.uploaded_at,
          'updated_at', e.updated_at
        ) order by e.slot
      ),
      '[]'::jsonb
    )
    from app_private.replacement_task_evidence e
    where e.task_id = p_task_id
  );
end;
$$;

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
    raise exception 'Task evidence is outside your assigned team or is no longer editable' using errcode = '42501';
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
  select e.byte_size into existing_size
  from app_private.replacement_task_evidence e
  where e.task_id = p_task_id and e.slot = slot_name
  for update;

  if reserved_size - coalesce(existing_size, 0) + p_byte_size > 900 * 1024 * 1024 then
    raise exception 'Evidence storage is at the free-plan safety limit; contact the system Admin' using errcode = '53100';
  end if;

  insert into app_private.replacement_task_evidence (
    task_id, slot, object_path, content_type, byte_size, status,
    signer_name, consent_confirmed, uploaded_by, updated_at, uploaded_at
  ) values (
    p_task_id, slot_name, path_name, 'image/jpeg', p_byte_size, 'pending',
    signer,
    slot_name in ('technician_signature', 'scanner_user_signature', 'inspector_signature'),
    actor,
    clock_timestamp(),
    null
  )
  on conflict (task_id, slot) do update
  set object_path = excluded.object_path,
      content_type = excluded.content_type,
      byte_size = excluded.byte_size,
      status = 'pending',
      signer_name = excluded.signer_name,
      consent_confirmed = excluded.consent_confirmed,
      uploaded_by = excluded.uploaded_by,
      updated_at = clock_timestamp(),
      uploaded_at = null;

  return pg_catalog.jsonb_build_object(
    'task_id', p_task_id,
    'slot', slot_name,
    'path', path_name,
    'byte_size', p_byte_size,
    'status', 'pending'
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
  slot_name text := lower(btrim(coalesce(p_slot, '')));
  evidence app_private.replacement_task_evidence%rowtype;
  object_size bigint;
  object_type text;
begin
  if not app_private.can_edit_task_evidence(p_task_id) then
    raise exception 'Task evidence is outside your assigned team or is no longer editable' using errcode = '42501';
  end if;

  select * into evidence
  from app_private.replacement_task_evidence e
  where e.task_id = p_task_id and e.slot = slot_name
  for update;
  if not found then
    raise exception 'No reserved evidence upload exists for this slot' using errcode = 'P0002';
  end if;

  if evidence.status = 'ready' then
    return pg_catalog.jsonb_build_object(
      'task_id', p_task_id, 'slot', slot_name, 'status', 'ready'
    );
  end if;

  select (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype'
  into object_size, object_type
  from storage.objects o
  where o.bucket_id = 'ais-task-evidence' and o.name = evidence.object_path;
  if not found or object_size is distinct from evidence.byte_size::bigint
    or object_type is distinct from evidence.content_type then
    raise exception 'Uploaded evidence is missing or its size/type did not match the reservation' using errcode = '55000';
  end if;

  update app_private.replacement_task_evidence e
  set status = 'ready', uploaded_at = coalesce(e.uploaded_at, clock_timestamp()), updated_at = clock_timestamp()
  where e.task_id = p_task_id and e.slot = slot_name;

  insert into app_private.audit_events (actor_id, event_type, entity_type, entity_id, summary)
  values (
    auth.uid(),
    'task_evidence_saved',
    'replacement_task',
    p_task_id,
    pg_catalog.jsonb_build_object('slot', slot_name, 'byte_size', evidence.byte_size)
  );

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
  evidence app_private.replacement_task_evidence%rowtype;
begin
  if not app_private.can_edit_task_evidence(p_task_id) then
    raise exception 'Task evidence is outside your assigned team or is no longer editable' using errcode = '42501';
  end if;
  select * into evidence
  from app_private.replacement_task_evidence e
  where e.task_id = p_task_id and e.slot = lower(btrim(coalesce(p_slot, '')))
  for update;
  if not found or evidence.status <> 'pending' then
    raise exception 'Only an unconfirmed evidence upload can be cancelled' using errcode = '22023';
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

revoke all on function public.ais_task_evidence_list(uuid) from public, anon;
revoke all on function public.ais_task_evidence_reserve(uuid, text, integer, text, boolean) from public, anon;
revoke all on function public.ais_task_evidence_finalize(uuid, text) from public, anon;
revoke all on function public.ais_task_evidence_cancel_pending(uuid, text) from public, anon;
grant execute on function public.ais_task_evidence_list(uuid) to authenticated;
grant execute on function public.ais_task_evidence_reserve(uuid, text, integer, text, boolean) to authenticated;
grant execute on function public.ais_task_evidence_finalize(uuid, text) to authenticated;
grant execute on function public.ais_task_evidence_cancel_pending(uuid, text) to authenticated;

create or replace function app_private.require_task_evidence_before_completion()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  missing_slots text[];
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    select pg_catalog.array_agg(required.slot order by required.slot)
    into missing_slots
    from pg_catalog.unnest(array[
      'old_serial_photo', 'new_serial_photo', 'old_device_photo', 'new_device_photo',
      'technician_signature', 'scanner_user_signature', 'inspector_signature'
    ]::text[]) as required(slot)
    left join app_private.replacement_task_evidence e
      on e.task_id = new.id and e.slot = required.slot and e.status = 'ready'
    left join storage.objects o
      on o.bucket_id = 'ais-task-evidence' and o.name = e.object_path
    where e.task_id is null or o.id is null;

    if coalesce(pg_catalog.cardinality(missing_slots), 0) > 0 then
      raise exception 'Required photos and signatures must be saved before completing this task: %',
        pg_catalog.array_to_string(missing_slots, ', ')
        using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function app_private.require_task_evidence_before_completion() from public, anon, authenticated;

create trigger replacement_tasks_require_evidence_before_completion
before update of status on app_private.replacement_tasks
for each row
execute function app_private.require_task_evidence_before_completion();

comment on table app_private.replacement_task_evidence is
  'Private photo and signature metadata for a replacement task. The Supabase Storage bucket is private, reserved usage is limited to 900 MiB, and only the active assigned team/Admin can upload while the task is in progress.';
comment on function public.ais_task_evidence_list(uuid) is
  'Lists private work-order evidence metadata for active Admin/Planner or the assigned active Field Technician team.';
comment on function public.ais_task_evidence_reserve(uuid, text, integer, text, boolean) is
  'Reserves one of nine evidence slots with role/team checks, per-slot byte limits, signer name consent, and a 900 MiB Free-plan quota guard.';
comment on function public.ais_task_evidence_finalize(uuid, text) is
  'Confirms an uploaded private JPEG by checking Storage object size and MIME metadata, then records an audit event.';
comment on function public.ais_task_evidence_cancel_pending(uuid, text) is
  'Releases an unconfirmed evidence slot only when its Storage object was not uploaded.';
