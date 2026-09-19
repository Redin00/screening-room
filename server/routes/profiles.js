const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, publicProfile } = require('../middleware/auth');

const router = express.Router();

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
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ? AND disabled = 0').get(id);
  if (!profile) return res.status(404).json({ error: 'Profile not found.' });

  if (profile.pin_hash) {
    const pin = (req.body && req.body.pin) || '';
    if (!pin || !bcrypt.compareSync(String(pin), profile.pin_hash)) {
      return res.status(401).json({ error: 'Incorrect PIN.' });
    }
  }

  req.session.userId = profile.id;
  res.json({ profile: publicProfile(profile) });
});

router.post('/logout', requireAuth, (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Could not log out.' });
    res.json({ ok: true });
  });
});

module.exports = router;
