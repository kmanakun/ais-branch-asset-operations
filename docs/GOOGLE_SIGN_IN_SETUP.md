# Google Sign-In setup

Status: application code and local migration prepared; hosted OAuth is not yet
configured or deployed. This guide is for Identity Admin and the project owner.

## Sign-in and authorization

1. A user selects **เข้าสู่ระบบด้วย Google**. Supabase Auth completes the Google
   OAuth flow and returns the user session to the app.
2. New Auth users are checked by the `Before User Created` hook against the
   exact, normalized email in `app_private.google_signin_allowlist`.
3. A database trigger maps an allowed Google user to the application role in
   `app_private.user_access`. The app loads that context before showing data.
4. RPC role checks and RLS remain the data security boundary. A valid Google
   session without an active app role cannot read or change operational data.

The hook handles new account creation. If an Auth account already exists but is
not allowlisted, it may still complete Google authentication; it has no active
application role and therefore receives no app data. Deactivating an allowlist
entry also deactivates the linked `user_access` row.

## Hosted provider setup

Do these steps in the Supabase and Google Cloud dashboards for the intended
project. OAuth client secrets belong only in the Supabase provider settings;
never place them in frontend environment variables, source files, or chat.

1. Apply the reviewed migration
   `20261111024156_google_sign_in_allowlist.sql` to the intended Supabase
   project. Do not apply it to Production until the project owner explicitly
   approves that migration.
2. In Google Cloud Console, create an OAuth client of type **Web application**.
   Add the deployed app origin as an authorized JavaScript origin. Add this
   Supabase callback as an authorized redirect URI:

   ```text
   https://<PROJECT_REF>.supabase.co/auth/v1/callback
   ```

3. In Supabase **Authentication → Sign In / Providers → Google**, enable Google
   and enter the OAuth client ID and secret from Google Cloud.
4. In Supabase **Authentication → URL Configuration**, set the Site URL to the
   deployed app origin and allow the exact app redirect URL used by the frontend.
   The current app returns to `window.location.origin` after OAuth.
5. In Supabase **Authentication → Hooks**, configure **Before User Created** to
   call the Postgres function
   `app_private.google_signin_before_user_created(jsonb)`. The migration grants
   `supabase_auth_admin` only the schema/function/table permissions and RLS read
   policy needed by that hook.
6. Add the first Admin email to the allowlist before that person’s first Google
   sign-in. Test with one Admin and one Technician account before wider use.
7. Only after successful Google sign-in and role verification, disable the
   hosted Email provider if password login is to be fully retired. The local
   config deliberately leaves it enabled for synthetic test fixtures.

## Allowlist administration

Use Supabase SQL Editor with an Identity Admin account. Replace the sample
values; never grant browser roles direct access to this table.

Add or restore an account:

```sql
insert into app_private.google_signin_allowlist (email, role, display_name)
values ('person@example.com', 'field_technician', 'Technician Name')
on conflict (email) do update
set role = excluded.role,
    display_name = excluded.display_name,
    is_active = true;
```

Supported roles are `admin` and `field_technician`. Disable access while keeping
the record for traceability:

```sql
update app_private.google_signin_allowlist
set is_active = false
where email = lower(btrim('person@example.com'));
```

The table is in the unexposed `app_private` schema, has RLS enabled, and grants
no access to `anon` or `authenticated`. The Auth Hook can only read it. Role
changes are projected to the protected `user_access` table by a database
trigger.

## Existing password accounts

The migration seeds the allowlist from current `user_access` rows and their
Auth email addresses, preserving current application roles. Existing people
should use the same Google account/email already associated with their
application access. Pilot the sign-in and confirm the resulting Auth user still
gets the expected role before disabling password login; do not manually delete
or recreate existing Auth users as part of this change.

## Local development

`web/supabase/config.toml` keeps Google OAuth and the signup hook disabled until
credentials and provider configuration are available. Email/password remains
enabled only for synthetic `test:app` fixtures. For local Google OAuth, set
`SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and
`SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` in the local process environment, enable
the provider, and enable the hook after the local DB has the migration applied.
Do not use `VITE_` variables for OAuth secrets.

## Reference docs

- [Supabase Google sign-in](https://supabase.com/docs/guides/auth/social-sign-in/auth-google)
- [Supabase Before User Created hook](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook)
- [Supabase Auth Hooks security and configuration](https://supabase.com/docs/guides/auth/auth-hooks)
- [Supabase redirect URL configuration](https://supabase.com/docs/guides/auth/redirect-urls)
