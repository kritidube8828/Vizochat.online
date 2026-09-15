require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const { v4: uuid } = require('uuid');

const { pool, migrate } = require('./db');
const { router: authRouter } = require('./routes/auth');
const userRouter = require('./routes/user');
const coinsRouter = require('./routes/coins');
const { router: paymentsRouter, webhookHandler } = require('./routes/payments');
const reportsRouter = require('./routes/reports');
const adminRouterFactory = require('./routes/admin');
const { attachSocketHandlers, getOnlineCount } = require('./sockets/index');

const app = express();
const server = http.createServer(app);

// Socket.io tuned for many mostly-idle-between-events connections
// (matchmaking + gift ticks + occasional chat messages).
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 20000,
  pingInterval: 25000,
  maxHttpBufferSize: 2 * 1024 * 1024,
  perMessageDeflate: { threshold: 1024 }
});

// Optional: when REDIS_URL is set, cross-instance broadcasts (gift ticks,
// room messages, etc) work correctly even when you run multiple Node
// processes/instances behind a load balancer for 10k concurrent users.
// See README "Scaling to 10,000 concurrent users" for the full setup
// (this alone is not enough - you also need sticky sessions at the LB,
// since matchmaking state itself is still per-process).
if (process.env.REDIS_URL) {
  (async () => {
    try {
      const { createAdapter } = require('@socket.io/redis-adapter');
      const { createClient } = require('redis');
      const pubClient = createClient({ url: process.env.REDIS_URL });
      const subClient = pubClient.duplicate();
      pubClient.on('error', (e) => console.error('Redis pub client error:', e.message));
      subClient.on('error', (e) => console.error('Redis sub client error:', e.message));
      await Promise.all([pubClient.connect(), subClient.connect()]);
      io.adapter(createAdapter(pubClient, subClient));
      console.log('Socket.io Redis adapter connected - ready for multi-instance scaling.');
    } catch (err) {
      console.error('Redis adapter failed to connect, continuing in single-instance mode:', err.message);
    }
  })();
} else {
  console.log('REDIS_URL not set - running in single-instance mode (fine up to a few hundred/low-thousands concurrent users).');
}

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false })); // CSP off by default since the client loads Google/Razorpay/Socket.io scripts from CDNs; lock this down with your real domains before production if you want CSP on
app.use(compression());
app.use(cors());

// Razorpay webhook needs the exact raw request bytes for signature
// verification, so it must be mounted BEFORE the global JSON body parser.
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), webhookHandler);

app.use(express.json({ limit: '1mb' }));

// Basic abuse protection so a small number of clients can't hammer the API
// and starve everyone else. Generous enough for many users sharing one
// public IP (mobile carrier NAT / office wifi).
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

app.use(express.static(path.join(__dirname, 'client'), { maxAge: '1h' }));

app.use('/api/auth', authRouter);
app.use('/api/user', userRouter);
app.use('/api/coins', coinsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/admin', adminRouterFactory(getOnlineCount));

attachSocketHandlers(io);

// Central error logger - captures unexpected server errors for the admin
// monitoring panel. Never leaks stack traces or internals to the client.
app.use((err, req, res, next) => {
  logErrorSafely(err.message, err.stack, req.originalUrl);
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

async function logErrorSafely(message, stack, route) {
  try {
    await pool.query('INSERT INTO error_logs (id, message, stack, route, created_at) VALUES ($1,$2,$3,$4,$5)',
      [uuid(), message, stack, route, Date.now()]);
  } catch (_) { /* if logging itself fails, don't let that crash anything */ }
}

// A crash in one request must never take down the whole process (and every
// DB write in this app already goes through a transaction, so an in-flight
// operation that gets interrupted rolls back cleanly rather than leaving
// half-written/corrupted data behind).
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (process kept alive):', err);
  logErrorSafely(err.message, err.stack, 'uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (process kept alive):', reason);
  logErrorSafely(String(reason?.message || reason), reason?.stack, 'unhandledRejection');
});

// Graceful shutdown - finish in-flight requests/DB transactions before
// exiting, instead of dropping connections mid-write on deploy/restart.
function gracefulShutdown() {
  console.log('Shutting down gracefully...');
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10000).unref(); // force-exit if something hangs
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Auto-restore expired 21-day bans every minute
setInterval(async () => {
  try {
    const now = Date.now();
    await pool.query(
      `UPDATE users SET account_status = 'active', ban_started_at = NULL, ban_expires_at = NULL, updated_at = $1
       WHERE account_status = 'banned' AND ban_expires_at IS NOT NULL AND ban_expires_at <= $1`,
      [now]
    );
  } catch (err) { console.error('Ban-expiry check failed (will retry next minute):', err.message); }
}, 60 * 1000);

const PORT = process.env.PORT || 4000;

migrate()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`VizoChat server running on http://localhost:${PORT}`);
      if (!process.env.GOOGLE_CLIENT_ID) {
        console.warn('WARNING: GOOGLE_CLIENT_ID is not set - login will not work until you configure it in server/.env');
      }
      if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        console.warn('WARNING: RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET not set - Buy Coins will show a setup message until configured.');
      }
    });
  })
  .catch((err) => {
    console.error('FATAL: database migration failed, refusing to start:', err.message);
    process.exit(1);
  });
