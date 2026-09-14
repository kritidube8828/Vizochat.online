# VizoChat.online — Full-Stack P2P Video Chat with Coin Economy

Mobile-first, dark-navy/neon-cyan glassmorphism video chat app: Spendable/
Earned coin economy, gift system, random P2P matchmaking, in-call text chat,
reporting + auto-ban, and an admin panel. Backend: Express + Socket.io +
PostgreSQL. Payments: real Razorpay integration. Login: real Google OAuth.

## The bug that was fixed: "login page reopens after Google login"

Two things were causing this, both fixed now:

1. **Auth middleware bug.** The old code verified the JWT *and* looked up the
   user in the database inside the same `try/catch`. Any transient database
   hiccup during the lookup was caught by the same block that handles "bad
   token", so it returned `401 Invalid or expired token` — which the frontend
   correctly (but wrongly, in this case) treated as "log out and show the
   login screen." `server/middleware/auth.js` now verifies the JWT first; a
   database problem after that returns `503` instead, which the client shows
   as a retryable "server is busy" message and never clears your session.

2. **Ephemeral storage.** The original app used a local SQLite file on the
   server's own disk. On most hosting platforms (Render, Railway, Heroku,
   etc.) that disk is wiped on every restart/redeploy — so all users (and
   their coins) could vanish, and logging in again would just create a
   "new" server with no record of you. The app now uses a managed
   **PostgreSQL** database, which lives independently of the app process —
   restarts, redeploys, and crashes no longer touch your data at all.

## Data safety / security

- **Every coin-moving operation is a database transaction** (`BEGIN` /
  `COMMIT` / `ROLLBACK`) — a payment, a gift send, a gift settlement, or a
  daily-task claim either fully happens or fully doesn't. A crash or error
  mid-operation rolls back automatically; nothing is ever partially applied.
- **Row-level locks** (`SELECT ... FOR UPDATE`) on the accounts involved in a
  gift or payment prevent two simultaneous requests (e.g. a client-side
  payment confirmation racing the Razorpay webhook) from double-crediting
  the same coins — a real risk once multiple requests can hit the database
  concurrently at scale.
- **A crash in one request can't take the server down**: `uncaughtException`
  and `unhandledRejection` are caught at the process level, logged to the
  `error_logs` table (visible in the admin panel), and the process keeps
  serving other users instead of dying mid-transaction.
- **Graceful shutdown**: on redeploy/restart (`SIGTERM`), the server stops
  accepting new connections, lets in-flight requests finish, then closes the
  database pool — so a deploy never cuts off a payment or gift mid-write.
- **No internals leak to the client**: every error response is a generic
  `{ error: 'server_error' }` — stack traces and query details only ever go
  to the server-side `error_logs` table, never to the browser.
- **`helmet`** sets standard security headers (hides `X-Powered-By`, blocks
  MIME-sniffing, etc.) and **`express-rate-limit`** caps requests per IP so
  one abusive client can't degrade service for everyone else.
- Report evidence clips are stored on the server's local disk by default —
  move this to a private cloud bucket (S3, etc.) before real production use
  so evidence also survives redeploys and is never publicly reachable.

## Setup

```bash
cd server
npm install
cp .env.example .env      # fill in the values below
npm start
```

### 1. PostgreSQL (required)
Get a free database from any of these (all work fine, pick one):
- https://neon.tech
- https://supabase.com
- https://railway.app

Copy the connection string into `server/.env` as `DATABASE_URL`. The app
creates all its tables automatically on first start — no manual migration
step needed.

### 2. Google OAuth (required — the only way to log in)
1. https://console.cloud.google.com/apis/credentials → create an OAuth 2.0
   Client ID (Web application)
2. Authorized JavaScript origins: your real domain + `http://localhost:4000`
   for local testing
3. Put the Client ID in `server/.env` as `GOOGLE_CLIENT_ID`

### 3. Razorpay (required for Buy Coins)
1. Sign up at https://dashboard.razorpay.com/ — Test mode is free
2. Put your Test **Key ID**/**Key Secret** in `server/.env`
3. Create a Webhook → `https://yourdomain.com/api/payments/webhook`, event
   `payment.captured` → put its secret in `RAZORPAY_WEBHOOK_SECRET`
4. Test card/UPI numbers: https://razorpay.com/docs/payments/payments/test-card-upi-details/

Until these are set, the app shows a clear setup message instead of failing
silently or faking success.

## Making yourself an admin

```bash
cd server
node make-admin.js you@example.com
```

## Scaling to 10,000 concurrent users

The current setup (one Node process) comfortably handles a few hundred to
low-thousands of concurrent users. To reach 10,000, you need **multiple
server instances behind a load balancer**, sharing one Postgres database and
one Redis instance. Recipe:

1. **Redis** — get one (https://upstash.com has a free tier), set
   `REDIS_URL` in `.env` on every instance. This lets Socket.io events
   (matchmaking, gift ticks, chat) work correctly across instances.

2. **Run N instances** — e.g. with PM2:
   ```bash
   PORT=4001 pm2 start index.js --name vizo-1
   PORT=4002 pm2 start index.js --name vizo-2
   PORT=4003 pm2 start index.js --name vizo-3
   PORT=4004 pm2 start index.js --name vizo-4
   pm2 save
   ```
   (Don't use PM2 "cluster mode" for this app — matchmaking state is
   per-process, so you need distinct instances + sticky routing, not
   round-robin worker sharing.)

3. **Sticky sessions at the load balancer** — a given user's WebSocket
   connection must always reach the same instance for matchmaking to work,
   since the waiting queue/room map is still per-process. Example nginx
   config:
   ```nginx
   upstream vizochat {
     ip_hash; # sticky by client IP
     server 127.0.0.1:4001;
     server 127.0.0.1:4002;
     server 127.0.0.1:4003;
     server 127.0.0.1:4004;
   }
   server {
     listen 443 ssl;
     server_name vizochat.online;
     location / {
       proxy_pass http://vizochat;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
     }
   }
   ```

4. **Postgres connection limit** — `N instances × PG_POOL_MAX` must stay
   under your database's max connections. With 4 instances and
   `PG_POOL_MAX=20`, that's 80 connections — check your provider's limit
   (managed Postgres often supports a few hundred; use a connection pooler
   like PgBouncer if you need more instances than that).

5. **Dedicated TURN server** — the app ships with a free public TURN relay
   for testing. At 10k concurrent video calls, get your own (coturn on a
   cheap VPS, or a paid Twilio/Metered plan) — the free one is rate-limited
   and will start failing calls under real load.

6. **Move report evidence off local disk** to S3 or similar, since with
   multiple instances there's no single shared local filesystem.

None of this needs to be set up on day one — the codebase already runs fine
as a single instance. Add Redis + more instances + the load balancer only
once you're actually approaching the scale that needs them.

## Project structure

```
vizochat/
  server/
    index.js              entry point (postgres migration, helmet, redis adapter, socket.io, cron)
    db.js                  PostgreSQL pool + schema
    routes/                auth (Google), user, coins, payments (Razorpay), reports, admin
    middleware/             JWT auth (with the login-loop fix) + ban check
    sockets/index.js        matchmaking, WebRTC signaling relay, gift timer, chat relay
  client/
    index.html              Google Sign-In login
    home.html, profile.html, earn.html, remain.html, help.html, camera.html
    video-chat.html + js/videochat.js   P2P video + chat + gifts + report
    admin.html + js/admin.js             admin panel
    css/style.css                        shared neon/glass theme
```

## Coin rules implemented

- **Spendable coins**: purchases + daily task rewards → usable for gifts.
- **Earned coins**: only from gifts received → not spendable/transferable,
  withdrawal only.
- Gift flow: sender's coins reserved immediately (row-locked check), consumed
  at 1 coin/second server-side. On swipe/disconnect/report/zero, the server
  computes consumed vs. unused, credits the receiver, refunds the sender —
  all in one atomic transaction.

## Known simplifications (documented, not hidden)

- Matchmaking/gift queue state is per-process — see the scaling section for
  going beyond a single instance.
- JWT sessions aren't revocable server-side (no blacklist) — fine for most
  apps, but note it if you need instant force-logout.
