begin;
select plan(15);

insert into app_private.google_signin_allowlist (email, role, display_name, is_active)
values ('whitelist-test@example.com', 'field_technician', 'Whitelist Test', true);

select is(
  app_private.google_signin_before_user_created(
    '{"user":{"email":"whitelist-test@example.com","app_metadata":{"provider":"google"}}}'::jsonb
  ),
  '{}'::jsonb,
  'an active allow-listed Google identity passes the signup hook'
);

select is(
  app_private.google_signin_before_user_created(
    '{"user":{"email":"WHITELIST-TEST@EXAMPLE.COM","app_metadata":{"provider":"google"}}}'::jsonb
  ),
  '{}'::jsonb,
  'allow-list matching normalizes email casing'
);

select is(
  app_private.google_signin_before_user_created(
    '{"user":{"email":"not-listed@example.com","app_metadata":{"provider":"google"}}}'::jsonb
  ) #>> '{error,http_code}',
  '403',
  'a Google identity outside the allow-list is rejected'
);

select is(
  app_private.google_signin_before_user_created(
    '{"user":{"email":"whitelist-test@example.com","app_metadata":{"provider":"email"}}}'::jsonb
  ) #>> '{error,http_code}',
  '403',
  'a non-Google identity is rejected even when its email is listed'
);

insert into auth.users (id, email, raw_app_meta_data)
values (
  'fa110000-0000-4000-8000-000000000001',
  'whitelist-test@example.com',
  '{"provider":"google","providers":["google"]}'::jsonb
);

select is(
  (select ua.role::text || ':' || ua.is_active::text
   from app_private.user_access ua
   where ua.user_id = 'fa110000-0000-4000-8000-000000000001'),
  'field_technician:true',
  'an active allow-listed identity receives its configured application access'
);

select throws_ok(
  $$insert into auth.users (id, email, raw_app_meta_data)
    values ('fa110000-0000-4000-8000-000000000002', 'not-listed@example.com',
      '{"provider":"google","providers":["google"]}'::jsonb)$$,
  '42501',
  'This Google account is not on the active allow-list',
  'the database rejects new Google users outside the allow-list'
);

select throws_ok(
  $$insert into auth.users (id, email, raw_app_meta_data)
    values ('fa110000-0000-4000-8000-000000000003', 'whitelist-test@example.com',
      '{"provider":"email","providers":["email"]}'::jsonb)$$,
  '42501',
  'Only pre-approved Google accounts can access this application',
  'the database rejects non-Google account creation even for a listed email'
);

select set_config('request.jwt.claim.sub', 'fa110000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"fa110000-0000-4000-8000-000000000002","role":"authenticated"}', true);

select is(public.ais_app_context(), null::jsonb, 'a Google identity outside the allow-list receives no application context');
select throws_ok($$select public.ais_dashboard()$$, '42501', 'Application access required', 'an unlisted Google identity cannot read dashboard data');
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);

update app_private.google_signin_allowlist
set is_active = false
where email = 'whitelist-test@example.com';

select is(
  app_private.google_signin_before_user_created(
    '{"user":{"email":"whitelist-test@example.com","app_metadata":{"provider":"google"}}}'::jsonb
  ) #>> '{error,http_code}',
  '403',
  'a disabled allow-list entry is rejected'
);

select is(
  (select ua.is_active from app_private.user_access ua
   where ua.user_id = 'fa110000-0000-4000-8000-000000000001'),
  false,
  'disabling an existing allow-list entry removes its application access'
);

select ok(
  not has_table_privilege('anon', 'app_private.google_signin_allowlist', 'select')
  and not has_table_privilege('authenticated', 'app_private.google_signin_allowlist', 'select'),
  'browser roles cannot read the private allow-list'
);

select ok(
  has_table_privilege('supabase_auth_admin', 'app_private.google_signin_allowlist', 'select'),
  'the Auth hook role can read the allow-list'
);

select ok(
  not has_function_privilege('authenticated', 'app_private.google_signin_before_user_created(jsonb)', 'execute'),
  'browser users cannot invoke the Auth hook directly'
);

select ok(
  not has_function_privilege('authenticated', 'app_private.enforce_google_signin_allowlist()', 'execute'),
  'browser users cannot invoke the auth.users allow-list trigger directly'
);

select * from finish();
rollback;
