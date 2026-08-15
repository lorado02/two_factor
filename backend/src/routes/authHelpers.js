/**
 * Shared audit log helper used by auth and transfer routes.
 */
const db = require('../db');

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

module.exports = { writeAudit };
