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
  const dir = roomDir(roomId);

  // Recursively delete the entire room directory (video, subtitle tracks, etc.)
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.error(`Failed to remove directory ${dir}:`, err.message);
    }
  }

  // Safety fallback if video_path was located outside roomDir
  if (room && room.video_path && fs.existsSync(room.video_path)) {
    try {
      fs.unlinkSync(room.video_path);
    } catch (err) {
      console.error(`Failed to delete video file for room ${room.code}:`, err.message);
    }
  }

  const t = pendingTimers.get(roomId);
  if (t) {
    clearTimeout(t);
    pendingTimers.delete(roomId);
  }

  if (!room) return;

  // If the room is closed, purge it from the database completely.
  if (room.status === 'closed') {
    db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
    console.log(`Cleaned up files and deleted closed room ${room.code} (room #${roomId}).`);
  } else {
    db.prepare(
      `UPDATE rooms SET video_path = NULL, video_original_name = NULL, video_size = NULL, subtitles = NULL, delete_at = NULL WHERE id = ?`
    ).run(roomId);
    console.log(`Cleaned up video for room ${room.code} (room #${roomId}).`);
  }
}

function cancelScheduledDeletion(roomId) {
  const t = pendingTimers.get(roomId);
  if (t) {
    clearTimeout(t);
    pendingTimers.delete(roomId);
  }
  db.prepare('UPDATE rooms SET delete_at = NULL WHERE id = ?').run(roomId);
}

function toSqliteUtc(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function scheduleDeletion(roomId, delayMinutes = config.deleteDelayMinutes) {
  cancelScheduledDeletion(roomId);
  const delayMs = Math.max(0, delayMinutes * 60 * 1000);
  const deleteAt = new Date(Date.now() + delayMs);
  db.prepare('UPDATE rooms SET delete_at = ? WHERE id = ?').run(toSqliteUtc(deleteAt), roomId);

  const timer = setTimeout(() => deleteRoomVideo(roomId), delayMs);
  timer.unref();
  pendingTimers.set(roomId, timer);
}

function closeRoom(roomId) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) return;

  db.prepare(
    `UPDATE rooms SET status = 'closed', closed_at = datetime('now') WHERE id = ?`
  ).run(roomId);

  // Notify any active socket connections in this room that the screening has ended
  try {
    const roomSocket = require('../sockets/roomSocket');
    roomSocket.notifyRoomEnded(room.code);
  } catch (err) {
    console.error(`Failed to notify room ended for ${room.code}:`, err.message);
  }

  // Schedule cleanup of files and removal of the room record
  scheduleDeletion(roomId);
}

// Scans uploadsDir for any folder room-<id> whose room is closed, deleted, or has no video
function sweepOrphanUploads() {
  if (!fs.existsSync(config.uploadsDir)) return;
  try {
    const entries = fs.readdirSync(config.uploadsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^room-(\d+)$/);
      if (!match) continue;
      const roomId = parseInt(match[1], 10);
      const room = db.prepare('SELECT id, status, video_path FROM rooms WHERE id = ?').get(roomId);
      const fullDir = path.join(config.uploadsDir, entry.name);
      let shouldDelete = false;
      if (!room || room.status === 'closed') {
        shouldDelete = true;
      } else if (!room.video_path) {
        // Protect active in-progress uploads: only delete if untouched for > 30 minutes
        try {
          const stat = fs.statSync(fullDir);
          if (Date.now() - stat.mtimeMs > 30 * 60 * 1000) {
            shouldDelete = true;
          }
        } catch (_) {}
      }
      if (shouldDelete) {
        try {
          fs.rmSync(fullDir, { recursive: true, force: true });
          console.log(`Cleaned up orphaned upload directory: ${entry.name}`);
        } catch (err) {
          console.error(`Failed to remove orphan dir ${entry.name}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('Error sweeping orphan uploads:', err.message);
  }
}

// Restores in-memory timers across server restarts for rooms with delete_at set in DB
function restorePendingTimers() {
  const now = Date.now();
  const pending = db
    .prepare(`SELECT id, delete_at FROM rooms WHERE delete_at IS NOT NULL`)
    .all();
  for (const row of pending) {
    const isoStr = row.delete_at.includes('T') ? row.delete_at : row.delete_at.replace(' ', 'T') + 'Z';
    const due = new Date(isoStr).getTime();
    const remainingMs = Number.isNaN(due) ? 0 : Math.max(0, due - now);
    const timer = setTimeout(() => deleteRoomVideo(row.id), remainingMs);
    timer.unref();
    pendingTimers.set(row.id, timer);
  }
}

// Safety net: catches rooms whose delete_at is overdue, auto-closes rooms
// that have been empty too long, purges stale closed rooms, and sweeps orphan folders.
function sweep() {
  const now = new Date();
  const nowSqlite = toSqliteUtc(now);

  // 1. Delete rooms / files whose scheduled deletion time has arrived
  const overdue = db
    .prepare(`SELECT id FROM rooms WHERE delete_at IS NOT NULL AND datetime(delete_at) <= datetime(?)`)
    .all(nowSqlite);
  for (const row of overdue) {
    deleteRoomVideo(row.id);
  }

  // 2. Auto-close orphaned rooms that have had 0 viewers for orphanRoomMinutes.
  // Checks all non-closed rooms (both 'active' and 'waiting').
  const orphanCutoff = toSqliteUtc(new Date(now.getTime() - config.orphanRoomMinutes * 60 * 1000));
  const orphaned = db
    .prepare(
      `SELECT id, code FROM rooms
       WHERE status != 'closed'
         AND viewer_count = 0
         AND datetime(COALESCE(last_empty_at, created_at)) <= datetime(?)`
    )
    .all(orphanCutoff);
  for (const room of orphaned) {
    console.log(`Auto-closing orphaned room ${room.code} (empty too long).`);
    closeRoom(room.id);
  }

  // 3. Purge stale closed rooms that were closed > deleteDelayMinutes ago
  // and have no active video or pending delete timer.
  const closedCutoff = toSqliteUtc(new Date(now.getTime() - config.deleteDelayMinutes * 60 * 1000));
  const staleClosed = db
    .prepare(
      `SELECT id FROM rooms
       WHERE status = 'closed'
         AND (delete_at IS NULL OR datetime(delete_at) <= datetime(?))
         AND (closed_at IS NULL OR datetime(closed_at) <= datetime(?))`
    )
    .all(nowSqlite, closedCutoff);
  for (const row of staleClosed) {
    deleteRoomVideo(row.id);
  }

  // 4. Clean up any leftover folders in uploadsDir
  sweepOrphanUploads();
}

function startSweeper() {
  // Reset stale in-memory viewer counts in DB on startup
  try {
    db.prepare(
      `UPDATE rooms SET viewer_count = 0, last_empty_at = COALESCE(last_empty_at, datetime('now')) WHERE status != 'closed'`
    ).run();
  } catch (err) {
    console.error('Failed to reset viewer_count on startup:', err.message);
  }

  restorePendingTimers();
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
  sweep,
  sweepOrphanUploads,
};
