# Business Requirements Document
## Two-Factor Authentication (2FA) — Retail Digital Banking

| Field | Value |
|---|---|
| Document version | 1.0 |
| Status | Draft |
| Author | Business Analyst |
| Date | 2025-07-16 |
| Feature request | `2_factor_requirement` |
| Codebase | React 19 frontend / Express 5 + better-sqlite3 backend |

---

## 1. Executive Summary

The retail internet and mobile banking product currently authenticates customers with a single factor (email + password). In Q2, 214 credential-stuffing-linked unauthorised access attempts were recorded, resulting in ₹1.4 Cr in disputed transactions and an average of 46 contact-centre minutes per fraud case. The existing single-factor flow is also an open RBI compliance finding from the March internal audit with an imminent remediation deadline, and three enterprise-adjacent partnerships have flagged 2FA as a commercial gate.

This document describes the business requirements to introduce a second factor at login and at high-risk transaction checkpoints, supply Fraud Ops and Contact Centre with appropriate tooling and runbooks, and close the compliance finding without materially increasing customer drop-off.

---

## 2. Business Objectives

| # | Objective | Measurable Target |
|---|---|---|
| BO-1 | Satisfy RBI's additional-factor requirement on digital channels | Audit finding closed before deadline |
| BO-2 | Reduce account-takeover (ATO) incidents | ≥ 80% reduction vs Q2 baseline |
| BO-3 | Unblock enterprise-adjacent partnership integrations | All three partners confirm gate cleared |
| BO-4 | Minimise customer drop-off introduced by the additional step | Login completion rate within 3 pp of pre-2FA baseline |
| BO-5 | Reduce fraud-related contact-centre load | Average handle time per fraud case reduced; total fraud-related inbound calls down ≥ 50% |

---

## 3. Scope

### 3.1 In Scope

- Second-factor challenge on the login flow for all registered customers.
- Second-factor challenge at the high-risk transaction checkpoint (fund transfers).
- Two second-factor delivery methods:
  - **TOTP (Time-based One-Time Password)** — authenticator app (e.g. Google Authenticator, Authy).
  - **SMS OTP** — one-time code sent to the customer's registered mobile number.
- Self-service 2FA enrolment and managed 2FA reset via Contact Centre.
- Fraud Ops dashboard signals and Contact Centre runbooks.
- Backend API changes (Node.js / Express).
- Frontend UI changes (React).
- Database schema additions (SQLite via better-sqlite3; columns `twofa_enabled`, `twofa_secret` already reserved).

### 3.2 Out of Scope

- Hardware security key (FIDO2/WebAuthn) — future phase.
- Push notification-based approval — future phase.
- 2FA for staff / back-office portals.
- Changes to the deposit demo endpoint (internal testing tool).
- Mobile native app (separate workstream).

---

## 4. Stakeholders

| Role | Interest |
|---|---|
| Retail Customers | Secure, low-friction access to internet banking |
| Fraud Operations | Real-time signals, case management tooling |
| Contact Centre | Runbooks for assisted 2FA reset and lockout recovery |
| Compliance / Internal Audit | RBI additional-factor finding closure evidence |
| Enterprise Partners | Confirmed 2FA gate cleared before integration go-live |
| Engineering (Backend) | API and DB implementation guidance |
| Engineering (Frontend) | UI/UX implementation guidance |
| Information Security | Key/secret management, token hardening |

---

## 5. Current-State Analysis

### 5.1 Authentication Flow (as-built)

```
Customer → POST /api/auth/login { email, password }
         ← 200 { token }   ← full session JWT issued immediately
```

The backend [`/api/auth/login`](backend/src/routes/auth.js:54) performs only `bcrypt.compareSync` against `password_hash`. The `twofa_enabled` flag is read but the branch is unimplemented (falls through to normal login). A full 2-hour session JWT is returned unconditionally.

The frontend [`AuthForm.jsx`](frontend/src/AuthForm.jsx) calls `api.login` and immediately calls `onAuthenticated(token)`, storing the token in `localStorage` and navigating to the [`Dashboard`](frontend/src/Dashboard.jsx).

### 5.2 Transfer Flow (as-built)

```
Customer → POST /api/transfer { toAccountNumber, amountCents }  (Bearer token)
         ← 200 { balanceCents }
```

[`transfer.js`](backend/src/routes/transfer.js:27) contains an explicit comment: *"once 2FA is implemented, this is the natural place to require a fresh TOTP/SMS code for transfers over a threshold before committing."* No challenge is raised today.

### 5.3 Existing Database Readiness

[`db.js`](backend/src/db.js:14) already provisions `twofa_enabled INTEGER NOT NULL DEFAULT 0` and `twofa_secret TEXT` on the `users` table. No migration is required for the core columns; only an `sms_phone` column and an OTP scratch-pad table will be added (see §7.3).

### 5.4 Identified Gaps

| Gap | Impact |
|---|---|
| `twofa_enabled` branch in login is a no-op | 2FA toggle has no effect |
| No pending-session ("step-up") token mechanism | Credential check and session grant are atomically coupled |
| No TOTP secret generation / verification endpoint | Cannot enrol or verify TOTP |
| No OTP generation, storage or SMS dispatch endpoint | Cannot deliver or verify SMS OTP |
| No transfer-time step-up challenge | High-value transfers unprotected |
| No enrolment UI | Customers cannot self-serve 2FA setup |
| No OTP entry UI (login or transfer) | No channel to collect the second factor |
| No admin / Fraud Ops signal | No visibility into 2FA-related events |

---

## 6. Business Requirements

### 6.1 Second Factor at Login

**BR-L-01** — After successful password verification, if `twofa_enabled = 1` for the user, the system **must not** issue a full session token. Instead it **must** issue a short-lived (≤ 5 minutes) *pending* token scoped only to the 2FA verification endpoint.

**BR-L-02** — The system **must** accept a valid TOTP code **or** a valid SMS OTP against the pending token and, on success, issue a full session token.

**BR-L-03** — An incorrect OTP **must** return an error without consuming the pending token until a configurable maximum attempt count (default: 5) is exceeded, at which point the pending token **must** be invalidated and the account temporarily locked.

**BR-L-04** — A pending token that expires **must** be treated as invalid; the customer **must** be required to restart the login flow.

**BR-L-05** — The full session JWT TTL **must** remain at 2 hours (preserving existing [`expiresIn: '2h'`](backend/src/routes/auth.js:74)).

### 6.2 Second Factor at Transfer (Step-Up)

**BR-T-01** — All outbound fund transfers, regardless of amount, **must** require a fresh second-factor challenge before the transaction is committed.

**BR-T-02** — The step-up challenge **must** be bound to the authenticated session (JWT `userId`) and the specific transfer intent (destination account + amount); replaying the OTP for a different transfer **must** fail.

**BR-T-03** — A step-up OTP **must** expire within 5 minutes of issuance.

**BR-T-04** — On successful step-up verification, the transfer **must** be committed atomically in the same database transaction as today.

### 6.3 TOTP Enrolment

**BR-E-01** — An authenticated customer **must** be able to initiate TOTP enrolment from their account settings.

**BR-E-02** — The system **must** generate a cryptographically random TOTP secret (RFC 6238 compliant), store it encrypted in `twofa_secret`, and expose a QR code / manual-entry key for the customer to scan into their authenticator app.

**BR-E-03** — The system **must** require the customer to submit a valid TOTP code before `twofa_enabled` is set to `1`. Enrolment with an unverified secret **must** be rejected.

**BR-E-04** — The system **must** generate and present exactly 8 single-use backup codes at enrolment time. Each code **must** be invalidated after first use.

**BR-E-05** — The `twofa_secret` value in the database **must** be encrypted at rest using an application-level key stored outside the database (environment variable / secrets manager).

### 6.4 SMS OTP

**BR-S-01** — Customers who do not have an authenticator app configured **must** be able to receive a 6-digit OTP via SMS to their registered mobile number.

**BR-S-02** — OTPs **must** be single-use, minimum 6 digits, and expire within 5 minutes.

**BR-S-03** — No more than 3 OTP send requests **must** be permitted per session challenge to prevent SMS pumping.

**BR-S-04** — OTPs **must not** be logged in application logs at any level.

**BR-S-05** — If the customer's mobile number is absent, the SMS channel **must** be unavailable and only TOTP presented.

### 6.5 Account Recovery

**BR-R-01** — Contact Centre agents **must** be able to initiate a supervised 2FA reset for a customer, which sets `twofa_enabled = 0` and clears `twofa_secret`, via an internal admin endpoint requiring elevated credentials.

**BR-R-02** — A 2FA reset event **must** generate an audit log entry (timestamp, agent ID, customer ID) and trigger an in-app notification and email to the customer.

**BR-R-03** — Customers who have lost access to both their authenticator app and SMS number **must** follow a documented identity-verification runbook before Contact Centre can initiate a reset.

### 6.6 Fraud Ops & Contact Centre Tooling

**BR-F-01** — All 2FA-related events (enrolment, successful login 2FA, failed 2FA attempts, lockout, reset, step-up challenge, step-up success/failure) **must** be written to an audit events table with `event_type`, `user_id`, `ip_address`, `user_agent`, `created_at`.

**BR-F-02** — A Fraud Ops read-only query endpoint **must** expose the audit events table, filterable by `user_id` and date range.

**BR-F-03** — Consecutive failed 2FA attempts exceeding the threshold (see BR-L-03) **must** trigger an alert to the Fraud Ops queue.

### 6.7 Compliance

**BR-C-01** — The implementation **must** satisfy the RBI "additional factor of authentication" requirement for internet banking channels.

**BR-C-02** — TOTP secrets and backup codes at rest **must** be encrypted (see BR-E-05).

**BR-C-03** — OTPs **must not** be transmitted or stored in plaintext in any persistent store.

**BR-C-04** — All 2FA events **must** be retained in the audit log for a minimum of 5 years.

---

## 7. Functional Specifications

### 7.1 New API Endpoints

| Method | Path | Auth required | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/login` *(modified)* | None | Returns `{ pendingToken }` when `twofa_enabled = 1`, else `{ token }` as today |
| `POST` | `/api/auth/2fa/verify` | Pending token | Accepts `{ code }`, returns `{ token }` on success |
| `POST` | `/api/auth/2fa/enrol/begin` | Full session token | Generates TOTP secret, returns `{ qrUri, manualKey }` |
| `POST` | `/api/auth/2fa/enrol/confirm` | Full session token | Verifies `{ code }`, sets `twofa_enabled = 1`, returns backup codes |
| `POST` | `/api/auth/2fa/otp/send` | Pending token | Sends SMS OTP (rate-limited) |
| `POST` | `/api/transfer/challenge` *(new)* | Full session token | Issues a transfer step-up challenge, returns `{ challengeToken }` |
| `POST` | `/api/transfer` *(modified)* | Full session token + `challengeToken` | Verifies step-up before committing transfer |
| `POST` | `/api/admin/2fa/reset` | Admin token | Resets 2FA for a customer |
| `GET` | `/api/admin/audit` | Admin token | Returns 2FA audit events |

### 7.2 JWT Token Types

| Type | Claim additions | TTL | Accepted by |
|---|---|---|---|
| Full session | `{ userId, type: 'session' }` | 2 h | All authenticated endpoints |
| Pending 2FA | `{ userId, type: 'pending' }` | 5 min | `/api/auth/2fa/verify`, `/api/auth/2fa/otp/send` |
| Transfer challenge | `{ userId, type: 'challenge', toAccountNumber, amountCents }` | 5 min | `/api/transfer` |

The existing [`requireAuth`](backend/src/middleware/auth.js:5) middleware will be extended to validate the `type` claim; authenticated endpoints will only accept `session` tokens.

### 7.3 Database Schema Additions

```sql
-- Additions to existing users table (columns already reserved — no migration needed):
--   twofa_enabled INTEGER NOT NULL DEFAULT 0   ← already present
--   twofa_secret  TEXT                          ← already present (stores encrypted TOTP secret)

ALTER TABLE users ADD COLUMN sms_phone TEXT;        -- registered mobile number
ALTER TABLE users ADD COLUMN twofa_locked INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS otp_codes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  code_hash    TEXT NOT NULL,          -- bcrypt hash of the OTP
  purpose      TEXT NOT NULL,          -- 'login' | 'transfer'
  expires_at   TEXT NOT NULL,
  used         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS backup_codes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  code_hash    TEXT NOT NULL,
  used         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type   TEXT NOT NULL,
  user_id      INTEGER REFERENCES users(id),
  ip_address   TEXT,
  user_agent   TEXT,
  metadata     TEXT,                   -- JSON blob for event-specific fields
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 7.4 Frontend UI Changes

| Screen | Change |
|---|---|
| [`AuthForm.jsx`](frontend/src/AuthForm.jsx) | After login API returns `pendingToken` instead of `token`, render a new `OtpStep` component (code input + "Send SMS" option) before calling `onAuthenticated` |
| [`Dashboard.jsx`](frontend/src/Dashboard.jsx) | Add "Security" settings panel with TOTP enrolment wizard (QR code display → code confirmation → backup code download) |
| [`Dashboard.jsx`](frontend/src/Dashboard.jsx) — Transfer form | Before submitting transfer, call challenge endpoint and show OTP entry modal; include `challengeToken` in transfer body |
| [`api.js`](frontend/src/api.js) | Add `verifyOtp`, `enrolBegin`, `enrolConfirm`, `requestSmsOtp`, `transferChallenge` methods |

### 7.5 Login Flow — Updated Sequence

```
1. Customer enters email + password → POST /api/auth/login
2a. twofa_enabled = 0  → { token }          ← existing happy path, unchanged
2b. twofa_enabled = 1  → { pendingToken }
3.  Frontend renders OTP entry screen
4a. Customer enters TOTP code → POST /api/auth/2fa/verify { code }
4b. Customer requests SMS     → POST /api/auth/2fa/otp/send  → SMS dispatched
                               → POST /api/auth/2fa/verify { code }
5.  Valid code → { token }   → onAuthenticated(token) — same as today
    Invalid    → error displayed; attempt count incremented
    Max attempts exceeded → account locked; Fraud Ops alerted
```

### 7.6 Transfer Flow — Updated Sequence

```
1. Customer fills transfer form → POST /api/transfer/challenge { toAccountNumber, amountCents }
2. Backend issues { challengeToken } (JWT bound to transfer intent)
3. Frontend shows OTP modal
4. Customer enters OTP → POST /api/transfer { toAccountNumber, amountCents, challengeToken, code }
5. Backend verifies challengeToken claims match body, verifies OTP/TOTP
6. On success → existing atomic transfer transaction committed
```

---

## 8. Non-Functional Requirements

| # | Category | Requirement |
|---|---|---|
| NFR-1 | Performance | OTP verification endpoint must respond in < 500 ms at the 95th percentile under normal load |
| NFR-2 | Availability | 2FA service availability must not fall below the existing application SLA |
| NFR-3 | Security | TOTP secrets encrypted with AES-256 or equivalent; key stored in environment variable / secrets manager, never in the database |
| NFR-4 | Security | Pending and challenge tokens must be signed with a separate signing key from session tokens, or carry a `type` claim validated by middleware |
| NFR-5 | Security | Brute-force protection: max 5 failed OTP attempts per pending session before lockout |
| NFR-6 | Privacy | OTP values must never appear in server logs, error messages, or API responses other than the initial delivery |
| NFR-7 | Compliance | Audit log retention ≥ 5 years (BR-C-04) |
| NFR-8 | Usability | Customers must be able to complete 2FA enrolment in ≤ 3 minutes; login with 2FA in ≤ 30 seconds |
| NFR-9 | Accessibility | OTP input fields must be compatible with screen readers and mobile autofill (`autocomplete="one-time-code"`) |

---

## 9. Acceptance Criteria

| ID | Scenario | Expected Result |
|---|---|---|
| AC-01 | Customer with `twofa_enabled = 0` logs in | Token returned immediately — no change to current behaviour |
| AC-02 | Customer with `twofa_enabled = 1` logs in with correct password | `pendingToken` returned; no session token issued |
| AC-03 | Customer submits correct TOTP code against pending token | Full session token returned; login completes |
| AC-04 | Customer submits incorrect OTP 5 times | Account locked; Fraud Ops alert triggered; further attempts rejected |
| AC-05 | Customer submits correct TOTP after pending token expires | Request rejected with 401; customer must restart login |
| AC-06 | Customer initiates transfer without completing step-up | Transfer rejected |
| AC-07 | Customer completes step-up and submits matching transfer intent | Transfer committed; balance updated |
| AC-08 | Customer replays a used challengeToken on a different transfer | Request rejected |
| AC-09 | Customer completes TOTP enrolment | `twofa_enabled = 1` set; 8 backup codes issued; subsequent login requires OTP |
| AC-10 | Contact Centre resets 2FA for a customer | `twofa_enabled = 0`, audit event written, customer notified by email and in-app |
| AC-11 | Fraud Ops queries audit events for a customer | All 2FA events returned in date-filtered results |
| AC-12 | SMS OTP is requested more than 3 times in one session | 4th request rejected with rate-limit error |

---

## 10. Dependencies & Risks

| Item | Type | Detail | Mitigation |
|---|---|---|---|
| SMS gateway provider | External dependency | No SMS gateway is currently integrated | Onboard gateway (e.g. Twilio, AWS SNS) before or in parallel with development |
| `totp` / `speakeasy` library | New dependency | Node.js TOTP generation/verification library needed | Evaluate `otplib` (actively maintained) as backend dependency |
| Secrets management | Infrastructure | TOTP secret encryption key must not live in the repo | Use environment variable; document in `.env.example`; add secret to CI/CD pipeline |
| RBI deadline | Compliance | Hard deadline from internal audit remediation | Prioritise login 2FA for first release; transfer step-up can follow in a fast-follow sprint |
| Drop-off risk | UX | Additional step at login may increase abandonment | A/B test with opt-in rollout before mandatory enforcement |
| Existing sessions | Migration | Users with active JWTs will not be 2FA-challenged until token expiry | Acceptable given 2-hour TTL; no forced logout needed |
| SQLite concurrency | Infrastructure | `bank.db` is a single-file SQLite; OTP table writes add contention | WAL mode already enabled ([`db.js:6`](backend/src/db.js:6)); monitor under load |

---

## 11. Assumptions

1. The RBI remediation deadline date is known to Compliance and will be shared with Engineering at project kick-off.
2. Customers have a registered mobile number stored in the system (or will provide one during 2FA enrolment).
3. A secrets management solution (environment variable injection in production) is available before go-live.
4. The SMS gateway procurement and contract are on a parallel track and will be ready before user acceptance testing.
5. The existing JWT secret (`JWT_SECRET` environment variable) is rotated as part of this release to invalidate all pre-2FA sessions in production.
6. "High-risk transaction" is defined as all outbound transfers (BR-T-01); the threshold may be revised in a later phase.

---

## 12. Out-of-Scope Deferral Log

| Item | Reason deferred |
|---|---|
| FIDO2 / WebAuthn hardware keys | Complexity; low customer adoption currently |
| Push-notification approval | Requires mobile native app workstream |
| Biometric step-up | Platform-specific; future phase |
| 2FA for staff portals | Separate identity provider; separate workstream |
| Per-transaction risk scoring | Requires ML pipeline not yet available |

---

## 13. Glossary

| Term | Definition |
|---|---|
| 2FA | Two-Factor Authentication — requiring a second verification factor beyond username/password |
| TOTP | Time-based One-Time Password (RFC 6238) — 6-digit code generated by an authenticator app, rotating every 30 seconds |
| OTP | One-Time Password — single-use code, here used for SMS-delivered codes |
| Pending token | Short-lived JWT issued after password check, valid only for the 2FA verification endpoint |
| Challenge token | Short-lived JWT bound to a specific transfer intent, required for step-up verification |
| Step-up | A fresh authentication challenge raised mid-session before a sensitive operation |
| ATO | Account Takeover — fraudulent access to a customer's account |
| Credential stuffing | Automated attack using leaked username/password pairs from other breaches |

---

*End of document*
