# AIS Branch & Asset Operations (Scanner Replacement)

A responsive web application for recording, tracking, and auditing barcode scanner replacement across AIS branches nationwide (~1,992 devices in 580 branches). Built with high security, auditable change history, and a strict 0-baht cloud cost discipline.

---

## 1. Scanner-First Workflow (V1.2)

- **Scanner-First Navigation:** Devices are accessed directly through the hierarchy: **Province → Branch → Scanner**.
- **Global Queue:** Technicians see all open devices nationwide without team-gate restrictions, matching real-world external coordination.
- **Onsite Operations:** Technicians start work directly on the scanner record (`On Process`), record the new serial number, condition of the old unit, and capture full closeout evidence.
- **Evidence Standards:** Normal closeout requires 10 mandatory photos (4 of the old scanner and 6 of the new scanner) plus dual onsite signatures (Onsite Technician + Branch Scanner User).
- **Governance & 4-Eyes Principle:** Delivery requires independent Admin Acceptance. An Admin who performed or submitted the closeout cannot approve their own work.
- **Exception Governance:** If a scanner is missing, damaged, or has a mismatched serial, it is sent to the Admin Review Queue as `Pending (Exception)`. The application strictly prohibits silent asset mutations or unverified creation.

---

## 2. Technical Stack

- **Frontend:** React 19, TypeScript, and Vite (Mobile-First responsive down to 320px, AIS Green Design System)
- **Delivery & CDN:** Cloudflare Static Assets / Workers (with strictly scoped Content Security Policy via `_headers`)
- **Backend & Database:** Supabase PostgreSQL 15+ (Schema separation: `public` for safe views/RPCs, `app_private` for core tables, Auth Hook, and security functions; Row Level Security enforced)
- **Authentication:** Google OAuth 2.0 with a database `before_user_created` Auth Hook guarding an exact-email allowlist
- **Evidence Storage:** Supabase Private Bucket with MIME-type and content-length validation

---

## 3. Local Development

Requirements: Node.js 22 or newer, npm, Docker Desktop, and the Supabase CLI for database tests.

```powershell
cd web
npm ci
Copy-Item .env.example .env.local
Copy-Item wrangler.example.jsonc wrangler.jsonc
```

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env.local` to a Supabase project you control. Use only the publishable key in the browser; never put a service-role or secret key in client configuration.

```powershell
npm run dev        # Start local Vite development server
npm run typecheck  # TypeScript project-wide type checking
npm run build      # Build production bundle and generate CSP headers
npm run test:xlsx  # Test Excel import parser and integrity guards
npm run test:app   # Test application E2E flows
npm run test:db    # Run pgTAP database regression suite (386+ assertions)
npm run test:all   # Run all automated test suites
```

---

## 4. Documentation

- [docs/SCANNER_FIRST_PROCESS_v1.2.md](docs/SCANNER_FIRST_PROCESS_v1.2.md) — Comprehensive Scanner-First process and operational baseline
- [docs/GOOGLE_SIGN_IN_SETUP.md](docs/GOOGLE_SIGN_IN_SETUP.md) — Google OAuth and Auth Hook allowlist configuration
- [docs/data-import-readiness.md](docs/data-import-readiness.md) — Excel register analysis and atomic import engine
- [docs/security-review.md](docs/security-review.md) — Production security review, RLS, and RPC authorization
- [docs/recovery-runbook.md](docs/recovery-runbook.md) — Zero-baht 7-Zip AES-256 encrypted backup procedure and restore drills
- [GEMINI.md](GEMINI.md) — Project engineering principles, security rules, and architecture baseline
