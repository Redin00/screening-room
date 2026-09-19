const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

const COLORS = ['#c98a3e', '#d97757', '#3e7ac9', '#5aa66b', '#a35ac9', '#c93e5a', '#3ec9b0'];
function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

router.get('/profiles', (req, res) => {
  const rows = db
    .prepare(
      'SELECT id, display_name, is_admin, can_host, avatar_color, pin_hash, disabled, created_at FROM profiles ORDER BY id ASC'
    )
    .all();
  res.json(
    rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      isAdmin: !!r.is_admin,
      canHost: !!r.can_host,
      avatarColor: r.avatar_color,
      hasPin: !!r.pin_hash,
      disabled: !!r.disabled,
      createdAt: r.created_at,
    }))
  );
});

router.post('/profiles', (req, res) => {
  const { displayName, pin, canHost, isAdmin } = req.body || {};
  const name = String(displayName || '').trim();
  if (!name) return res.status(400).json({ error: 'Display name is required.' });
  if (pin && !/^\d{4,8}$/.test(String(pin))) {
    return res.status(400).json({ error: 'PIN must be 4–8 digits, or left blank.' });
  }

  const existing = db.prepare('SELECT id FROM profiles WHERE display_name = ?').get(name);
  if (existing) return res.status(409).json({ error: 'A profile with that name already exists.' });

  const pinHash = pin ? bcrypt.hashSync(String(pin), 10) : null;
  const info = db
    .prepare(
      `INSERT INTO profiles (display_name, pin_hash, is_admin, can_host, avatar_color)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(name, pinHash, isAdmin ? 1 : 0, canHost ? 1 : 0, randomColor());

  res.status(201).json({ id: info.lastInsertRowid });
});

router.patch('/profiles/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
  if (!profile) return res.status(404).json({ error: 'Profile not found.' });

  const { canHost, isAdmin, disabled, pin, clearPin, displayName } = req.body || {};

  if (id === req.profile.id && (isAdmin === false || disabled === true)) {
    const adminCount = db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE is_admin = 1 AND disabled = 0').get().n;
    if (adminCount <= 1) {
      return res.status(400).json({ error: "Can't remove the last remaining admin." });
    }
  }

  const updates = [];
  const params = [];

  if (typeof canHost === 'boolean') {
    updates.push('can_host = ?');
    params.push(canHost ? 1 : 0);
  }
  if (typeof isAdmin === 'boolean') {
    updates.push('is_admin = ?');
    params.push(isAdmin ? 1 : 0);
  }
  if (typeof disabled === 'boolean') {
    updates.push('disabled = ?');
    params.push(disabled ? 1 : 0);
  }
  if (typeof displayName === 'string' && displayName.trim()) {
    updates.push('display_name = ?');
    params.push(displayName.trim());
  }
  if (clearPin) {
    updates.push('pin_hash = ?');
    params.push(null);
  } else if (pin) {
    if (!/^\d{4,8}$/.test(String(pin))) {
      return res.status(400).json({ error: 'PIN must be 4–8 digits.' });
    }
    updates.push('pin_hash = ?');
    params.push(bcrypt.hashSync(String(pin), 10));
  }

  if (!updates.length) return res.status(400).json({ error: 'No changes provided.' });

  params.push(id);
  db.prepare(`UPDATE profiles SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

router.delete('/profiles/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.profile.id) return res.status(400).json({ error: "You can't delete the profile you're using." });

  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
  if (!profile) return res.status(404).json({ error: 'Profile not found.' });

  db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
