const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuid } = require('uuid');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const EVIDENCE_DIR = path.join(__dirname, '..', 'uploads', 'evidence');
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, EVIDENCE_DIR),
  filename: (req, file, cb) => cb(null, uuid() + path.extname(file.originalname || '.webm'))
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

const WINDOW_MIN = Number(process.env.REPORT_WINDOW_MINUTES || 60);
const THRESHOLD = Number(process.env.REPORT_BAN_THRESHOLD || 5);
const BAN_DAYS = Number(process.env.BAN_DURATION_DAYS || 21);

async function applyAutoBanIfNeeded(reportedUserId) {
  const since = Date.now() - WINDOW_MIN * 60 * 1000;
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT reporter_id)::int AS count FROM reports
     WHERE reported_user_id = $1 AND created_at >= $2 AND status != 'dismissed'`,
    [reportedUserId, since]
  );

  if (rows[0].count >= THRESHOLD) {
    const now = Date.now();
    const expires = now + BAN_DAYS * 24 * 60 * 60 * 1000;
    await pool.query(
      `UPDATE users SET account_status = 'banned', ban_started_at = $1, ban_expires_at = $2, updated_at = $1
       WHERE id = $3 AND account_status != 'banned'`,
      [now, expires, reportedUserId]
    );
    return { banned: true, ban_expires_at: expires };
  }
  return { banned: false };
}

// POST /api/reports  (multipart: evidence file field "clip", plus reported_user_id, reason, session_id)
// Evidence is stored privately on the server filesystem - never served publicly.
router.post('/', requireAuth, upload.single('clip'), async (req, res) => {
  try {
    const { reported_user_id, reason, session_id } = req.body;
    if (!reported_user_id) return res.status(400).json({ error: 'reported_user_id required' });
    if (reported_user_id === req.user.id) return res.status(400).json({ error: 'cannot_report_self' });

    // Prevent duplicate/spam report from same reporter against same person for same session.
    const dup = await pool.query(
      `SELECT id FROM reports WHERE reporter_id = $1 AND reported_user_id = $2 AND (session_id = $3 OR session_id IS NULL)
       AND created_at >= $4`,
      [req.user.id, reported_user_id, session_id || null, Date.now() - 10 * 60 * 1000]
    );
    if (dup.rows.length) return res.status(409).json({ error: 'duplicate_report' });

    const id = uuid();
    const now = Date.now();
    const evidencePath = req.file ? path.join('evidence', req.file.filename) : null;

    await pool.query(
      `INSERT INTO reports (id, reporter_id, reported_user_id, session_id, reason, evidence_url, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'valid',$7)`,
      [id, req.user.id, reported_user_id, session_id || null, reason || null, evidencePath, now]
    );

    const banResult = await applyAutoBanIfNeeded(reported_user_id);
    res.json({ ok: true, report_id: id, ...banResult });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
