# Functional Specification Document
## Two-Factor Authentication (2FA) — Retail Digital Banking

| Field | Value |
|---|---|
| Document version | 1.0 |
| Status | Draft |
| Author | Engineering |
| Date | 2025-07-16 |
| BRD reference | `BRD_Two_Factor_Authentication.md` v1.0 |
| Codebase | React 19 frontend / Express 5 + better-sqlite3 backend |

---

## Table of Contents

1. [Purpose & Scope](#1-purpose--scope)
2. [System Context](#2-system-context)
3. [Database Changes](#3-database-changes)
4. [Backend — New Dependencies](#4-backend--new-dependencies)
5. [Backend — Middleware Changes](#5-backend--middleware-changes)
6. [Backend — Auth Routes](#6-backend--auth-routes)
7. [Backend — Transfer Routes](#7-backend--transfer-routes)
8. [Backend — Admin Routes](#8-backend--admin-routes)
9. [Frontend — API Client](#9-frontend--api-client)
10. [Frontend — Auth Flow](#10-frontend--auth-flow)
11. [Frontend — Dashboard: Security Panel](#11-frontend--dashboard-security-panel)
12. [Frontend — Dashboard: Transfer Step-Up](#12-frontend--dashboard-transfer-step-up)
13. [Token Contracts](#13-token-contracts)
14. [OTP Lifecycle](#14-otp-lifecycle)
15. [Audit Event Catalogue](#15-audit-event-catalogue)
16. [Security Controls](#16-security-controls)
17. [Error Codes Reference](#17-error-codes-reference)
18. [Acceptance Criteria Mapping](#18-acceptance-criteria-mapping)
19. [Open Items](#19-open-items)

---

## 1. Purpose & Scope

This FSD translates the business requirements in `BRD_Two_Factor_Authentication.md` into concrete, file-level implementation instructions for the existing React 19 / Express 5 / better-sqlite3 codebase.

### In scope (this document)
- Database schema additions to `bank.db` via [`backend/src/db.js`](backend/src/db.js)
- New and modified backend routes under [`backend/src/routes/`](backend/src/routes/)
- Auth middleware changes in [`backend/src/middleware/auth.js`](backend/src/middleware/auth.js)
- New admin routes registered in [`backend/src/index.js`](backend/src/index.js)
- Frontend changes to [`frontend/src/AuthForm.jsx`](frontend/src/AuthForm.jsx), [`frontend/src/Dashboard.jsx`](frontend/src/Dashboard.jsx), and [`frontend/src/api.js`](frontend/src/api.js)
- New frontend components: `OtpStep`, `EnrolWizard`, `TransferOtpModal`

### Out of scope (deferred per BRD §3.2)
FIDO2/WebAuthn, push-notification approval, biometric step-up, staff portals, native mobile app, per-transaction risk scoring, deposit demo endpoint.

---

## 2. System Context

### 2.1 Current authentication flow (as-built)

```
POST /api/auth/login { email, password }
  └─ bcrypt.compareSync → full 2h session JWT { userId } returned immediately
```

The `twofa_enabled` branch at [`backend/src/routes/auth.js:70`](backend/src/routes/auth.js:70) is a no-op.
[`frontend/src/AuthForm.jsx:17`](frontend/src/AuthForm.jsx:17) destructures `{ token }` from the response and calls `onAuthenticated(token)` directly.

### 2.2 Current transfer flow (as-built)

```
POST /api/transfer { toAccountNumber, amountCents }  (Bearer session token)
  └─ requireAuth → balance check → atomic DB transaction → { balanceCents }
```

No step-up challenge is raised. The note at [`backend/src/routes/transfer.js:27`](backend/src/routes/transfer.js:27) explicitly marks the insertion point.

### 2.3 Target state overview

```
Login flow (twofa_enabled = 1):
  POST /api/auth/login
    └─ password OK → { pendingToken }  (5 min, type:'pending')
  POST /api/auth/2fa/verify { code }   (Bearer pendingToken)
    └─ OTP/TOTP OK → { token }         (2 h,   type:'session')

Transfer flow:
  POST /api/transfer/challenge { toAccountNumber, amountCents }  (Bearer session token)
    └─ { challengeToken }  (5 min, type:'challenge', toAccountNumber, amountCents)
  POST /api/transfer { toAccountNumber, amountCents, challengeToken, code }  (Bearer session token)
    └─ verify challengeToken claims match body → verify OTP/TOTP → atomic transfer
```

---

## 3. Database Changes

**File:** [`backend/src/db.js`](backend/src/db.js)

All changes are **additive**. No existing columns or tables are modified.

### 3.1 Additions to `users` table

Two new columns are added to the existing `CREATE TABLE IF NOT EXISTS users` block, and via `ALTER TABLE` guards for live databases:

```sql
ALTER TABLE users ADD COLUMN sms_phone TEXT;
ALTER TABLE users ADD COLUMN twofa_locked INTEGER NOT NULL DEFAULT 0;
```

| Column | Type | Purpose |
|---|---|---|
| `sms_phone` | `TEXT` | Registered mobile number for SMS OTP delivery |
| `twofa_locked` | `INTEGER DEFAULT 0` | Set to `1` when max OTP attempts exceeded (BR-L-03) |

> **Note:** `twofa_enabled` (default 0) and `twofa_secret` (TEXT, nullable) are already present in [`backend/src/db.js:15-16`](backend/src/db.js:15). The `twofa_secret` column stores an **AES-256-CBC encrypted** ciphertext (`iv:ciphertext` hex string), not the raw TOTP secret.

### 3.2 New `otp_codes` table

Scratch-pad for SMS OTPs and transfer step-up codes. TOTP is verified in-memory via `otplib`; it does not use this table.

```sql
CREATE TABLE IF NOT EXISTS otp_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  code_hash   TEXT NOT NULL,       -- bcrypt hash of the plaintext OTP
  purpose     TEXT NOT NULL,       -- 'login' | 'transfer'
  expires_at  TEXT NOT NULL,       -- ISO-8601 UTC datetime
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 3.3 New `backup_codes` table

Stores the 8 single-use backup codes issued at TOTP enrolment.

```sql
CREATE TABLE IF NOT EXISTS backup_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  code_hash   TEXT NOT NULL,       -- bcrypt hash of the plaintext backup code
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 3.4 New `audit_events` table

Central append-only log for all 2FA-related events (BR-F-01, BR-C-04).

```sql
CREATE TABLE IF NOT EXISTS audit_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id),
  ip_address  TEXT,
  user_agent  TEXT,
  metadata    TEXT,                -- JSON blob; event-type-specific fields
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 3.5 Implementation pattern for `ALTER TABLE` guards

Because `better-sqlite3` `exec()` runs in one shot and `ALTER TABLE … ADD COLUMN` will throw on existing columns, wrap each in a helper:

```js
// In db.js — add after the existing CREATE TABLE block
function addColumnIfMissing(table, column, definition) {
  const cols = db.pragma(`table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing('users', 'sms_phone', 'TEXT');
addColumnIfMissing('users', 'twofa_locked', 'INTEGER NOT NULL DEFAULT 0');
```

---

## 4. Backend — New Dependencies

Add to [`backend/package.json`](backend/package.json):

| Package | Version constraint | Purpose |
|---|---|---|
| `otplib` | `^12.0.1` | RFC 6238 TOTP generation & verification |
| `qrcode` | `^1.5.4` | QR code data-URI generation for enrolment |

No SMS gateway SDK is committed yet — the adapter is behind a thin interface (see §6.5) so the gateway can be swapped without touching route code.

```bash
cd backend && npm install otplib qrcode
```

---

## 5. Backend — Middleware Changes

**File:** [`backend/src/middleware/auth.js`](backend/src/middleware/auth.js)

### 5.1 Token type enforcement

The existing `requireAuth` middleware (line 5) accepts any valid JWT. It must be extended to validate the `type` claim so that `pending` and `challenge` tokens are rejected by session-protected endpoints.

**New export: `requireSession`** — wraps `requireAuth` and asserts `payload.type === 'session'`.

**New export: `requirePending`** — asserts `payload.type === 'pending'`. Used by `/api/auth/2fa/verify` and `/api/auth/2fa/otp/send`.

**Backwards-compatible change:** The existing `requireAuth` is updated to set `req.tokenType = payload.type` for downstream use but otherwise behaves identically. All existing routes that call `requireAuth` are updated to call `requireSession` instead.

### 5.2 Revised `auth.js` specification

```js
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function _verify(req, res, next, requiredType) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    if (requiredType && payload.type !== requiredType) {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    req.userId      = payload.userId;
    req.tokenType   = payload.type;
    req.tokenClaims = payload;   // full payload forwarded (used by transfer route)
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

const requireAuth    = (req, res, next) => _verify(req, res, next, null);
const requireSession = (req, res, next) => _verify(req, res, next, 'session');
const requirePending = (req, res, next) => _verify(req, res, next, 'pending');

module.exports = { requireAuth, requireSession, requirePending, JWT_SECRET };
```

> **Migration note:** Every existing route that currently calls `requireAuth` (`accounts.js`, the existing `transfer.js` POST) must be updated to call `requireSession` so that a `pending` token cannot be used to query account data.

---

## 6. Backend — Auth Routes

**File:** [`backend/src/routes/auth.js`](backend/src/routes/auth.js)

### 6.1 `POST /api/auth/login` — modified

**Current behaviour (line 54–76):** Returns `{ token }` unconditionally.

**New behaviour:**

```
Request:  { email: string, password: string }

Response A (twofa_enabled = 0):  200 { token: string }          ← unchanged
Response B (twofa_enabled = 1):  200 { pendingToken: string }
Response C (twofa_locked = 1):   423 { error: 'Account locked' }
```

Implementation steps:
1. After `bcrypt.compareSync` succeeds, check `user.twofa_locked`. If `1`, return `423`.
2. Check `user.twofa_enabled`. If `0`, sign a `{ userId, type: 'session' }` JWT with `expiresIn: '2h'` — identical to current line 74.
3. If `1`, sign a `{ userId, type: 'pending' }` JWT with `expiresIn: '5m'` and return `{ pendingToken }`. Do **not** issue a session token.
4. Write `audit_events` row: `event_type = '2fa_login_challenged'`.

### 6.2 `POST /api/auth/2fa/verify` — new

**Auth:** `requirePending` middleware.

```
Request:  { code: string }    -- TOTP code, SMS OTP, or backup code

Response (success):  200 { token: string }     -- full session token
Response (failure):  401 { error: 'Invalid code', attemptsRemaining: number }
Response (locked):   423 { error: 'Account locked' }
```

Implementation steps:
1. Load user from DB using `req.userId`.
2. Attempt to verify `code` in this priority order:
   a. **TOTP:** Call `totp.verify({ token: code, secret: decrypt(user.twofa_secret) })` from `otplib`.
   b. **SMS OTP:** Query `otp_codes` where `user_id = req.userId AND purpose = 'login' AND used = 0 AND expires_at > now`. For each unexpired row, `bcrypt.compareSync(code, row.code_hash)`. If match found, mark `used = 1`.
   c. **Backup code:** Query `backup_codes` where `user_id = req.userId AND used = 0`. For each row, `bcrypt.compareSync(code, row.code_hash)`. If match found, mark `used = 1`.
3. **On success:** Sign `{ userId, type: 'session' }` with `expiresIn: '2h'`. Write `audit_events` row `2fa_login_success`. Reset any transient attempt counter (see step 5). Return `{ token }`.
4. **On failure:** Increment `req.userId` attempt counter (in-memory map keyed by `userId`, or use the `otp_codes` table count). If count >= 5: set `users.twofa_locked = 1`, write `2fa_login_locked` audit event, return `423`. Otherwise write `2fa_login_failed` audit event, return `401 { error, attemptsRemaining }`.
5. The attempt counter is per-pending-token session. When the pending token expires (5 min), any new login will start a fresh pending token and reset the counter.

> **Note on attempt counter storage:** Because `better-sqlite3` is synchronous and single-process, an in-process `Map<userId, count>` is sufficient for MVP. The counter is cleared on success or when the pending JWT expires (the frontend will re-initiate login, producing a new userId/attempt entry).

### 6.3 `POST /api/auth/2fa/otp/send` — new

**Auth:** `requirePending` middleware.

```
Request:  {} (no body required; userId comes from pending token)

Response (success):  200 { message: 'OTP sent' }
Response (no phone): 400 { error: 'No mobile number registered' }
Response (rate limit): 429 { error: 'OTP send limit reached' }
```

Implementation steps:
1. Load user. If `sms_phone` is null/empty, return `400`.
2. Count rows in `otp_codes` where `user_id = req.userId AND purpose = 'login' AND created_at > (now - 10 minutes)`. If count >= 3, return `429` (BR-S-03).
3. Generate a cryptographically random 6-digit code using `crypto.randomInt(100000, 1000000).toString()`.
4. Hash it: `bcrypt.hashSync(code, 10)`.
5. Insert into `otp_codes`: `{ user_id, code_hash, purpose:'login', expires_at: now+5min, used:0 }`.
6. Dispatch the plaintext code to the SMS gateway adapter (see §6.5). **Do not log the code** (BR-S-04).
7. Write `audit_events` row `2fa_sms_sent` (no OTP value in metadata).
8. Return `{ message: 'OTP sent' }`.

### 6.4 TOTP Enrolment endpoints

Both endpoints require `requireSession` middleware.

#### `POST /api/auth/2fa/enrol/begin`

```
Request:  {} (no body)

Response: 200 {
  qrUri:     string,   -- data URI for QR code image (otpauth:// URI encoded as PNG)
  manualKey: string    -- base32 TOTP secret for manual entry
}
```

Implementation steps:
1. Generate secret: `authenticator.generateSecret()` from `otplib`.
2. Build OTP auth URI: `authenticator.keyuri(user.email, 'AxisBank', secret)`.
3. Generate QR data URI: `await QRCode.toDataURL(otpAuthUri)` from the `qrcode` package.
4. **Do not** write the secret to the database yet — enrolment is not confirmed.
5. Sign a short-lived intermediate token: `{ userId, type:'enrol', secret }` with `expiresIn: '10m'` and return it alongside `{ qrUri, manualKey, enrolToken }`. The frontend holds `enrolToken` and submits it in the confirm step.
6. Write `audit_events` row `2fa_enrol_begin`.

> **Alternative:** Store the unconfirmed secret server-side in a temporary `enrol_sessions` table. The token approach is simpler for a single-node deployment and avoids an additional table. If horizontal scaling is added later, replace with server-side storage.

#### `POST /api/auth/2fa/enrol/confirm`

```
Request:  { code: string, enrolToken: string }

Response (success): 200 { backupCodes: string[] }   -- 8 plaintext backup codes; shown once only
Response (failure): 400 { error: 'Invalid TOTP code' }
```

Implementation steps:
1. Verify `enrolToken` as a JWT with `type:'enrol'`. Extract `{ userId, secret }` from claims.
2. Verify `code` against `secret` using `totp.verify({ token: code, secret })`.
3. On failure, return `400`.
4. On success:
   a. Encrypt `secret` using AES-256-CBC: `iv = crypto.randomBytes(16)`, `key = Buffer.from(process.env.TOTP_ENCRYPTION_KEY, 'hex')`. Store `iv.toString('hex') + ':' + ciphertext.toString('hex')` in `users.twofa_secret`.
   b. Set `users.twofa_enabled = 1`.
   c. Generate 8 backup codes: `Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex'))` (10 hex chars each).
   d. Hash each and insert into `backup_codes` table.
   e. Write `audit_events` row `2fa_enrol_complete`.
   f. Return `{ backupCodes }` (plaintext; shown once, never stored plaintext — BR-C-02).

### 6.5 SMS Gateway Adapter

**File (new):** `backend/src/lib/smsGateway.js`

```js
/**
 * Thin interface for SMS dispatch.
 * Swap the implementation body when an SMS provider is onboarded.
 * The function must never throw — it catches internally and returns { ok, error }.
 */
async function sendSms(phoneNumber, message) {
  // TODO: replace stub with provider SDK call (e.g. Twilio, AWS SNS)
  console.log(`[SMS STUB] to=${phoneNumber} message=<redacted>`);
  return { ok: true };
}

module.exports = { sendSms };
```

The OTP value is passed as part of `message` but **must not** be logged. The stub above logs a redacted placeholder to make this explicit.

---

## 7. Backend — Transfer Routes

### 7.1 `POST /api/transfer/challenge` — new route

**File:** New handler added to [`backend/src/routes/transfer.js`](backend/src/routes/transfer.js) (or a separate `transferChallenge.js` registered alongside it in [`backend/src/index.js`](backend/src/index.js)).

**Auth:** `requireSession`.

```
Request:  { toAccountNumber: string, amountCents: number }

Response: 200 { challengeToken: string }   -- JWT, 5 min TTL
```

Implementation steps:
1. Validate `toAccountNumber` and `amountCents` (same guards as the existing transfer route).
2. Verify destination account exists and is not the sender's account (do not commit — read only).
3. Sign: `{ userId, type:'challenge', toAccountNumber, amountCents }` with `expiresIn: '5m'`.
4. If the user has `sms_phone`, also trigger an SMS OTP automatically (insert `otp_codes` row with `purpose:'transfer'`, dispatch SMS). This avoids a separate OTP-send call for the transfer flow.
5. Write `audit_events` row `2fa_transfer_challenged`.
6. Return `{ challengeToken }`.

### 7.2 `POST /api/transfer` — modified

**File:** [`backend/src/routes/transfer.js`](backend/src/routes/transfer.js)

**Auth:** `requireSession` (Bearer session token in `Authorization` header).

```
Request:  {
  toAccountNumber: string,
  amountCents:     number,
  challengeToken:  string,
  code:            string
}
```

**Implementation changes** (replacing the current no-op comment at line 27):

1. Validate `challengeToken` as a JWT with `type:'challenge'`.
2. Assert that `challengeToken.toAccountNumber === req.body.toAccountNumber` and `challengeToken.amountCents === req.body.amountCents` (BR-T-02 replay protection).
3. Assert that `challengeToken.userId === req.userId` (cross-user replay protection).
4. Verify `code` using the same priority order as §6.2 (TOTP → SMS OTP with `purpose:'transfer'` → backup code).
5. On OTP failure: write `2fa_transfer_failed` audit event, return `401`.
6. On success: proceed with the existing `db.transaction()` block unchanged. Write `2fa_transfer_success` audit event.
7. Return `{ balanceCents }` as today.

> **Backward compatibility note:** The transfer endpoint signature changes (two new required fields). The frontend must send them; any client that does not will receive a `400` immediately at validation step before any balance is touched.

---

## 8. Backend — Admin Routes

**File (new):** `backend/src/routes/admin.js`

Registered in [`backend/src/index.js`](backend/src/index.js) as `app.use('/api/admin', adminRoutes)`.

### 8.1 Admin token middleware

A separate `requireAdmin` middleware reads `ADMIN_SECRET` from `process.env`. Admin endpoints accept `Authorization: Bearer <ADMIN_SECRET>` directly (no JWT signing needed for this internal tool). If `ADMIN_SECRET` is unset, all admin endpoints return `503`.

### 8.2 `POST /api/admin/2fa/reset`

```
Request:  { userId: number }

Response: 200 { message: 'OK' }
```

Implementation steps:
1. Look up the user.
2. In a single transaction:
   a. `UPDATE users SET twofa_enabled = 0, twofa_secret = NULL, twofa_locked = 0 WHERE id = ?`
   b. `DELETE FROM backup_codes WHERE user_id = ?`
3. Write `audit_events` row `2fa_reset` with `metadata = { agentId: req.headers['x-agent-id'] }` (BR-R-02).
4. Trigger customer notification (email + in-app; stub for now — see §8.4).
5. Return `{ message: 'OK' }`.

### 8.3 `GET /api/admin/audit`

```
Query params:  userId (integer, optional), from (ISO date, optional), to (ISO date, optional)

Response: 200 { events: AuditEvent[] }
```

Implementation steps:
1. Build a parameterised SQL query against `audit_events`, applying `WHERE user_id = ?` and/or `WHERE created_at BETWEEN ? AND ?` only when the query params are present.
2. Return events ordered by `created_at DESC`, capped at 1000 rows per request.

### 8.4 Notification adapter (stub)

**File (new):** `backend/src/lib/notificationService.js`

```js
async function notify2faReset(userId) {
  // TODO: integrate with email provider and in-app notification queue
  console.log(`[NOTIFY STUB] 2FA reset notification for userId=${userId}`);
}

module.exports = { notify2faReset };
```

---

## 9. Frontend — API Client

**File:** [`frontend/src/api.js`](frontend/src/api.js)

The existing `request()` helper is unchanged. Add the following methods to the `api` export object:

```js
// --- 2FA: Login flow ---
verifyOtp: (pendingToken, code) =>
  request('/auth/2fa/verify', { method: 'POST', body: { code }, token: pendingToken }),

requestSmsOtp: (pendingToken) =>
  request('/auth/2fa/otp/send', { method: 'POST', token: pendingToken }),

// --- 2FA: TOTP Enrolment ---
enrolBegin: (token) =>
  request('/auth/2fa/enrol/begin', { method: 'POST', token }),

enrolConfirm: (token, code, enrolToken) =>
  request('/auth/2fa/enrol/confirm', { method: 'POST', body: { code, enrolToken }, token }),

// --- 2FA: Transfer step-up ---
transferChallenge: (token, toAccountNumber, amountCents) =>
  request('/transfer/challenge', { method: 'POST', body: { toAccountNumber, amountCents }, token }),

transfer: (token, toAccountNumber, amountCents, challengeToken, code) =>
  request('/transfer', {
    method: 'POST',
    body: { toAccountNumber, amountCents, challengeToken, code },
    token,
  }),
```

> The existing `api.transfer` method at line 26 is replaced by the new signature above.

---

## 10. Frontend — Auth Flow

**File:** [`frontend/src/AuthForm.jsx`](frontend/src/AuthForm.jsx)

### 10.1 State additions

```jsx
const [step, setStep]               = useState('credentials'); // 'credentials' | 'otp'
const [pendingToken, setPendingToken] = useState(null);
const [otpError, setOtpError]       = useState('');
const [otpLoading, setOtpLoading]   = useState(false);
const [smsSent, setSmsSent]         = useState(false);
```

### 10.2 `handleSubmit` changes

Replace the current `const { token } = await api.login(...)` destructure with:

```jsx
const result = await api.login(email, password);

if (result.token) {
  // twofa_enabled = 0: existing path unchanged
  onAuthenticated(result.token);
} else if (result.pendingToken) {
  // twofa_enabled = 1: show OTP step
  setPendingToken(result.pendingToken);
  setStep('otp');
}
```

### 10.3 New `OtpStep` component

Extract as a sibling file `frontend/src/OtpStep.jsx` (or inline in `AuthForm.jsx`):

```
Props:
  pendingToken: string
  onAuthenticated: (token: string) => void
  hasSmsOption: boolean      -- backend returns this alongside pendingToken
```

**Rendered elements:**
- `<input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} />` — OTP field (NFR-9).
- "Verify" button.
- "Send SMS code" button (rendered only when `hasSmsOption = true`; disabled after first send until resend timer clears).
- Attempt-remaining feedback and error message.

**Handler logic:**
1. `handleVerify`: calls `api.verifyOtp(pendingToken, code)`. On success, calls `onAuthenticated(token)`. On `401`, shows error + remaining attempts. On `423`, shows lockout message and returns to `credentials` step.
2. `handleSendSms`: calls `api.requestSmsOtp(pendingToken)`. On success, sets `smsSent = true` and starts a 60-second resend cooldown. On `429`, shows rate-limit message.

### 10.4 Conditional render in `AuthForm`

```jsx
if (step === 'otp') {
  return (
    <OtpStep
      pendingToken={pendingToken}
      onAuthenticated={onAuthenticated}
      hasSmsOption={hasSmsOption}
    />
  );
}
// ... existing credentials form
```

### 10.5 `hasSmsOption` flag

The login response is extended: `{ pendingToken, hasSmsOption: boolean }`. The backend sets this to `true` when `user.sms_phone` is non-null. This avoids an extra API call from the frontend to discover channel availability.

---

## 11. Frontend — Dashboard: Security Panel

**File:** [`frontend/src/Dashboard.jsx`](frontend/src/Dashboard.jsx)

### 11.1 Security tab

Add a "Security" card alongside the existing "Add funds" and "Send money" cards. It is rendered only when `me.user.twofa_enabled === 0` (not yet enrolled) or as a status indicator when enabled.

**When not enrolled:** Show an "Enable Two-Factor Authentication" call-to-action button that opens `EnrolWizard`.

**When enrolled:** Show "2FA is active" with a "Manage" option (out of scope for this phase; renders static text).

### 11.2 `EnrolWizard` component

New file: `frontend/src/EnrolWizard.jsx`

Three internal steps (`'begin' | 'confirm' | 'backupCodes'`):

#### Step `begin`
- On mount: calls `api.enrolBegin(token)`. Displays the returned `qrUri` as `<img src={qrUri} />` and `manualKey` in a copyable `<code>` block.
- Stores `enrolToken` from the response in component state.
- "Next" button advances to `confirm`.

#### Step `confirm`
- OTP input with `autoComplete="one-time-code"`.
- "Confirm" button calls `api.enrolConfirm(token, code, enrolToken)`.
- On success: stores backup codes in state, advances to `backupCodes`.
- On failure: shows "Incorrect code, try again" error.

#### Step `backupCodes`
- Displays all 8 backup codes in a monospace list.
- "Download" button generates a `data:text/plain` blob download of the codes.
- "Done" button closes the wizard and calls `onEnrolComplete()` (which triggers `me` refresh so the security panel updates).

### 11.3 Dashboard state additions

```jsx
const [showEnrol, setShowEnrol] = useState(false);
```

---

## 12. Frontend — Dashboard: Transfer Step-Up

**File:** [`frontend/src/Dashboard.jsx`](frontend/src/Dashboard.jsx)

### 12.1 `handleTransfer` changes

Replace the current single `api.transfer(...)` call:

```jsx
async function handleTransfer(e) {
  e.preventDefault();
  setError('');
  setActionLoading(true);

  const amountCents = Math.round(Number(transferAmount) * 100);

  try {
    // Step 1: request challenge token
    const { challengeToken } = await api.transferChallenge(token, transferTo, amountCents);

    // Step 2: show OTP modal
    setTransferChallenge({ challengeToken, toAccountNumber: transferTo, amountCents });
    setShowTransferOtp(true);
  } catch (err) {
    setError(err.message);
  } finally {
    setActionLoading(false);
  }
}
```

### 12.2 `TransferOtpModal` component

New file: `frontend/src/TransferOtpModal.jsx`

```
Props:
  challengeToken:    string
  toAccountNumber:   string
  amountCents:       number
  sessionToken:      string
  onSuccess:         () => void    -- refresh + close
  onCancel:          () => void    -- close without transfer
```

**Rendered elements:**
- Transfer summary: "Sending ₹X to account NNNN — enter your 6-digit code to confirm."
- OTP `<input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} />`.
- "Confirm Transfer" button.
- "Cancel" button.

**Handler:** On confirm, calls `api.transfer(sessionToken, toAccountNumber, amountCents, challengeToken, code)`. On success, calls `onSuccess()`. On error, shows error inline.

### 12.3 Dashboard state additions

```jsx
const [showTransferOtp, setShowTransferOtp]   = useState(false);
const [transferChallenge, setTransferChallenge] = useState(null);
```

---

## 13. Token Contracts

| Token type | Claim shape | TTL | Issued by | Accepted by |
|---|---|---|---|---|
| `session` | `{ userId, type:'session', iat, exp }` | 2 h | `POST /api/auth/login` (no-2FA path) or `POST /api/auth/2fa/verify` | All `requireSession` endpoints |
| `pending` | `{ userId, type:'pending', iat, exp }` | 5 min | `POST /api/auth/login` (2FA path) | `POST /api/auth/2fa/verify`, `POST /api/auth/2fa/otp/send` |
| `challenge` | `{ userId, type:'challenge', toAccountNumber, amountCents, iat, exp }` | 5 min | `POST /api/transfer/challenge` | `POST /api/transfer` |
| `enrol` | `{ userId, type:'enrol', secret, iat, exp }` | 10 min | `POST /api/auth/2fa/enrol/begin` | `POST /api/auth/2fa/enrol/confirm` |

All tokens are signed with `JWT_SECRET` (single signing key). The `type` claim is validated by middleware to enforce purpose-binding (NFR-4).

---

## 14. OTP Lifecycle

### 14.1 SMS OTP (login)

```
1. POST /api/auth/2fa/otp/send (pendingToken)
   → generate 6-digit code
   → bcrypt-hash → INSERT otp_codes (purpose='login', expires_at=now+5min)
   → dispatch plaintext code via smsGateway.sendSms()
   → return { message: 'OTP sent' }

2. POST /api/auth/2fa/verify (pendingToken) { code }
   → SELECT unexpired, unused rows WHERE purpose='login' AND user_id=?
   → bcrypt.compareSync(code, row.code_hash) for each row
   → on match: UPDATE otp_codes SET used=1 WHERE id=?
               → issue session token
   → on no match: increment attempt counter
```

### 14.2 SMS OTP (transfer)

```
1. POST /api/transfer/challenge (sessionToken)
   → auto-generate OTP (same as above but purpose='transfer')
   → return { challengeToken }

2. POST /api/transfer (sessionToken) { ..., challengeToken, code }
   → verify challengeToken claims
   → SELECT unexpired, unused rows WHERE purpose='transfer' AND user_id=?
   → bcrypt.compareSync for each row
   → on match: proceed with transfer transaction
```

### 14.3 TOTP verification

TOTP codes are stateless. Verification is: `authenticator.verify({ token: code, secret: decrypt(user.twofa_secret) })` from `otplib`. `otplib` checks the current 30-second window ±1 window by default. No database row is created or consumed.

### 14.4 Backup code consumption

```
SELECT * FROM backup_codes WHERE user_id = ? AND used = 0
→ for each row: bcrypt.compareSync(code, row.code_hash)
→ on match: UPDATE backup_codes SET used = 1 WHERE id = ?
            → treat as successful second factor
```

---

## 15. Audit Event Catalogue

All events written to the `audit_events` table. `metadata` is a JSON-serialised object.

| `event_type` | Trigger | Key metadata fields |
|---|---|---|
| `2fa_login_challenged` | Login response sends `pendingToken` | `{ method: 'totp' \| 'sms' \| 'both' }` |
| `2fa_login_success` | `/api/auth/2fa/verify` succeeds | `{ method: 'totp' \| 'sms' \| 'backup' }` |
| `2fa_login_failed` | `/api/auth/2fa/verify` fails | `{ attemptsRemaining: number }` |
| `2fa_login_locked` | Max attempts exceeded | `{}` |
| `2fa_sms_sent` | OTP dispatched via SMS | `{ purpose: 'login' \| 'transfer' }` |
| `2fa_enrol_begin` | Enrolment wizard started | `{}` |
| `2fa_enrol_complete` | `twofa_enabled` set to 1 | `{}` |
| `2fa_transfer_challenged` | Challenge token issued | `{ toAccountNumber, amountCents }` |
| `2fa_transfer_success` | Transfer committed post step-up | `{ toAccountNumber, amountCents }` |
| `2fa_transfer_failed` | Step-up OTP incorrect | `{}` |
| `2fa_reset` | Admin reset | `{ agentId: string, customerId: number }` |

Helper function (add to `db.js` or a shared `audit.js` module):

```js
// backend/src/lib/audit.js
const db = require('../db');

const insertAudit = db.prepare(`
  INSERT INTO audit_events (event_type, user_id, ip_address, user_agent, metadata)
  VALUES (?, ?, ?, ?, ?)
`);

function writeAudit(eventType, userId, req, metadata = {}) {
  insertAudit.run(
    eventType,
    userId ?? null,
    req?.ip ?? null,
    req?.headers?.['user-agent'] ?? null,
    JSON.stringify(metadata),
  );
}

module.exports = { writeAudit };
```

---

## 16. Security Controls

| Control | Implementation |
|---|---|
| TOTP secret encryption at rest (BR-E-05, BR-C-02) | AES-256-CBC; key in `TOTP_ENCRYPTION_KEY` env var (32-byte hex string); `iv:ciphertext` stored in `twofa_secret` |
| OTP never logged (BR-S-04, NFR-6) | `smsGateway.js` logs `<redacted>` placeholder only; OTP not included in any `console.log`, `writeAudit` metadata, or error response |
| Pending/challenge token isolation (NFR-4) | `requireSession` rejects any token where `type !== 'session'`; `requirePending` rejects any token where `type !== 'pending'` |
| Brute-force lockout (NFR-5, BR-L-03) | In-memory counter per `userId`; 5 failures → `twofa_locked = 1`; further login attempts return `423` |
| SMS pump prevention (BR-S-03) | Max 3 `otp/send` requests counted against `otp_codes` rows per 10-minute window |
| OTP single-use (BR-S-02) | `used = 1` marked atomically on first successful `bcrypt.compareSync` match |
| Backup codes single-use (BR-E-04) | `used = 1` on first consumption |
| Transfer replay prevention (BR-T-02) | `challengeToken` claims must exactly match transfer body; JWT is single-use by TTL (5 min) |
| Audit log retention (BR-C-04, NFR-7) | `audit_events` table never deleted; database backup policy enforces ≥ 5-year retention (ops responsibility) |
| `JWT_SECRET` rotation | Per BRD §11 assumption 5, `JWT_SECRET` env var is rotated at go-live to invalidate pre-2FA sessions |
| `TOTP_ENCRYPTION_KEY` | Add to `.env.example`; document in project README; inject via CI/CD secrets manager |

---

## 17. Error Codes Reference

| HTTP status | Error string | Scenario |
|---|---|---|
| `400` | `'email and password are required'` | Login missing fields (existing) |
| `400` | `'No mobile number registered'` | `otp/send` called with no `sms_phone` |
| `400` | `'Invalid TOTP code'` | Enrolment confirm — bad code |
| `400` | `'Challenge token mismatch'` | Transfer body differs from challenge claims |
| `401` | `'Invalid or expired token'` | JWT signature/expiry check fails |
| `401` | `'Invalid token type'` | Wrong token type for endpoint |
| `401` | `'Invalid code'` | OTP verification failure; includes `attemptsRemaining` |
| `423` | `'Account locked'` | `twofa_locked = 1` or max attempts hit |
| `429` | `'OTP send limit reached'` | > 3 OTP sends in window |
| `503` | `'Admin endpoint unavailable'` | `ADMIN_SECRET` env var not set |

---

## 18. Acceptance Criteria Mapping

| AC | Scenario | Component(s) tested |
|---|---|---|
| AC-01 | `twofa_enabled = 0` login → `{ token }` immediately | `POST /api/auth/login` (§6.1) |
| AC-02 | `twofa_enabled = 1` login → `{ pendingToken }`, no session token | `POST /api/auth/login` (§6.1) |
| AC-03 | Correct TOTP against pending token → session token | `POST /api/auth/2fa/verify` (§6.2) |
| AC-04 | 5 incorrect OTPs → lockout + Fraud Ops alert (`2fa_login_locked` event) | `POST /api/auth/2fa/verify` (§6.2) |
| AC-05 | Expired pending token → `401` | JWT TTL; `requirePending` middleware (§5.2) |
| AC-06 | Transfer without `challengeToken` / `code` → `400` | `POST /api/transfer` validation (§7.2) |
| AC-07 | Valid step-up + matching intent → transfer committed | `POST /api/transfer` (§7.2) |
| AC-08 | Replayed `challengeToken` for different amount → `400` | Claims matching in `POST /api/transfer` (§7.2) |
| AC-09 | TOTP enrolment → `twofa_enabled = 1`; 8 backup codes issued | `POST /api/auth/2fa/enrol/confirm` (§6.4) |
| AC-10 | Admin reset → `twofa_enabled = 0`; audit event written; user notified | `POST /api/admin/2fa/reset` (§8.2) |
| AC-11 | Fraud Ops audit query by `userId` + date range | `GET /api/admin/audit` (§8.3) |
| AC-12 | 4th SMS OTP request in session → `429` | `POST /api/auth/2fa/otp/send` (§6.3) |

---

## 19. Open Items

| ID | Item | Owner | Priority |
|---|---|---|---|
| OI-01 | Select and contract SMS gateway provider (Twilio / AWS SNS) | Product / Procurement | 🔴 Blocker for SMS OTP |
| OI-02 | Provision `TOTP_ENCRYPTION_KEY` in all environments (dev, staging, prod) and CI/CD | InfoSec / DevOps | 🔴 Blocker for enrolment |
| OI-03 | Confirm RBI remediation deadline date with Compliance | Compliance | 🟠 High — affects sprint priority |
| OI-04 | Decide attempt-counter persistence strategy (in-memory vs DB) if horizontal scaling is planned before go-live | Architecture | 🟡 Medium |
| OI-05 | Design email notification template for 2FA reset (BR-R-02) | UX / CX | 🟡 Medium |
| OI-06 | Define `ADMIN_SECRET` rotation policy and document in runbook | InfoSec | 🟡 Medium |
| OI-07 | Add `autocomplete="one-time-code"` to OTP inputs and validate on mobile (NFR-9) | Frontend | 🟢 Low |
| OI-08 | Load-test `POST /api/auth/2fa/verify` to confirm < 500 ms p95 (NFR-1) — note `bcrypt` cost factor | Backend | 🟢 Low (pre-UAT) |

---

*End of document*
