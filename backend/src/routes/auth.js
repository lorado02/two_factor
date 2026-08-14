const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

function generateAccountNumber() {
  let accountNumber;
  const exists = db.prepare('SELECT 1 FROM accounts WHERE account_number = ?');
  do {
    accountNumber = String(Math.floor(1000000000 + Math.random() * 9000000000));
  } while (exists.get(accountNumber));
  return accountNumber;
}

router.post('/register', (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);

  const createUserAndAccount = db.transaction(() => {
    const userResult = db
      .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
      .run(name, email, passwordHash);

    const accountNumber = generateAccountNumber();
    db.prepare(
      'INSERT INTO accounts (user_id, account_number, balance_cents) VALUES (?, ?, ?)'
    ).run(userResult.lastInsertRowid, accountNumber, 0);

    return userResult.lastInsertRowid;
  });

  const userId = createUserAndAccount();
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '2h' });

  res.status(201).json({ token });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Hook point for a future second factor: once 2FA is added, a user with
  // twofa_enabled should get a short-lived "pending" token here instead of a
  // full session token, and only receive the real token after verifying a
  // TOTP/SMS code against twofa_secret.
  if (user.twofa_enabled) {
    // Not implemented yet — falls through to normal login for now.
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '2h' });
  res.json({ token });
});

module.exports = router;
