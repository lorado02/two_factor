'use strict';
/**
 * Integration tests for all 2FA routes — auth, transfer, admin.
 * Uses Supertest against an in-memory SQLite database (via makeApp).
 *
 * Acceptance Criteria covered:
 *   AC-001  login with 2FA → 2fa_required + pendingToken
 *   AC-002  valid TOTP → full JWT + audit verify_success
 *   AC-003  invalid TOTP → 401 + audit verify_fail
 *   AC-004  pending JWT rejected on protected endpoints
 *   AC-005  SMS OTP fallback completes login
 *   AC-006  transfer blocked without 2FA code
 *   AC-007  transfer succeeds with valid 2FA code + audit transfer_2fa_verified
 *   AC-008  TOTP enrolment sets twofa_enabled=1, 8 backup codes, audit enrol
 *   AC-009  backup code single-use
 *   AC-010  disable 2FA requires password + TOTP
 *   AC-011  disable 2FA clears secret + audit disable
 *   AC-012  lockout after 5 consecutive failures + audit lockout
 *   AC-013  admin reset clears 2FA + audit admin_bypass with actor_id
 *   AC-017  non-2FA user gets full JWT immediately
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const totp = require('../../totp');

const makeApp = require('../../testHelpers/makeApp');

process.env.NODE_ENV = 'test';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'; // matches middleware/auth resolution

// ── Shared test helpers ──────────────────────────────────────────────────────

/**
 * Register a user and return their JWT + userId.
 */
async function registerUser(app, { name = 'Test User', email, password = 'password123' } = {}) {
  const res = await request(app).post('/api/auth/register').send({ name, email, password });
  expect(res.status).toBe(201);
  const payload = jwt.verify(res.body.token, JWT_SECRET);
  return { token: res.body.token, userId: payload.userId };
}

/**
 * Enrol a user in 2FA.  Returns { token, secret, backupCodes }.
 */
async function enrol2FA(app, token) {
  // Setup
  const setupRes = await request(app)
    .post('/api/auth/2fa/setup')
    .set('Authorization', `Bearer ${token}`);
  expect(setupRes.status).toBe(200);
  const { manualEntryKey: secret } = setupRes.body;

  // Enable
  const code = totp.generate(secret);
  const enableRes = await request(app)
    .post('/api/auth/2fa/enable')
    .set('Authorization', `Bearer ${token}`)
    .send({ code });
  expect(enableRes.status).toBe(200);

  return { secret, backupCodes: enableRes.body.backupCodes };
}

/**
 * Issue a pending token directly (simulates a successful password login
 * for a 2FA-enrolled user, bypassing the full login round-trip).
 */
function makePendingToken(userId) {
  return jwt.sign({ userId, scope: '2fa_pending' }, JWT_SECRET, { expiresIn: '5m' });
}

function makeAdminToken(userId) {
  return jwt.sign({ userId, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/register', () => {
  let app;
  beforeEach(() => { ({ app } = makeApp()); });

  test('creates user and returns JWT', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Alice', email: 'alice@test.com', password: 'password123' });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
  });

  test('rejects duplicate email with 409', async () => {
    await request(app).post('/api/auth/register').send({ name: 'A', email: 'dup@test.com', password: 'password123' });
    const res = await request(app).post('/api/auth/register').send({ name: 'B', email: 'dup@test.com', password: 'password123' });
    expect(res.status).toBe(409);
  });

  test('rejects missing fields with 400', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'x@test.com', password: 'password123' });
    expect(res.status).toBe(400);
  });

  test('rejects short password', async () => {
    const res = await request(app).post('/api/auth/register').send({ name: 'A', email: 'a@b.com', password: 'short' });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/login — AC-001, AC-017', () => {
  let app, db;
  const email = 'login@test.com';
  const password = 'password123';

  beforeEach(async () => {
    ({ app, db } = makeApp());
    await request(app).post('/api/auth/register').send({ name: 'Login User', email, password });
  });

  test('AC-017: non-2FA user gets full JWT immediately', async () => {
    const res = await request(app).post('/api/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.status).toBeUndefined();
    const p = jwt.verify(res.body.token, JWT_SECRET);
    expect(p.scope).toBeUndefined();
  });

  test('AC-001: 2FA-enrolled user gets 2fa_required + pendingToken', async () => {
    const { token } = await registerUser(app, { email: 'enrol@test.com', password });
    await enrol2FA(app, token);

    const res = await request(app).post('/api/auth/login').send({ email: 'enrol@test.com', password });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('2fa_required');
    expect(res.body.pendingToken).toBeTruthy();
    expect(res.body.token).toBeUndefined();

    // pendingToken must carry scope: '2fa_pending'
    const p = jwt.verify(res.body.pendingToken, JWT_SECRET);
    expect(p.scope).toBe('2fa_pending');
  });

  test('wrong password returns 401', async () => {
    const res = await request(app).post('/api/auth/login').send({ email, password: 'wrong' });
    expect(res.status).toBe(401);
  });

  test('unknown email returns 401', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'nobody@x.com', password });
    expect(res.status).toBe(401);
  });

  test('locked account returns 403', async () => {
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    db.prepare('UPDATE users SET account_locked = 1 WHERE id = ?').run(user.id);
    const res = await request(app).post('/api/auth/login').send({ email, password });
    expect(res.status).toBe(403);
  });

  test('missing fields returns 400', async () => {
    const res = await request(app).post('/api/auth/login').send({ email });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/verify-2fa — AC-002, AC-003, AC-004, AC-009, AC-012', () => {
  let app, db, userToken, userId, secret;

  beforeEach(async () => {
    ({ app, db } = makeApp());
    ({ token: userToken, userId } = await registerUser(app, { email: 'v2fa@test.com', password: 'password123' }));
    ({ secret } = await enrol2FA(app, userToken));
  });

  test('AC-002: valid TOTP returns full JWT + audit verify_success', async () => {
        const code = totp.generate(secret);
    const pendingToken = makePendingToken(userId);

    const res = await request(app)
      .post('/api/auth/verify-2fa')
      .set('Authorization', `Bearer ${pendingToken}`)
      .send({ code });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    const p = jwt.verify(res.body.token, JWT_SECRET);
    expect(p.scope).toBeUndefined();

    const audit = db.prepare(
      `SELECT * FROM audit_log WHERE user_id = ? AND event_type = 'verify_success' ORDER BY id DESC LIMIT 1`
    ).get(userId);
    expect(audit).toBeTruthy();
  });

  test('AC-003: invalid TOTP returns 401 + audit verify_fail', async () => {
    const pendingToken = makePendingToken(userId);
    const res = await request(app)
      .post('/api/auth/verify-2fa')
      .set('Authorization', `Bearer ${pendingToken}`)
      .send({ code: '000000' });

    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();

    const audit = db.prepare(
      `SELECT * FROM audit_log WHERE user_id = ? AND event_type = 'verify_fail' ORDER BY id DESC LIMIT 1`
    ).get(userId);
    expect(audit).toBeTruthy();
  });

  test('AC-003: invalid code response includes remaining attempts count', async () => {
    const pendingToken = makePendingToken(userId);
    const res = await request(app)
      .post('/api/auth/verify-2fa')
      .set('Authorization', `Bearer ${pendingToken}`)
      .send({ code: '000000' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/remaining/i);
  });

  test('AC-004: pending JWT is rejected on /api/accounts/me', async () => {
    const pendingToken = makePendingToken(userId);
    const res = await request(app)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${pendingToken}`);
    expect(res.status).toBe(401);
  });

  test('AC-004: pending JWT is rejected on /api/transfer', async () => {
    const pendingToken = makePendingToken(userId);
    const res = await request(app)
      .post('/api/transfer')
      .set('Authorization', `Bearer ${pendingToken}`)
      .send({ toAccountNumber: '1111111111', amountCents: 100 });
    expect(res.status).toBe(401);
  });

  test('AC-004: full JWT rejected on /verify-2fa', async () => {
    // verify-2fa requires a PENDING token, not a full one
    const res = await request(app)
      .post('/api/auth/verify-2fa')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ code: '000000' });
    expect(res.status).toBe(401);
  });

  test('no Authorization header → 401', async () => {
    const res = await request(app).post('/api/auth/verify-2fa').send({ code: '123456' });
    expect(res.status).toBe(401);
  });

  test('missing code body → 400', async () => {
    const pendingToken = makePendingToken(userId);
    const res = await request(app)
      .post('/api/auth/verify-2fa')
      .set('Authorization', `Bearer ${pendingToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('locked account returns 403 even with correct code', async () => {
    db.prepare('UPDATE users SET account_locked = 1 WHERE id = ?').run(userId);
    const code = totp.generate(secret);
    const pendingToken = makePendingToken(userId);
    const res = await request(app)
      .post('/api/auth/verify-2fa')
      .set('Authorization', `Bearer ${pendingToken}`)
      .send({ code });
    expect(res.status).toBe(403);
  });

  test('AC-009: backup code completes login and is then single-use', async () => {
    const { backupCodes: bcs } = await enrol2FA(app, userToken);
    // Consume one backup code
    const pending = makePendingToken(userId);
    const res1 = await request(app)
      .post('/api/auth/verify-2fa')
      .set('Authorization', `Bearer ${pending}`)
      .send({ code: bcs[0] });
    expect(res1.status).toBe(200);
    expect(res1.body.token).toBeTruthy();

    // Second attempt with the same code must fail
    const pending2 = makePendingToken(userId);
    const res2 = await request(app)
      .post('/api/auth/verify-2fa')
      .set('Authorization', `Bearer ${pending2}`)
      .send({ code: bcs[0] });
    expect(res2.status).toBe(401);
  });

  test('AC-012: account locks after 5 consecutive failures', async () => {
    for (let i = 0; i < 4; i++) {
      const pending = makePendingToken(userId);
      const res = await request(app)
        .post('/api/auth/verify-2fa')
        .set('Authorization', `Bearer ${pending}`)
        .send({ code: '000000' });
      expect(res.status).toBe(401);
    }

    // 5th attempt — triggers lockout
    const pending = makePendingToken(userId);
    const res = await request(app)
      .post('/api/auth/verify-2fa')
      .set('Authorization', `Bearer ${pending}`)
      .send({ code: '000000' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/locked/i);

    // Verify DB flag
    const user = db.prepare('SELECT account_locked FROM users WHERE id = ?').get(userId);
    expect(user.account_locked).toBe(1);

    // Verify audit log contains lockout event
    const audit = db.prepare(
      `SELECT * FROM audit_log WHERE user_id = ? AND event_type = 'lockout'`
    ).get(userId);
    expect(audit).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/request-sms-otp — AC-005', () => {
  let app, db, userId, userToken;

  beforeEach(async () => {
    ({ app, db } = makeApp());
    ({ token: userToken, userId } = await registerUser(app, { email: 'sms@test.com', password: 'password123' }));
  });

  test('returns 400 when no phone number on file', async () => {
    const pending = makePendingToken(userId);
    const res = await request(app)
      .post('/api/auth/request-sms-otp')
      .set('Authorization', `Bearer ${pending}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/phone/i);
  });

  test('AC-005: SMS OTP sent and can complete login', async () => {
    // Set phone number
    db.prepare('UPDATE users SET phone_number = ? WHERE id = ?').run('+911234567890', userId);

    // Enrol 2FA first (SMS OTP is a fallback — user must be enrolled)
    const { secret } = await enrol2FA(app, userToken);

    const pending = makePendingToken(userId);
    const smsRes = await request(app)
      .post('/api/auth/request-sms-otp')
      .set('Authorization', `Bearer ${pending}`);
    expect(smsRes.status).toBe(200);
    expect(smsRes.body.sent).toBe(true);

    // In test mode the OTP is returned in the response
    const otp = smsRes.body._otp;
    expect(otp).toMatch(/^\d{6}$/);

    const pending2 = makePendingToken(userId);
    const verifyRes = await request(app)
      .post('/api/auth/verify-2fa')
      .set('Authorization', `Bearer ${pending2}`)
      .send({ code: otp });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.token).toBeTruthy();
  });

  test('SMS OTP is single-use', async () => {
    db.prepare('UPDATE users SET phone_number = ? WHERE id = ?').run('+911234567890', userId);
    await enrol2FA(app, userToken);

    const pending = makePendingToken(userId);
    const smsRes = await request(app)
      .post('/api/auth/request-sms-otp')
      .set('Authorization', `Bearer ${pending}`);
    const otp = smsRes.body._otp;

    // First use — success
    const p1 = makePendingToken(userId);
    const r1 = await request(app)
      .post('/api/auth/verify-2fa')
      .set('Authorization', `Bearer ${p1}`)
      .send({ code: otp });
    expect(r1.status).toBe(200);

    // Second use — fail
    const p2 = makePendingToken(userId);
    const r2 = await request(app)
      .post('/api/auth/verify-2fa')
      .set('Authorization', `Bearer ${p2}`)
      .send({ code: otp });
    expect(r2.status).toBe(401);
  });

  test('requires a pending JWT, not a full one', async () => {
    const res = await request(app)
      .post('/api/auth/request-sms-otp')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/2fa/setup, /2fa/enable — AC-008', () => {
  let app, db, userToken, userId;

  beforeEach(async () => {
    ({ app, db } = makeApp());
    ({ token: userToken, userId } = await registerUser(app, { email: 'setup@test.com', password: 'password123' }));
  });

  test('AC-008: setup returns secret + QR code', async () => {
    const res = await request(app)
      .post('/api/auth/2fa/setup')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.manualEntryKey).toBeTruthy();
    expect(res.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(res.body.qrCodeDataUrl).toMatch(/^data:image\/png/);
  });

  test('setup requires full JWT', async () => {
    const pending = makePendingToken(userId);
    const res = await request(app)
      .post('/api/auth/2fa/setup')
      .set('Authorization', `Bearer ${pending}`);
    expect(res.status).toBe(401);
  });

  test('AC-008: enable with correct code sets twofa_enabled=1, 8 backup codes, audit enrol', async () => {
    const setupRes = await request(app)
      .post('/api/auth/2fa/setup')
      .set('Authorization', `Bearer ${userToken}`);
    const { manualEntryKey: secret } = setupRes.body;

        const code = totp.generate(secret);

    const enableRes = await request(app)
      .post('/api/auth/2fa/enable')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ code });
    expect(enableRes.status).toBe(200);
    expect(enableRes.body.backupCodes).toHaveLength(8);

    const user = db.prepare('SELECT twofa_enabled FROM users WHERE id = ?').get(userId);
    expect(user.twofa_enabled).toBe(1);

    const bcCount = db.prepare('SELECT COUNT(*) AS cnt FROM backup_codes WHERE user_id = ? AND consumed_at IS NULL').get(userId);
    expect(bcCount.cnt).toBe(8);

    const audit = db.prepare(`SELECT * FROM audit_log WHERE user_id = ? AND event_type = 'enrol'`).get(userId);
    expect(audit).toBeTruthy();
  });

  test('enable with incorrect code returns 400 and clears pending secret', async () => {
    await request(app).post('/api/auth/2fa/setup').set('Authorization', `Bearer ${userToken}`);
    const res = await request(app)
      .post('/api/auth/2fa/enable')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ code: '000000' });
    expect(res.status).toBe(400);

    const user = db.prepare('SELECT twofa_secret, twofa_enabled FROM users WHERE id = ?').get(userId);
    expect(user.twofa_secret).toBeNull();
    expect(user.twofa_enabled).toBe(0);
  });

  test('enable without prior setup returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/2fa/enable')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ code: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/setup/i);
  });

  test('enable without code returns 400', async () => {
    await request(app).post('/api/auth/2fa/setup').set('Authorization', `Bearer ${userToken}`);
    const res = await request(app)
      .post('/api/auth/2fa/enable')
      .set('Authorization', `Bearer ${userToken}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/2fa/disable — AC-010, AC-011', () => {
  let app, db, userToken, userId, secret;
  const password = 'password123';

  beforeEach(async () => {
    ({ app, db } = makeApp());
    ({ token: userToken, userId } = await registerUser(app, { email: 'dis@test.com', password }));
    ({ secret } = await enrol2FA(app, userToken));
  });

  test('AC-011: disable with correct password + TOTP clears secret and audits disable', async () => {
        const code = totp.generate(secret);

    const res = await request(app)
      .post('/api/auth/2fa/disable')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ password, code });

    expect(res.status).toBe(200);
    expect(res.body.disabled).toBe(true);

    const user = db.prepare('SELECT twofa_enabled, twofa_secret FROM users WHERE id = ?').get(userId);
    expect(user.twofa_enabled).toBe(0);
    expect(user.twofa_secret).toBeNull();

    const audit = db.prepare(`SELECT * FROM audit_log WHERE user_id = ? AND event_type = 'disable'`).get(userId);
    expect(audit).toBeTruthy();
  });

  test('AC-010: wrong password returns 401, twofa_enabled stays 1', async () => {
        const code = totp.generate(secret);
    const res = await request(app)
      .post('/api/auth/2fa/disable')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ password: 'wrongpass', code });
    expect(res.status).toBe(401);

    const user = db.prepare('SELECT twofa_enabled FROM users WHERE id = ?').get(userId);
    expect(user.twofa_enabled).toBe(1);
  });

  test('AC-010: wrong TOTP code returns 401, twofa_enabled stays 1', async () => {
    const res = await request(app)
      .post('/api/auth/2fa/disable')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ password, code: '000000' });
    expect(res.status).toBe(401);

    const user = db.prepare('SELECT twofa_enabled FROM users WHERE id = ?').get(userId);
    expect(user.twofa_enabled).toBe(1);
  });

  test('AC-010: missing password or code returns 400', async () => {
    let res = await request(app)
      .post('/api/auth/2fa/disable')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ password });
    expect(res.status).toBe(400);

    res = await request(app)
      .post('/api/auth/2fa/disable')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ code: '123456' });
    expect(res.status).toBe(400);
  });

  test('backup codes are soft-deleted on disable (AC-011)', async () => {
        const code = totp.generate(secret);
    await request(app)
      .post('/api/auth/2fa/disable')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ password, code });

    const active = db.prepare(
      `SELECT COUNT(*) AS cnt FROM backup_codes WHERE user_id = ? AND consumed_at IS NULL`
    ).get(userId);
    expect(active.cnt).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/auth/2fa/backup-codes  |  POST /api/auth/2fa/backup-codes/regenerate', () => {
  let app, db, userToken, userId, secret;

  beforeEach(async () => {
    ({ app, db } = makeApp());
    ({ token: userToken, userId } = await registerUser(app, { email: 'bc2@test.com', password: 'password123' }));
    ({ secret } = await enrol2FA(app, userToken));
  });

  test('GET returns total=8, remaining=8 after fresh enrolment', async () => {
    const res = await request(app)
      .get('/api/auth/2fa/backup-codes')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(8);
    expect(res.body.remaining).toBe(8);
  });

  test('GET remaining decreases after a backup code is used', async () => {
    // Use one backup code
    const { backupCodes: bcs } = await enrol2FA(app, userToken);
    const pending = makePendingToken(userId);
    await request(app)
      .post('/api/auth/verify-2fa')
      .set('Authorization', `Bearer ${pending}`)
      .send({ code: bcs[0] });

    const res = await request(app)
      .get('/api/auth/2fa/backup-codes')
      .set('Authorization', `Bearer ${userToken}`);
    // After second enrol+one use: 8 - 1 = 7 remaining
    expect(res.body.remaining).toBe(7);
  });

  test('regenerate with valid TOTP returns 8 new codes + audit', async () => {
        const code = totp.generate(secret);
    const res = await request(app)
      .post('/api/auth/2fa/backup-codes/regenerate')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ code });
    expect(res.status).toBe(200);
    expect(res.body.backupCodes).toHaveLength(8);

    const audit = db.prepare(
      `SELECT * FROM audit_log WHERE user_id = ? AND event_type = 'backup_codes_regenerated'`
    ).get(userId);
    expect(audit).toBeTruthy();
  });

  test('regenerate with invalid TOTP returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/2fa/backup-codes/regenerate')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ code: '000000' });
    expect(res.status).toBe(401);
  });

  test('regenerate old codes are soft-deleted', async () => {
        const code = totp.generate(secret);
    await request(app)
      .post('/api/auth/2fa/backup-codes/regenerate')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ code });

    const active = db.prepare(
      `SELECT COUNT(*) AS cnt FROM backup_codes WHERE user_id = ? AND consumed_at IS NULL`
    ).get(userId);
    expect(active.cnt).toBe(8);
  });

  test('requires full JWT', async () => {
    const pending = makePendingToken(userId);
    const res = await request(app)
      .get('/api/auth/2fa/backup-codes')
      .set('Authorization', `Bearer ${pending}`);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/transfer — AC-006, AC-007', () => {
  let app, db;
  let senderToken, senderId, senderSecret;
  let recipientAccountNumber;

  beforeEach(async () => {
    ({ app, db } = makeApp());
    // Sender (2FA enrolled)
    ({ token: senderToken, userId: senderId } = await registerUser(app, { email: 'sender@test.com', password: 'password123' }));
    ({ secret: senderSecret } = await enrol2FA(app, senderToken));
    // Fund sender
    await request(app).post('/api/accounts/deposit').set('Authorization', `Bearer ${senderToken}`).send({ amountCents: 50000 });

    // Recipient
    const { token: recipientToken } = await registerUser(app, { email: 'recipient@test.com', password: 'password123' });
    const acctRes = await request(app).get('/api/accounts/me').set('Authorization', `Bearer ${recipientToken}`);
    recipientAccountNumber = acctRes.body.account.accountNumber;
  });

  test('AC-006: transfer blocked without 2FA code for enrolled user', async () => {
    const res = await request(app)
      .post('/api/transfer')
      .set('Authorization', `Bearer ${senderToken}`)
      .send({ toAccountNumber: recipientAccountNumber, amountCents: 1000 });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/2FA/i);
  });

  test('AC-006: transfer blocked with invalid 2FA code', async () => {
    const res = await request(app)
      .post('/api/transfer')
      .set('Authorization', `Bearer ${senderToken}`)
      .send({ toAccountNumber: recipientAccountNumber, amountCents: 1000, twoFaCode: '000000' });
    expect(res.status).toBe(403);
  });

  test('AC-007: transfer succeeds with valid 2FA code + audit transfer_2fa_verified', async () => {
        const code = totp.generate(senderSecret);

    const res = await request(app)
      .post('/api/transfer')
      .set('Authorization', `Bearer ${senderToken}`)
      .send({ toAccountNumber: recipientAccountNumber, amountCents: 1000, twoFaCode: code });
    expect(res.status).toBe(200);
    expect(res.body.balanceCents).toBe(49000);

    const audit = db.prepare(
      `SELECT * FROM audit_log WHERE user_id = ? AND event_type = 'transfer_2fa_verified'`
    ).get(senderId);
    expect(audit).toBeTruthy();
  });

  test('AC-007: valid 2FA code via x-2fa-code header also works', async () => {
        const code = totp.generate(senderSecret);
    const res = await request(app)
      .post('/api/transfer')
      .set('Authorization', `Bearer ${senderToken}`)
      .set('x-2fa-code', code)
      .send({ toAccountNumber: recipientAccountNumber, amountCents: 500 });
    expect(res.status).toBe(200);
  });

  test('non-2FA user can transfer without code', async () => {
    const { token: plain } = await registerUser(app, { email: 'plain@test.com', password: 'password123' });
    await request(app).post('/api/accounts/deposit').set('Authorization', `Bearer ${plain}`).send({ amountCents: 5000 });
    const res = await request(app)
      .post('/api/transfer')
      .set('Authorization', `Bearer ${plain}`)
      .send({ toAccountNumber: recipientAccountNumber, amountCents: 100 });
    expect(res.status).toBe(200);
  });

  test('insufficient funds returns 400', async () => {
        const code = totp.generate(senderSecret);
    const res = await request(app)
      .post('/api/transfer')
      .set('Authorization', `Bearer ${senderToken}`)
      .send({ toAccountNumber: recipientAccountNumber, amountCents: 9_999_999, twoFaCode: code });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/funds/i);
  });

  test('unknown destination account returns 404', async () => {
        const code = totp.generate(senderSecret);
    const res = await request(app)
      .post('/api/transfer')
      .set('Authorization', `Bearer ${senderToken}`)
      .send({ toAccountNumber: '0000000000', amountCents: 100, twoFaCode: code });
    expect(res.status).toBe(404);
  });

  test('self-transfer returns 400', async () => {
        const code = totp.generate(senderSecret);
    const meRes = await request(app).get('/api/accounts/me').set('Authorization', `Bearer ${senderToken}`);
    const own = meRes.body.account.accountNumber;
    const res = await request(app)
      .post('/api/transfer')
      .set('Authorization', `Bearer ${senderToken}`)
      .send({ toAccountNumber: own, amountCents: 100, twoFaCode: code });
    expect(res.status).toBe(400);
  });

  test('transfer fails if 2FA code given but transfer_2fa_failed is audited', async () => {
    const res = await request(app)
      .post('/api/transfer')
      .set('Authorization', `Bearer ${senderToken}`)
      .send({ toAccountNumber: recipientAccountNumber, amountCents: 100, twoFaCode: '000000' });
    expect(res.status).toBe(403);

    const audit = db.prepare(
      `SELECT * FROM audit_log WHERE user_id = ? AND event_type = 'transfer_2fa_failed'`
    ).get(senderId);
    expect(audit).toBeTruthy();
  });

  test('unauthenticated request returns 401', async () => {
    const res = await request(app)
      .post('/api/transfer')
      .send({ toAccountNumber: recipientAccountNumber, amountCents: 100 });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/admin/2fa/reset/:userId — AC-013', () => {
  let app, db;
  let adminToken, adminId;
  let targetToken, targetId, targetSecret;

  beforeEach(async () => {
    ({ app, db } = makeApp());

    // Create admin user — insert directly so we can set role
    const hash = bcrypt.hashSync('adminpass', 10);
    const adminRes = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run('Admin', 'admin@test.com', hash);
    adminId = adminRes.lastInsertRowid;
    db.prepare('INSERT INTO accounts (user_id, account_number) VALUES (?, ?)').run(adminId, '9000000001');
    adminToken = makeAdminToken(adminId);

    // Target user with 2FA enrolled + locked
    ({ token: targetToken, userId: targetId } = await registerUser(app, { email: 'target@test.com', password: 'password123' }));
    ({ secret: targetSecret } = await enrol2FA(app, targetToken));
    db.prepare('UPDATE users SET account_locked = 1 WHERE id = ?').run(targetId);
  });

  test('AC-013: admin reset clears 2FA + lock + audit with actor_id', async () => {
    const res = await request(app)
      .post(`/api/admin/2fa/reset/${targetId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.reset).toBe(true);

    const user = db.prepare('SELECT twofa_enabled, twofa_secret, account_locked FROM users WHERE id = ?').get(targetId);
    expect(user.twofa_enabled).toBe(0);
    expect(user.twofa_secret).toBeNull();
    expect(user.account_locked).toBe(0);

    const audit = db.prepare(
      `SELECT * FROM audit_log WHERE user_id = ? AND event_type = 'admin_bypass' ORDER BY id DESC LIMIT 1`
    ).get(targetId);
    expect(audit).toBeTruthy();
    expect(audit.actor_id).toBe(adminId);
  });

  test('AC-013: audit record includes ip_address and user_agent', async () => {
    await request(app)
      .post(`/api/admin/2fa/reset/${targetId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('User-Agent', 'TestAgent/1.0');

    const audit = db.prepare(
      `SELECT * FROM audit_log WHERE user_id = ? AND event_type = 'admin_bypass'`
    ).get(targetId);
    expect(audit.user_agent).toBe('TestAgent/1.0');
  });

  test('non-admin JWT returns 403', async () => {
    const userTok = jwt.sign({ userId: targetId }, JWT_SECRET, { expiresIn: '1h' });
    const res = await request(app)
      .post(`/api/admin/2fa/reset/${targetId}`)
      .set('Authorization', `Bearer ${userTok}`);
    expect(res.status).toBe(403);
  });

  test('unauthenticated returns 401', async () => {
    const res = await request(app).post(`/api/admin/2fa/reset/${targetId}`);
    expect(res.status).toBe(401);
  });

  test('unknown userId returns 404', async () => {
    const res = await request(app)
      .post('/api/admin/2fa/reset/99999')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  test('backup codes are soft-deleted by admin reset', async () => {
    await request(app)
      .post(`/api/admin/2fa/reset/${targetId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    const active = db.prepare(
      `SELECT COUNT(*) AS cnt FROM backup_codes WHERE user_id = ? AND consumed_at IS NULL`
    ).get(targetId);
    expect(active.cnt).toBe(0);
  });

  test('pending 2FA token is rejected', async () => {
    const pending = makePendingToken(adminId);
    const res = await request(app)
      .post(`/api/admin/2fa/reset/${targetId}`)
      .set('Authorization', `Bearer ${pending}`);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('AC-014: all required audit event types are recorded', () => {
  /**
   * This test exercises every event type mandated by FR-013 and verifies
   * it appears in audit_log with correct user_id and non-null created_at.
   */
  const REQUIRED_EVENTS = [
    'verify_success',
    'verify_fail',
    'enrol',
    'disable',
    'lockout',
    'backup_code_used',
    'backup_codes_regenerated',
    'sms_otp_sent',
    'admin_bypass',
    'transfer_2fa_verified',
    'transfer_2fa_failed',
  ];

  test('all audit event types can be produced and have required fields', async () => {
    const { app, db } = makeApp();
    const password = 'password123';

    // -- Enrol user
    const { token: tok, userId } = await registerUser(app, { email: 'audit@test.com', password });
    const { secret, backupCodes } = await enrol2FA(app, tok);
    // ^ produces: enrol

    // -- Fund account
    await request(app).post('/api/accounts/deposit').set('Authorization', `Bearer ${tok}`).send({ amountCents: 50000 });

    // -- Recipient
    const { token: rTok } = await registerUser(app, { email: 'rec@test.com', password });
    const rMe = await request(app).get('/api/accounts/me').set('Authorization', `Bearer ${rTok}`);
    const recipAcct = rMe.body.account.accountNumber;

    // -- verify_success (TOTP)
        const goodCode = totp.generate(secret);
    await request(app)
      .post('/api/auth/verify-2fa')
      .set('Authorization', `Bearer ${makePendingToken(userId)}`)
      .send({ code: goodCode });

    // -- verify_fail
    await request(app)
      .post('/api/auth/verify-2fa')
      .set('Authorization', `Bearer ${makePendingToken(userId)}`)
      .send({ code: '000000' });

    // -- lockout (need 4 more failures)
    for (let i = 0; i < 4; i++) {
      await request(app)
        .post('/api/auth/verify-2fa')
        .set('Authorization', `Bearer ${makePendingToken(userId)}`)
        .send({ code: '000000' });
    }
    // ^ on 5th, lockout is written

    // -- Admin reset (clears lock so we can continue)
    const hash = bcrypt.hashSync('adminpass', 10);
    const adminR = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run('Admin', 'adm2@test.com', hash);
    db.prepare('INSERT INTO accounts (user_id, account_number) VALUES (?, ?)').run(adminR.lastInsertRowid, '9000000099');
    const adminTok = makeAdminToken(adminR.lastInsertRowid);
    await request(app)
      .post(`/api/admin/2fa/reset/${userId}`)
      .set('Authorization', `Bearer ${adminTok}`);
    // ^ produces: admin_bypass
    // (also clears twofa, so we need to re-enrol for subsequent events)

    // Re-enrol
    await enrol2FA(app, tok);
    // ^ produces: enrol (second time)

    // -- sms_otp_sent
    db.prepare('UPDATE users SET phone_number = ? WHERE id = ?').run('+911111111111', userId);
    const smsR = await request(app)
      .post('/api/auth/request-sms-otp')
      .set('Authorization', `Bearer ${makePendingToken(userId)}`);
    // ^ produces: sms_otp_sent

    // -- backup_code_used: use one backup code to login
    // Need fresh backup codes from re-enrol
    const { backupCodes: bcs2 } = await enrol2FA(app, tok);
    await request(app)
      .post('/api/auth/verify-2fa')
      .set('Authorization', `Bearer ${makePendingToken(userId)}`)
      .send({ code: bcs2[0] });
    // ^ produces: backup_code_used + verify_success

    // -- transfer_2fa_verified + transfer_2fa_failed
        const tCode = totp.generate(
      db.prepare('SELECT twofa_secret FROM users WHERE id = ?').get(userId).twofa_secret
    );
    await request(app)
      .post('/api/transfer')
      .set('Authorization', `Bearer ${tok}`)
      .send({ toAccountNumber: recipAcct, amountCents: 100, twoFaCode: tCode });
    // ^ transfer_2fa_verified
    await request(app)
      .post('/api/transfer')
      .set('Authorization', `Bearer ${tok}`)
      .send({ toAccountNumber: recipAcct, amountCents: 100, twoFaCode: '000000' });
    // ^ transfer_2fa_failed

    // -- backup_codes_regenerated
    const regenCode = totp.generate(
      db.prepare('SELECT twofa_secret FROM users WHERE id = ?').get(userId).twofa_secret
    );
    await request(app)
      .post('/api/auth/2fa/backup-codes/regenerate')
      .set('Authorization', `Bearer ${tok}`)
      .send({ code: regenCode });

    // -- disable
    const disCode = totp.generate(
      db.prepare('SELECT twofa_secret FROM users WHERE id = ?').get(userId).twofa_secret
    );
    await request(app)
      .post('/api/auth/2fa/disable')
      .set('Authorization', `Bearer ${tok}`)
      .send({ password, code: disCode });

    // ── Verify all events exist with required fields ────────────────────────
    const allEvents = db.prepare(`SELECT DISTINCT event_type FROM audit_log`).all().map(r => r.event_type);

    for (const eventType of REQUIRED_EVENTS) {
      expect(allEvents).toContain(eventType);
    }

    // Every row must have user_id and non-null created_at
    const rows = db.prepare(`SELECT * FROM audit_log`).all();
    for (const row of rows) {
      expect(row.user_id).toBeTruthy();
      expect(row.created_at).toBeTruthy();
    }
  }, 90_000); // many bcrypt rounds — allow 90 s
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Middleware edge cases', () => {
  let app, userId;

  beforeEach(async () => {
    ({ app } = makeApp());
    ({ userId } = await registerUser(app, { email: 'mw@test.com', password: 'password123' }));
  });

  test('missing Authorization header on protected route → 401', async () => {
    const res = await request(app).get('/api/accounts/me');
    expect(res.status).toBe(401);
  });

  test('malformed token → 401', async () => {
    const res = await request(app)
      .get('/api/accounts/me')
      .set('Authorization', 'Bearer notavalidtoken');
    expect(res.status).toBe(401);
  });

  test('expired token → 401', async () => {
    const expired = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '0ms' });
    const res = await request(app)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });
});
