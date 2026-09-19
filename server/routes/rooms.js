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
  if (req.room.host_id !== req.profile.id) {
    return res.status(403).json({ error: 'Only the host can do that.' });
  }
  next();
}

function requireCanUpload(req, res, next) {
  if (req.room.host_id === req.profile.id) return next();
  const roomState = roomSocket.getRoomState(req.params.code);
  if (roomState && roomState.uploadList && roomState.uploadList.has(req.profile.id)) return next();
  return res.status(403).json({ error: 'You are not authorized to upload in this room.' });
}

function requireCanControl(req, res, next) {
  if (req.room.host_id === req.profile.id) return next();
  const roomState = roomSocket.getRoomState(req.params.code);
  if (roomState && roomState.controlList && roomState.controlList.has(req.profile.id)) return next();
  return res.status(403).json({ error: 'You are not authorized to control playback in this room.' });
}

// Rooms still open, for a lightweight "join a room" browser.
router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT rooms.*, profiles.display_name AS host_name
       FROM rooms JOIN profiles ON profiles.id = rooms.host_id
       WHERE rooms.status != 'closed' AND rooms.private = 0
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

    // Replace any previous file for this room immediately.
    if (req.room.video_path && fs.existsSync(req.room.video_path) && req.room.video_path !== req.file.path) {
      fs.unlink(req.room.video_path, () => {});
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

// Range-request video streaming so scrubbing/seeking works in the player.
router.get('/:code/media', loadRoom, (req, res) => {
  const room = req.room;
  if (!room.video_path || !fs.existsSync(room.video_path)) {
    return res.status(404).json({ error: 'No video is available for this room.' });
  }

  const stat = fs.statSync(room.video_path);
  const fileSize = stat.size;
  const range = req.headers.range;
  const ext = path.extname(room.video_path).toLowerCase();
  const contentType =
    { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.ogg': 'video/ogg', '.m4v': 'video/x-m4v' }[ext] ||
    'application/octet-stream';

  if (!range) {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(room.video_path).pipe(res);
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
  fs.createReadStream(room.video_path, { start, end }).pipe(res);
});

// List subtitle tracks available for the current video in this room.
router.get('/:code/subtitles', loadRoom, (req, res) => {
  const room = req.room;
  if (!room.video_path || !fs.existsSync(room.video_path)) {
    return res.json({ tracks: [] });
  }
  let tracks = [];
  try { tracks = room.subtitles ? JSON.parse(room.subtitles) : []; } catch (_) { tracks = []; }
  // Same cache-busting version as the upload handler, derived from the current
  // video file's own (unique-per-upload) name, so a client that calls this
  // endpoint gets a vttUrl that matches what was pushed over the socket for
  // this video — and differs from whatever an older video used.
  const subtitleVersion = path.basename(room.video_path, path.extname(room.video_path));
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
  let tracks = [];
  try { tracks = room.subtitles ? JSON.parse(room.subtitles) : []; } catch (_) { tracks = []; }
  const track = tracks.find((t) => t.index === parseInt(req.params.index, 10));
  if (!track) {
    return res.status(404).json({ error: 'Subtitle track not found.' });
  }
  // Determine the VTT file path: prefer subIndex (new format), fall back to
  // vttPath stored in DB (old format), or reconstruct from video path.
  let vttPath = track.vttPath; // may be undefined for new-format tracks
  if (!vttPath && track.subIndex != null) {
    const videoDir = path.dirname(room.video_path);
    const videoBase = path.basename(room.video_path, path.extname(room.video_path));
    vttPath = path.join(videoDir, `${videoBase}.s${track.subIndex}.vtt`);
  }
  // Check both DB and file existence — if the video was deleted but tracks
  // weren't cleared (stale DB), fall through to 404.
  if (!room.video_path || !fs.existsSync(room.video_path)) {
    return res.status(404).json({ error: 'No video is available for this room.' });
  }
  if (!vttPath || !fs.existsSync(vttPath)) {
    return res.status(404).json({ error: 'Subtitle file not found on disk.' });
  }
  const stat = fs.statSync(vttPath);
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'text/vtt', 'Cache-Control': 'no-cache' });
    fs.createReadStream(vttPath).pipe(res);
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
    'Content-Type': 'text/vtt',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(vttPath, { start, end }).pipe(res);
});

module.exports = router;