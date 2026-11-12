# AIS Branch & Asset Operations — Google Sign-In & Authentication Setup

Updated: 2026-11-12. Authoritative setup guide for Google Sign-In, Role-Based Access Control (RBAC), and Allowlist Governance on **Cloudflare Pages & D1 Native Edge**.

---

## 1. Authentication & Security Architecture

1. **Edge Middleware Verification (`web/functions/api/[[route]].ts`):**
   - Every API request passes through the Hono Authentication Middleware.
   - For Production: Accepts Cloudflare Access JWT or Google OAuth Bearer Token.
   - For Development / Staging: Supports the interactive **Dev Auth Bar** via `x-dev-user-email` header or query parameter for testing all 4 roles.
2. **Database Allowlist Table (`google_signin_allowlist` in D1):**
   - Stores exact normalized emails, display names, application roles, and active status.
   - Roles supported:
     - `admin`: SYM Operations Admin (Full system control, import, exception review, Stage 1 verification).
     - `field_technician`: Onsite Technician (Start tasks, upload 10 photos + signatures, closeout, scanner discovery).
     - `customer_reviewer`: Gable Customer Reviewer (Stage 2 batch acceptance per branch or reject with reason).
     - `viewer`: Read-only audit access (Masked serial numbers, view status and dashboard metrics).
3. **Fail-Closed Boundary:**
   - If an authenticated Google email is not found in `google_signin_allowlist` or `is_active = 0`, the Edge API strictly returns `403 Forbidden` with `"บัญชีนี้ยังไม่มีสิทธิ์เข้าใช้งาน"`.
   - No silent accounts or unverified users are permitted.

---

## 2. Managing the User Allowlist in Cloudflare D1

Administrators manage user access directly via D1 commands:

### 2.1 View Current Allowlist
```powershell
npx wrangler d1 execute ais-scanner-db --remote --command="SELECT email, role, display_name, is_active FROM google_signin_allowlist"
```

### 2.2 Add or Update User Access
```powershell
# Add an Admin
npx wrangler d1 execute ais-scanner-db --remote --command="INSERT INTO google_signin_allowlist (email, role, display_name, is_active) VALUES ('admin@sym.co.th', 'admin', 'SYM System Admin', 1) ON CONFLICT(email) DO UPDATE SET role='admin', is_active=1"

# Add an Onsite Technician
npx wrangler d1 execute ais-scanner-db --remote --command="INSERT INTO google_signin_allowlist (email, role, display_name, is_active) VALUES ('tech1@sym.co.th', 'field_technician', 'นายช่าง สยาม', 1) ON CONFLICT(email) DO UPDATE SET role='field_technician', is_active=1"

# Add a Customer Reviewer (Gable)
npx wrangler d1 execute ais-scanner-db --remote --command="INSERT INTO google_signin_allowlist (email, role, display_name, is_active) VALUES ('reviewer@gable.co.th', 'customer_reviewer', 'ผู้ตรวจรับ Gable', 1) ON CONFLICT(email) DO UPDATE SET role='customer_reviewer', is_active=1"
```

### 2.3 Revoke or Deactivate Access
```powershell
npx wrangler d1 execute ais-scanner-db --remote --command="UPDATE google_signin_allowlist SET is_active=0 WHERE email='user@sym.co.th'"
```

---

## 3. Production Google OAuth 2.0 Integration (Cloudflare Pages)

To connect Google Sign-In on live production:

### 3.1 Google Cloud Console Setup
1. Navigate to **Google Cloud Console → APIs & Services → Credentials**.
2. Create **OAuth 2.0 Client ID** of type **Web application**.
3. Add Authorized JavaScript origins:
   - `https://ais-branch-asset-operations.pages.dev`
4. Add Authorized redirect URIs:
   - `https://ais-branch-asset-operations.pages.dev/api/auth/callback`
5. Note down the Client ID. (Keep the Client Secret secure; never commit it to source control).

### 3.2 Cloudflare Pages Configuration
1. In Cloudflare Dashboard → Workers & Pages → `ais-branch-asset-operations` → Settings → Environment Variables.
2. Add `GOOGLE_CLIENT_ID` (Plain text).
3. Add `GOOGLE_CLIENT_SECRET` (Encrypted / Secret).
4. Save and redeploy.

---

## 4. Security Guardrails

- **Zero Hard-Coded Credentials:** No OAuth secrets or tokens exist in frontend code or Git history.
- **Session Isolation:** Dev Auth Switcher is active in staging/internal environments; production endpoints enforce valid signed tokens.
- **Least Privilege:** Each role can only access endpoints relevant to their duties (e.g. technicians cannot access `/api/review/customer-batch-accept` and customer reviewers cannot modify scanner registers).
