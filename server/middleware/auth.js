const jwt = require('jsonwebtoken');
const { pool } = require('../db');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  // Step 1: verify the token itself. Only THIS can legitimately mean
  // "please log in again".
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret_change_me');
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Step 2: load the user. A database hiccup here is a TEMPORARY server
  // problem, not proof the session is invalid - it must never wipe the
  // user's login. (This is what used to send people back to the login
  // screen on any transient DB error.)
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.uid]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'User not found' });

    // Always re-check ban status server-side, never trust the token alone.
    if (user.account_status === 'banned') {
      const now = Date.now();
      if (user.ban_expires_at && now >= Number(user.ban_expires_at)) {
        await pool.query(
          `UPDATE users SET account_status = 'active', ban_started_at = NULL, ban_expires_at = NULL, updated_at = $1 WHERE id = $2`,
          [now, user.id]
        );
        user.account_status = 'active';
      }
    }

    req.user = user; // full, trusted, server-side copy
    next();
  } catch (err) {
    console.error('DB error while loading user session:', err.message);
    // 503, NOT 401 - the client only clears the saved login on 401, so a
    // temporary outage shows a retryable error instead of logging anyone out.
    return res.status(503).json({ error: 'temporarily_unavailable' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
