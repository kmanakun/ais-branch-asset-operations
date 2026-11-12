# AIS Branch & Asset Operations (Frontend & Edge API)

This directory contains the web frontend and Cloudflare Pages Functions for the AIS Scanner Replacement system.

## Stack Overview

- **Frontend:** React 19, TypeScript, Material UI, Lucide Icons, Vite
- **API Runtime:** Hono running on Cloudflare Pages Functions (`functions/api/[[route]].ts`)
- **Database:** Cloudflare D1 (`ais-scanner-db`)
- **Object Storage:** Cloudflare R2 (`ais-scanner-evidence`)
- **Cost Discipline:** 0-Baht (Cloudflare Free Tier)

## Available Scripts

- `npm run dev`: Launch local Vite dev server.
- `npm run dev:d1`: Launch local Cloudflare Pages dev server with local D1 emulation.
- `npm run typecheck`: Run project-wide TypeScript check without emitting JS.
- `npm run build`: Compile frontend assets, verify CSP headers, and clean stale assets.
- `npm run test:xlsx`: Run Excel parser and workbook security unit tests.
- `npm run test:d1`: Run D1 schema and edge endpoint unit tests.
- `npm run test:e2e`: Run 10-stage End-to-End integration test suite against live production Edge.
- `npm run test:all`: Run all test suites in sequence.
- `npm run deploy`: Deploy build artifacts directly to Cloudflare Pages (`ais-branch-asset-operations`).

## Edge Architecture Details

- All API routes are prefixed under `/api`.
- CORS and Content Security Policy are strictly limited to `'self'`.
- Authentication passes through `google_signin_allowlist` in D1 with 4 distinct roles (`admin`, `field_technician`, `customer_reviewer`, `viewer`).
