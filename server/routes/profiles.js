const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, publicProfile } = require('../middleware/auth');

const router = express.Router();

// Brute-force protection for PIN login (max 5 failed attempts per 15 minutes per IP+profile)
const loginAttempts = new Map(); // key -> { count, resetAt }
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_WINDOW_MS = 15 * 60 * 1000;

function getAttemptKey(req, profileId) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  return `${ip}:${profileId}`;
}

function isRateLimited(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= MAX_PIN_ATTEMPTS;
}

function recordFailedAttempt(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + PIN_LOCK_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

// List profiles for the "who's watching" picker. No auth required to view
// the list (mirrors a Netflix-style profile screen), but no secrets leak.
router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT id, display_name, avatar_color, pin_hash, disabled FROM profiles WHERE disabled = 0 ORDER BY id ASC')
    .all();
  res.json(
    rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      avatarColor: r.avatar_color,
      hasPin: !!r.pin_hash,
    }))
  );
});

router.get('/me', (req, res) => {
  res.json({ profile: publicProfile(req.profile) });
});

router.post('/:id/select', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid profile ID.' });
  }
  const attemptKey = getAttemptKey(req, id);
  if (isRateLimited(attemptKey)) {
    return res.status(429).json({ error: 'Too many failed PIN attempts. Please wait 15 minutes and try again.' });
  }

  const profile = db.prepare('SELECT * FROM profiles WHERE id = ? AND disabled = 0').get(id);
  if (!profile) return res.status(404).json({ error: 'Profile not found.' });

  if (profile.pin_hash) {
    const pin = (req.body && req.body.pin) || '';
    if (!pin || typeof pin !== 'string' || pin.length > 16 || !bcrypt.compareSync(String(pin), profile.pin_hash)) {
      recordFailedAttempt(attemptKey);
      return res.status(401).json({ error: 'Incorrect PIN.' });
    }
    loginAttempts.delete(attemptKey);
  }

  // Regenerate session ID on login to prevent session fixation
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start session.' });
    req.session.userId = profile.id;
    res.json({ profile: publicProfile(profile) });
  });
});

router.post('/logout', requireAuth, (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Could not log out.' });
    res.json({ ok: true });
  });
});

module.exports = router;
