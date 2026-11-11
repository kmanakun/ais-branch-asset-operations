create table app_private.task_evidence_delete_reservations (
  task_id uuid not null,
  slot text not null,
  object_path text not null,
  reservation_token uuid not null default gen_random_uuid(),
  requested_by uuid not null references auth.users(id) on delete restrict,
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  primary key (task_id, slot),
  unique (object_path),
  unique (reservation_token),
  check (object_path = task_id::text || '/' || slot || '.jpg')
);

alter table app_private.task_evidence_delete_reservations enable row level security;
create policy task_evidence_delete_reservations_deny_browser
  on app_private.task_evidence_delete_reservations for all to anon, authenticated
  using (false) with check (false);
revoke all on table app_private.task_evidence_delete_reservations from public, anon, authenticated;
create index task_evidence_delete_reservations_expiry_idx
  on app_private.task_evidence_delete_reservations (expires_at);

create table app_private.task_evidence_removal_history (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references app_private.replacement_tasks(id) on delete restrict,
  slot text not null,
  object_path text not null,
  byte_size integer not null check (byte_size between 1 and 131072),
  outcome_context text,
  removed_by uuid not null references auth.users(id) on delete restrict,
  removed_at timestamptz not null default now(),
  check (object_path = task_id::text || '/' || slot || '.jpg'),
  check (outcome_context is null or outcome_context in ('replaced', 'no_damage_found', 'different_device_found', 'target_device_not_found'))
);

alter table app_private.task_evidence_removal_history enable row level security;
create policy task_evidence_removal_history_deny_browser
  on app_private.task_evidence_removal_history for all to anon, authenticated
  using (false) with check (false);
revoke all on table app_private.task_evidence_removal_history from public, anon, authenticated;
create index task_evidence_removal_history_task_idx
  on app_private.task_evidence_removal_history (task_id, removed_at desc);

create or replace function app_private.prevent_evidence_write_during_removal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1
    from app_private.task_evidence_delete_reservations r
    where r.task_id = new.task_id and r.slot = new.slot and r.expires_at > now()
  ) then
    raise exception 'Evidence removal is in progress; retry the upload after it finishes' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function app_private.prevent_evidence_write_during_removal() from public, anon, authenticated;
create trigger replacement_task_evidence_prevent_write_during_removal
  before insert or update on app_private.replacement_task_evidence
  for each row execute function app_private.prevent_evidence_write_during_removal();

create or replace function app_private.can_delete_task_evidence_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1
    from app_private.task_evidence_delete_reservations r
    join app_private.replacement_task_evidence e
      on e.task_id = r.task_id and e.slot = r.slot and e.object_path = r.object_path
    where r.object_path = p_name
      and r.requested_by = auth.uid()
      and r.expires_at > now()
      and e.status = 'ready'
      and app_private.can_edit_task_evidence_slot(r.task_id, r.slot)
  );
$$;
revoke all on function app_private.can_delete_task_evidence_object(text) from public, anon, authenticated;
grant execute on function app_private.can_delete_task_evidence_object(text) to authenticated;

create policy "AIS evidence delete for reserved slot"
on storage.objects for delete to authenticated
using (
  bucket_id = 'ais-task-evidence'
  and app_private.can_delete_task_evidence_object(name)
);

create or replace function public.ais_task_evidence_delete_reserve(p_task_id uuid, p_slot text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  slot_name text := lower(btrim(coalesce(p_slot, '')));
  evidence app_private.replacement_task_evidence%rowtype;
  reservation app_private.task_evidence_delete_reservations%rowtype;
begin
  if actor is null or not app_private.can_edit_task_evidence_slot(p_task_id, slot_name) then
    raise exception 'Task evidence is not editable by this account' using errcode = '42501';
  end if;

  select * into evidence
  from app_private.replacement_task_evidence e
  where e.task_id = p_task_id and e.slot = slot_name and e.status = 'ready'
  for update;
  if not found then
    raise exception 'Only saved evidence can be removed' using errcode = '22023';
  end if;

  delete from app_private.task_evidence_delete_reservations r where r.expires_at <= now();
  select * into reservation
  from app_private.task_evidence_delete_reservations r
  where r.task_id = p_task_id and r.slot = slot_name
  for update;
  if found and reservation.expires_at > now() then
    if reservation.requested_by = actor then
      return jsonb_build_object('reservation_token', reservation.reservation_token, 'path', reservation.object_path);
    end if;
    raise exception 'Evidence deletion is reserved by another account' using errcode = '55000';
  end if;

  insert into app_private.task_evidence_delete_reservations(task_id, slot, object_path, requested_by, expires_at)
  values (p_task_id, slot_name, evidence.object_path, actor, now() + interval '15 minutes')
  on conflict (task_id, slot) do update set
    object_path = excluded.object_path,
    reservation_token = gen_random_uuid(),
    requested_by = excluded.requested_by,
    expires_at = excluded.expires_at
  where app_private.task_evidence_delete_reservations.expires_at <= now()
  returning * into reservation;

  if not found then
    raise exception 'Evidence deletion is reserved by another account' using errcode = '55000';
  end if;
  return jsonb_build_object('reservation_token', reservation.reservation_token, 'path', reservation.object_path);
end;
$$;

create or replace function public.ais_task_evidence_delete_finalize(p_task_id uuid, p_slot text, p_reservation_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  slot_name text := lower(btrim(coalesce(p_slot, '')));
  reservation app_private.task_evidence_delete_reservations%rowtype;
  evidence app_private.replacement_task_evidence%rowtype;
begin
  if actor is null or not app_private.can_edit_task_evidence_slot(p_task_id, slot_name) then
    raise exception 'Task evidence is not editable by this account' using errcode = '42501';
  end if;

  select * into reservation
  from app_private.task_evidence_delete_reservations r
  where r.task_id = p_task_id and r.slot = slot_name
    and r.reservation_token = p_reservation_token and r.requested_by = actor
    and r.expires_at > now()
  for update;
  if not found then
    raise exception 'Evidence deletion request is missing or expired' using errcode = '22023';
  end if;

  select * into evidence
  from app_private.replacement_task_evidence e
  where e.task_id = p_task_id and e.slot = slot_name and e.object_path = reservation.object_path and e.status = 'ready'
  for update;
  if not found then
    raise exception 'Saved evidence changed before removal completed' using errcode = '40001';
  end if;
  if exists (select 1 from storage.objects o where o.bucket_id = 'ais-task-evidence' and o.name = evidence.object_path) then
    raise exception 'Evidence file remains in Storage; retry removal before confirming' using errcode = '55000';
  end if;

  insert into app_private.task_evidence_removal_history(task_id, slot, object_path, byte_size, outcome_context, removed_by)
  values (p_task_id, slot_name, evidence.object_path, evidence.byte_size, evidence.outcome_context, actor);
  delete from app_private.replacement_task_evidence e where e.task_id = p_task_id and e.slot = slot_name;
  delete from app_private.task_evidence_delete_reservations r where r.task_id = p_task_id and r.slot = slot_name;
  return jsonb_build_object('task_id', p_task_id, 'slot', slot_name, 'status', 'removed');
end;
$$;

create or replace function public.ais_task_evidence_delete_cancel(p_task_id uuid, p_slot text, p_reservation_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  slot_name text := lower(btrim(coalesce(p_slot, '')));
  reservation app_private.task_evidence_delete_reservations%rowtype;
begin
  if actor is null or not app_private.can_edit_task_evidence_slot(p_task_id, slot_name) then
    raise exception 'Task evidence is not editable by this account' using errcode = '42501';
  end if;
  select * into reservation
  from app_private.task_evidence_delete_reservations r
  where r.task_id = p_task_id and r.slot = slot_name
    and r.reservation_token = p_reservation_token and r.requested_by = actor
  for update;
  if not found then
    return jsonb_build_object('task_id', p_task_id, 'slot', slot_name, 'status', 'already_finished');
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'ais-task-evidence' and o.name = reservation.object_path) then
    raise exception 'Evidence file was removed; finalize removal instead of cancelling' using errcode = '55000';
  end if;
  delete from app_private.task_evidence_delete_reservations r where r.task_id = p_task_id and r.slot = slot_name;
  return jsonb_build_object('task_id', p_task_id, 'slot', slot_name, 'status', 'cancelled');
end;
$$;

revoke all on function public.ais_task_evidence_delete_reserve(uuid, text) from public, anon;
revoke all on function public.ais_task_evidence_delete_finalize(uuid, text, uuid) from public, anon;
revoke all on function public.ais_task_evidence_delete_cancel(uuid, text, uuid) from public, anon;
grant execute on function public.ais_task_evidence_delete_reserve(uuid, text) to authenticated;
grant execute on function public.ais_task_evidence_delete_finalize(uuid, text, uuid) to authenticated;
grant execute on function public.ais_task_evidence_delete_cancel(uuid, text, uuid) to authenticated;

comment on function public.ais_task_evidence_delete_reserve(uuid, text) is
  'Creates a short-lived, account-bound deletion reservation for a saved evidence slot that the account can edit.';
comment on function public.ais_task_evidence_delete_finalize(uuid, text, uuid) is
  'Removes saved evidence metadata only after Storage confirms the underlying object has been removed; records who removed it.';
comment on function public.ais_task_evidence_delete_cancel(uuid, text, uuid) is
  'Cancels a deletion reservation only while the evidence object remains in Storage.';
