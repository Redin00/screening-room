const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');

// roomId -> Timeout, so a fresh upload or reopen can cancel a pending deletion.
const pendingTimers = new Map();

function roomDir(roomId) {
  return path.join(config.uploadsDir, `room-${roomId}`);
}

function deleteRoomVideo(roomId) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) return;

  if (room.video_path && fs.existsSync(room.video_path)) {
    try {
      fs.unlinkSync(room.video_path);
    } catch (err) {
      console.error(`Failed to delete video for room ${room.code}:`, err.message);
    }
  }

  const dir = roomDir(roomId);
  if (fs.existsSync(dir)) {
    try {
      const remaining = fs.readdirSync(dir);
      if (remaining.length === 0) fs.rmdirSync(dir);
    } catch (_) {
      /* non-fatal */
    }
  }

  db.prepare(
    `UPDATE rooms SET video_path = NULL, video_original_name = NULL, video_size = NULL, subtitles = NULL, delete_at = NULL WHERE id = ?`
  ).run(roomId);

  pendingTimers.delete(roomId);
  console.log(`Cleaned up video for room ${room.code} (room #${roomId}).`);
}

function cancelScheduledDeletion(roomId) {
  const t = pendingTimers.get(roomId);
  if (t) {
    clearTimeout(t);
    pendingTimers.delete(roomId);
  }
  db.prepare('UPDATE rooms SET delete_at = NULL WHERE id = ?').run(roomId);
}

function scheduleDeletion(roomId, delayMinutes = config.deleteDelayMinutes) {
  cancelScheduledDeletion(roomId);
  const deleteAt = new Date(Date.now() + delayMinutes * 60 * 1000);
  db.prepare('UPDATE rooms SET delete_at = ? WHERE id = ?').run(deleteAt.toISOString(), roomId);

  const timer = setTimeout(() => deleteRoomVideo(roomId), delayMinutes * 60 * 1000);
  timer.unref();
  pendingTimers.set(roomId, timer);
}

// Safety net: catches rooms whose delete_at is already overdue (e.g. the
// process restarted and lost its in-memory timers), and auto-closes active
// rooms that have been empty for too long.
function sweep() {
  const now = new Date();

  const overdue = db
    .prepare(`SELECT id FROM rooms WHERE video_path IS NOT NULL AND delete_at IS NOT NULL AND delete_at <= ?`)
    .all(now.toISOString());
  for (const row of overdue) deleteRoomVideo(row.id);

  const orphanCutoff = new Date(now.getTime() - config.orphanRoomMinutes * 60 * 1000).toISOString();
  const orphaned = db
    .prepare(
      `SELECT id, code FROM rooms
       WHERE status = 'active'
         AND viewer_count = 0
         AND COALESCE(last_empty_at, created_at) <= ?`
    )
    .all(orphanCutoff);
  for (const room of orphaned) {
    console.log(`Auto-closing orphaned room ${room.code} (host absent too long).`);
    closeRoom(room.id);
  }
}

function closeRoom(roomId) {
  db.prepare(
    `UPDATE rooms SET status = 'closed', closed_at = datetime('now') WHERE id = ?`
  ).run(roomId);
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (room && room.video_path) {
    scheduleDeletion(roomId);
  }
}

function startSweeper() {
  sweep();
  const interval = setInterval(sweep, config.cleanupSweepMinutes * 60 * 1000);
  interval.unref();
}

module.exports = {
  scheduleDeletion,
  cancelScheduledDeletion,
  deleteRoomVideo,
  closeRoom,
  startSweeper,
  roomDir,
};
