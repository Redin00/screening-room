require('dotenv').config();
const path = require('path');

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  port: int(process.env.PORT, 3000),
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  deleteDelayMinutes: int(process.env.DELETE_DELAY_MINUTES, 10),
  cleanupSweepMinutes: int(process.env.CLEANUP_SWEEP_MINUTES, 2),
  orphanRoomMinutes: int(process.env.ORPHAN_ROOM_MINUTES, 10),
  maxUploadMb: int(process.env.MAX_UPLOAD_MB, 4096),
  adminBootstrapPin: process.env.ADMIN_BOOTSTRAP_PIN || '',
  dataDir: path.join(__dirname, '..', 'data'),
  uploadsDir: path.join(__dirname, '..', 'uploads'),
  dbPath: path.join(__dirname, '..', 'data', 'screening-room.db'),
  allowedExtensions: ['.mp4', '.webm', '.mov', '.mkv', '.avi', '.ogg', '.m4v'],
  allowedMimePrefixes: ['video/'],
};
