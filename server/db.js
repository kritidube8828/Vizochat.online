// db.js - PostgreSQL (via `pg`). Replaces the earlier SQLite file, which
// lived on the app server's local disk and was silently wiped on every
// restart/redeploy on most hosting platforms (Render, Railway, Heroku, etc).
// A managed Postgres instance lives independently of the app process, so
// data survives crashes, redeploys, and scaling up to multiple instances.
require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set in server/.env. See .env.example.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 20), // per-instance pool size; run multiple instances behind a load balancer for 10k concurrent, see README
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
});

// A dropped/broken idle connection must never crash the whole process -
// the pool recovers and issues a fresh connection on the next query.
pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error (connection recovered automatically):', err.message);
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      google_id TEXT UNIQUE,
      username TEXT NOT NULL,
      email TEXT,
      profile_image TEXT,
      spendable_coins BIGINT NOT NULL DEFAULT 0,
      earned_coins BIGINT NOT NULL DEFAULT 0,
      account_status TEXT NOT NULL DEFAULT 'active',
      ban_started_at BIGINT,
      ban_expires_at BIGINT,
      is_admin BOOLEAN NOT NULL DEFAULT false,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      task_date TEXT NOT NULL,
      task_name TEXT NOT NULL,
      completed_at BIGINT NOT NULL,
      reward_coins INTEGER NOT NULL,
      UNIQUE(user_id, task_date)
    );

    CREATE TABLE IF NOT EXISTS coin_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      amount BIGINT NOT NULL,
      source TEXT NOT NULL,
      balance_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      meta TEXT,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gift_sessions (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL REFERENCES users(id),
      receiver_id TEXT NOT NULL REFERENCES users(id),
      room_id TEXT,
      gift_amount INTEGER NOT NULL,
      started_at BIGINT NOT NULL,
      ended_at BIGINT,
      consumed_seconds INTEGER,
      consumed_coins INTEGER,
      unused_coins INTEGER,
      platform_fee INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      sender_balance_before BIGINT,
      sender_balance_after BIGINT,
      receiver_earning_before BIGINT,
      receiver_earning_after BIGINT
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL REFERENCES users(id),
      reported_user_id TEXT NOT NULL REFERENCES users(id),
      session_id TEXT,
      reason TEXT,
      evidence_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      package_label TEXT NOT NULL,
      amount_inr INTEGER NOT NULL,
      coins INTEGER NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      provider_order_id TEXT,
      provider_transaction_id TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS error_logs (
      id TEXT PRIMARY KEY,
      message TEXT,
      stack TEXT,
      route TEXT,
      created_at BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_reports_reported_created ON reports(reported_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_coin_tx_user ON coin_transactions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(provider_order_id);
    CREATE INDEX IF NOT EXISTS idx_error_logs_created ON error_logs(created_at DESC);
  `);
}

module.exports = { pool, migrate };
