# AIS Branch & Asset Operations

A responsive web application for coordinating scanner replacement work across
branches. The application includes an asset register, replacement rounds,
scheduling, technician work orders, evidence capture, and office acceptance.

## Technology

- React, TypeScript, and Vite
- Supabase Auth and Postgres, with authorization enforced by database RPCs and
  Row Level Security
- Cloudflare Workers static asset delivery

This repository contains application code, database migrations, and synthetic
tests only. It does not include production records, credentials, or database
backup archives. Configure your own Supabase and Cloudflare projects before
connecting or deploying it.

## Local development

Requirements: Node.js 22 or newer, npm, and Docker Desktop for local database
tests.

```powershell
cd web
npm ci
Copy-Item .env.example .env.local
Copy-Item wrangler.example.jsonc wrangler.jsonc
```

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env.local` to
your own Supabase project. Set the same project's URL as `SUPABASE_URL` in
`wrangler.jsonc`. Use a publishable key only; never place a service-role or
secret key in browser configuration.

Start the app with `npm run dev`. Build it with `npm run build`.

## Database and tests

Ordered schema changes are in `web/supabase/migrations/`; database tests are in
`web/supabase/tests/`. Use a separate local Supabase instance for development:

```powershell
npx supabase start
npm run test:all
npx supabase stop
```

Do not run development migrations against a production project. Review database
changes and authorization rules before deploying them.

## Deployment

The app can be deployed to Cloudflare Workers after configuring your own
Cloudflare account and Supabase environment. The committed configuration is a
starting point; review resource names, environment variables, security headers,
and migrations for your environment before deployment.

