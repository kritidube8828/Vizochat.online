const express = require('express');
const { v4: uuid } = require('uuid');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { publicUser } = require('./auth');

const router = express.Router();

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post('/logout', requireAuth, (req, res) => {
  // Stateless JWT: real invalidation would use a token blacklist / short expiry + refresh.
  res.json({ ok: true });
});

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// GET current daily task status
router.get('/daily-task', requireAuth, async (req, res) => {
  try {
    const date = todayUTC();
    const { rows } = await pool.query('SELECT 1 FROM daily_tasks WHERE user_id = $1 AND task_date = $2', [req.user.id, date]);
    res.json({
      claimed_today: rows.length > 0,
      reward_coins: 25,
      task_name: 'Write / Submit: vizochat.online'
    });
  } catch (err) {
    console.error(err);
    res.status(503).json({ error: 'temporarily_unavailable' });
  }
});

// POST claim daily task reward. The UNIQUE(user_id, task_date) constraint is
// what actually prevents a double-claim under concurrency - two simultaneous
// requests from the same user race to insert, and the database itself
// rejects the second one atomically (no app-level check-then-insert gap).
router.post('/daily-task/claim', requireAuth, async (req, res) => {
  const date = todayUTC();
  const now = Date.now();
  const reward = 25;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO daily_tasks (id, user_id, task_date, task_name, completed_at, reward_coins) VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuid(), req.user.id, date, 'Write / Submit: vizochat.online', now, reward]
    );
    const updated = await client.query(
      `UPDATE users SET spendable_coins = spendable_coins + $1, updated_at = $2 WHERE id = $3 RETURNING spendable_coins`,
      [reward, now, req.user.id]
    );
    await client.query(
      `INSERT INTO coin_transactions (id, user_id, type, amount, source, balance_type, status, created_at)
       VALUES ($1, $2, 'credit', $3, 'daily_task', 'spendable', 'completed', $4)`,
      [uuid(), req.user.id, reward, now]
    );
    await client.query('COMMIT');
    res.json({ ok: true, reward_coins: reward, new_balance: Number(updated.rows[0].spendable_coins) });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') { // unique_violation = already claimed today
      return res.status(409).json({ error: 'already_claimed_today' });
    }
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});

// Transaction history (coins) - for Earn Coin / Remain Coin pages
router.get('/transactions', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM coin_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.user.id]
    );
    res.json({ transactions: rows.map(r => ({ ...r, amount: Number(r.amount) })) });
  } catch (err) {
    console.error(err);
    res.status(503).json({ error: 'temporarily_unavailable' });
  }
});

module.exports = router;
