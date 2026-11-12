# AIS Branch & Asset Operations

Responsive V1 pilot for coordinating Scanner replacement work across branches.
This repository edition contains application code, schema migrations, synthetic
tests, and setup notes. It does not include production records, credentials, or
database backups.

## Stack

- React, TypeScript, and Vite
- Supabase Auth and Postgres, with role checks enforced by database functions
  and Row Level Security
- Cloudflare Workers Static Assets for hosting

## Local setup

Requirements: Node.js 22 or newer, npm, Docker Desktop, and the Supabase CLI for
database tests.

1. Copy `.env.example` to `.env.local`.
2. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` for a Supabase
   project you control. Keep service-role keys and other secrets out of the
   browser configuration.
3. Copy `wrangler.example.jsonc` to `wrangler.jsonc`.
4. Run `npm ci` and `npm run dev`.

## Google Sign-In

The application login uses Supabase OAuth with Google. A user must have an
active exact-email entry in `app_private.google_signin_allowlist`; the mapped
role is synchronized to the private `user_access` table, where database RPC/RLS
remain the authorization boundary. There is no password field in the app login.

Hosted setup, OAuth callback URLs, the Auth Hook, and the safe transition from
existing password users are documented in
[`../docs/GOOGLE_SIGN_IN_SETUP.md`](../docs/GOOGLE_SIGN_IN_SETUP.md). Do not
disable the hosted email provider until Google OAuth and an existing user have
passed the pilot verification steps in that guide. The local Supabase
configuration intentionally keeps email/password enabled for synthetic
`test:app` fixtures and keeps Google OAuth/Auth Hook disabled until credentials
and provider setup are available.

`npm run build` type-checks and builds the app. It derives the exact Supabase
HTTPS and WebSocket origins for the Content Security Policy in `dist/_headers`
from `.env.local`; the production project reference is not stored in the source
template. The deployment serves static assets and does not run app requests
through a Worker script.

## Checks

```powershell
npm run typecheck
npm run build
npm run test:all
```

The database tests use a local Supabase stack and require Docker Desktop. Stop the
local stack after testing to preserve system resources.

## Database and deployment

Review every migration and authorization rule before applying changes to any
shared database. To use your own Supabase project, import your own branch and
asset data after setting up a separate project. Test fixtures use synthetic
records.

Build the site, then run `npx wrangler deploy` from this directory. Cloudflare
account plan and usage limits are separate from this example; check the current
provider billing page before operating a deployment.
