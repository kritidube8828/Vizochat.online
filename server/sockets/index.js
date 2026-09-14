const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { pool } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

// In-memory runtime state. This is per-process, which is fine for a single
// instance. Once you run multiple instances for 10k concurrent users (see
// README), put a load balancer in front with STICKY SESSIONS (so a given
// user's socket always lands on the same instance) - the Redis adapter
// wired up in index.js keeps cross-instance emits working, but this
// matchmaking queue/room map itself is still local to each process.
const onlineUsers = new Map();   // userId -> socketId
const waitingQueue = [];         // [userId, ...]
const rooms = new Map();         // roomId -> { a: userId, b: userId }
const userRoom = new Map();      // userId -> roomId
const activeGifts = new Map();   // roomId -> { intervalId, giftSessionId, senderId, receiverId, remaining, startedAt }

function getOnlineCount() {
  return onlineUsers.size;
}

async function authenticateSocket(socket, next) {
  try {
    const token = socket.handshake.auth?.token;
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.uid]);
    const user = rows[0];
    if (!user) return next(new Error('user_not_found'));
    socket.user = user;
    next();
  } catch (err) {
    next(new Error('unauthorized'));
  }
}

async function refreshUser(userId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  return rows[0];
}

// Row-locks both users involved before touching balances, so this can never
// double-settle even if it were somehow triggered twice concurrently for the
// same room (e.g. simultaneous disconnect + swipe racing at high load).
async function endGiftSession(io, roomId, reason) {
  const g = activeGifts.get(roomId);
  if (!g) return;
  clearInterval(g.intervalId);
  activeGifts.delete(roomId);

  const elapsedSeconds = Math.min(g.giftAmount, Math.floor((Date.now() - g.startedAt) / 1000));
  const consumed = elapsedSeconds;
  const unused = g.giftAmount - consumed;
  const now = Date.now();

  const client = await pool.connect();
  let updatedSender, updatedReceiver;
  try {
    await client.query('BEGIN');
    // Lock in a consistent order (sender id, then receiver id, alphabetically)
    // to avoid a classic deadlock where two simultaneous gift settlements
    // lock the same two users in opposite order.
    const ids = [g.senderId, g.receiverId].sort();
    const locked = {};
    for (const id of ids) {
      const r = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]);
      locked[id] = r.rows[0];
    }
    const sender = locked[g.senderId];
    const receiver = locked[g.receiverId];
    if (!sender || !receiver) { await client.query('ROLLBACK'); return; }

    if (unused > 0) {
      await client.query('UPDATE users SET spendable_coins = spendable_coins + $1, updated_at = $2 WHERE id = $3', [unused, now, sender.id]);
      await client.query(
        `INSERT INTO coin_transactions (id, user_id, type, amount, source, balance_type, status, created_at)
         VALUES ($1, $2, 'credit', $3, 'gift_refund', 'spendable', 'completed', $4)`,
        [uuid(), sender.id, unused, now]
      );
    }
    if (consumed > 0) {
      await client.query('UPDATE users SET earned_coins = earned_coins + $1, updated_at = $2 WHERE id = $3', [consumed, now, receiver.id]);
      await client.query(
        `INSERT INTO coin_transactions (id, user_id, type, amount, source, balance_type, status, created_at)
         VALUES ($1, $2, 'credit', $3, 'gift_received', 'earned', 'completed', $4)`,
        [uuid(), receiver.id, consumed, now]
      );
    }
    await client.query(
      `UPDATE gift_sessions SET ended_at = $1, consumed_seconds = $2, consumed_coins = $3, unused_coins = $4,
       status = 'completed', sender_balance_after = $5, receiver_earning_after = $6 WHERE id = $7`,
      [now, elapsedSeconds, consumed, unused,
        Number(sender.spendable_coins) + unused, Number(receiver.earned_coins) + consumed, g.giftSessionId]
    );
    await client.query('COMMIT');

    updatedSender = (await pool.query('SELECT spendable_coins, earned_coins FROM users WHERE id = $1', [sender.id])).rows[0];
    updatedReceiver = (await pool.query('SELECT spendable_coins, earned_coins FROM users WHERE id = $1', [receiver.id])).rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Gift settlement failed - transaction rolled back, no coins were lost or duplicated:', err.message);
    return;
  } finally {
    client.release();
  }

  io.to(roomId).emit('gift_ended', { reason, consumed, unused, gift_session_id: g.giftSessionId });
  io.to(g.senderSocketId).emit('balance_update', { spendable_coins: Number(updatedSender.spendable_coins), earned_coins: Number(updatedSender.earned_coins) });
  io.to(g.receiverSocketId).emit('balance_update', { spendable_coins: Number(updatedReceiver.spendable_coins), earned_coins: Number(updatedReceiver.earned_coins) });
}

async function leaveRoom(io, socket, { rejoinQueue } = {}) {
  const roomId = userRoom.get(socket.user.id);
  if (!roomId) return;

  await endGiftSession(io, roomId, 'session_ended');

  const room = rooms.get(roomId);
  if (room) {
    const otherId = room.a === socket.user.id ? room.b : room.a;
    userRoom.delete(otherId);
    userRoom.delete(socket.user.id);
    rooms.delete(roomId);

    const otherSocketId = onlineUsers.get(otherId);
    if (otherSocketId) {
      io.to(otherSocketId).emit('partner_left');
      io.sockets.sockets.get(otherSocketId)?.leave(roomId);
      if (rejoinQueue?.requeueOther) {
        enqueue(io, otherId);
      }
    }
  }
  socket.leave(roomId);
}

function tryMatch(io) {
  while (waitingQueue.length >= 2) {
    const aId = waitingQueue.shift();
    const bId = waitingQueue.shift();
    const aSocketId = onlineUsers.get(aId);
    const bSocketId = onlineUsers.get(bId);
    if (!aSocketId || !bSocketId) {
      if (aSocketId) waitingQueue.unshift(aId);
      if (bSocketId) waitingQueue.unshift(bId);
      continue;
    }
    const roomId = uuid();
    rooms.set(roomId, { a: aId, b: bId });
    userRoom.set(aId, roomId);
    userRoom.set(bId, roomId);

    const aSocket = io.sockets.sockets.get(aSocketId);
    const bSocket = io.sockets.sockets.get(bSocketId);
    aSocket?.join(roomId);
    bSocket?.join(roomId);

    io.to(aSocketId).emit('matched', { roomId, initiator: true, peerId: bId });
    io.to(bSocketId).emit('matched', { roomId, initiator: false, peerId: aId });
  }
}

function enqueue(io, userId) {
  if (!waitingQueue.includes(userId) && !userRoom.has(userId)) {
    waitingQueue.push(userId);
  }
  tryMatch(io);
}

function dequeue(userId) {
  const idx = waitingQueue.indexOf(userId);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

function attachSocketHandlers(io) {
  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    const user = socket.user;
    onlineUsers.set(user.id, socket.id);
    // NOTE: we deliberately do NOT broadcast presence to every connected socket
    // here - at hundreds/thousands of concurrent users that turns into an
    // O(n^2) message storm on every connect/disconnect. The admin panel
    // instead polls GET /api/admin/stats periodically, which is O(1) per request.

    socket.on('find_match', async () => {
      try {
        const fresh = await refreshUser(user.id);
        if (!fresh || fresh.account_status === 'banned') {
          socket.emit('banned', { ban_expires_at: fresh?.ban_expires_at ? Number(fresh.ban_expires_at) : null });
          return;
        }
        enqueue(io, user.id);
        socket.emit('searching');
      } catch (err) {
        console.error('find_match failed:', err.message);
        socket.emit('gift_error', { error: 'server_error' });
      }
    });

    socket.on('cancel_search', () => dequeue(user.id));

    // WebRTC signaling relay (offer/answer/ICE candidates) - server never
    // inspects media, it just relays SDP/ICE between the two matched peers.
    socket.on('signal', ({ roomId, data }) => {
      socket.to(roomId).emit('signal', { data, from: user.id });
    });

    socket.on('swipe_next', async () => {
      await leaveRoom(io, socket, { requeueOther: true });
      enqueue(io, user.id);
      socket.emit('searching');
    });

    socket.on('leave_room', async () => {
      await leaveRoom(io, socket, { requeueOther: true });
    });

    // ---- In-call text chat ----
    socket.on('chat_message', ({ text }) => {
      const roomId = userRoom.get(user.id);
      if (!roomId || !text) return;
      const trimmed = String(text).slice(0, 500); // guard against huge payloads
      socket.to(roomId).emit('chat_message', { text: trimmed, from: user.id, at: Date.now() });
    });

    // ---- GIFT SYSTEM (server-authoritative) ----
    socket.on('send_gift', async ({ amount }) => {
      const roomId = userRoom.get(user.id);
      if (!roomId) return socket.emit('gift_error', { error: 'not_in_a_call' });
      if (activeGifts.has(roomId)) return socket.emit('gift_error', { error: 'gift_already_active' });

      const validAmounts = [3, 29, 69, 149, 599, 999];
      if (!validAmounts.includes(amount)) return socket.emit('gift_error', { error: 'invalid_gift_amount' });

      const room = rooms.get(roomId);
      const receiverId = room.a === user.id ? room.b : room.a;
      const receiverSocketId = onlineUsers.get(receiverId);
      if (!receiverSocketId) return socket.emit('gift_error', { error: 'partner_offline' });

      const now = Date.now();
      const giftSessionId = uuid();
      const client = await pool.connect();
      let newSpendable, newEarnedForSenderDisplay;

      try {
        await client.query('BEGIN');
        // Lock the sender's row before checking balance - required so two
        // simultaneous gift sends from the same user can't both pass the
        // balance check against a stale read.
        const senderRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [user.id]);
        const sender = senderRes.rows[0];
        if (!sender || Number(sender.spendable_coins) < amount) {
          await client.query('ROLLBACK');
          return socket.emit('gift_error', { error: 'insufficient_balance' });
        }
        const receiverRes = await client.query('SELECT earned_coins FROM users WHERE id = $1', [receiverId]);

        await client.query('UPDATE users SET spendable_coins = spendable_coins - $1, updated_at = $2 WHERE id = $3', [amount, now, user.id]);
        await client.query(
          `INSERT INTO coin_transactions (id, user_id, type, amount, source, balance_type, status, created_at)
           VALUES ($1, $2, 'debit', $3, 'gift_sent', 'spendable', 'completed', $4)`,
          [uuid(), user.id, amount, now]
        );
        await client.query(
          `INSERT INTO gift_sessions (id, sender_id, receiver_id, room_id, gift_amount, started_at, platform_fee, status, sender_balance_before, receiver_earning_before)
           VALUES ($1,$2,$3,$4,$5,$6,0,'active',$7,$8)`,
          [giftSessionId, user.id, receiverId, roomId, amount, now, sender.spendable_coins, receiverRes.rows[0].earned_coins]
        );
        await client.query('COMMIT');
        newSpendable = Number(sender.spendable_coins) - amount;
        newEarnedForSenderDisplay = Number(sender.earned_coins);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('send_gift failed:', err.message);
        return socket.emit('gift_error', { error: 'server_error' });
      } finally {
        client.release();
      }

      socket.emit('balance_update', { spendable_coins: newSpendable, earned_coins: newEarnedForSenderDisplay });

      let remaining = amount;
      const intervalId = setInterval(() => {
        remaining -= 1;
        io.to(roomId).emit('gift_tick', { remaining, gift_session_id: giftSessionId });
        if (remaining <= 0) {
          endGiftSession(io, roomId, 'completed');
        }
      }, 1000);

      activeGifts.set(roomId, {
        intervalId, giftSessionId, giftAmount: amount,
        senderId: user.id, receiverId, startedAt: now,
        senderSocketId: socket.id, receiverSocketId
      });

      io.to(roomId).emit('gift_started', { amount, gift_session_id: giftSessionId, senderId: user.id });
    });

    socket.on('disconnect', async () => {
      onlineUsers.delete(user.id);
      dequeue(user.id);
      try {
        await leaveRoom(io, socket, { requeueOther: true });
      } catch (err) {
        console.error('Cleanup on disconnect failed:', err.message);
      }
    });
  });
}

module.exports = { attachSocketHandlers, getOnlineCount };
