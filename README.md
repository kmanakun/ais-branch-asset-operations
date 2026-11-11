# AIS Branch & Asset Operations

A responsive web application for recording and tracking scanner replacement work across branches. The public repository contains the application, database schema changes, synthetic tests, and operating notes; it does not contain the workbook's branch/team data, production records, credentials, or database backups.

## Workflow in this version

- Admin opens a branch work order for one or more scanners already listed in the verified asset register. No duplicate confirmation, team assignment, or appointment date is required.
- Admin and onsite technicians can work on every open order. A work item represents one scanner.
- Technicians record the observed result, old/new serial numbers, device details, ten required photos for a normal replacement (four of the old Scanner and six of the new Scanner), up to two optional extra photos, and signatures from the onsite technician and Scanner user.
- If the listed scanner is missing or a different one is found, the item is sent for Admin review. The application does not silently create or move an asset. Admin review and a separate acceptance signature are required before delivery is complete.
- The work order shows status, scanner details, evidence, signatures, and the recorded work history. Branch lists can be filtered by province.

Scanner stock issuance and stock balance tracking are outside this version.

## Technology

- React, TypeScript, and Vite
- Supabase Auth and Postgres, with authorization enforced by database functions and Row Level Security
- Cloudflare Workers for static asset delivery

## Local development

Requirements: Node.js 22 or newer, npm, Docker Desktop, and the Supabase CLI for database tests.

```powershell
cd web
npm ci
Copy-Item .env.example .env.local
Copy-Item wrangler.example.jsonc wrangler.jsonc
```

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env.local` to a project you control. Use only the publishable key in the browser; never put a service-role or secret key in client configuration. The build creates a project-specific Content Security Policy in `dist/_headers` from this local URL, so the project reference does not need to be committed to source.

```powershell
npm run dev
npm run typecheck
npm run build
npm run test:all
```

`npm run test:all` starts application-flow tests and the local Supabase database tests. The local database tests require Docker Desktop to be running.

## Database and deployment

Database migrations are in `web/supabase/migrations/`; SQL tests are in `web/supabase/tests/`. The two workbook data-seed migrations are intentionally empty in this public edition. Import your own branch and asset data through the app after setting up a separate project. Test fixtures use synthetic data.

Review every migration and authorization rule before applying changes to any shared or production database. Configure your own Supabase project and review `web/wrangler.example.jsonc` before deployment. The app is served as static assets; it does not require an application Worker script. Build with `npm run build`, then deploy with `npx wrangler deploy` from `web/`.

The examples are starting points, not a production security review or a guarantee about provider pricing or free-tier limits.
