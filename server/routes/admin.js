const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

module.exports = function (getOnlineCount) {
  const router = express.Router();
  router.use(requireAuth, requireAdmin);

  router.get('/stats', async (req, res) => {
    try {
      const totalUsers = (await pool.query('SELECT COUNT(*)::int c FROM users')).rows[0].c;
      const bannedRows = (await pool.query(
        `SELECT id, username, email, ban_started_at, ban_expires_at FROM users WHERE account_status = 'banned'`
      )).rows;
      const totalEarned = (await pool.query('SELECT COALESCE(SUM(earned_coins),0)::bigint s FROM users')).rows[0].s;
      const totalBought = (await pool.query(`SELECT COALESCE(SUM(coins),0)::bigint s FROM payments WHERE payment_status = 'success'`)).rows[0].s;

      res.json({
        total_users: totalUsers,
        online_users: getOnlineCount(),
        banned_users: bannedRows.map(u => ({
          ...u,
          ban_started_at: u.ban_started_at ? Number(u.ban_started_at) : null,
          ban_expires_at: u.ban_expires_at ? Number(u.ban_expires_at) : null
        })),
        total_earned_coins: Number(totalEarned),
        total_bought_coins: Number(totalBought)
      });
    } catch (err) { console.error(err); res.status(503).json({ error: 'temporarily_unavailable' }); }
  });

  router.get('/user/:id', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
      const user = rows[0];
      if (!user) return res.status(404).json({ error: 'not_found' });
      const transactions = (await pool.query('SELECT * FROM coin_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [user.id])).rows;
      const reportsAgainst = (await pool.query('SELECT * FROM reports WHERE reported_user_id = $1 ORDER BY created_at DESC LIMIT 50', [user.id])).rows;
      const payments = (await pool.query('SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [user.id])).rows;
      res.json({ user, transactions, reportsAgainst, payments });
    } catch (err) { console.error(err); res.status(503).json({ error: 'temporarily_unavailable' }); }
  });

  router.get('/users/search', async (req, res) => {
    try {
      const q = `%${req.query.q || ''}%`;
      const { rows } = await pool.query(
        `SELECT id, username, email, account_status FROM users WHERE id ILIKE $1 OR username ILIKE $1 OR email ILIKE $1 LIMIT 25`,
        [q]
      );
      res.json({ users: rows });
    } catch (err) { console.error(err); res.status(503).json({ error: 'temporarily_unavailable' }); }
  });

  router.post('/user/:id/ban', async (req, res) => {
    try {
      const now = Date.now();
      const days = Number(req.body.days || process.env.BAN_DURATION_DAYS || 21);
      await pool.query(
        `UPDATE users SET account_status = 'banned', ban_started_at = $1, ban_expires_at = $2, updated_at = $1 WHERE id = $3`,
        [now, now + days * 86400000, req.params.id]
      );
      res.json({ ok: true });
    } catch (err) { console.error(err); res.status(500).json({ error: 'server_error' }); }
  });

  router.post('/user/:id/unban', async (req, res) => {
    try {
      const now = Date.now();
      await pool.query(
        `UPDATE users SET account_status = 'active', ban_started_at = NULL, ban_expires_at = NULL, updated_at = $1 WHERE id = $2`,
        [now, req.params.id]
      );
      res.json({ ok: true });
    } catch (err) { console.error(err); res.status(500).json({ error: 'server_error' }); }
  });

  router.get('/errors', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM error_logs ORDER BY created_at DESC LIMIT 200');
      res.json({ errors: rows.map(r => ({ ...r, created_at: Number(r.created_at) })) });
    } catch (err) { console.error(err); res.status(503).json({ error: 'temporarily_unavailable' }); }
  });

  return router;
};
