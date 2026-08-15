'use strict';
const express = require('express');
const jwt = require('jsonwebtoken');
const totp = require('../totp');
const { JWT_SECRET } = require('../middleware/auth');

const TRANSFER_2FA_THRESHOLD = parseInt(process.env.TRANSFER_2FA_THRESHOLD_CENTS || '0', 10);

module.exports = function makeTransferRouter(db) {
  const router = express.Router();

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

  router.post('/', requireAuth, (req, res) => {
    const { toAccountNumber, amountCents, twoFaCode } = req.body;
    const headerCode = req.headers['x-2fa-code'];
    const code = twoFaCode || headerCode;

    if (!toAccountNumber || !Number.isInteger(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'toAccountNumber and a positive integer amountCents are required' });
    }

    const userId = req.userId;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

    if (user.twofa_enabled && amountCents >= TRANSFER_2FA_THRESHOLD) {
      if (!code) return res.status(403).json({ error: 'Valid 2FA code required for transfers' });
      if (!totp.verify(code, user.twofa_secret)) {
        db.prepare(
          `INSERT INTO audit_log (event_type, user_id, ip_address, user_agent) VALUES ('transfer_2fa_failed', ?, ?, ?)`
        ).run(userId, req.ip, req.headers['user-agent'] || null);
        return res.status(403).json({ error: 'Valid 2FA code required for transfers' });
      }
    }

    const fromAccount = db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(userId);
    const toAccount = db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(toAccountNumber);
    if (!toAccount) return res.status(404).json({ error: 'Destination account not found' });
    if (toAccount.id === fromAccount.id) return res.status(400).json({ error: 'Cannot transfer to your own account' });
    if (fromAccount.balance_cents < amountCents) return res.status(400).json({ error: 'Insufficient funds' });

    db.transaction(() => {
      db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?').run(amountCents, fromAccount.id);
      db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(amountCents, toAccount.id);
      db.prepare('INSERT INTO transactions (from_account_id, to_account_id, amount_cents, type) VALUES (?, ?, ?, ?)').run(fromAccount.id, toAccount.id, amountCents, 'transfer');
    })();

    if (user.twofa_enabled) {
      db.prepare(
        `INSERT INTO audit_log (event_type, user_id, ip_address, user_agent) VALUES ('transfer_2fa_verified', ?, ?, ?)`
      ).run(userId, req.ip, req.headers['user-agent'] || null);
    }

    const updated = db.prepare('SELECT balance_cents FROM accounts WHERE id = ?').get(fromAccount.id);
    res.json({ balanceCents: updated.balance_cents });
  });

  return router;
};
