# Business Requirements Document
## Two-Factor Authentication (2FA) — Axis Bank Retail Digital Banking

| Field            | Value                                            |
|------------------|--------------------------------------------------|
| Document ID      | BRD-001                                          |
| Version          | 1.0 — Draft                                      |
| Date             | 2025-07-15                                       |
| Author           | <!-- TODO: Insert Business Analyst name -->      |
| Status           | Draft                                            |
| Regulatory Scope | RBI Master Directions on Digital Payment Security, PCI-DSS v4, ISO 27001, IT Act 2000 |

---

## 1. Executive Summary

The Axis Bank retail digital banking application currently authenticates users with a single factor (email + password), leaving customers and the bank exposed to credential-stuffing attacks. This initiative adds a mandatory second authentication factor at login and at high-risk transaction checkpoints across the internet and mobile banking channels. Success is defined as closing the open RBI audit finding, achieving ≥80 % reduction in account-takeover cases, and removing the 2FA gate that is blocking three enterprise partnerships.

---

## 2. Business Case

- **Problem statement** — In Q2, the platform recorded 214 credential-stuffing-linked unauthorised access attempts, resulting in ₹1.4 Cr in disputed transactions and an average of 46 contact-centre minutes consumed per fraud case. The existing `POST /api/auth/login` flow issues a full-session JWT immediately after password verification with no second factor. The `twofa_enabled` flag and `twofa_secret` columns already exist in the `users` table but the enforcement branch is explicitly unimplemented (`// Not implemented yet — falls through to normal login for now`).
- **Strategic alignment** — An open finding from the March internal audit requires a second factor on digital channels before the remediation deadline. Three enterprise-adjacent partnerships have flagged 2FA as a contractual gate for onboarding.
- **Expected benefit** — Eliminate the audit finding; reduce account-takeover cases by ≥80 %; unblock three partnership agreements; reduce contact-centre fraud-handling load.

---

## 3. Scope

### 3.1 In Scope

- **Login flow** — Enforce OTP/TOTP second factor after successful password verification on `POST /api/auth/login` for all users who have 2FA enabled; phased mandatory rollout to all retail users.
- **High-risk transaction checkpoint** — Require a fresh second-factor verification before committing any `POST /api/transfer` request (and, optionally, large deposits via `POST /accounts/deposit`).
- **2FA enrolment & management** — User-initiated TOTP setup (QR code + authenticator app), backup codes, and opt-in/opt-out UI within the dashboard.
- **Fallback / recovery** — SMS OTP as a fallback channel; account recovery flow when the second factor is unavailable.
- **Backend** — Node.js/Express API changes to `backend/src/routes/auth.js`, `backend/src/routes/transfer.js`, `backend/src/middleware/auth.js`, and `backend/src/db.js`.
- **Frontend** — React UI changes to `frontend/src/AuthForm.jsx`, `frontend/src/Dashboard.jsx`, and `frontend/src/api.js`.
- **Ops tooling** — Fraud Ops and Contact Centre screens / runbooks to unlock or bypass 2FA for verified customers.

### 3.2 Out of Scope

- Biometric authentication (fingerprint / face ID) — future phase.
- Hardware security keys (FIDO2 / WebAuthn) — future phase.
- Changes to the account registration flow (first-time login 2FA prompting is in scope; mandatory enrolment at signup is out of scope for v1).
- Third-party identity provider (IdP) or SSO integration.
- Mobile native app (iOS/Android) — the current application is web-only; native app hardening is a separate workstream.

---

## 4. Stakeholders

| Role                     | Name / Team                            | Interest / Responsibility                             |
|--------------------------|----------------------------------------|-------------------------------------------------------|
| Business Owner           | <!-- TODO: Retail Banking Head -->     | Sponsor; accepts delivery and residual risk           |
| Product Manager          | <!-- TODO: Digital Banking PM -->      | Requirement prioritisation; UAT sign-off              |
| Compliance / Risk        | <!-- TODO: CISO / Risk Officer -->     | Regulatory alignment; audit-finding closure           |
| IT / Engineering         | <!-- TODO: Engineering Lead -->        | Design, build, and deploy backend & frontend changes  |
| Fraud Operations         | <!-- TODO: Fraud Ops Manager -->       | Define thresholds; create runbooks; operate tooling   |
| Contact Centre           | <!-- TODO: CC Operations Head -->      | Handle customer 2FA lockout recovery calls            |
| Internal Audit           | <!-- TODO: Audit Team -->              | Validate remediation before deadline                  |
| External Partners (×3)   | <!-- TODO: Partner Names -->           | Confirm gate is cleared before onboarding             |
| Customers (Retail)       | All retail internet-banking users      | Directly impacted; usability and trust                |

---

## 5. Business Requirements

| ID     | Requirement                                                                                                                                                       | Priority | Source / Rule                        |
|--------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|--------------------------------------|
| BR-001 | The system shall enforce a second authentication factor for every user login after successful password verification before issuing a full-session JWT.             | Must     | RBI Master Directions; Internal Audit|
| BR-002 | The system shall support TOTP (RFC 6238, e.g. Google Authenticator, Authy) as the primary second factor.                                                          | Must     | RBI; Internal Security Standard      |
| BR-003 | The system shall support SMS OTP as a fallback second factor when TOTP is unavailable.                                                                            | Must     | RBI Master Directions                |
| BR-004 | The system shall require a second-factor verification before processing any fund transfer (`POST /api/transfer`) regardless of amount.                            | Must     | RBI; Fraud Ops recommendation        |
| BR-005 | The system shall provide users with a self-service 2FA enrolment flow (TOTP QR code generation, verification, and activation) within the authenticated dashboard. | Must     | Product; Regulatory                  |
| BR-006 | The system shall generate and present a set of one-time backup codes at enrolment that allow account recovery when the primary second factor is unavailable.      | Must     | Customer Experience; Risk            |
| BR-007 | The system shall allow a user to disable 2FA only after re-authenticating with their current second factor and password.                                           | Must     | Security Policy                      |
| BR-008 | The system shall lock a user account after 5 consecutive failed second-factor attempts and notify the registered email address.                                    | Must     | RBI; PCI-DSS v4                      |
| BR-009 | Fraud Ops and Contact Centre staff shall have an administrative screen to temporarily bypass or reset a customer's 2FA, subject to identity verification.         | Must     | Operational; Contact Centre SLA      |
| BR-010 | The system shall emit a structured audit log entry for every 2FA event (enrolment, verification success/failure, bypass, disable).                                | Must     | RBI; ISO 27001; IT Act 2000          |
| BR-011 | The login flow shall complete (including OTP delivery and verification) within a total elapsed time acceptable to 95% of users, targeting ≤ 30 seconds end-to-end.| Should   | Customer Experience                  |
| BR-012 | The 2FA OTP/TOTP step shall be accessible and operable via keyboard-only navigation and screen readers.                                                            | Should   | WCAG 2.1 AA; Accessibility Policy    |
| BR-013 | The system shall allow configuration of the transfer amount threshold above which 2FA is additionally enforced at transaction time (default: all transfers).       | Could    | Fraud Ops flexibility                |
| BR-014 | Users shall be notified via email when 2FA is enabled, disabled, or a bypass is performed on their account.                                                       | Should   | Security Awareness; Audit            |

---

## 6. Functional Requirements Summary

### 6.1 Authentication Flow Changes
- On `POST /api/auth/login`, after password check passes, if `twofa_enabled = 1`: issue a short-lived "pending" JWT (scope: `2fa_pending`, expiry ≤ 5 min) instead of a full session token.
- New endpoint `POST /api/auth/verify-2fa` accepts `{ pendingToken, code }` and, on success, returns a full session JWT.
- Frontend `AuthForm.jsx` gains a second step: OTP entry screen rendered when the API returns a `pending` challenge.

### 6.2 Transaction-Level 2FA
- `POST /api/transfer` requires either (a) a fresh `X-2FA-Code` header verified server-side, or (b) a short-lived transaction-scoped token granted by `POST /api/auth/verify-2fa?scope=transfer`.
- Frontend `Dashboard.jsx` transfer form collects the OTP field before submission.

### 6.3 2FA Enrolment & Management
- New endpoint `POST /api/auth/2fa/setup` generates a TOTP secret and returns a `otpauth://` URI for QR rendering.
- New endpoint `POST /api/auth/2fa/enable` verifies the first TOTP code and sets `twofa_enabled = 1`, `twofa_secret` in the `users` table.
- New endpoint `POST /api/auth/2fa/disable` requires current password + valid TOTP code before setting `twofa_enabled = 0`.
- Dashboard settings section shows enrolment status, option to view/regenerate backup codes, and disable toggle.

### 6.4 Backup Codes
- Generated as 8 × 8-character alphanumeric codes at enrolment; hashed (bcrypt) and stored in a new `backup_codes` table.
- Each code is single-use; consumed codes are soft-deleted with a timestamp.

### 6.5 Account Lockout
- Failed 2FA attempts stored in a new `auth_attempts` table (or in-memory with Redis for horizontal scale).
- After 5 failures within a rolling 15-minute window, account is soft-locked; unlock via email link or Ops bypass.

### 6.6 Administrative / Ops Tooling
- Internal-only route `POST /api/admin/2fa/reset/:userId` (protected by an admin-role JWT claim) clears `twofa_enabled` and logs the bypass event with the operator ID.

### 6.7 Audit Logging
- All 2FA events written to a new `audit_log` table: `event_type`, `user_id`, `actor_id` (null for self-service, admin ID for Ops), `ip_address`, `user_agent`, `created_at`.

---

## 7. Non-Functional Requirements

| Category        | Requirement                                                                                  |
|-----------------|----------------------------------------------------------------------------------------------|
| Security        | TOTP secrets encrypted at rest (AES-256); OTP valid ≤ 5 minutes; transmitted over TLS 1.2+  |
| Security        | Pending JWT scope (`2fa_pending`) cannot access any authenticated endpoint except `/verify-2fa` |
| Availability    | 2FA service (TOTP verification) — 99.9 % uptime; SMS gateway SLA ≥ 99.5 %                  |
| Performance     | OTP verification API response ≤ 500 ms at P95 under normal load                             |
| Performance     | SMS OTP delivery ≤ 10 seconds at P95                                                         |
| Compliance      | RBI Master Directions on Digital Payment Security Controls (current version)                 |
| Compliance      | PCI-DSS v4 — Req. 8 (Identity & Access Management)                                          |
| Compliance      | ISO 27001 — A.9 Access Control                                                               |
| Compliance      | IT Act 2000 — audit trail requirements                                                       |
| Data Retention  | Audit logs retained for minimum 5 years per RBI mandate                                      |
| Accessibility   | WCAG 2.1 AA — OTP input screen; enrolment UI                                                |
| Scalability     | Solution must work with the current better-sqlite3 store in dev; production DB migration plan required |

---

## 8. Assumptions & Dependencies

### Assumptions
- The existing `twofa_enabled` and `twofa_secret` columns in the `users` table (currently unused) are retained and used as designed.
- A TOTP library (e.g. `otplib`) will be added as a backend dependency; this does not require infrastructure changes.
- An SMS gateway provider (e.g. Twilio, Kaleyra) is procured or is already available; its credentials are injectable via environment variables.
- The current JWT-based session model (`jsonwebtoken`, 2-hour expiry) is extended, not replaced.
- All existing API consumers (frontend `api.js`) are owned by this team and can be updated in the same release.
- A QR-code rendering library (e.g. `qrcode`) is acceptable to add as a frontend dependency.

### Dependencies
- **SMS Gateway** — vendor selection and credentials provisioning must precede SMS OTP development.
- **Internal Audit** — audit team must confirm remediation criteria before UAT sign-off.
- **Partner onboarding gates** — partner technical review of 2FA implementation may add lead time.
- **Production DB migration** — SQLite is used in development; production environment and migration scripts must be agreed before deployment.

---

## 9. Constraints

- **Audit remediation deadline** — <!-- TODO: Insert actual deadline from audit finding -->. All `Must` requirements must be live before this date.
- **Technology stack** — Solution must use the existing Node.js/Express backend and React (Vite) frontend; no full framework rewrites.
- **Database** — Schema changes must be backward-compatible with the existing `better-sqlite3` setup in development; production DB technology TBD.
- **Budget** — <!-- TODO: Insert approved budget / team-sprint allocation -->.
- **Branch / release model** — All changes must pass existing CI checks and code review before merging to `main`.
- **No breaking API changes** — The existing API contract (register, login, me, transactions, deposit, transfer) must remain backward-compatible for users who have not yet enrolled in 2FA during the rollout period.

---

## 10. Acceptance Criteria

| AC-ID  | Criterion                                                                                                                   | Linked BR        |
|--------|-----------------------------------------------------------------------------------------------------------------------------|------------------|
| AC-001 | A user with `twofa_enabled = 1` cannot obtain a full session JWT from `POST /api/auth/login` with password alone.          | BR-001           |
| AC-002 | A valid TOTP code entered within the 5-minute window at `POST /api/auth/verify-2fa` returns a full session JWT.            | BR-001, BR-002   |
| AC-003 | An expired or invalid TOTP code returns HTTP 401; the attempt is recorded in the audit log.                                | BR-002, BR-010   |
| AC-004 | A valid SMS OTP (fallback) entered within the validity window completes login successfully.                                 | BR-003           |
| AC-005 | `POST /api/transfer` is rejected with HTTP 403 if the required second-factor token/code is missing or invalid.             | BR-004           |
| AC-006 | A user can complete TOTP enrolment (scan QR, enter verification code, receive backup codes) from the dashboard in < 3 minutes in usability testing. | BR-005, BR-006 |
| AC-007 | Backup codes allow login when TOTP device is unavailable; each code works exactly once.                                    | BR-006           |
| AC-008 | 2FA cannot be disabled without entering a valid current TOTP code and password.                                            | BR-007           |
| AC-009 | After 5 consecutive failed 2FA attempts, the account is locked and the user receives a lockout email within 60 seconds.    | BR-008           |
| AC-010 | An admin/Ops user can reset a customer's 2FA via the admin endpoint; the event appears in the audit log with the operator's ID. | BR-009, BR-010 |
| AC-011 | All 2FA audit events (enrol, verify pass, verify fail, disable, bypass) are present in `audit_log` with correct fields.    | BR-010           |
| AC-012 | OTP verification API responds in ≤ 500 ms at P95 under a load of 100 concurrent requests in the test environment.          | BR-001, NFR      |
| AC-013 | The OTP entry screen passes WCAG 2.1 AA automated scan (axe / Lighthouse) with zero critical violations.                   | BR-012           |
| AC-014 | Internal Audit formally accepts the implementation as closing the open finding.                                             | BR-001–BR-010    |

---

## 11. Open Issues / Decisions Log

| ID      | Issue / Decision Needed                                                                 | Owner                            | Target Date                            | Status |
|---------|-----------------------------------------------------------------------------------------|----------------------------------|----------------------------------------|--------|
| OI-001  | Confirm exact RBI audit remediation deadline                                            | Compliance / Risk                | <!-- TODO -->                          | Open   |
| OI-002  | Select and procure SMS OTP gateway provider; agree on cost model                        | IT / Product                     | <!-- TODO -->                          | Open   |
| OI-003  | Decide production database technology (PostgreSQL / MySQL) and agree migration timeline | Engineering Lead                 | <!-- TODO -->                          | Open   |
| OI-004  | Define transfer amount threshold for mandatory 2FA (BR-013) — all vs. above ₹X         | Fraud Ops / Product              | <!-- TODO -->                          | Open   |
| OI-005  | Confirm whether mandatory 2FA enrolment at signup is in scope for v1 or deferred       | Product Manager                  | <!-- TODO -->                          | Open   |
| OI-006  | Agree admin-role JWT provisioning mechanism for Ops bypass endpoint                     | Engineering Lead / Ops           | <!-- TODO -->                          | Open   |
| OI-007  | Partner technical review — confirm each partner's specific 2FA evidence requirements   | Business Owner / Partner Manager | <!-- TODO -->                          | Open   |
| OI-008  | TOTP secret encryption key management (KMS vs. env var) in production                  | CISO / Engineering               | <!-- TODO -->                          | Open   |

---

## 12. Document History

| Version | Date       | Author                                    | Change Summary   |
|---------|------------|-------------------------------------------|------------------|
| 1.0     | 2025-07-15 | <!-- TODO: Insert Business Analyst name -->| Initial draft    |

---
*End of Document*
