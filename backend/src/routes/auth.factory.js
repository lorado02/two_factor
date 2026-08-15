'use strict';
/**
 * auth.factory.js — re-exports the auth router with a caller-supplied db.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const totp = require('../totp');
const QRCode = require('qrcode');
const { JWT_SECRET } = require('../middleware/auth');

const LOCKOUT_MAX_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const BCRYPT_ROUNDS = process.env.NODE_ENV === 'test' ? 1 : 10;

module.exports = function makeAuthRouter(db) {
  const router = express.Router();

  // ── shared helpers ──────────────────────────────────────────────────────────
  function writeAudit({ eventType, userId, actorId = null, req }) {
    db.prepare(
      `INSERT INTO audit_log (event_type, user_id, actor_id, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      eventType,
      userId,
      actorId,
      req ? req.ip : null,
      req ? (req.headers['user-agent'] || null) : null
    );
  }

  function generateAccountNumber() {
    let accountNumber;
    const exists = db.prepare('SELECT 1 FROM accounts WHERE account_number = ?');
    do {
      accountNumber = String(Math.floor(1000000000 + Math.random() * 9000000000));
    } while (exists.get(accountNumber));
    return accountNumber;
  }

  function generateBackupCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  function recordFailedAttempt(user) {
    const now = new Date();
    const windowStart = user.failed_2fa_window_start ? new Date(user.failed_2fa_window_start) : null;
    let attempts = user.failed_2fa_attempts;

    if (!windowStart || now - windowStart > LOCKOUT_WINDOW_MS) {
      attempts = 1;
      db.prepare(`UPDATE users SET failed_2fa_attempts = 1, failed_2fa_window_start = ? WHERE id = ?`)
        .run(now.toISOString(), user.id);
    } else {
      attempts += 1;
      db.prepare(`UPDATE users SET failed_2fa_attempts = ? WHERE id = ?`).run(attempts, user.id);
    }

    if (attempts >= LOCKOUT_MAX_ATTEMPTS) {
      db.prepare(`UPDATE users SET account_locked = 1 WHERE id = ?`).run(user.id);
      return true;
    }
    return false;
  }

  function resetFailedAttempts(userId) {
    db.prepare(
      `UPDATE users SET failed_2fa_attempts = 0, failed_2fa_window_start = NULL WHERE id = ?`
    ).run(userId);
  }

  function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.scope === '2fa_pending') return res.status(401).json({ error: 'Pending 2FA token cannot be used here' });
      req.userId = payload.userId;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  function requirePendingAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.scope !== '2fa_pending') return res.status(401).json({ error: 'Invalid token scope' });
      req.userId = payload.userId;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  // ── POST /register ──────────────────────────────────────────────────────────
  router.post('/register', (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'An account with that email already exists' });
    const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    const userId = db.transaction(() => {
      const r = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run(name, email, passwordHash);
      db.prepare('INSERT INTO accounts (user_id, account_number, balance_cents) VALUES (?, ?, ?)').run(r.lastInsertRowid, generateAccountNumber(), 0);
      return r.lastInsertRowid;
    })();
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '2h' });
    res.status(201).json({ token });
  });

  // ── POST /login ─────────────────────────────────────────────────────────────
  router.post('/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
    if (user.account_locked) return res.status(403).json({ error: 'Account locked. Check your email for unlock instructions.' });
    if (user.twofa_enabled) {
      const pendingToken = jwt.sign({ userId: user.id, scope: '2fa_pending' }, JWT_SECRET, { expiresIn: '5m' });
      return res.json({ status: '2fa_required', pendingToken });
    }
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '2h' });
    res.json({ token });
  });

  // ── POST /verify-2fa ────────────────────────────────────────────────────────
  router.post('/verify-2fa', requirePendingAuth, (req, res) => {
    const { code } = req.body;
    const userId = req.userId;
    if (!code) return res.status(400).json({ error: 'code is required' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.account_locked) return res.status(403).json({ error: 'Account locked. Check your email for unlock instructions.' });

    // TOTP
    if (user.twofa_enabled && user.twofa_secret) {
      if (totp.verify(code, user.twofa_secret)) {
        resetFailedAttempts(userId);
        writeAudit({ eventType: 'verify_success', userId, req });
        return res.json({ token: jwt.sign({ userId }, JWT_SECRET, { expiresIn: '2h' }) });
      }
    }

    // SMS OTP
    const codeNorm = code.trim();
    const smsEntry = db.prepare(
      `SELECT * FROM sms_otp WHERE user_id = ? AND consumed = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1`
    ).get(userId);
    if (smsEntry && bcrypt.compareSync(codeNorm, smsEntry.otp_hash)) {
      db.prepare(`UPDATE sms_otp SET consumed = 1 WHERE id = ?`).run(smsEntry.id);
      resetFailedAttempts(userId);
      writeAudit({ eventType: 'verify_success', userId, req });
      return res.json({ token: jwt.sign({ userId }, JWT_SECRET, { expiresIn: '2h' }) });
    }

    // Backup code
    const backupCodes = db.prepare(`SELECT * FROM backup_codes WHERE user_id = ? AND consumed_at IS NULL`).all(userId);
    for (const bc of backupCodes) {
      if (bcrypt.compareSync(codeNorm.toUpperCase(), bc.code_hash)) {
        db.prepare(`UPDATE backup_codes SET consumed_at = datetime('now') WHERE id = ?`).run(bc.id);
        resetFailedAttempts(userId);
        writeAudit({ eventType: 'backup_code_used', userId, req });
        writeAudit({ eventType: 'verify_success', userId, req });
        return res.json({ token: jwt.sign({ userId }, JWT_SECRET, { expiresIn: '2h' }) });
      }
    }

    // All failed
    const locked = recordFailedAttempt(user);
    writeAudit({ eventType: 'verify_fail', userId, req });
    if (locked) {
      writeAudit({ eventType: 'lockout', userId, req });
      return res.status(403).json({ error: 'Account locked. Check your email for unlock instructions.' });
    }
    const refreshed = db.prepare('SELECT failed_2fa_attempts FROM users WHERE id = ?').get(userId);
    const remaining = Math.max(0, LOCKOUT_MAX_ATTEMPTS - refreshed.failed_2fa_attempts);
    return res.status(401).json({
      error: `Invalid or expired code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining before lockout.`,
    });
  });

  // ── POST /request-sms-otp ───────────────────────────────────────────────────
  router.post('/request-sms-otp', requirePendingAuth, (req, res) => {
    const userId = req.userId;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.phone_number) return res.status(400).json({ error: 'No phone number on file. Please update your profile.' });

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpHash = bcrypt.hashSync(otp, BCRYPT_ROUNDS);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];
    db.prepare(`INSERT INTO sms_otp (user_id, otp_hash, expires_at) VALUES (?, ?, ?)`).run(userId, otpHash, expiresAt);
    writeAudit({ eventType: 'sms_otp_sent', userId, req });

    // Expose OTP in test env so tests can retrieve it
    const payload = { sent: true };
    if (process.env.NODE_ENV === 'test') payload._otp = otp;
    res.json(payload);
  });

  // ── POST /2fa/setup ─────────────────────────────────────────────────────────
  router.post('/2fa/setup', requireAuth, async (req, res) => {
    const userId = req.userId;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const secret = totp.generateSecret();
    const otpauthUri = totp.keyuri(user.email, 'Axis Bank', secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri);
    db.prepare(`UPDATE users SET twofa_secret = ? WHERE id = ?`).run(secret, userId);
    res.json({ otpauthUri, qrCodeDataUrl, manualEntryKey: secret });
  });

  // ── POST /2fa/enable ────────────────────────────────────────────────────────
  router.post('/2fa/enable', requireAuth, (req, res) => {
    const { code } = req.body;
    const userId = req.userId;
    if (!code) return res.status(400).json({ error: 'code is required' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || !user.twofa_secret) return res.status(400).json({ error: 'Setup not initiated. Call /2fa/setup first.' });
    if (!totp.verify(code, user.twofa_secret)) {
      db.prepare(`UPDATE users SET twofa_secret = NULL WHERE id = ?`).run(userId);
      return res.status(400).json({ error: 'Incorrect code. Please ensure your authenticator app is synced.' });
    }
    const plainCodes = Array.from({ length: 8 }, generateBackupCode);
    db.transaction(() => {
      db.prepare(`UPDATE users SET twofa_enabled = 1 WHERE id = ?`).run(userId);
      db.prepare(`DELETE FROM backup_codes WHERE user_id = ?`).run(userId);
      for (const c of plainCodes) {
        db.prepare(`INSERT INTO backup_codes (user_id, code_hash) VALUES (?, ?)`).run(userId, bcrypt.hashSync(c, BCRYPT_ROUNDS));
      }
    })();
    writeAudit({ eventType: 'enrol', userId, req });
    res.json({ backupCodes: plainCodes });
  });

  // ── POST /2fa/disable ───────────────────────────────────────────────────────
  router.post('/2fa/disable', requireAuth, (req, res) => {
    const { password, code } = req.body;
    const userId = req.userId;
    if (!password || !code) return res.status(400).json({ error: 'password and code are required' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Incorrect password or code' });
    if (!totp.verify(code, user.twofa_secret)) return res.status(401).json({ error: 'Incorrect password or code' });
    db.transaction(() => {
      db.prepare(`UPDATE users SET twofa_enabled = 0, twofa_secret = NULL WHERE id = ?`).run(userId);
      db.prepare(`UPDATE backup_codes SET consumed_at = datetime('now') WHERE user_id = ? AND consumed_at IS NULL`).run(userId);
    })();
    writeAudit({ eventType: 'disable', userId, req });
    res.json({ disabled: true });
  });

  // ── GET /2fa/backup-codes ───────────────────────────────────────────────────
  router.get('/2fa/backup-codes', requireAuth, (req, res) => {
    const userId = req.userId;
    const remaining = db.prepare(`SELECT COUNT(*) AS cnt FROM backup_codes WHERE user_id = ? AND consumed_at IS NULL`).get(userId).cnt;
    res.json({ total: 8, remaining });
  });

  // ── POST /2fa/backup-codes/regenerate ──────────────────────────────────────
  router.post('/2fa/backup-codes/regenerate', requireAuth, (req, res) => {
    const { code } = req.body;
    const userId = req.userId;
    if (!code) return res.status(400).json({ error: 'code is required' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || !user.twofa_enabled) return res.status(400).json({ error: '2FA is not enabled' });
    if (!totp.verify(code, user.twofa_secret)) return res.status(401).json({ error: 'Invalid authenticator code' });
    const plainCodes = Array.from({ length: 8 }, generateBackupCode);
    db.transaction(() => {
      db.prepare(`UPDATE backup_codes SET consumed_at = datetime('now') WHERE user_id = ? AND consumed_at IS NULL`).run(userId);
      for (const c of plainCodes) {
        db.prepare(`INSERT INTO backup_codes (user_id, code_hash) VALUES (?, ?)`).run(userId, bcrypt.hashSync(c, BCRYPT_ROUNDS));
      }
    })();
    writeAudit({ eventType: 'backup_codes_regenerated', userId, req });
    res.json({ backupCodes: plainCodes });
  });

  return router;
};
