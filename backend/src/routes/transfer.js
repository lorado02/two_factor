const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/', requireAuth, (req, res) => {
  const { toAccountNumber, amountCents } = req.body;

  if (!toAccountNumber || !Number.isInteger(amountCents) || amountCents <= 0) {
    return res.status(400).json({ error: 'toAccountNumber and a positive integer amountCents are required' });
  }

  const fromAccount = db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(req.userId);
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

  // NOTE: once 2FA is implemented, this is the natural place to require a
  // fresh TOTP/SMS code for transfers over a threshold before committing.
  const runTransfer = db.transaction(() => {
    db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?').run(amountCents, fromAccount.id);
    db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(amountCents, toAccount.id);
    db.prepare(
      'INSERT INTO transactions (from_account_id, to_account_id, amount_cents, type) VALUES (?, ?, ?, ?)'
    ).run(fromAccount.id, toAccount.id, amountCents, 'transfer');
  });

  runTransfer();

  const updated = db.prepare('SELECT balance_cents FROM accounts WHERE id = ?').get(fromAccount.id);
  res.json({ balanceCents: updated.balance_cents });
});

module.exports = router;
