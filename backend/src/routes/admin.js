const express = require('express');
const db = require('../db');
const { requireAdminAuth } = require('../middleware/auth');
const { writeAudit } = require('./authHelpers');

const router = express.Router();

// POST /api/admin/2fa/reset/:userId
router.post('/2fa/reset/:userId', requireAdminAuth, (req, res) => {
  const targetId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(targetId)) {
    return res.status(400).json({ error: 'Invalid userId' });
  }

  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  db.transaction(() => {
    db.prepare(
      `UPDATE users SET twofa_enabled = 0, twofa_secret = NULL,
       account_locked = 0, failed_2fa_attempts = 0, failed_2fa_window_start = NULL
       WHERE id = ?`
    ).run(targetId);
    db.prepare(
      `UPDATE backup_codes SET consumed_at = datetime('now')
       WHERE user_id = ? AND consumed_at IS NULL`
    ).run(targetId);
  })();

  writeAudit({
    eventType: 'admin_bypass',
    userId: targetId,
    actorId: req.actorId,
    req,
  });

  res.json({ reset: true });
});

module.exports = router;
