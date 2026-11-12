# AIS Branch & Asset Operations (Scanner Replacement)

A modern, high-performance Edge Native web application for recording, tracking, and auditing barcode scanner replacement across AIS branches nationwide (~1,992 devices in 580 branches). Built with high security, auditable change history, mobile-first responsiveness, and a strict **0-baht cloud cost discipline** (Cloudflare Free Tier).

- **Production URL:** [https://ais-branch-asset-operations.pages.dev](https://ais-branch-asset-operations.pages.dev)
- **Baseline Version:** V1.2 Scanner-First

---

## 1. Scanner-First Workflow (V1.2)

- **Scanner-First Navigation:** Devices are accessed directly through the operational hierarchy: **Province → Branch → Scanner** (`จังหวัด → สาขา → เครื่องสแกน`).
- **National Visibility:** Technicians view all open devices nationwide without team-gate restrictions, matching real-world external coordination.
- **Onsite Operations:** Technicians start work directly on the scanner record (`On Process`), record the new serial number, assess the condition of the old unit, and capture full closeout evidence.
- **Evidence Standards:** Normal closeout requires **10 mandatory photos** (4 of the old scanner, 6 of the new scanner) plus **dual onsite signatures** (Onsite Technician + AIS Branch Scanner User).
- **Two-Stage Governance (4-Eyes Principle):**
  - **Stage 1 (SYM Admin):** Reviews all submitted closeout photos and signatures (`/api/review/sym-verify`).
  - **Stage 2 (Gable Customer):** Conducts batch acceptance per branch or rejects with reasons (`/api/review/customer-batch-accept`).
  - *Self-approval guard:* Technicians who submit closeout evidence cannot sign as Admin to approve their own work.
- **Exception Governance:** Missing units or mismatched serial numbers trigger `Pending (Exception)`. The system strictly prohibits silent asset mutations or unverified creation.
- **Scanner Discovery:** Technicians can report uncataloged barcode scanners found onsite (`/api/discovery`), entering an Admin review queue before inclusion in the official register.

---

## 2. Technical Stack (100% Cloudflare Native Edge)

- **Frontend:** React 19, TypeScript, and Vite (Mobile-First responsive down to 320px, AIS Green Design System)
- **API Runtime:** Hono on Cloudflare Pages Functions (`web/functions/api/[[route]].ts`)
- **Database:** Cloudflare D1 Distributed SQLite Engine (`ais-scanner-db`)
- **Storage:** Cloudflare R2 (`ais-scanner-evidence`) with automatic base64 fallback
- **Delivery & Security:** Cloudflare Pages with strict Content Security Policy (`dist/_headers` enforcing `connect-src 'self'`)
- **Authentication:** Role-Based Access Control (RBAC) backed by `google_signin_allowlist` table in D1

---

## 3. Local Development & Verification

### Prerequisites
- Node.js 22 or newer
- npm
- Cloudflare Wrangler CLI (`npm i -g wrangler`)

### Getting Started
```powershell
cd web
npm install
npm run dev        # Start local Vite development server
```

### Verification Suite
```powershell
cd web
npm run typecheck  # TypeScript project-wide strict type checking
npm run build      # Build production bundle and generate CSP headers
npm run test:xlsx  # Test Excel import parser and integrity guards
npm run test:d1    # Test D1 schema, tables, and API routes
npm run test:e2e   # Run 10/10 live End-to-End integration tests on production Edge
npm run test:all   # Run all automated test suites
npm run deploy     # Deploy directly to Cloudflare Pages production
```

---

## 4. Documentation & Operations

- [docs/SCANNER_FIRST_PROCESS_v1.2.md](docs/SCANNER_FIRST_PROCESS_v1.2.md) — Production specification for the Scanner-First process
- [docs/v1-release-acceptance.md](docs/v1-release-acceptance.md) — Production Release Acceptance and live test verification
- [docs/security-review.md](docs/security-review.md) — Edge security architecture, CSP, RBAC, and input sanitization
- [docs/GOOGLE_SIGN_IN_SETUP.md](docs/GOOGLE_SIGN_IN_SETUP.md) — Google Sign-In setup and D1 allowlist management
- [docs/recovery-runbook.md](docs/recovery-runbook.md) — D1 Time Travel, 7-Zip AES-256 encrypted backups, and disaster recovery
- [GEMINI.md](GEMINI.md) — Engineering partner principles, security rules, and architectural baseline
