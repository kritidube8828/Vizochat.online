const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { OAuth2Client } = require('google-auth-library');
const { pool } = require('../db');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

// This is the classic OAuth 2.0 "Authorization Code" flow: a plain full-page
// redirect to Google and back, with the token exchange happening
// server-to-server. It does NOT depend on third-party cookies, iframes, or
// FedCM the way the "Sign in with Google" button/One Tap widget does - so it
// keeps working even as browsers lock down cross-site cookies further.
let oauthClient = null;
if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
}

function issueToken(user) {
  return jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });
}

function redirectUriFor(req) {
  // Built from the actual request, so it automatically matches whichever
  // domain the person is using (Railway domain, custom domain, localhost) -
  // as long as that exact URL is also listed in Google Cloud Console under
  // "Authorized redirect URIs".
  return `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
}

async function findOrCreateUser({ google_id, username, email, profile_image }) {
  const now = Date.now();
  const existing = await pool.query('SELECT * FROM users WHERE google_id = $1', [google_id]);
  if (existing.rows[0]) {
    const updated = await pool.query(
      `UPDATE users SET username = $1, email = $2, profile_image = $3, updated_at = $4 WHERE id = $5 RETURNING *`,
      [username, email, profile_image, now, existing.rows[0].id]
    );
    return updated.rows[0];
  }
  const id = uuid();
  const created = await pool.query(
    `INSERT INTO users (id, google_id, username, email, profile_image, spendable_coins, earned_coins, account_status, is_admin, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,0,0,'active',false,$6,$6) RETURNING *`,
    [id, google_id, username, email, profile_image, now]
  );
  return created.rows[0];
}

// Public - the client checks this to decide whether to show the login button
// or a "not configured" message.
router.get('/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ googleConfigured: !!oauthClient });
});

// STEP 1 - the login page's button links here, which redirects the whole
// page to Google's consent screen. Nothing but a normal top-level navigation.
router.get('/google/start', (req, res) => {
  if (!oauthClient) {
    return res.status(400).send('Google login is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server/.env.');
  }
  const url = oauthClient.generateAuthUrl({
    redirect_uri: redirectUriFor(req),
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account'
  });
  res.redirect(url);
});

// STEP 2 - Google redirects back here with a one-time ?code. Exchanged for
// tokens server-to-server (never exposed to the browser), then the person
// is handed a normal app JWT via a short bridge page.
router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/auth-callback.html?error=' + encodeURIComponent(error));
  if (!oauthClient || !code) return res.redirect('/auth-callback.html?error=missing_code');

  try {
    const { tokens } = await oauthClient.getToken({ code, redirect_uri: redirectUriFor(req) });
    const ticket = await oauthClient.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload.email_verified) {
      return res.redirect('/auth-callback.html?error=email_not_verified');
    }

    const user = await findOrCreateUser({
      google_id: payload.sub,
      username: payload.name || payload.email.split('@')[0],
      email: payload.email,
      profile_image: payload.picture
    });

    const token = issueToken(user);
    res.redirect('/auth-callback.html?token=' + encodeURIComponent(token));
  } catch (err) {
    console.error('Google OAuth callback failed:', err.message);
    res.redirect('/auth-callback.html?error=exchange_failed');
  }
});

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    profile_image: u.profile_image,
    spendable_coins: Number(u.spendable_coins),
    earned_coins: Number(u.earned_coins),
    account_status: u.account_status,
    ban_expires_at: u.ban_expires_at ? Number(u.ban_expires_at) : null,
    is_admin: !!u.is_admin
  };
}

module.exports = { router, publicUser };
