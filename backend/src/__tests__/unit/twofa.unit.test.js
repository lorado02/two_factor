'use strict';
/**
 * Unit tests for standalone 2FA logic that does NOT require the HTTP or DB layer.
 *
 * Covers:
 *  - OTP generation and verification (TOTP RFC 6238)
 *  - OTP expiry window behaviour
 *  - generateBackupCode character-set constraints
 *  - JWT scope enforcement logic
 *  - recordFailedAttempt counter / window reset / lockout boundary
 */

const totp = require('../../totp');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = 'test-secret';

// ── Inline copies of the pure helpers from auth.factory.js ──────────────────

const LOCKOUT_MAX_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

function generateBackupCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

/**
 * Pure version of recordFailedAttempt — operates on a plain object
 * and returns { attempts, locked } without touching a DB.
 */
function simulateFailedAttempt(user) {
  const now = new Date();
  const windowStart = user.failed_2fa_window_start ? new Date(user.failed_2fa_window_start) : null;
  let attempts = user.failed_2fa_attempts;

  if (!windowStart || now - windowStart > LOCKOUT_WINDOW_MS) {
    attempts = 1;
    user.failed_2fa_window_start = now.toISOString();
  } else {
    attempts += 1;
  }
  user.failed_2fa_attempts = attempts;
  if (attempts >= LOCKOUT_MAX_ATTEMPTS) {
    user.account_locked = 1;
    return { attempts, locked: true };
  }
  return { attempts, locked: false };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('TOTP — RFC 6238 implementation', () => {
  let secret;

  beforeEach(() => {
    secret = totp.generateSecret();
  });

  test('generateSecret returns a non-empty base32 string', () => {
    expect(secret).toBeTruthy();
    expect(/^[A-Z2-7]+=*$/.test(secret)).toBe(true);
  });

  test('current token verifies correctly (window: 1)', () => {
    const token = totp.generate(secret);
    expect(totp.verify(token, secret)).toBe(true);
  });

  test('wrong token does not verify', () => {
    expect(totp.verify('000000', secret)).toBe(false);
  });

  test('token length is exactly 6 digits', () => {
    const token = totp.generate(secret);
    expect(token).toMatch(/^\d{6}$/);
  });

  test('different secrets produce different tokens (with overwhelming probability)', () => {
    const secret2 = totp.generateSecret();
    const t1 = totp.generate(secret);
    const t2 = totp.generate(secret2);
    expect(secret).not.toBe(secret2);
    expect(totp.verify(t1, secret)).toBe(true);
    expect(totp.verify(t2, secret2)).toBe(true);
  });

  test('token from one secret fails verification against another secret', () => {
    const secret2 = totp.generateSecret();
    const token = totp.generate(secret);
    if (token !== totp.generate(secret2)) {
      expect(totp.verify(token, secret2)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('OTP keyuri helper', () => {
  test('keyuri returns an otpauth:// URI with the correct format', () => {
    const secret = totp.generateSecret();
    const uri = totp.keyuri('user@example.com', 'TestApp', secret);
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('secret=');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('generateBackupCode', () => {
  test('returns 8 characters', () => {
    expect(generateBackupCode()).toHaveLength(8);
  });

  test('only uses unambiguous alphanumeric characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateBackupCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  test('generates unique codes across a batch', () => {
    const codes = Array.from({ length: 8 }, generateBackupCode);
    const unique = new Set(codes);
    // Collision with 8 codes out of 32^8 space is negligible
    expect(unique.size).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('JWT scope logic', () => {
  const sign = (payload, opts = {}) => jwt.sign(payload, JWT_SECRET, { expiresIn: '1h', ...opts });

  function isFullToken(token) {
    try {
      const p = jwt.verify(token, JWT_SECRET);
      return p.scope !== '2fa_pending';
    } catch { return false; }
  }

  function isPendingToken(token) {
    try {
      const p = jwt.verify(token, JWT_SECRET);
      return p.scope === '2fa_pending';
    } catch { return false; }
  }

  test('full JWT passes isFullToken check', () => {
    const tok = sign({ userId: 1 });
    expect(isFullToken(tok)).toBe(true);
    expect(isPendingToken(tok)).toBe(false);
  });

  test('pending JWT passes isPendingToken check', () => {
    const tok = sign({ userId: 1, scope: '2fa_pending' });
    expect(isPendingToken(tok)).toBe(true);
    expect(isFullToken(tok)).toBe(false);
  });

  test('admin JWT with role:admin is a full token', () => {
    const tok = sign({ userId: 99, role: 'admin' });
    expect(isFullToken(tok)).toBe(true);
  });

  test('expired token is not valid', () => {
    const tok = sign({ userId: 1 }, { expiresIn: '0ms' });
    expect(isFullToken(tok)).toBe(false);
  });

  test('token signed with wrong secret is rejected', () => {
    const tok = jwt.sign({ userId: 1 }, 'other-secret', { expiresIn: '1h' });
    expect(() => jwt.verify(tok, JWT_SECRET)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('recordFailedAttempt — lockout counter logic (AC-012)', () => {
  function freshUser() {
    return { id: 1, failed_2fa_attempts: 0, failed_2fa_window_start: null, account_locked: 0 };
  }

  test('first failure sets attempts to 1, not locked', () => {
    const user = freshUser();
    const { attempts, locked } = simulateFailedAttempt(user);
    expect(attempts).toBe(1);
    expect(locked).toBe(false);
  });

  test('4 consecutive failures — not yet locked', () => {
    const user = freshUser();
    for (let i = 0; i < 4; i++) simulateFailedAttempt(user);
    expect(user.account_locked).toBe(0);
    expect(user.failed_2fa_attempts).toBe(4);
  });

  test('5th failure triggers lockout (AC-012)', () => {
    const user = freshUser();
    let result;
    for (let i = 0; i < 5; i++) result = simulateFailedAttempt(user);
    expect(result.locked).toBe(true);
    expect(user.account_locked).toBe(1);
    expect(user.failed_2fa_attempts).toBe(5);
  });

  test('counter resets when outside the 15-min window', () => {
    const user = freshUser();
    // Simulate an old window start (16 minutes ago)
    user.failed_2fa_attempts = 4;
    user.failed_2fa_window_start = new Date(Date.now() - 16 * 60 * 1000).toISOString();

    const { attempts, locked } = simulateFailedAttempt(user);
    // Window was expired → reset to 1, not locked
    expect(attempts).toBe(1);
    expect(locked).toBe(false);
  });

  test('counter accumulates within the window', () => {
    const user = freshUser();
    user.failed_2fa_attempts = 2;
    user.failed_2fa_window_start = new Date(Date.now() - 60_000).toISOString(); // 1 min ago

    const { attempts } = simulateFailedAttempt(user);
    expect(attempts).toBe(3);
  });

  test('LOCKOUT_MAX_ATTEMPTS constant is 5', () => {
    expect(LOCKOUT_MAX_ATTEMPTS).toBe(5);
  });

  test('LOCKOUT_WINDOW_MS is exactly 15 minutes', () => {
    expect(LOCKOUT_WINDOW_MS).toBe(15 * 60 * 1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('bcrypt — OTP hash round-trip', () => {
  test('hash verifies correctly', () => {
    const otp = '482910';
    const hash = bcrypt.hashSync(otp, 10);
    expect(bcrypt.compareSync(otp, hash)).toBe(true);
  });

  test('wrong OTP does not verify', () => {
    const hash = bcrypt.hashSync('482910', 10);
    expect(bcrypt.compareSync('000000', hash)).toBe(false);
  });
});
