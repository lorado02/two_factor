const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const totp = require('../totp');
const { writeAudit } = require('./authHelpers');

const router = express.Router();

const TRANSFER_2FA_THRESHOLD = parseInt(process.env.TRANSFER_2FA_THRESHOLD_CENTS || '0', 10);

router.post('/', requireAuth, (req, res) => {
  const { toAccountNumber, amountCents, twoFaCode } = req.body;
  const headerCode = req.headers['x-2fa-code'];
  const code = twoFaCode || headerCode;

  if (!toAccountNumber || !Number.isInteger(amountCents) || amountCents <= 0) {
    return res.status(400).json({ error: 'toAccountNumber and a positive integer amountCents are required' });
  }

  const userId = req.userId;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  // 2FA enforcement for enrolled users
  if (user.twofa_enabled && amountCents >= TRANSFER_2FA_THRESHOLD) {
    if (!code) {
      return res.status(403).json({ error: 'Valid 2FA code required for transfers' });
    }
    if (!totp.verify(code, user.twofa_secret)) {
      db.prepare(
        `INSERT INTO audit_log (event_type, user_id, ip_address, user_agent)
         VALUES ('transfer_2fa_failed', ?, ?, ?)`
      ).run(userId, req.ip, req.headers['user-agent'] || null);
      return res.status(403).json({ error: 'Valid 2FA code required for transfers' });
    }
  }

  const fromAccount = db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(userId);
  const toAccount = db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(toAccountNumber);

  if (!toAccount) {
    return res.status(404).json({ error: 'Destination account not found' });
  }
  if (toAccount.id === fromAccount.id) {
    return res.status(400).json({ error: 'Cannot transfer to your own account' });
  }
  if (fromAccount.balance_cents < amountCents) {
    return res.status(400).json({ error: 'Insufficient funds' });
  }

  const runTransfer = db.transaction(() => {
    db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?').run(amountCents, fromAccount.id);
    db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(amountCents, toAccount.id);
    db.prepare(
      'INSERT INTO transactions (from_account_id, to_account_id, amount_cents, type) VALUES (?, ?, ?, ?)'
    ).run(fromAccount.id, toAccount.id, amountCents, 'transfer');
  });

  runTransfer();

  if (user.twofa_enabled) {
    db.prepare(
      `INSERT INTO audit_log (event_type, user_id, ip_address, user_agent)
       VALUES ('transfer_2fa_verified', ?, ?, ?)`
    ).run(userId, req.ip, req.headers['user-agent'] || null);
  }

  const updated = db.prepare('SELECT balance_cents FROM accounts WHERE id = ?').get(fromAccount.id);
  res.json({ balanceCents: updated.balance_cents });
});

module.exports = router;
