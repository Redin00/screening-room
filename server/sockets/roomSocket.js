const db = require('../db');

// In-memory presence per room code. Purely runtime state — never persisted —
// so a restart just means clients re-announce themselves on reconnect.
const rooms = new Map(); // code -> { hostSocketId, members: Map<socketId, info>, lastState, controlList: Set<profileId>, uploadList: Set<profileId>, lastController, subtitleIndex }
function getRoomState(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      hostSocketId: null,
      members: new Map(),
      lastState: { playing: false, time: 0, updatedAt: Date.now() },
      controlList: new Set(),
      uploadList: new Set(),
      lastController: null,
      subtitleIndex: null,
    });
  }
  return rooms.get(code);
}

function memberCount(code) {
  const r = rooms.get(code);
  return r ? r.members.size : 0;
}

let io = null;

function attach(_io) {
  io = _io;
  _io.on('connection', (socket) => {
    const profile = socket.request.session && socket.request.session.userId
      ? db.prepare('SELECT * FROM profiles WHERE id = ? AND disabled = 0').get(socket.request.session.userId)
      : null;

    if (!profile) {
      socket.emit('room:error', 'Not signed in.');
      socket.disconnect(true);
      return;
    }

    let joinedCode = null;

    socket.on('room:join', (code) => {
      const room = db.prepare('SELECT * FROM rooms WHERE code = ?').get(code);
      if (!room || room.status === 'closed') {
        socket.emit('room:error', 'Room not found or has ended.');
        return;
      }

      joinedCode = code;
      socket.join(code);
      const state = getRoomState(code);
      const isHost = room.host_id === profile.id;
      const isAdmin = !!profile.is_admin;

      socket.data.roomCode = code;
      socket.data.roomId = room.id;
      socket.data.isHost = isHost;
      socket.data.isAdmin = isAdmin;

      // Persist profile id on the socket so control-list ops survive reconnects
      // (socket ids change on reconnect but profile ids do not).
      socket.data.profileId = profile.id;
      socket.data.displayName = profile.display_name;
      socket.data.avatarColor = profile.avatar_color;

      // Track members as a Map so we can broadcast member lists with names.
      // On reconnect the socket id changes; remove any stale entry for this
      // profile first so the viewer count stays correct.
      state.members.forEach((info, socketId) => {
        if (info.profileId === profile.id) {
          state.members.delete(socketId);
        }
      });
      state.members.set(socket.id, {
        profileId: profile.id,
        displayName: profile.display_name,
        avatarColor: profile.avatar_color,
        isAdmin,
        isHost,
      });
      if (room.id) {
        const count = state.members.size;
        db.prepare(`UPDATE rooms SET viewer_count = ?, last_empty_at = NULL WHERE id = ?`).run(count, room.id);
      }

      if (isHost || isAdmin) {
        if (isHost) {
          state.hostSocketId = socket.id;
          db.prepare(`UPDATE rooms SET host_last_seen = datetime('now') WHERE id = ?`).run(room.id);
        }
        // Host and Admins are always implicitly in both permission lists.
        state.controlList.add(profile.id);
        state.uploadList.add(profile.id);
      }

      // Send permission lists and member list to the newcomer so they know
      // what they can do and who else is here.
      socket.emit('room:joined', {
        isHost,
        isAdmin,
        profileId: profile.id,
        displayName: profile.display_name,
        viewerCount: memberCount(code),
        lastState: state.lastState,
        controlList: [...state.controlList],
        uploadList: [...state.uploadList],
        members: broadcastMembers_snapshot(code),
        subtitleIndex: state.subtitleIndex,
      });

      // Broadcast the updated member list to everyone in the room (including the newcomer).
      broadcastMembers(code);

      socket.to(code).emit('room:presence', { viewerCount: memberCount(code) });

      // Do NOT push state to the host on every join — the host is the source of
      // truth and already has the video in the correct state. Sending a sync command
      // to the host causes unnecessary seeking/playing on refresh/join.
    });

    // --- Heartbeat: clients ping every 2s so the server knows they're alive.
    // Handled explicitly so an unknown event doesn't trip default error logging.
    socket.on('room:heartbeat', () => {});

    // --- Command-based control: anyone may send a command; server authorizes ---
    // Play/pause/seek require authorization. The server debounces: it only broadcasts
    // a new state to other clients when the new state meaningfully differs from the
    // previous broadcast state (time delta >= 0.3s or playing state differs).
    // This prevents constant sync loops where every play() event generates a
    // broadcast that re-triggers play() on every client.
    socket.on('room:command', ({ type, data }) => {
      if (!socket.data.roomCode) return;
      const state = getRoomState(socket.data.roomCode);

      // Volume and fullscreen are local actions — no server-side gate.
      if (type === 'volume' || type === 'fullscreen') {
        socket.emit('room:command-ack', { type, allowed: true });
        return;
      }

      // Play/pause/seek require authorization.
      if (type !== 'play' && type !== 'pause' && type !== 'seek') return;

      const isAuthorized = socket.data.isHost || socket.data.isAdmin || state.controlList.has(socket.data.profileId);
      if (!isAuthorized) {
        socket.emit('room:command-denied', {
          type,
          reason: 'Not authorized to control playback.',
          currentState: state.lastState,
        });
        return;
      }

      const now = Date.now();
      const currentTime = Number(data.time) || 0;

      let newPlaying, newTime;
      if (type === 'play') {
        newPlaying = true;
        newTime = currentTime;
      } else if (type === 'pause') {
        newPlaying = false;
        newTime = currentTime;
      } else if (type === 'seek') {
        newPlaying = state.lastState.playing;
        newTime = currentTime;
      }

      // Only apply and broadcast if state actually changed.
      const prev = state.lastState;
      const timeDrift = Math.abs(newTime - (prev.time || 0));
      const playingChanged = newPlaying !== prev.playing;
      if (timeDrift < 0.3 && !playingChanged) {
        // State is essentially the same — acknowledge but don't broadcast.
        socket.emit('room:command-ack', { type, allowed: true });
        return;
      }

      state.lastState = { playing: newPlaying, time: newTime, updatedAt: now };
      state.lastController = { socketId: socket.id, profileId: socket.data.profileId };

      // Broadcast the new state to everyone else in the room.
      socket.to(socket.data.roomCode).emit('room:command', { type, data: state.lastState });
      socket.emit('room:command-ack', { type, allowed: true });
    });

    // --- Subtitle selection: authorized controllers may switch tracks. ---
    socket.on('room:subtitle', ({ index }) => {
      if (!socket.data.roomCode) return;
      const state = getRoomState(socket.data.roomCode);
      const isAuthorized = socket.data.isHost || socket.data.isAdmin || state.controlList.has(socket.data.profileId);
      if (!isAuthorized) {
        socket.emit('room:command-denied', {
          type: 'subtitle',
          reason: 'Not authorized to control playback.',
          currentState: { ...state.lastState, subtitleIndex: state.subtitleIndex },
        });
        return;
      }
      const idx = Number(index);
      if (Number.isNaN(idx)) return;
      state.subtitleIndex = idx;
      socket.to(socket.data.roomCode).emit('room:command', { type: 'subtitle', data: { index: idx } });
      socket.emit('room:command-ack', { type: 'subtitle', allowed: true });
    });

    // --- Sync requests: a late-joiner or viewer asks for the current playback state. ---
    // The server routes this to the host (or any authorized controller), not directly
    // client-to-client, so the server can throttle it and ensure the responder is
    // actually authorized. Also debounced per requester so one slow-refreshing client
    // doesn't hammer the host.
    const syncRequestTimers = new Map(); // requesterSocketId -> { timer, lastRequesterId }
    socket.on('room:sync-request', ({ requesterId }) => {
      if (!socket.data.roomCode) return;
      const state = getRoomState(socket.data.roomCode);
      const requesterSocketId = socket.id;

      // Debounce: at most one sync response every 2 seconds per requester.
      const existing = syncRequestTimers.get(requesterSocketId);
      if (existing && existing.requesterId === requesterId) return;

      clearTimeout(existing && existing.timer);
      const timer = setTimeout(() => {
        syncRequestTimers.delete(requesterSocketId);
      }, 2000);
      syncRequestTimers.set(requesterSocketId, { timer, requesterId });

      // Route to the host if present, otherwise to any authorized controller (admin or controlList).
      let targetSocketId = null;
      if (state.hostSocketId) {
        targetSocketId = state.hostSocketId;
      } else {
        state.members.forEach((info, sid) => {
          if (sid !== requesterSocketId && (info.isAdmin || state.controlList.has(info.profileId))) {
            targetSocketId = sid;
          }
        });
      }
      if (!targetSocketId) return;

      io.to(targetSocketId).emit('room:sync-request', { requesterId });
    });

    // Any authorized controller (host or viewer with control-list membership) can
    // respond to a sync request from the server. The response is sent as a room:command
    // with type 'sync' so the receiver applies it through the same path.
    socket.on('room:sync-response', ({ requesterId, playing, time, subtitleIndex }) => {
      if (!socket.data.roomCode) return;
      const state = getRoomState(socket.data.roomCode);
      const isAuthorized = socket.data.isHost || socket.data.isAdmin || state.controlList.has(socket.data.profileId);
      if (!isAuthorized) return;
      io.to(requesterId).emit('room:command', { type: 'sync', data: { playing: !!playing, time: Number(time) || 0, subtitleIndex: subtitleIndex != null ? subtitleIndex : null, updatedAt: Date.now() } });
    });

    // --- Permission list management (host and admin can manage; viewers may self-add) ---

    socket.on('room:control-list-update', ({ action, list, profileId }) => {
      if (!socket.data.roomCode) return;
      if (action !== 'add' && action !== 'remove') return;
      if (list !== 'control' && list !== 'upload') return;
      const state = getRoomState(socket.data.roomCode);
      const target = list === 'control' ? state.controlList : state.uploadList;
      const isHostOrAdmin = socket.data.isHost || socket.data.isAdmin;

      if (action === 'add') {
        // Self-add: a viewer may add their own profile to either list; host or admin may add anyone.
        if (profileId !== socket.data.profileId && !isHostOrAdmin) return;
        target.add(profileId);
      } else {
        // Remove: only the host or admin may remove someone from either list.
        if (!isHostOrAdmin) return;
        // Cannot remove self if host or admin
        if (profileId === socket.data.profileId) return;
        // Host can't be removed
        const room = db.prepare('SELECT host_id FROM rooms WHERE code = ?').get(socket.data.roomCode);
        if (room && room.host_id === profileId) return;
        // Admins can't be removed
        const targetProf = db.prepare('SELECT is_admin FROM profiles WHERE id = ?').get(profileId);
        if (targetProf && targetProf.is_admin) return;

        target.delete(profileId);
      }
      io.to(socket.data.roomCode).emit('room:control-list', {
        controlList: [...state.controlList],
        uploadList: [...state.uploadList],
      });
    });

    socket.on('room:leave', () => leaveRoom());
    socket.on('disconnect', () => leaveRoom());

    function leaveRoom() {
      if (!joinedCode) return;
      const state = rooms.get(joinedCode);
      if (state) {
        if (state.hostSocketId === socket.id) {
          state.hostSocketId = null;
          if (socket.data.roomId) {
            db.prepare(`UPDATE rooms SET host_last_seen = datetime('now') WHERE id = ?`).run(socket.data.roomId);
          }
        }
        state.members.delete(socket.id);
        if (socket.data.roomId) {
          const count = state.members.size;
          if (count === 0) {
            db.prepare(`UPDATE rooms SET viewer_count = 0, last_empty_at = datetime('now') WHERE id = ?`).run(socket.data.roomId);
          } else {
            db.prepare(`UPDATE rooms SET viewer_count = ? WHERE id = ?`).run(count, socket.data.roomId);
          }
        }
        if (!state.hostSocketId && state.members.size === 0) rooms.delete(joinedCode);
      }
      socket.to(joinedCode).emit('room:presence', { viewerCount: memberCount(joinedCode) });
      if (state) broadcastMembers(joinedCode);
      joinedCode = null;
    }
  });
}

// Build a member list snapshot (no socketId) for the room:joined payload and
// the control panel. The client only needs profileId / displayName / avatarColor.
function broadcastMembers_snapshot(code) {
  const state = getRoomState(code);
  if (!state) return [];
  const members = [];
  state.members.forEach((info) => {
    members.push({ ...info });
  });
  return members;
}

// Broadcast the full member list (with socketId) to everyone in the room
// via the room:members socket event.
function broadcastMembers(code) {
  if (!io) return;
  const state = getRoomState(code);
  if (!state) return;
  const members = [];
  state.members.forEach((info, socketId) => {
    members.push({ socketId, ...info });
  });
  io.to(code).emit('room:members', { members });
}

// Called by the upload route after a video is saved. Tells every client in the room
// that a new video is available so they can reload without a manual refresh.
function notifyVideoChange(code, videoName) {
  const state = rooms.get(code);
  if (state) {
    state.lastState = { playing: false, time: 0, updatedAt: Date.now() };
    state.subtitleIndex = null;
  }
  if (!io) return;
  io.to(code).emit('room:video', { videoName });
}

// Called after subtitle extraction. Pushes the track list to all clients so they
// can rebuild <track> elements without waiting for a separate GET request.
function notifySubtitleChange(code, tracks) {
  const state = rooms.get(code);
  if (state) {
    state.subtitleIndex = (tracks && tracks.length > 0) ? tracks[0].index : null;
  }
  if (!io) return;
  io.to(code).emit('room:subtitles', { tracks });
}

// Called when a room is ended or auto-closed. Informs all connected clients
// so they are cleanly redirected back to the lobby instead of being stuck.
function notifyRoomEnded(code) {
  if (!io) return;
  io.to(code).emit('room:ended', { message: 'The screening has ended.' });
  rooms.delete(code);
}

module.exports = { attach, getRoomState, notifyVideoChange, notifySubtitleChange, notifyRoomEnded };
