-- Google Sign-In uses an exact email allow-list for onboarding and keeps the
-- existing user_access table as the application authorization source.
create table app_private.google_signin_allowlist (
  email text primary key
    check (email = lower(btrim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  role app_private.app_role not null
    check (role in ('admin', 'field_technician')),
  display_name text not null check (length(btrim(display_name)) > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
alter table app_private.google_signin_allowlist enable row level security;
revoke all on table app_private.google_signin_allowlist from public, anon, authenticated;
create policy google_signin_allowlist_auth_hook_read
on app_private.google_signin_allowlist
for select to supabase_auth_admin
using (true);

-- Preserve the current role assignments for existing Auth users. The email
-- list is now the onboarding source; user_access remains the runtime role gate.
insert into app_private.google_signin_allowlist (email, role, display_name, is_active)
select lower(btrim(au.email)), ua.role, ua.display_name, ua.is_active
from app_private.user_access ua
join auth.users au on au.id = ua.user_id
where au.email is not null
  and ua.role in ('admin', 'field_technician')
on conflict (email) do nothing;

create or replace function app_private.google_signin_before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  candidate_email text := lower(btrim(coalesce(event #>> '{user,email}', '')));
  provider_name text := lower(btrim(coalesce(event #>> '{user,app_metadata,provider}', '')));
begin
  if provider_name is distinct from 'google' then
    return pg_catalog.jsonb_build_object(
      'error', pg_catalog.jsonb_build_object(
        'http_code', 403,
        'message', 'ใช้บัญชี Google ที่ได้รับอนุญาตเท่านั้น'
      )
    );
  end if;

  if candidate_email = '' or not exists (
    select 1
    from app_private.google_signin_allowlist allowlist
    where allowlist.email = candidate_email and allowlist.is_active
  ) then
    return pg_catalog.jsonb_build_object(
      'error', pg_catalog.jsonb_build_object(
        'http_code', 403,
        'message', 'บัญชี Google นี้ยังไม่ได้รับอนุญาต โปรดติดต่อ Identity Admin'
      )
    );
  end if;

  return '{}'::jsonb;
end
$$;
revoke all on function app_private.google_signin_before_user_created(jsonb) from public, anon, authenticated;
grant usage on schema app_private to supabase_auth_admin;
grant select on table app_private.google_signin_allowlist to supabase_auth_admin;
grant execute on function app_private.google_signin_before_user_created(jsonb) to supabase_auth_admin;

-- Keep user_access synchronized with the private allow-list. This lets the
-- Identity Admin add/revoke an email once without exposing role-editing APIs.
create or replace function app_private.sync_google_signin_allowlist_user_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_email text;
  target_user_id uuid;
  target_role app_private.app_role;
  target_display_name text;
  target_active boolean;
begin
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.email is distinct from new.email) then
    select au.id into target_user_id
    from auth.users au
    where lower(btrim(au.email)) = old.email;
    if target_user_id is not null then
      update app_private.user_access
      set is_active = false, updated_at = clock_timestamp()
      where user_id = target_user_id;
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;

  target_email := new.email;
  target_role := new.role;
  target_display_name := new.display_name;
  target_active := new.is_active;
  select au.id into target_user_id
  from auth.users au
  where lower(btrim(au.email)) = target_email;

  if target_user_id is not null then
    insert into app_private.user_access (user_id, role, display_name, is_active)
    values (target_user_id, target_role, target_display_name, target_active)
    on conflict (user_id) do update
      set role = excluded.role,
          display_name = excluded.display_name,
          is_active = excluded.is_active,
          updated_at = clock_timestamp();
  end if;

  return new;
end
$$;
revoke all on function app_private.sync_google_signin_allowlist_user_access() from public, anon, authenticated;

create or replace function app_private.touch_google_signin_allowlist_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end
$$;
revoke all on function app_private.touch_google_signin_allowlist_updated_at() from public, anon, authenticated;

create trigger google_signin_allowlist_touch_updated_at
before update on app_private.google_signin_allowlist
for each row execute function app_private.touch_google_signin_allowlist_updated_at();

create trigger google_signin_allowlist_sync_user_access
after insert or update or delete on app_private.google_signin_allowlist
for each row execute function app_private.sync_google_signin_allowlist_user_access();

-- Provision the application role after an allowed Google identity is created.
-- The Before User Created hook rejects unlisted signups before this trigger;
-- this trigger still fails closed if the hook is not enabled in Auth settings.
create or replace function app_private.provision_google_signin_user_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate_email text := lower(btrim(coalesce(new.email, '')));
  allowlist_role app_private.app_role;
  allowlist_name text;
  allowlist_active boolean;
begin
  if lower(coalesce(new.raw_app_meta_data ->> 'provider', '')) <> 'google'
    or candidate_email = '' then
    return new;
  end if;

  select allowlist.role, allowlist.display_name, allowlist.is_active
  into allowlist_role, allowlist_name, allowlist_active
  from app_private.google_signin_allowlist allowlist
  where allowlist.email = candidate_email;

  if found and allowlist_active then
    insert into app_private.user_access (user_id, role, display_name, is_active)
    values (new.id, allowlist_role, allowlist_name, true)
    on conflict (user_id) do nothing;
  end if;

  return new;
end
$$;
revoke all on function app_private.provision_google_signin_user_access() from public, anon, authenticated;

create trigger google_signin_provision_user_access
after insert on auth.users
for each row execute function app_private.provision_google_signin_user_access();

comment on table app_private.google_signin_allowlist is
  'Exact normalized Google email allow-list; role grants are projected into user_access and never writable from the browser.';
comment on function app_private.google_signin_before_user_created(jsonb) is
  'Rejects new Auth accounts unless the verified Google email is on the active allow-list.';
