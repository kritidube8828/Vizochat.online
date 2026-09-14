const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const PACKAGES = [
  { label: '49', amount_inr: 49, coins: 125 },
  { label: '99', amount_inr: 99, coins: 270 },
  { label: '249', amount_inr: 249, coins: 625 },
  { label: '999', amount_inr: 999, coins: 2700 }
];

router.get('/packages', (req, res) => res.json({ packages: PACKAGES }));

// Remain Coin page data
router.get('/remain', requireAuth, (req, res) => {
  res.json({
    spendable_coins: Number(req.user.spendable_coins),
    packages: PACKAGES
  });
});

// Earn Coin page data
router.get('/earn', requireAuth, async (req, res) => {
  try {
    const perDollar = Number(process.env.EARNED_COINS_PER_DOLLAR || 307);
    const withdrawableUsd = +(Number(req.user.earned_coins) / perDollar).toFixed(2);
    const { rows } = await pool.query(
      `SELECT * FROM coin_transactions WHERE user_id = $1 AND balance_type = 'earned' ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );

    res.json({
      total_earned: Number(req.user.earned_coins),
      withdrawable_usd: withdrawableUsd,
      coins_per_dollar: perDollar,
      history: rows.map(r => ({ ...r, amount: Number(r.amount) }))
    });
  } catch (err) {
    console.error(err);
    res.status(503).json({ error: 'temporarily_unavailable' });
  }
});

module.exports = router;
