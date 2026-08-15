'use strict';
const express = require('express');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');

module.exports = function makeAccountsRouter(db) {
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

  router.get('/me', requireAuth, (req, res) => {
    const user = db.prepare('SELECT id, name, email, twofa_enabled FROM users WHERE id = ?').get(req.userId);
    const account = db.prepare('SELECT account_number, balance_cents FROM accounts WHERE user_id = ?').get(req.userId);
    res.json({
      user: { id: user.id, name: user.name, email: user.email, twofaEnabled: !!user.twofa_enabled },
      account: { accountNumber: account.account_number, balanceCents: account.balance_cents },
    });
  });

  router.post('/deposit', requireAuth, (req, res) => {
    const { amountCents } = req.body;
    if (!Number.isInteger(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'A positive integer amountCents is required' });
    const account = db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(req.userId);
    db.transaction(() => {
      db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(amountCents, account.id);
      db.prepare('INSERT INTO transactions (from_account_id, to_account_id, amount_cents, type) VALUES (NULL, ?, ?, ?)').run(account.id, amountCents, 'deposit');
    })();
    const updated = db.prepare('SELECT balance_cents FROM accounts WHERE id = ?').get(account.id);
    res.json({ balanceCents: updated.balance_cents });
  });

  router.get('/transactions', requireAuth, (req, res) => {
    const account = db.prepare('SELECT id FROM accounts WHERE user_id = ?').get(req.userId);
    const rows = db.prepare(
      `SELECT t.id, t.amount_cents, t.type, t.created_at,
              t.from_account_id, t.to_account_id,
              fa.account_number AS from_account_number,
              ta.account_number AS to_account_number
       FROM transactions t
       LEFT JOIN accounts fa ON fa.id = t.from_account_id
       LEFT JOIN accounts ta ON ta.id = t.to_account_id
       WHERE t.from_account_id = ? OR t.to_account_id = ?
       ORDER BY t.created_at DESC, t.id DESC`
    ).all(account.id, account.id);
    res.json({
      transactions: rows.map(row => ({
        id: row.id, amountCents: row.amount_cents, type: row.type, createdAt: row.created_at,
        fromAccountNumber: row.from_account_number, toAccountNumber: row.to_account_number,
        direction: row.from_account_id === row.to_account_id ? 'self'
          : row.from_account_id === account.id ? 'debit' : 'credit',
      })),
    });
  });

  return router;
};
