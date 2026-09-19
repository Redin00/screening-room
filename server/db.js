const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name TEXT NOT NULL UNIQUE,
    pin_hash TEXT,               -- nullable: profile with no PIN
    is_admin INTEGER NOT NULL DEFAULT 0,
    can_host INTEGER NOT NULL DEFAULT 0,
    avatar_color TEXT NOT NULL DEFAULT '#c98a3e',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    disabled INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    host_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'waiting',   -- waiting | active | closed
    video_path TEXT,
    video_original_name TEXT,
    video_size INTEGER,
    private INTEGER NOT NULL DEFAULT 0,       -- 0 = public (listed), 1 = private (unlisted)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT,
    delete_at TEXT,
    host_last_seen TEXT,
    viewer_count INTEGER NOT NULL DEFAULT 0,
    last_empty_at TEXT
  );
`);

try {
  db.exec(`ALTER TABLE rooms ADD COLUMN viewer_count INTEGER NOT NULL DEFAULT 0`);
} catch (e) {
  // Column may already exist on an existing DB.
}
try {
  db.exec(`ALTER TABLE rooms ADD COLUMN last_empty_at TEXT`);
} catch (e) {
  // Column may already exist on an existing DB.
}
try {
  db.exec(`ALTER TABLE rooms ADD COLUMN subtitles TEXT`);
} catch (e) {
  // Column may already exist on an existing DB.
}
try {
  db.exec(`ALTER TABLE rooms ADD COLUMN subtitles TEXT`);
} catch (e) {
  // Column may already exist on an existing DB.
}
try {
  db.exec(`ALTER TABLE rooms ADD COLUMN private INTEGER NOT NULL DEFAULT 0`);
} catch (e) {
  // Column may already exist on an existing DB.
}

function seedAdminIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n;
  if (count > 0) return;

  const pin = config.adminBootstrapPin || String(Math.floor(100000 + Math.random() * 900000));
  const pinHash = bcrypt.hashSync(pin, 10);
  db.prepare(
    `INSERT INTO profiles (display_name, pin_hash, is_admin, can_host, avatar_color)
     VALUES (?, ?, 1, 1, '#d97757')`
  ).run('Admin', pinHash);

  console.log('\n============================================');
  console.log(' No profiles existed yet — created a bootstrap admin:');
  console.log('   Profile name: Admin');
  console.log(`   PIN:          ${pin}`);
  console.log(' Log in with this profile, then create real profiles');
  console.log(' from the Admin panel and consider disabling this one.');
  console.log('============================================\n');
}

seedAdminIfEmpty();

module.exports = db;
