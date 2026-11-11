-- Enforce the exact Google allow-list at the auth.users boundary as a fallback
-- for projects where the Before User Created Auth hook is not configured.
create or replace function app_private.enforce_google_signin_allowlist()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate_email text := lower(btrim(coalesce(new.email, '')));
  provider_name text := lower(btrim(coalesce(new.raw_app_meta_data ->> 'provider', '')));
begin
  if provider_name is distinct from 'google' then
    raise exception using
      errcode = '42501',
      message = 'Only pre-approved Google accounts can access this application';
  end if;

  if candidate_email = '' or not exists (
    select 1
    from app_private.google_signin_allowlist allowlist
    where allowlist.email = candidate_email
      and allowlist.is_active
  ) then
    raise exception using
      errcode = '42501',
      message = 'This Google account is not on the active allow-list';
  end if;

  return new;
end
$$;
revoke all on function app_private.enforce_google_signin_allowlist() from public, anon, authenticated;

create trigger google_signin_allowlist_signup_guard
before insert on auth.users
for each row execute function app_private.enforce_google_signin_allowlist();
