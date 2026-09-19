const db = require('../db');

function loadProfile(req, res, next) {
  req.profile = null;
  const userId = req.session && req.session.userId;
  if (userId) {
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ? AND disabled = 0').get(userId);
    if (profile) req.profile = profile;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.profile) return res.status(401).json({ error: 'Not signed in. Pick a profile first.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.profile || !req.profile.is_admin) {
    return res.status(403).json({ error: 'Admin profile required.' });
  }
  next();
}

function requireHostPermission(req, res, next) {
  if (!req.profile || (!req.profile.can_host && !req.profile.is_admin)) {
    return res.status(403).json({ error: 'This profile does not have permission to create rooms yet. Ask an admin to grant hosting access.' });
  }
  next();
}

function publicProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    isAdmin: !!row.is_admin,
    canHost: !!row.can_host,
    avatarColor: row.avatar_color,
    hasPin: !!row.pin_hash,
  };
}

module.exports = { loadProfile, requireAuth, requireAdmin, requireHostPermission, publicProfile };
