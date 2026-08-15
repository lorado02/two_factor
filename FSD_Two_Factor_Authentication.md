# Functional Specification Document
## Two-Factor Authentication (2FA) — Axis Bank Retail Digital Banking

---

## 1. Document Control

| Field            | Value                                                                                     |
|------------------|-------------------------------------------------------------------------------------------|
| Document ID      | FSD-001                                                                                   |
| Version          | 1.0 — Draft                                                                               |
| Date             | 2025-07-15                                                                                |
| Status           | Draft                                                                                     |
| Author           | <!-- TODO: Insert Business Analyst / Solution Architect name -->                          |
| Source BRD       | BRD-001 v1.0 — Two-Factor Authentication, Axis Bank Retail Digital Banking                |
| Regulatory Scope | RBI Master Directions on Digital Payment Security; PCI-DSS v4 Req. 8; ISO 27001 A.9; IT Act 2000 |

---

## 2. Purpose and Scope

### 2.1 Purpose
This document specifies, at an implementation-ready level of detail, all functional and non-functional behaviour required to deliver mandatory two-factor authentication (2FA) across the Axis Bank retail digital banking web application. It is the authoritative design reference for the engineering, QA, and compliance teams during build and UAT.

### 2.2 In Scope

| Area | Detail |
|---|---|
| Login channel | Internet-banking web application (React/Vite frontend + Node.js/Express backend) |
| Login 2FA | Second-factor enforcement after successful password check on `POST /api/auth/login` |
| Transaction 2FA | Second-factor gate on `POST /api/transfer` before fund transfer is committed |
| 2FA enrolment | Self-service TOTP setup, QR code rendering, verification, and activation within the authenticated dashboard |
| Fallback channel | SMS OTP as fallback when TOTP is unavailable |
| Backup codes | Generation, storage, and single-use consumption of 8 alphanumeric recovery codes |
| Account lockout | Soft-lock after 5 consecutive failed 2FA attempts; email notification; Ops unlock |
| Ops / Admin tooling | Internal admin endpoint to bypass or reset a customer's 2FA with full audit trail |
| Audit logging | Structured `audit_log` table for all 2FA lifecycle events |
| Email notifications | Security event emails for enrolment, disable, lockout, and bypass |
| Backend files | `backend/src/routes/auth.js`, `backend/src/routes/transfer.js`, `backend/src/middleware/auth.js`, `backend/src/db.js` |
| Frontend files | `frontend/src/AuthForm.jsx`, `frontend/src/Dashboard.jsx`, `frontend/src/api.js` |

### 2.3 Out of Scope

- Biometric authentication (fingerprint / face ID) — deferred to future phase.
- Hardware security keys (FIDO2 / WebAuthn) — deferred to future phase.
- Mandatory 2FA enrolment at account registration (`POST /api/auth/register`) — deferred to v2.
- Third-party identity provider (IdP) / SSO integration.
- Native iOS or Android app changes.
- Push notification delivery channel for OTP.

---

## 3. Background and Business Context

The current `POST /api/auth/login` implementation in [`backend/src/routes/auth.js`](backend/src/routes/auth.js) performs email + password verification and immediately issues a full-session JWT regardless of the `twofa_enabled` column value. The code comment at line 71 explicitly notes:

> *"Not implemented yet — falls through to normal login for now."*

The [`backend/src/db.js`](backend/src/db.js) schema confirms that the `users` table already carries `twofa_enabled INTEGER NOT NULL DEFAULT 0` and `twofa_secret TEXT` columns, reserved and unused. Similarly, [`backend/src/routes/transfer.js`](backend/src/routes/transfer.js) contains a comment at line 28 identifying the transfer route as the natural second-factor checkpoint, which is also unimplemented.

**Business drivers (BR-001–BR-014):**
- Q2 recorded 214 credential-stuffing-linked unauthorised access attempts; ₹1.4 Cr in disputed transactions; 46 contact-centre minutes per fraud case on average.
- An open finding from the March internal audit requires a second factor on digital channels before the remediation deadline.
- Three enterprise-adjacent partnerships have flagged 2FA compliance as a contractual gate for onboarding.

**Success criteria:** Audit finding closed; account-takeover cases reduced by ≥ 80 %; partnership onboarding gates cleared.

---

## 4. Actors and User Roles

| Actor | Description | System Interaction |
|---|---|---|
| **Retail User (Enrolled)** | Retail internet-banking customer with `twofa_enabled = 1` | Completes 2FA at login and at transfer; manages 2FA settings in dashboard |
| **Retail User (Not Enrolled)** | Retail customer with `twofa_enabled = 0` | Logs in with password only (backward-compatible during rollout); invited to enrol from dashboard |
| **Fraud Ops / Contact Centre Agent** | Internal staff with admin-role JWT claim | Resets or bypasses a customer's 2FA via admin endpoint following identity verification |
| **System (TOTP Verifier)** | Backend TOTP verification service | Validates TOTP codes against stored secrets using RFC 6238 |
| **System (SMS Gateway)** | Third-party SMS provider (e.g. Twilio / Kaleyra) | Delivers SMS OTP to customer's registered mobile number |
| **System (Email Service)** | Transactional email service | Sends security event notifications and lockout alerts |

---

## 5. Use Cases / User Stories

### UC-001 — Login with 2FA (TOTP)
**Actor:** Retail User (Enrolled)  
**Preconditions:** User has `twofa_enabled = 1` and a valid `twofa_secret` stored. Account is not soft-locked.  
**Trigger:** User submits credentials on the login screen.

**Main Flow:**
1. User enters email and password on [`frontend/src/AuthForm.jsx`](frontend/src/AuthForm.jsx) and submits.
2. Frontend calls `POST /api/auth/login` with `{ email, password }`.
3. Backend validates password against `password_hash`; on success, detects `twofa_enabled = 1`.
4. Backend issues a **pending JWT** (`scope: "2fa_pending"`, expiry 5 min) and returns `{ status: "2fa_required", pendingToken }`.
5. Frontend renders the OTP entry step (Step 2 of `AuthForm`).
6. User opens authenticator app, reads current TOTP code, enters it.
7. Frontend calls `POST /api/auth/verify-2fa` with `{ pendingToken, code }`.
8. Backend verifies TOTP code (RFC 6238, ±1 time-step tolerance) and checks the pending token scope.
9. On success: backend writes a `verify_success` entry to `audit_log` and returns `{ token }` (full session JWT, 2-hour expiry).
10. Frontend stores the full session JWT in `localStorage`; [`frontend/src/App.jsx`](frontend/src/App.jsx) transitions to `Dashboard`.

**Alternate Flow A — SMS OTP Fallback:**
1a. After step 5, user selects "Use SMS code instead".  
2a. Frontend calls `POST /api/auth/request-sms-otp` with `{ pendingToken }`.  
3a. Backend generates a 6-digit OTP, stores a hash with a 5-minute TTL, and dispatches via SMS gateway.  
4a. User enters the SMS OTP; flow rejoins main flow at step 7 with `code` = SMS OTP.

**Alternate Flow B — Backup Code:**
1b. User selects "Use a backup code".  
2b. User enters one of their 8-character backup codes.  
3b. Backend looks up the hash in `backup_codes`, verifies, marks the code as consumed (soft-delete with timestamp).  
4b. Flow rejoins main flow at step 9.

**Exception E1 — Wrong TOTP Code:**
- Backend returns HTTP 401 `{ error: "Invalid or expired code" }`.
- Backend increments failed attempt counter. If counter reaches 5 within 15-minute window: soft-lock account, send lockout email (UC-006).
- Frontend displays inline error; OTP field is cleared; user may retry.

**Exception E2 — Expired Pending Token:**
- Backend returns HTTP 401 `{ error: "Session expired. Please log in again." }`.
- Frontend redirects to Step 1 (email/password entry).

**Exception E3 — Account Soft-Locked:**
- Backend returns HTTP 403 `{ error: "Account locked. Check your email for unlock instructions." }`.
- Frontend displays locked-account message.

---

### UC-002 — Login without 2FA (Enrolled user; backward-compatible rollout)
**Actor:** Retail User (Not Enrolled, `twofa_enabled = 0`)  
**Preconditions:** `twofa_enabled = 0`.

**Main Flow:**
1. User submits credentials.
2. `POST /api/auth/login` validates password; `twofa_enabled = 0`.
3. Backend issues full session JWT immediately (existing behaviour preserved).
4. Dashboard is shown with a non-blocking banner inviting 2FA enrolment (FR-008).

---

### UC-003 — Fund Transfer with Transaction-Level 2FA
**Actor:** Retail User (Enrolled)  
**Preconditions:** User is authenticated with a full session JWT. `twofa_enabled = 1`.

**Main Flow:**
1. User fills in "To account number" and "Amount" in the Send Money form in [`frontend/src/Dashboard.jsx`](frontend/src/Dashboard.jsx).
2. Dashboard renders an additional "Authentication code" field before the Transfer button is enabled.
3. User enters current TOTP code.
4. Frontend calls `POST /api/transfer` with `{ toAccountNumber, amountCents, twoFaCode }` (or includes `X-2FA-Code` header).
5. Backend middleware verifies `twoFaCode` against the user's `twofa_secret` before executing the transfer.
6. On success: transfer committed; `audit_log` entry written (`transfer_2fa_verified`); updated balance returned.

**Exception — Missing or Invalid Code:**
- Backend returns HTTP 403 `{ error: "Valid 2FA code required for transfers" }`.
- Transfer is not executed. Attempt counter is incremented.

---

### UC-004 — Self-Service TOTP Enrolment
**Actor:** Retail User (Not Enrolled, authenticated)  
**Preconditions:** User holds a full session JWT; `twofa_enabled = 0`.

**Main Flow:**
1. User navigates to "Security Settings" in Dashboard.
2. User clicks "Set up two-factor authentication".
3. Frontend calls `POST /api/auth/2fa/setup` (authenticated).
4. Backend generates a TOTP secret, stores it temporarily (un-activated) under `twofa_secret`, returns `{ otpauthUri, qrCodeSvg }`.
5. Frontend renders QR code (using `qrcode` library) with manual entry fallback.
6. User scans QR with authenticator app (e.g. Google Authenticator, Authy).
7. User enters first TOTP code from app into the verification field.
8. Frontend calls `POST /api/auth/2fa/enable` with `{ code }`.
9. Backend verifies TOTP code; on success: sets `twofa_enabled = 1`; generates 8 backup codes, bcrypt-hashes each, stores in `backup_codes` table; writes `enrol` event to `audit_log`; sends confirmation email.
10. Frontend displays backup codes page (one-time reveal; user must acknowledge).
11. User copies / downloads backup codes; acknowledges.

**Exception — Invalid Verification Code at Enrolment:**
- Backend returns HTTP 400 `{ error: "Incorrect code. Please ensure your authenticator app is synced." }`.
- `twofa_enabled` remains 0; `twofa_secret` is cleared. User may restart.

---

### UC-005 — Disable 2FA
**Actor:** Retail User (Enrolled, authenticated)  
**Preconditions:** `twofa_enabled = 1`.

**Main Flow:**
1. User navigates to "Security Settings"; clicks "Disable two-factor authentication".
2. Frontend renders confirmation form requiring current password and current TOTP code.
3. Frontend calls `POST /api/auth/2fa/disable` with `{ password, code }`.
4. Backend re-validates password hash and verifies TOTP code.
5. On success: sets `twofa_enabled = 0`, clears `twofa_secret`; soft-deletes all backup codes; writes `disable` event to `audit_log`; sends security notification email.
6. Frontend shows confirmation; settings page updates to "Not enrolled" state.

**Exception — Wrong Password or Code:**
- HTTP 401 returned; 2FA remains active; attempt logged.

---

### UC-006 — Account Lockout and Recovery
**Actor:** Retail User; System  
**Preconditions:** User has accumulated 5 consecutive failed 2FA verification attempts within a 15-minute window.

**Main Flow:**
1. On the 5th failure, backend sets `account_locked = 1` (or equivalent status field) on the user record; writes `lockout` event to `audit_log`.
2. System sends lockout email to registered address within 60 seconds containing a time-limited unlock link.
3. User clicks unlock link; backend validates token, clears lock, resets attempt counter; writes `unlock` event to `audit_log`.
4. User may log in again.

**Alternate Flow — Ops Unlock (UC-007):** Fraud Ops / CC agent unlocks via admin endpoint (see UC-007).

---

### UC-007 — Ops / Admin 2FA Reset
**Actor:** Fraud Ops / Contact Centre Agent  
**Preconditions:** Agent holds a valid admin-role JWT. Customer identity has been verified offline.

**Main Flow:**
1. Agent calls `POST /api/admin/2fa/reset/:userId` with admin JWT in `Authorization` header.
2. Backend verifies admin-role JWT claim.
3. Backend clears `twofa_enabled`, `twofa_secret`; clears backup codes; clears lockout; writes `admin_bypass` event to `audit_log` with `actor_id` = operator's user ID, `ip_address`, and `user_agent`.
4. Security notification email sent to the customer.
5. Agent records the bypass in the case management system (outside this system's scope).

**Exception — Insufficient Role:**
- HTTP 403 returned. Event is logged as an unauthorised admin attempt.

---

### UC-008 — View and Regenerate Backup Codes
**Actor:** Retail User (Enrolled, authenticated)  
**Preconditions:** `twofa_enabled = 1`; session JWT valid.

**Main Flow:**
1. User navigates to "Security Settings" → "Backup codes".
2. Frontend calls `GET /api/auth/2fa/backup-codes` to retrieve consumed/available count.
3. User clicks "Regenerate backup codes".
4. Frontend calls `POST /api/auth/2fa/backup-codes/regenerate` with current TOTP code.
5. Backend verifies code; soft-deletes old codes; generates 8 new codes; stores hashes; writes `backup_codes_regenerated` to `audit_log`.
6. Frontend displays new codes (one-time reveal).

---

## 6. Functional Requirements

| ID | Requirement | Priority | Linked BR |
|---|---|---|---|
| FR-001 | On `POST /api/auth/login`, after a successful password check, if the user's `twofa_enabled = 1`, the system shall issue a short-lived pending JWT (`scope: "2fa_pending"`, expiry ≤ 5 min) and return `{ status: "2fa_required", pendingToken }` instead of a full session JWT. | Must | BR-001 |
| FR-002 | A pending JWT with `scope: "2fa_pending"` shall be accepted **only** by `POST /api/auth/verify-2fa` and `POST /api/auth/request-sms-otp`. All other authenticated endpoints must reject it with HTTP 401. | Must | BR-001 |
| FR-003 | The new endpoint `POST /api/auth/verify-2fa` shall accept `{ pendingToken, code }`, verify the TOTP code against the user's stored secret (RFC 6238, ±1 time-step), and on success return a full session JWT (`expiresIn: "2h"`, matching existing token model in [`backend/src/middleware/auth.js`](backend/src/middleware/auth.js)). | Must | BR-001, BR-002 |
| FR-004 | The system shall support SMS OTP as a fallback second factor. Endpoint `POST /api/auth/request-sms-otp` shall accept a valid pending token, generate a 6-digit OTP, hash and store it with a 5-minute TTL, and deliver it to the user's registered mobile number via the configured SMS gateway. | Must | BR-003 |
| FR-005 | `POST /api/auth/verify-2fa` shall also accept a valid SMS OTP (matched against the stored hash within TTL) in the `code` field; it shall accept a valid backup code (matched against un-consumed hashes in `backup_codes`); in each case a full session JWT is returned on success. | Must | BR-003, BR-006 |
| FR-006 | `POST /api/transfer` (in [`backend/src/routes/transfer.js`](backend/src/routes/transfer.js)) shall require a valid second-factor code on every request for users with `twofa_enabled = 1`, regardless of transfer amount. The code may be supplied as a `twoFaCode` field in the request body or as an `X-2FA-Code` header. The transfer is only committed after the code is verified. | Must | BR-004 |
| FR-007 | The new endpoint `POST /api/auth/2fa/setup` (authenticated, full session JWT required) shall generate a TOTP secret, temporarily store it against the user record, and return `{ otpauthUri, qrCodeDataUrl }` for QR rendering. No `twofa_enabled` change occurs at this step. | Must | BR-005 |
| FR-008 | The new endpoint `POST /api/auth/2fa/enable` shall accept `{ code }` (authenticated), verify the code against the pending TOTP secret, and on success set `twofa_enabled = 1` and `twofa_secret` in the `users` table, generate 8 backup codes (8 characters each, alphanumeric), store bcrypt hashes in `backup_codes`, and return the plaintext codes one time for the user to record. | Must | BR-005, BR-006 |
| FR-009 | The new endpoint `POST /api/auth/2fa/disable` (authenticated) shall accept `{ password, code }`, re-validate the user's password hash and TOTP code, and on success set `twofa_enabled = 0`, clear `twofa_secret`, and soft-delete all active backup codes. | Must | BR-007 |
| FR-010 | The system shall maintain a failed-attempt counter per user. After 5 consecutive failed second-factor verification attempts within a rolling 15-minute window, the system shall: (a) soft-lock the account, (b) write a `lockout` event to `audit_log`, and (c) send a lockout notification email within 60 seconds. | Must | BR-008 |
| FR-011 | The system shall provide a time-limited email-based unlock link that, when followed by the user, clears the soft-lock and resets the attempt counter. | Must | BR-008 |
| FR-012 | The internal-only endpoint `POST /api/admin/2fa/reset/:userId` shall be protected by an admin-role JWT claim. On success it shall clear `twofa_enabled`, `twofa_secret`, all backup codes, and any soft-lock, and write an `admin_bypass` event to `audit_log` recording `actor_id`, `ip_address`, and `user_agent`. | Must | BR-009 |
| FR-013 | Every 2FA lifecycle event (enrol, verify_success, verify_fail, sms_otp_sent, backup_code_used, disable, lockout, unlock, admin_bypass, backup_codes_regenerated, transfer_2fa_verified, transfer_2fa_failed) shall be written to a new `audit_log` table with: `event_type`, `user_id`, `actor_id` (NULL for self-service), `ip_address`, `user_agent`, `created_at`. | Must | BR-010 |
| FR-014 | Users with `twofa_enabled = 0` shall continue to receive a full session JWT immediately on valid password authentication (backward-compatible; no regression). | Must | BR-001 (rollout compatibility) |
| FR-015 | The frontend `AuthForm.jsx` shall add a second step/screen: after the API returns `{ status: "2fa_required", pendingToken }`, a new OTP entry form is rendered with: a 6-digit (or 6–8 character backup code) input, a "Use SMS code instead" link, a "Use a backup code" link, and a submit button. | Must | BR-001, BR-002 |
| FR-016 | The frontend `Dashboard.jsx` transfer form shall add an "Authentication code" input field rendered only when the authenticated user has `twofa_enabled = 1`. The `api.transfer()` call in [`frontend/src/api.js`](frontend/src/api.js) shall be extended to accept and forward the `twoFaCode` parameter. | Must | BR-004 |
| FR-017 | The Dashboard settings section shall display: (a) current 2FA enrolment status, (b) a QR code + manual key for enrolment (when not enrolled), (c) backup codes count and regenerate option (when enrolled), (d) a disable toggle (when enrolled). | Must | BR-005 |
| FR-018 | The system shall send a transactional email to the user's registered address when any of the following events occur: 2FA enabled, 2FA disabled, account locked, admin bypass performed on their account. | Should | BR-014 |
| FR-019 | The system shall expose a configurable threshold `TRANSFER_2FA_THRESHOLD_CENTS` (environment variable; default: `0`, meaning all transfers require 2FA). When set above zero, `POST /api/transfer` enforces 2FA only for requests where `amountCents` ≥ threshold. | Could | BR-013 |
| FR-020 | The OTP entry form in `AuthForm.jsx` and the enrolment UI in `Dashboard.jsx` shall be operable via keyboard-only navigation and shall meet WCAG 2.1 AA requirements including correct ARIA labels and focus management. | Should | BR-012 |

---

## 7. Non-Functional Requirements

| ID | Category | Requirement | Priority | Linked BR |
|---|---|---|---|---|
| NFR-001 | Security | TOTP secrets shall be encrypted at rest using AES-256. The encryption key shall be managed via an environment variable or a KMS (see OI-008). | Must | BR-002 |
| NFR-002 | Security | All OTP and token exchanges shall occur exclusively over TLS 1.2 or higher. | Must | RBI |
| NFR-003 | Security | Pending JWT tokens with `scope: "2fa_pending"` shall be scoped at signing time and validated at every protected route to prevent scope escalation. | Must | BR-001 |
| NFR-004 | Security | SMS OTP codes shall be 6 digits, valid for ≤ 5 minutes, single-use (invalidated immediately upon successful or failed verification of the same session). | Must | RBI |
| NFR-005 | Security | Backup codes shall be stored as bcrypt hashes (cost factor ≥ 10); plaintext codes shall never be stored or logged. | Must | BR-006 |
| NFR-006 | Security | Admin bypass endpoint (`POST /api/admin/2fa/reset/:userId`) shall be excluded from the public API gateway and accessible only from internal network ranges. | Must | BR-009 |
| NFR-007 | Performance | `POST /api/auth/verify-2fa` response time ≤ 500 ms at P95 under 100 concurrent requests in the test environment. | Must | BR-001, BR-011 |
| NFR-008 | Performance | SMS OTP delivery time ≤ 10 seconds at P95 (gateway SLA). | Should | BR-003 |
| NFR-009 | Performance | End-to-end login flow (including OTP delivery and entry) ≤ 30 seconds elapsed for 95 % of users. | Should | BR-011 |
| NFR-010 | Availability | TOTP verification service availability ≥ 99.9 % uptime. | Must | BR-001 |
| NFR-011 | Availability | SMS gateway SLA ≥ 99.5 % uptime. | Should | BR-003 |
| NFR-012 | Compliance | All 2FA controls shall comply with RBI Master Directions on Digital Payment Security Controls (current version). | Must | BR-001 |
| NFR-013 | Compliance | Implementation shall satisfy PCI-DSS v4 Requirement 8 (Identity & Access Management). | Must | PCI-DSS v4 |
| NFR-014 | Compliance | Implementation shall satisfy ISO 27001 Annex A.9 (Access Control). | Must | ISO 27001 |
| NFR-015 | Data Retention | Audit log records in `audit_log` table shall be retained for a minimum of 5 years per RBI mandate. Deletion shall be restricted to automated archival processes. | Must | BR-010, IT Act 2000 |
| NFR-016 | Accessibility | OTP entry screen and enrolment UI shall pass WCAG 2.1 AA automated scan (axe / Lighthouse) with zero critical violations. | Should | BR-012 |
| NFR-017 | Scalability | The failed-attempt counter implementation shall support horizontal scaling (Redis-backed counter recommended for production; in-memory acceptable in development with `better-sqlite3`). | Should | BR-008 |
| NFR-018 | Backward Compatibility | No existing API contracts (`/register`, `/login` for non-2FA users, `/accounts/me`, `/accounts/transactions`, `/accounts/deposit`, `/transfer` for non-2FA users) shall be broken during the rollout period. | Must | BRD §9 |

---

## 8. System and Integration Design

### 8.1 New Database Schema Objects

```sql
-- New table: backup_codes
CREATE TABLE backup_codes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  code_hash    TEXT NOT NULL,          -- bcrypt hash of 8-char alphanumeric code
  consumed_at  TEXT,                   -- NULL = available; datetime = consumed (soft-delete)
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- New table: audit_log
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type   TEXT NOT NULL,          -- enrol | verify_success | verify_fail | sms_otp_sent |
                                       -- backup_code_used | disable | lockout | unlock |
                                       -- admin_bypass | backup_codes_regenerated |
                                       -- transfer_2fa_verified | transfer_2fa_failed
  user_id      INTEGER NOT NULL REFERENCES users(id),
  actor_id     INTEGER REFERENCES users(id),  -- NULL for self-service; admin user ID for Ops
  ip_address   TEXT,
  user_agent   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Extend existing users table
ALTER TABLE users ADD COLUMN account_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN failed_2fa_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN failed_2fa_window_start TEXT;
ALTER TABLE users ADD COLUMN phone_number TEXT;  -- required for SMS OTP

-- New table: sms_otp (transient; records may be pruned after expiry)
CREATE TABLE sms_otp (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  otp_hash     TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  consumed     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
```

> **Note:** The `users` table extension via `ALTER TABLE` is safe in SQLite (`better-sqlite3`) for development. Production DDL migration scripts must be developed and reviewed separately (OI-003).

### 8.2 New and Modified API Endpoints

| Method | Path | Auth Required | Description |
|---|---|---|---|
| `POST` | `/api/auth/login` | None | **Modified.** Returns `{ status: "2fa_required", pendingToken }` when `twofa_enabled = 1`; otherwise returns `{ token }` as today. |
| `POST` | `/api/auth/verify-2fa` | Pending JWT | **New.** Verifies TOTP / SMS OTP / backup code; returns full session JWT on success. |
| `POST` | `/api/auth/request-sms-otp` | Pending JWT | **New.** Triggers SMS OTP dispatch; returns `{ sent: true }`. |
| `POST` | `/api/auth/2fa/setup` | Full JWT | **New.** Generates TOTP secret; returns `{ otpauthUri, qrCodeDataUrl }`. |
| `POST` | `/api/auth/2fa/enable` | Full JWT | **New.** Activates 2FA; returns `{ backupCodes: string[] }` (one-time). |
| `POST` | `/api/auth/2fa/disable` | Full JWT | **New.** Disables 2FA after re-auth; returns `{ disabled: true }`. |
| `GET`  | `/api/auth/2fa/backup-codes` | Full JWT | **New.** Returns `{ total: 8, remaining: N }` (counts only, no plaintext). |
| `POST` | `/api/auth/2fa/backup-codes/regenerate` | Full JWT | **New.** Re-generates backup codes after TOTP verification; returns new plaintext codes one-time. |
| `POST` | `/api/transfer` | Full JWT | **Modified.** Requires `twoFaCode` (body) or `X-2FA-Code` (header) when `twofa_enabled = 1`. |
| `POST` | `/api/admin/2fa/reset/:userId` | Admin JWT | **New.** Resets customer 2FA; internal network only. |

### 8.3 JWT Token Model

Two distinct JWT payloads are used:

**Pending JWT** (new):
```json
{
  "userId": 42,
  "scope": "2fa_pending",
  "iat": 1721000000,
  "exp": 1721000300
}
```
Expiry: 300 seconds (5 minutes). Signed with the same `JWT_SECRET` as full tokens. Scope validated explicitly in `requireAuth` middleware.

**Full Session JWT** (existing shape unchanged):
```json
{
  "userId": 42,
  "iat": 1721000300,
  "exp": 1721007500
}
```
Expiry: 7200 seconds (2 hours) — matches current implementation in [`backend/src/routes/auth.js`](backend/src/routes/auth.js) line 49.

The `requireAuth` middleware in [`backend/src/middleware/auth.js`](backend/src/middleware/auth.js) must be updated to reject tokens carrying `scope: "2fa_pending"` for all routes other than `/api/auth/verify-2fa` and `/api/auth/request-sms-otp`.

### 8.4 Sequence Diagrams

#### 8.4.1 Login — TOTP Happy Path

```
User          AuthForm.jsx        POST /auth/login        POST /auth/verify-2fa    audit_log
 |               |                      |                         |                    |
 |--credentials->|                      |                         |                    |
 |               |--POST /auth/login--->|                         |                    |
 |               |                      |--validate password      |                    |
 |               |                      |--twofa_enabled=1        |                    |
 |               |                      |--issue pendingJWT       |                    |
 |               |<-{status,pendingToken}|                        |                    |
 |<--OTP form----|                      |                         |                    |
 |--TOTP code--->|                      |                         |                    |
 |               |--POST /auth/verify-2fa (pendingToken, code)-->|                    |
 |               |                      |                 |--verify TOTP             |
 |               |                      |                 |--write verify_success--->|
 |               |                      |                 |--issue full JWT          |
 |               |<------------------------------------------{token}                 |
 |<--Dashboard---|                      |                         |                    |
```

#### 8.4.2 Fund Transfer — 2FA Enforcement

```
User          Dashboard.jsx        POST /api/transfer          audit_log
 |               |                      |                           |
 |--form+OTP---->|                      |                           |
 |               |--POST /api/transfer  |                           |
 |               |  (body: twoFaCode)-->|                           |
 |               |                      |--verify twoFaCode         |
 |               |                      |--if valid: commit tx      |
 |               |                      |--write transfer_2fa_verified->|
 |               |<---{balanceCents}----|                           |
 |<--balance-----|                      |                           |
```

#### 8.4.3 TOTP Enrolment

```
User          Dashboard.jsx     POST /auth/2fa/setup    POST /auth/2fa/enable    audit_log
 |               |                    |                        |                    |
 |--click setup->|                    |                        |                    |
 |               |--POST /2fa/setup-->|                        |                    |
 |               |                    |--gen secret            |                    |
 |               |<--{otpauthUri, qr}-|                        |                    |
 |<--QR code-----|                    |                        |                    |
 |--scan app--   |                    |                        |                    |
 |--enter code-->|                    |                        |                    |
 |               |--POST /2fa/enable (code)------------------>|                    |
 |               |                    |               |--verify TOTP              |
 |               |                    |               |--set twofa_enabled=1      |
 |               |                    |               |--gen 8 backup codes       |
 |               |                    |               |--write enrol------------->|
 |               |<--------------------------------{backupCodes}                  |
 |<--backup codes|                    |                        |                    |
```

### 8.5 Third-Party Dependencies

| Dependency | Purpose | Notes |
|---|---|---|
| `otplib` (npm) | TOTP generation and verification (RFC 6238) | Backend. No infrastructure change required. |
| `qrcode` (npm) | QR code data URL generation from `otpauth://` URI | Frontend. Acceptable as confirmed in BRD §8. |
| SMS gateway (Twilio / Kaleyra) | SMS OTP delivery | Vendor selection open (OI-002); credentials via env vars. |
| `nodemailer` or equivalent | Transactional email (lockout, security alerts) | Backend. Config via env vars. |
| Redis (production) | Failed-attempt counter with TTL; optional for dev | Required for horizontal scaling in production (OI-003). |

---

## 9. UI and Channel Flows

### 9.1 Login Flow — AuthForm.jsx

**Step 1 — Credential Entry (existing screen, no visual change for non-2FA users):**
```
┌────────────────────────────────────┐
│  Axis Bank                         │
│  [Log in]  [Sign up]               │
│                                    │
│  Email: [________________]         │
│  Password: [____________]          │
│                                    │
│  [Log in]                          │
└────────────────────────────────────┘
```

**Step 2 — OTP Entry (new; rendered only when API returns `status: "2fa_required"`):**
```
┌────────────────────────────────────┐
│  Axis Bank                         │
│  Two-factor authentication         │
│                                    │
│  Enter the code from your          │
│  authenticator app.                │
│                                    │
│  Code: [________]                  │
│                                    │
│  [Verify]                          │
│                                    │
│  Use SMS code instead              │
│  Use a backup code                 │
└────────────────────────────────────┘
```

**Error state:** Inline error below the code field: *"Invalid or expired code. X attempts remaining before lockout."*

**Locked state:** Full-page message: *"Your account has been locked due to too many failed attempts. Please check your email for unlock instructions or contact support."*

**Expired pending token state:** *"Your session has expired. Please log in again."* → redirect to Step 1.

### 9.2 Transfer Form — Dashboard.jsx

**Send money form (existing fields + new OTP field, shown only when `twofa_enabled = 1`):**
```
┌────────────────────────────────────┐
│  Send money                        │
│                                    │
│  To account number: [____________] │
│  Amount (₹): [___________]         │
│  Authentication code: [______]     │  ← new field
│                                    │
│  [Transfer]                        │
└────────────────────────────────────┘
```

**Error state:** *"Invalid or expired authentication code. Please try again."*

### 9.3 Security Settings — Dashboard.jsx (new section)

**Not enrolled state:**
```
┌────────────────────────────────────┐
│  Security Settings                 │
│                                    │
│  Two-factor authentication: OFF    │
│  [Set up two-factor authentication]│
└────────────────────────────────────┘
```

**Enrolment wizard — Step 1 (QR):**
```
┌────────────────────────────────────┐
│  Set up authenticator app          │
│                                    │
│  1. Open Google Authenticator      │
│     or Authy.                      │
│  2. Scan this QR code:             │
│     [QR code image]                │
│     Can't scan? Enter key: XXXX    │
│  3. Enter the 6-digit code shown   │
│     in your app:                   │
│     Code: [______]                 │
│                                    │
│  [Verify and activate]             │
└────────────────────────────────────┘
```

**Enrolment wizard — Step 2 (Backup codes; one-time reveal):**
```
┌────────────────────────────────────┐
│  Save your backup codes            │
│                                    │
│  Store these in a safe place.      │
│  Each code can only be used once.  │
│                                    │
│  XXXXXXXX  XXXXXXXX                │
│  XXXXXXXX  XXXXXXXX                │
│  XXXXXXXX  XXXXXXXX                │
│  XXXXXXXX  XXXXXXXX                │
│                                    │
│  [Copy all codes]  [Download .txt] │
│  ☑ I have saved my backup codes    │
│  [Done]                            │
└────────────────────────────────────┘
```

**Enrolled state:**
```
┌────────────────────────────────────┐
│  Security Settings                 │
│                                    │
│  Two-factor authentication: ON ✓   │
│  Backup codes: N of 8 remaining    │
│  [Regenerate backup codes]         │
│  [Disable two-factor authentication│
└────────────────────────────────────┘
```

**Disable confirmation form:**
```
┌────────────────────────────────────┐
│  Disable two-factor authentication │
│                                    │
│  For security, please confirm:     │
│  Password: [____________]          │
│  Authenticator code: [______]      │
│                                    │
│  [Confirm disable]  [Cancel]       │
└────────────────────────────────────┘
```

---

## 10. Data Requirements

### 10.1 Data Elements

| Entity | Field | Type | Format / Constraint | Notes |
|---|---|---|---|---|
| `users` | `twofa_enabled` | INTEGER | 0 or 1; NOT NULL DEFAULT 0 | Pre-existing column; now enforced |
| `users` | `twofa_secret` | TEXT | Base32 TOTP secret; AES-256 encrypted at rest | Pre-existing column; populated at enrolment |
| `users` | `account_locked` | INTEGER | 0 or 1; NOT NULL DEFAULT 0 | New column; set on 5th failed attempt |
| `users` | `failed_2fa_attempts` | INTEGER | 0–5; NOT NULL DEFAULT 0 | New column; reset on success or unlock |
| `users` | `failed_2fa_window_start` | TEXT | ISO 8601 datetime | New column; start of rolling 15-min window |
| `users` | `phone_number` | TEXT | E.164 format (e.g. +91XXXXXXXXXX) | New column; required for SMS fallback |
| `backup_codes` | `code_hash` | TEXT | bcrypt (cost ≥ 10) of 8-char alphanumeric | Never store plaintext |
| `backup_codes` | `consumed_at` | TEXT | ISO 8601 datetime or NULL | NULL = available; datetime = consumed |
| `sms_otp` | `otp_hash` | TEXT | bcrypt hash of 6-digit numeric OTP | |
| `sms_otp` | `expires_at` | TEXT | ISO 8601 datetime; 5 min from creation | |
| `audit_log` | `event_type` | TEXT | Enum (see FR-013) | |
| `audit_log` | `ip_address` | TEXT | IPv4 or IPv6 | Collected from `req.ip` |
| `audit_log` | `user_agent` | TEXT | Raw `User-Agent` header value | |

### 10.2 Validation Rules

| Field | Rule |
|---|---|
| TOTP code (login / transfer) | Exactly 6 digits; validated with ±1 time-step (30-second window) per RFC 6238 |
| SMS OTP code | Exactly 6 digits; single-use; valid within 5-minute TTL |
| Backup code | Exactly 8 alphanumeric characters (case-insensitive comparison before hash lookup) |
| Pending JWT | Must have `scope = "2fa_pending"`; must not be expired; must match `userId` in DB |
| Phone number | Must be E.164 format; must be present before SMS OTP can be requested |

### 10.3 Data Storage and Retention

| Data | Storage | Retention |
|---|---|---|
| TOTP secrets | `users.twofa_secret` (AES-256 encrypted) | Until 2FA disabled or account deleted |
| Backup code hashes | `backup_codes` table | Until regenerated or 2FA disabled; soft-deleted records retained 90 days then purged |
| SMS OTP hashes | `sms_otp` table | Purged after expiry + 24 hours (automated job) |
| Audit log entries | `audit_log` table | Minimum 5 years (RBI mandate); read-only after 90 days |
| Failed-attempt counters | `users` table columns (or Redis with 15-min TTL) | Reset on successful 2FA or admin unlock |

---

## 11. Security and Fraud Controls

### 11.1 Authentication Flows

| Scenario | Control |
|---|---|
| Login — TOTP | RFC 6238; ±1 time-step; single-use per time window (replay protection via time-step tracking) |
| Login — SMS OTP | 6-digit numeric; 5-min TTL; bcrypt-hashed in `sms_otp`; single-use |
| Login — Backup code | 8-char alphanumeric; bcrypt-hashed; single-use (consumed on first successful use) |
| Transfer 2FA | Same TOTP verification as login; code rejected if same time-step was already used for login within the session (optional: enforce separate time-step counter per transaction) |
| Pending JWT | Scope-locked; 5-min expiry; only accepted by two endpoints |
| Admin bypass | Admin-role JWT claim required; internal network only; full audit trail |

### 11.2 Encryption Standards

| Asset | Standard |
|---|---|
| TOTP secrets at rest | AES-256-GCM; key from KMS or environment variable (OI-008) |
| Backup codes at rest | bcrypt, cost factor ≥ 10 |
| SMS OTP at rest | bcrypt, cost factor ≥ 10 |
| Data in transit | TLS 1.2 minimum; TLS 1.3 preferred |
| Passwords at rest | bcrypt (already in use per [`backend/src/routes/auth.js`](backend/src/routes/auth.js) line 33) |

### 11.3 Fraud Controls and Thresholds

| Control | Threshold / Rule |
|---|---|
| Failed 2FA lockout | 5 failures within 15-minute rolling window → soft-lock |
| Lockout notification | Email to registered address within 60 seconds of lockout event |
| OTP expiry | TOTP: time-step (~30 s ±1); SMS OTP: 5 min; Backup code: no time expiry |
| Admin bypass audit | Every bypass recorded with operator ID, IP, user agent; customer notified by email |
| Transfer 2FA bypass | No bypass permitted for transfers; admin reset clears enrolment but does not waive 2FA requirement for future transfers |
| Configurable transfer threshold | `TRANSFER_2FA_THRESHOLD_CENTS` env var (default: 0 = all transfers) per FR-019 |

---

## 12. Acceptance Criteria

| ID | Criterion | Given / When / Then | Linked FR | Linked BR |
|---|---|---|---|---|
| AC-001 | User with 2FA enabled cannot get full JWT from login with password alone | **Given** a user with `twofa_enabled = 1` **When** `POST /api/auth/login` is called with valid email and password **Then** HTTP 200 is returned with `{ status: "2fa_required", pendingToken }` and no `token` field | FR-001 | BR-001 |
| AC-002 | Valid TOTP code returns full session JWT | **Given** a valid pending JWT (within 5-min window) **When** `POST /api/auth/verify-2fa` is called with a correct TOTP code **Then** HTTP 200 is returned with a full session JWT and a `verify_success` event is written to `audit_log` | FR-003 | BR-001, BR-002 |
| AC-003 | Invalid or expired TOTP code returns 401 | **Given** a valid pending JWT **When** `POST /api/auth/verify-2fa` is called with an incorrect TOTP code **Then** HTTP 401 is returned, no full JWT is issued, and a `verify_fail` event is written to `audit_log` | FR-003, FR-013 | BR-002, BR-010 |
| AC-004 | Pending JWT rejected on protected endpoints | **Given** a pending JWT (`scope: "2fa_pending"`) **When** any endpoint other than `/verify-2fa` or `/request-sms-otp` is called with it **Then** HTTP 401 is returned | FR-002 | BR-001 |
| AC-005 | SMS OTP fallback completes login | **Given** a valid pending JWT **When** `POST /api/auth/request-sms-otp` is called and a valid SMS OTP is submitted to `POST /api/auth/verify-2fa` within 5 minutes **Then** HTTP 200 is returned with a full session JWT | FR-004, FR-005 | BR-003 |
| AC-006 | Transfer blocked without valid 2FA code | **Given** a user with `twofa_enabled = 1` and a full session JWT **When** `POST /api/transfer` is called without `twoFaCode` or with an invalid code **Then** HTTP 403 is returned and the transfer is not committed | FR-006 | BR-004 |
| AC-007 | Transfer succeeds with valid 2FA code | **Given** a user with `twofa_enabled = 1`, a full session JWT, and sufficient balance **When** `POST /api/transfer` is called with a valid `twoFaCode` **Then** HTTP 200 is returned, balance is updated, and a `transfer_2fa_verified` event is in `audit_log` | FR-006, FR-013 | BR-004 |
| AC-008 | TOTP enrolment flow completes and sets `twofa_enabled = 1` | **Given** an authenticated user with `twofa_enabled = 0` **When** the enrolment wizard is completed (QR scan → code verification) **Then** `twofa_enabled = 1` and `twofa_secret` are set in `users`; 8 backup codes are present in `backup_codes`; an `enrol` event is in `audit_log`; backup codes are displayed once | FR-007, FR-008, FR-013 | BR-005, BR-006 |
| AC-009 | Backup code enables login when TOTP unavailable; single-use | **Given** a user with 2FA enabled and at least one unused backup code **When** the backup code is used to complete `POST /api/auth/verify-2fa` **Then** login succeeds; the code's `consumed_at` is set; a second attempt with the same code returns HTTP 401 | FR-005 | BR-006 |
| AC-010 | 2FA cannot be disabled without password + TOTP | **Given** a user with `twofa_enabled = 1` **When** `POST /api/auth/2fa/disable` is called with missing, wrong password, or wrong TOTP code **Then** HTTP 401 is returned and `twofa_enabled` remains 1 | FR-009 | BR-007 |
| AC-011 | Successful 2FA disable sets `twofa_enabled = 0` | **Given** valid password and TOTP code **When** `POST /api/auth/2fa/disable` is called **Then** `twofa_enabled = 0`, `twofa_secret` is cleared, backup codes are soft-deleted, a `disable` event is in `audit_log`, and a security email is sent | FR-009, FR-013, FR-018 | BR-007, BR-014 |
| AC-012 | Account locked after 5 consecutive 2FA failures | **Given** a user with `twofa_enabled = 1` **When** 5 incorrect codes are submitted within 15 minutes **Then** the account is soft-locked (`account_locked = 1`), a `lockout` event is in `audit_log`, and a lockout email is sent within 60 seconds | FR-010 | BR-008 |
| AC-013 | Admin reset clears 2FA and is logged with operator ID | **Given** a valid admin-role JWT **When** `POST /api/admin/2fa/reset/:userId` is called **Then** `twofa_enabled = 0`, lock is cleared, an `admin_bypass` event is in `audit_log` with the operator's `actor_id`, `ip_address`, and `user_agent`, and a security email is sent to the customer | FR-012, FR-013, FR-018 | BR-009, BR-010 |
| AC-014 | All 2FA audit event types are correctly recorded | **Given** a test scenario exercising each of the 12 event types defined in FR-013 **When** each event occurs **Then** all 12 event types appear in `audit_log` with correct `user_id`, non-null `created_at`, and `ip_address` populated | FR-013 | BR-010 |
| AC-015 | OTP verification API response ≤ 500 ms at P95 | **Given** a load test with 100 concurrent requests to `POST /api/auth/verify-2fa` **When** the test is run in a representative test environment **Then** P95 response time ≤ 500 ms | FR-003 | NFR-007 |
| AC-016 | OTP entry screen passes WCAG 2.1 AA automated scan | **Given** the rendered OTP entry step in `AuthForm.jsx` **When** an axe or Lighthouse accessibility scan is run **Then** zero critical violations are reported | FR-020 | BR-012 |
| AC-017 | Non-2FA users are unaffected during rollout | **Given** a user with `twofa_enabled = 0` **When** `POST /api/auth/login` is called with valid credentials **Then** a full session JWT is returned immediately (identical to pre-2FA behaviour) | FR-014 | NFR-018 |
| AC-018 | Internal Audit formally accepts implementation | **Given** all AC-001 through AC-017 pass in UAT **When** the Internal Audit team reviews the evidence **Then** the open finding from the March internal audit is formally closed | — | BR-001–BR-010, AC-014 |

---

## 13. Assumptions, Dependencies, and Constraints

### 13.1 Assumptions

| ID | Assumption |
|---|---|
| A-001 | The existing `twofa_enabled` and `twofa_secret` columns in `users` (confirmed present in [`backend/src/db.js`](backend/src/db.js)) are retained and used as designed. |
| A-002 | `otplib` is added as a backend npm dependency; no infrastructure changes required. |
| A-003 | An SMS gateway (Twilio or Kaleyra) is procured or already available; credentials are injectable via environment variables. |
| A-004 | The existing JWT model (`jsonwebtoken`, 2-hour expiry in [`backend/src/routes/auth.js`](backend/src/routes/auth.js) line 49) is extended, not replaced. |
| A-005 | All existing API consumers are owned by this team and can be updated in the same release sprint. |
| A-006 | `qrcode` is acceptable as a frontend npm dependency for QR code rendering. |
| A-007 | All retail customers with phone numbers on file can receive SMS OTP. Users without a phone number on record must be informed to update their profile before SMS fallback is available. |
| A-008 | The `JWT_SECRET` environment variable is already rotated and is not `"dev-secret-change-me"` in any environment beyond local development. |

### 13.2 Dependencies

| ID | Dependency | Owner | Blocking |
|---|---|---|---|
| D-001 | SMS gateway vendor selection and credentials provisioning | IT / Product | SMS OTP development |
| D-002 | Internal Audit confirmation of remediation criteria | Compliance / Risk | UAT sign-off |
| D-003 | Partner technical review of 2FA implementation evidence | Business Owner | Partnership onboarding |
| D-004 | Production database technology decision and migration script approval | Engineering Lead | Production deployment |
| D-005 | TOTP secret encryption key management decision (KMS vs. env var) | CISO / Engineering | Production deployment |

### 13.3 Constraints

| ID | Constraint |
|---|---|
| C-001 | Audit remediation deadline — <!-- TODO: Insert actual deadline from audit finding -->. All `Must`-priority FR items must be live before this date. |
| C-002 | Technology stack must remain Node.js/Express (backend) and React/Vite (frontend); no framework rewrites. |
| C-003 | Schema changes must be backward-compatible with `better-sqlite3` in development. |
| C-004 | Budget — <!-- TODO: Insert approved budget / sprint allocation -->. |
| C-005 | All changes must pass existing CI checks and code review before merging to `main`. |
| C-006 | The existing API contract for all endpoints must remain backward-compatible for users not yet enrolled in 2FA during the phased rollout period. |

---

## 14. Open Issues and Decisions Log

| ID | Issue / Decision Needed | Owner | Target Date | Status |
|---|---|---|---|---|
| OI-001 | Confirm exact RBI audit remediation deadline | Compliance / Risk | <!-- TODO --> | Open |
| OI-002 | Select and procure SMS OTP gateway provider; agree cost model | IT / Product | <!-- TODO --> | Open |
| OI-003 | Decide production database technology (PostgreSQL / MySQL) and agree migration timeline | Engineering Lead | <!-- TODO --> | Open |
| OI-004 | Define transfer amount threshold for mandatory 2FA (FR-019) — all transfers vs. above ₹X | Fraud Ops / Product | <!-- TODO --> | Open |
| OI-005 | Confirm whether mandatory 2FA enrolment at signup is in scope for v1 or deferred to v2 | Product Manager | <!-- TODO --> | Open |
| OI-006 | Agree admin-role JWT provisioning mechanism and admin user management for Ops bypass endpoint | Engineering Lead / Ops | <!-- TODO --> | Open |
| OI-007 | Partner technical review — confirm each partner's specific 2FA evidence requirements | Business Owner / Partner Manager | <!-- TODO --> | Open |
| OI-008 | TOTP secret encryption key management (KMS vs. env var) in production | CISO / Engineering | <!-- TODO --> | Open |
| OI-009 | Determine phone number collection strategy for existing users without `phone_number` on file (required for SMS fallback per A-007) | Product / Contact Centre | <!-- TODO --> | Open |
| OI-010 | Decide failed-attempt counter implementation for production: `users` table columns vs. Redis (affects NFR-017) | Engineering Lead | <!-- TODO --> | Open |

---

## 15. Document History

| Version | Date | Author | Change Summary |
|---|---|---|---|
| 1.0 | 2025-07-15 | <!-- TODO: Insert author name --> | Initial draft; derived from BRD-001 v1.0 and source code analysis of `backend/` and `frontend/` |

---
*End of Document*
