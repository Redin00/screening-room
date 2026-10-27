const express = require('express');
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');
const db = require('../db');
const config = require('../config');
const { requireAuth, requireHostPermission } = require('../middleware/auth');
const scheduler = require('../cleanup/scheduler');
const upload = require('../upload');
const roomSocket = require('../sockets/roomSocket');
const subtitles = require('../subtitles');

const router = express.Router();
router.use(requireAuth);

function roomPublic(row) {
  let subs = null;
  try { subs = row.subtitles ? JSON.parse(row.subtitles) : null; } catch (_) { subs = null; }
  return {
    code: row.code,
    name: row.name,
    status: row.status,
    hostId: row.host_id,
    hostName: row.host_name,
    hasVideo: !!row.video_path,
    videoName: row.video_original_name,
    createdAt: row.created_at,
    isPrivate: !!row.private,
    subtitles: subs,
  };
}

function loadRoom(req, res, next) {
  const room = db
    .prepare(
      `SELECT rooms.*, profiles.display_name AS host_name
       FROM rooms JOIN profiles ON profiles.id = rooms.host_id
       WHERE rooms.code = ?`
    )
    .get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found. It may have ended.' });
  req.room = room;
  next();
}

function requireIsHost(req, res, next) {
  if (req.room.host_id !== req.profile.id && !req.profile.is_admin) {
    return res.status(403).json({ error: 'Only the host or an administrator can do that.' });
  }
  next();
}

function requireCanUpload(req, res, next) {
  if (req.profile.is_admin || req.room.host_id === req.profile.id) return next();
  const roomState = roomSocket.getRoomState(req.params.code);
  if (roomState && roomState.uploadList && roomState.uploadList.has(req.profile.id)) return next();
  return res.status(403).json({ error: 'You are not authorized to upload in this room.' });
}

function requireCanControl(req, res, next) {
  if (req.profile.is_admin || req.room.host_id === req.profile.id) return next();
  const roomState = roomSocket.getRoomState(req.params.code);
  if (roomState && roomState.controlList && roomState.controlList.has(req.profile.id)) return next();
  return res.status(403).json({ error: 'You are not authorized to control playback in this room.' });
}

// Rooms still open, for a lightweight "join a room" browser.
router.get('/', (req, res) => {
  const where = req.profile && req.profile.is_admin
    ? `WHERE rooms.status != 'closed'`
    : `WHERE rooms.status != 'closed' AND rooms.private = 0`;
  const rows = db
    .prepare(
      `SELECT rooms.*, profiles.display_name AS host_name
       FROM rooms JOIN profiles ON profiles.id = rooms.host_id
       ${where}
       ORDER BY rooms.created_at DESC`
    )
    .all();
  res.json(rows.map(roomPublic));
});

router.post('/', requireHostPermission, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim() || `${req.profile.display_name}'s room`;
  const isPrivate = !!(req.body && req.body.private);
  let code;
  do {
    code = nanoid(6).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
  } while (db.prepare('SELECT 1 FROM rooms WHERE code = ?').get(code));

  db.prepare(
    `INSERT INTO rooms (code, name, host_id, status, host_last_seen, private) VALUES (?, ?, ?, 'waiting', datetime('now'), ?)`
  ).run(code, name, req.profile.id, isPrivate ? 1 : 0);

  res.status(201).json({ code, isPrivate });
});

router.get('/:code', loadRoom, (req, res) => {
  res.json(roomPublic(req.room));
});

router.post('/:code/upload', loadRoom, requireCanUpload, (req, res) => {
  upload.single('video')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No video file received.' });

    // Clean up any previous video and subtitle files in this room directory
    const dir = scheduler.roomDir(req.room.id);
    if (fs.existsSync(dir)) {
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          const fullPath = path.join(dir, f);
          if (fullPath !== req.file.path && fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
          }
        }
      } catch (err) {
        console.error('Error cleaning previous files in roomDir:', err.message);
      }
    }
    scheduler.cancelScheduledDeletion(req.room.id);

    db.prepare(
      `UPDATE rooms SET video_path = ?, video_original_name = ?, video_size = ?, status = 'active' WHERE id = ?`
    ).run(req.file.path, req.file.originalname, req.file.size, req.room.id);

    // Extract any embedded subtitle tracks to WebVTT files alongside the video.
    // Returns the freshly-extracted track list — do not use req.room.subtitles
    // (it was loaded by loadRoom before extraction ran).
    const tracks = subtitles.extractAndPersistSubtitles(req.file.path, req.room.id);

    // Tell every client in the room a new video is available so they can reload
    // without manually refreshing the page.
    roomSocket.notifyVideoChange(req.params.code, req.file.originalname);

    // Push the freshly-extracted track list to all clients so they can rebuild
    // <track> elements without waiting for a separate GET request.
    // The tracks carry vttPath; clients expect vttUrl — normalize here.
    // Cache-bust with the uploaded file's own name (unique per upload) so a
    // new video whose subtitle happens to land on the same stream index as
    // the previous one gets a distinct URL. Without this, the client's <track
    // src> is identical across uploads and it never notices the underlying
    // VTT changed — and never has a reason to rebuild the element.
    const subtitleVersion = path.basename(req.file.filename, path.extname(req.file.filename));
    const tracksWithUrl = tracks.map((t) => ({
      ...t,
      vttUrl: `/api/rooms/${encodeURIComponent(req.params.code)}/subtitles/${t.index}.vtt?v=${subtitleVersion}`,
    }));
    roomSocket.notifySubtitleChange(req.params.code, tracksWithUrl);

    res.json({ ok: true, videoName: req.file.originalname });
  });
});

router.post('/:code/end', loadRoom, requireIsHost, (req, res) => {
  scheduler.closeRoom(req.room.id);
  res.json({ ok: true });
});

// Toggle room visibility between public (listed) and private (unlisted).
router.patch('/:code/private', loadRoom, requireIsHost, (req, res) => {
  const { private: isPrivate } = req.body || {};
  if (typeof isPrivate !== 'boolean') {
    return res.status(400).json({ error: 'Provide "private": true or false.' });
  }
  db.prepare('UPDATE rooms SET private = ? WHERE id = ?').run(isPrivate ? 1 : 0, req.room.id);
  res.json({ ok: true, isPrivate });
});

// Helper to resolve the actual video path on disk for a room, handling
// moved directories, cross-system DB migrations, or relative locations.
function resolveVideoPath(room) {
  if (!room) return null;
  if (room.video_path && fs.existsSync(room.video_path)) {
    return room.video_path;
  }
  const dir = scheduler.roomDir(room.id);
  if (room.video_path) {
    const candidate = path.join(dir, path.basename(room.video_path));
    if (fs.existsSync(candidate)) return candidate;
  }
  if (fs.existsSync(dir)) {
    try {
      const files = fs.readdirSync(dir);
      const videoFile = files.find((f) => {
        const ext = path.extname(f).toLowerCase();
        return config.allowedExtensions.includes(ext);
      });
      if (videoFile) return path.join(dir, videoFile);
    } catch (_) {}
  }
  return null;
}

// Range-request video streaming so scrubbing/seeking works in the player.
router.get('/:code/media', loadRoom, (req, res) => {
  const room = req.room;
  const videoPath = resolveVideoPath(room);
  if (!videoPath) {
    return res.status(404).json({ error: 'No video is available for this room.' });
  }

  const stat = fs.statSync(videoPath);
  const fileSize = stat.size;
  const range = req.headers.range;
  const ext = path.extname(videoPath).toLowerCase();
  const contentType =
    { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.ogg': 'video/ogg', '.m4v': 'video/x-m4v' }[ext] ||
    'application/octet-stream';

  if (!range) {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(videoPath).pipe(res);
    return;
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  let start = match && match[1] ? parseInt(match[1], 10) : 0;
  let end = match && match[2] ? parseInt(match[2], 10) : fileSize - 1;
  if (Number.isNaN(start) || start >= fileSize) start = 0;
  if (Number.isNaN(end) || end >= fileSize) end = fileSize - 1;

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': contentType,
  });
  fs.createReadStream(videoPath, { start, end }).pipe(res);
});

// List subtitle tracks available for the current video in this room.
router.get('/:code/subtitles', loadRoom, (req, res) => {
  const room = req.room;
  const videoPath = resolveVideoPath(room);
  if (!videoPath) {
    return res.json({ tracks: [] });
  }

  let tracks = [];
  try { tracks = room.subtitles ? JSON.parse(room.subtitles) : []; } catch (_) { tracks = []; }

  const dir = scheduler.roomDir(room.id);
  const anyMissingOnDisk = tracks.some((t) => {
    if (t.vttPath && fs.existsSync(t.vttPath)) return false;
    if (t.vttPath && fs.existsSync(path.join(dir, path.basename(t.vttPath)))) return false;
    return true;
  });

  // Auto-extraction safeguard: if video exists but tracks were never persisted
  // or VTT files are missing on disk, probe and persist them now.
  if (tracks.length === 0 || anyMissingOnDisk) {
    try {
      tracks = subtitles.extractAndPersistSubtitles(videoPath, room.id);
    } catch (err) {
      console.warn('Auto-extract subtitles on get failed:', err.message);
    }
  }

  // Same cache-busting version as the upload handler, derived from the current
  // video file's own (unique-per-upload) name, so a client that calls this
  // endpoint gets a vttUrl that matches what was pushed over the socket for
  // this video — and differs from whatever an older video used.
  const subtitleVersion = path.basename(videoPath, path.extname(videoPath));
  res.json({ tracks: tracks.map((t) => ({
    index: t.index,
    srclang: t.srclang || '',
    label: t.label,
    vttUrl: `/api/rooms/${encodeURIComponent(req.params.code)}/subtitles/${t.index}.vtt?v=${subtitleVersion}`,
  }))});
});

// Serve a previously-extracted WebVTT subtitle file. Any authenticated room
// member can load it — subtitles are a viewing feature, not a control feature.
router.get('/:code/subtitles/:index.vtt', loadRoom, (req, res) => {
  const room = req.room;
  const videoPath = resolveVideoPath(room);
  let tracks = [];
  try { tracks = room.subtitles ? JSON.parse(room.subtitles) : []; } catch (_) { tracks = []; }

  const streamIndex = parseInt(req.params.index, 10);
  let track = tracks.find((t) => t.index === streamIndex || t.subIndex === streamIndex);

  // If track not found in DB tracks, but video exists, try re-extracting
  if (!track && videoPath) {
    try {
      tracks = subtitles.extractAndPersistSubtitles(videoPath, room.id);
      track = tracks.find((t) => t.index === streamIndex || t.subIndex === streamIndex);
    } catch (_) {}
  }

  if (!track) {
    return res.status(404).json({ error: 'Subtitle track not found.' });
  }

  const dir = scheduler.roomDir(room.id);
  const videoBase = videoPath ? path.basename(videoPath, path.extname(videoPath)) : '';

  // Determine the VTT file path via multi-candidate resolution:
  const candidates = [];
  if (track.vttPath) candidates.push(track.vttPath);
  if (track.vttPath) candidates.push(path.join(dir, path.basename(track.vttPath)));
  if (videoPath && track.vttPath) candidates.push(path.join(path.dirname(videoPath), path.basename(track.vttPath)));
  if (videoBase) {
    if (track.subIndex != null) {
      candidates.push(path.join(dir, `${videoBase}.s${track.subIndex}.vtt`));
      if (videoPath) candidates.push(path.join(path.dirname(videoPath), `${videoBase}.s${track.subIndex}.vtt`));
    }
    candidates.push(path.join(dir, `${videoBase}.s${track.index}.vtt`));
    candidates.push(path.join(dir, `${videoBase}.${track.index}.vtt`));
    if (videoPath) candidates.push(path.join(path.dirname(videoPath), `${videoBase}.s${track.index}.vtt`));
  }

  let finalVttPath = candidates.find((p) => p && fs.existsSync(p) && fs.statSync(p).size > 10);

  // If still missing on disk, dynamically extract this specific track on demand!
  if (!finalVttPath && videoPath && fs.existsSync(videoPath)) {
    try {
      finalVttPath = subtitles.extractSubtitleToVtt(
        videoPath,
        track.subIndex != null ? track.subIndex : 0,
        dir,
        track.codec
      );
    } catch (err) {
      console.error(`On-the-fly subtitle extraction failed for stream ${track.index}:`, err.message);
    }
  }

  if (!finalVttPath || !fs.existsSync(finalVttPath)) {
    return res.status(404).json({ error: 'Subtitle file not found on disk.' });
  }

  const stat = fs.statSync(finalVttPath);
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': 'text/vtt; charset=utf-8',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(finalVttPath).pipe(res);
    return;
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  let start = match && match[1] ? parseInt(match[1], 10) : 0;
  let end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
  if (Number.isNaN(start) || start >= stat.size) start = 0;
  if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': 'text/vtt; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(finalVttPath, { start, end }).pipe(res);
});

module.exports = router;