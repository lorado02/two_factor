'use strict';
const express = require('express');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');

module.exports = function makeAdminRouter(db) {
  const router = express.Router();

  function writeAudit({ eventType, userId, actorId = null, req }) {
    db.prepare(
      `INSERT INTO audit_log (event_type, user_id, actor_id, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)`
    ).run(eventType, userId, actorId, req ? req.ip : null, req ? (req.headers['user-agent'] || null) : null);
  }

  function requireAdminAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.scope === '2fa_pending') return res.status(401).json({ error: 'Pending 2FA token cannot be used here' });
      if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
      req.userId = payload.userId;
      req.actorId = payload.userId;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  router.post('/2fa/reset/:userId', requireAdminAuth, (req, res) => {
    const targetId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(targetId)) return res.status(400).json({ error: 'Invalid userId' });
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    db.transaction(() => {
      db.prepare(
        `UPDATE users SET twofa_enabled = 0, twofa_secret = NULL,
         account_locked = 0, failed_2fa_attempts = 0, failed_2fa_window_start = NULL WHERE id = ?`
      ).run(targetId);
      db.prepare(`UPDATE backup_codes SET consumed_at = datetime('now') WHERE user_id = ? AND consumed_at IS NULL`).run(targetId);
    })();
    writeAudit({ eventType: 'admin_bypass', userId: targetId, actorId: req.actorId, req });
    res.json({ reset: true });
  });

  return router;
};
