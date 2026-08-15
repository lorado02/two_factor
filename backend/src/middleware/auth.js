const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

/**
 * Standard requireAuth — rejects pending-scope tokens.
 * Use on all routes that require a full session JWT.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.scope === '2fa_pending') {
      return res.status(401).json({ error: 'Pending 2FA token cannot be used here' });
    }
    req.userId = payload.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * requirePendingAuth — accepts ONLY pending-scope tokens.
 * Use on /verify-2fa and /request-sms-otp.
 */
function requirePendingAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.scope !== '2fa_pending') {
      return res.status(401).json({ error: 'Invalid token scope' });
    }
    req.userId = payload.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * requireAdminAuth — requires a full JWT with role: "admin".
 */
function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.scope === '2fa_pending') {
      return res.status(401).json({ error: 'Pending 2FA token cannot be used here' });
    }
    if (payload.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.userId = payload.userId;
    req.actorId = payload.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireAuth, requirePendingAuth, requireAdminAuth, JWT_SECRET };
