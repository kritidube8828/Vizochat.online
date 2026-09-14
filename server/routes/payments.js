const express = require('express');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const PACKAGES = {
  '49': { amount_inr: 49, coins: 125 },
  '99': { amount_inr: 99, coins: 270 },
  '249': { amount_inr: 249, coins: 625 },
  '999': { amount_inr: 999, coins: 2700 }
};

const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';

let razorpay = null;
if (KEY_ID && KEY_SECRET) {
  const Razorpay = require('razorpay');
  razorpay = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });
}

// Coins are only ever credited inside this one function, and it locks the
// payment row (SELECT ... FOR UPDATE) before checking its status. That lock
// is essential now that two independent callers - the client-side /verify
// call AND the Razorpay webhook - can race to credit the SAME payment at
// the same instant. Without the row lock, both could read "pending"
// simultaneously and both credit the coins (a double-credit bug that a
// single-writer SQLite setup masked by accident, but a real concern once
// multiple server instances/concurrent requests are in play at 10k scale).
async function creditPaymentIfPending(paymentId, providerPaymentId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
    const payment = rows[0];
    if (!payment) { await client.query('ROLLBACK'); return { ok: false, reason: 'not_found' }; }
    if (payment.payment_status === 'success') { await client.query('ROLLBACK'); return { ok: true, already: true, payment }; }

    const now = Date.now();
    await client.query(`UPDATE payments SET payment_status = 'success', provider_transaction_id = $1, updated_at = $2 WHERE id = $3`,
      [providerPaymentId, now, payment.id]);
    await client.query('UPDATE users SET spendable_coins = spendable_coins + $1, updated_at = $2 WHERE id = $3',
      [payment.coins, now, payment.user_id]);
    await client.query(
      `INSERT INTO coin_transactions (id, user_id, type, amount, source, balance_type, status, meta, created_at)
       VALUES ($1, $2, 'credit', $3, 'purchase', 'spendable', 'completed', $4, $5)`,
      [uuid(), payment.user_id, payment.coins, JSON.stringify({ payment_id: payment.id }), now]
    );
    await client.query('COMMIT');
    return { ok: true, already: false, payment };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

router.get('/packages', (req, res) => res.json({ packages: PACKAGES, configured: !!razorpay }));

// STEP 1 - Create a real Razorpay order. The client uses this order id to
// open Razorpay's Checkout widget - no coins are credited at this point.
router.post('/create', requireAuth, async (req, res) => {
  const { package_label } = req.body;
  const pkg = PACKAGES[package_label];
  if (!pkg) return res.status(400).json({ error: 'invalid_package' });
  if (!razorpay) {
    return res.status(400).json({
      error: 'payment_gateway_not_configured',
      message: 'Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in server/.env (use test mode keys to try it out for free).'
    });
  }

  try {
    const order = await razorpay.orders.create({
      amount: pkg.amount_inr * 100, // paise
      currency: 'INR',
      receipt: 'vizo_' + Date.now()
    });

    const id = uuid();
    const now = Date.now();
    await pool.query(
      `INSERT INTO payments (id, user_id, package_label, amount_inr, coins, payment_status, provider_order_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$7)`,
      [id, req.user.id, package_label, pkg.amount_inr, pkg.coins, order.id, now]
    );

    res.json({
      payment_id: id,
      razorpay_order_id: order.id,
      razorpay_key_id: KEY_ID,
      amount_inr: pkg.amount_inr,
      coins: pkg.coins,
      user_name: req.user.username,
      user_email: req.user.email
    });
  } catch (err) {
    console.error('Razorpay order creation failed:', err);
    res.status(502).json({ error: 'order_creation_failed' });
  }
});

// STEP 2 - Client-side verification, called from Razorpay Checkout's success
// handler. Coins are only credited after the HMAC signature check passes -
// a forged/fake "success" from the browser can never pass this check.
router.post('/verify', requireAuth, async (req, res) => {
  try {
    const { payment_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1 AND user_id = $2', [payment_id, req.user.id]);
    const payment = rows[0];
    if (!payment) return res.status(404).json({ error: 'payment_not_found' });

    const expectedSignature = crypto
      .createHmac('sha256', KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      await pool.query(`UPDATE payments SET payment_status = 'failed', updated_at = $1 WHERE id = $2`, [Date.now(), payment.id]);
      return res.status(402).json({ error: 'signature_mismatch' });
    }

    const result = await creditPaymentIfPending(payment.id, razorpay_payment_id);
    const updated = await pool.query('SELECT spendable_coins FROM users WHERE id = $1', [req.user.id]);
    res.json({ ok: true, coins_added: payment.coins, new_balance: Number(updated.rows[0].spendable_coins), already_credited: result.already });
  } catch (err) {
    console.error(err);
    res.status(503).json({ error: 'temporarily_unavailable' });
  }
});

router.get('/history', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
    res.json({ payments: rows });
  } catch (err) {
    console.error(err);
    res.status(503).json({ error: 'temporarily_unavailable' });
  }
});

// STEP 3 (belt-and-suspenders) - Razorpay server-to-server webhook. This is
// what makes crediting truly automatic for every user even if their browser
// closes/crashes right after paying, before the client-side /verify call
// fires. Mounted with a raw body parser in index.js (signature needs the
// exact raw bytes), so this export is a plain handler, not a router.
async function webhookHandler(req, res) {
  if (!WEBHOOK_SECRET) {
    console.warn('Received Razorpay webhook but RAZORPAY_WEBHOOK_SECRET is not set - ignoring.');
    return res.status(400).send('webhook_not_configured');
  }
  const signature = req.headers['x-razorpay-signature'];
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.body).digest('hex');
  if (signature !== expected) {
    return res.status(400).send('invalid_signature');
  }

  try {
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.event === 'payment.captured' || event.event === 'order.paid') {
      const orderId = event.payload?.payment?.entity?.order_id || event.payload?.order?.entity?.id;
      const paymentEntityId = event.payload?.payment?.entity?.id;
      if (orderId) {
        const { rows } = await pool.query('SELECT * FROM payments WHERE provider_order_id = $1', [orderId]);
        if (rows[0]) await creditPaymentIfPending(rows[0].id, paymentEntityId || 'webhook');
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook processing failed:', err.message);
    // Still 200 so Razorpay doesn't retry-storm us for a parsing issue on our end;
    // the payment stays 'pending' and can be reconciled manually via the admin panel.
    res.json({ received: true, processed: false });
  }
}

module.exports = { router, webhookHandler };
