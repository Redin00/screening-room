const params = new URLSearchParams(window.location.search);
const roomCode = (params.get('code') || '').toUpperCase();

let me = null;
let myProfileId = null;
let isHost = false;
let socket = null;
let heartbeatTimer = null;
let applyingRemoteState = false;
let controlList = [];
let uploadList = [];
let subtitles = [];
let subtitlesSelectedIndex = null;
let subtitlesRequestId = 0;
let _lastVideoLoadedAt = 0;
let members = [];
let controlPanelOpen = false;

let video = document.getElementById('player');
const noVideo = document.getElementById('no-video');
const screenWrap = document.getElementById('screen-wrap');

function showToast(msg, ms = 3500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => (t.style.display = 'none'), ms);
}

async function init() {
  if (!roomCode) {
    window.location.href = '/lobby.html';
    return;
  }

  video.addEventListener('contextmenu', (e) => e.preventDefault());

  me = await requireProfile();
  if (!me) return;
  renderWhoami(me, 'whoami');
  document.getElementById('room-code-chip').textContent = roomCode;

  // Logo click goes back to the lobby.
  document.querySelector('.brand').addEventListener('click', () => {
    window.location.href = '/lobby.html';
  });

  let room;
  try {
    room = await api('GET', `/api/rooms/${encodeURIComponent(roomCode)}`);
  } catch (err) {
    showToast(err.message);
    setTimeout(() => (window.location.href = '/lobby.html'), 2000);
    return;
  }

  setVideoAvailability(room.hasVideo);

  // Private-toggle button: only the host sees it.
  const privBtn = document.getElementById('private-toggle-btn');
  if (privBtn) {
    privBtn.textContent = room.isPrivate ? 'Make public' : 'Make private';
    privBtn.style.display = isHost ? 'inline-block' : 'none';
    privBtn.addEventListener('click', async () => {
      const newVal = !room.isPrivate;
      try {
        await api('PATCH', `/api/rooms/${encodeURIComponent(roomCode)}/private`, { private: newVal });
        room.isPrivate = newVal;
        privBtn.textContent = newVal ? 'Make public' : 'Make private';
        showToast(newVal ? 'Room is now private — removed from the open list.' : 'Room is now public — visible in the open list.');
      } catch (err) {
        showToast(err.message);
      }
    });
  }

  connectSocket();

  document.getElementById('end-room-btn').addEventListener('click', endRoom);
  document.getElementById('file-input').addEventListener('change', onFileChosen);
  document.getElementById('control-panel-toggle').addEventListener('click', toggleControlPanel);
}

// Some browsers (notably Chromium-based ones) keep stale entries in the
// native captions/CC menu for a <video> element even after its <track>
// children are correctly removed from the DOM — the menu is effectively
// cached for the lifetime of that specific element instance, not rebuilt
// from the live track list. Simply removing/re-adding <track> nodes on the
// same <video> is therefore not enough: every genuinely new video (and
// subtitle set) needs a brand-new <video> element so the browser starts
// with a clean menu. This swaps in a fresh element in place of the old one
// and re-wires the handful of listeners that were bound directly to it.
function recreateVideoElement() {
  const old = video;
  const replacement = document.createElement('video');
  replacement.id = old.id;
  if (old.className) replacement.className = old.className;
  replacement.playsInline = true;
  replacement.disablePictureInPicture = true;
  replacement.style.cssText = old.style.cssText;
  replacement.controls = old.controls;
  replacement.muted = old.muted;
  replacement.volume = old.volume;

  old.replaceWith(replacement);
  video = replacement;

  video.addEventListener('contextmenu', (e) => e.preventDefault());
  // Re-bind play/pause/seeked emitters to the new element (the old
  // listeners are still attached to the now-detached old node).
  controlEmittersAttached = false;
  attachControlEmitters();
  if (typeof initSubtitleVideoListeners === 'function') {
    initSubtitleVideoListeners();
  }
}

function setVideoAvailability(hasVideo) {
  if (hasVideo) {
    _lastVideoLoadedAt = Date.now();
    // Fresh element per video so the native captions menu can't accumulate
    // entries from previous uploads (see recreateVideoElement above).
    recreateVideoElement();
    noVideo.style.display = 'none';
    video.style.display = 'block';
    video.src = `/api/rooms/${encodeURIComponent(roomCode)}/media?t=${Date.now()}`;
    if (typeof resetSubtitleTracking === 'function') {
      resetSubtitleTracking();
    }
    if (subtitles && subtitles.length > 0 && typeof renderSubtitleTracks === 'function') {
      renderSubtitleTracks();
    }
  } else {
    noVideo.style.display = 'flex';
    video.style.display = 'none';
    video.removeAttribute('src');
    if (typeof resetSubtitleTracking === 'function') {
      resetSubtitleTracking();
    }
    subtitles = [];
    subtitlesSelectedIndex = null;
    subtitlesRequestId++;
    if (typeof renderSubtitleTracks === 'function') {
      renderSubtitleTracks();
    }
  }
}

function connectSocket() {
  socket = io({ withCredentials: true });

  socket.on('connect', () => socket.emit('room:join', roomCode));

  socket.on('room:error', (msg) => {
    showToast(msg);
    setTimeout(() => (window.location.href = '/lobby.html'), 2000);
  });

  socket.on('room:joined', ({ isHost: hostFlag, isAdmin: adminFlag, profileId, displayName, viewerCount, lastState, controlList: ctrlList, uploadList: ulList, members: membersList, subtitleIndex: serverSubtitleIndex }) => {
    isHost = hostFlag;
    if (adminFlag && me) me.isAdmin = true;
    myProfileId = profileId;
    controlList = ctrlList || [];
    uploadList = ulList || [];
    members = membersList || [];
    applyRole();
    updateViewerCount(viewerCount);
    if (membersList) renderMembers(membersList);
    if (video.style.display !== 'none') {
      applyRemoteState(lastState);
      if (serverSubtitleIndex != null && serverSubtitleIndex >= 0) {
        subtitlesSelectedIndex = serverSubtitleIndex;
        renderSubtitleTracks();
      }
      startControlStatusPoll();
      // Fetch the subtitle track list for this video.
      fetchSubtitles();
    }
  });

  socket.on('room:presence', ({ viewerCount }) => updateViewerCount(viewerCount));

  // Playback commands from the server: play / pause / seek / subtitle (authorized)
  // or sync (initial state push for late joiners). The server always sends the full
  // lastState payload, so we apply it directly whichever command type it is.
  socket.on('room:command', ({ type, data }) => {
    if (type === 'sync' || type === 'play' || type === 'pause' || type === 'seek') {
      applyRemoteState(data);
      if (type === 'sync' && data.subtitleIndex != null && data.subtitleIndex !== subtitlesSelectedIndex) {
        subtitlesSelectedIndex = data.subtitleIndex;
        renderSubtitleTracks();
      }
    } else if (type === 'subtitle') {
      // A remote client changed the subtitle track. Update our local state and
      // re-render tracks so the matching <track> gets the default flag.
      subtitlesSelectedIndex = data.index;
      renderSubtitleTracks();
    }
  });

  // Server-pushed subtitle track list (e.g. after a new video with subs is uploaded).
  // Rebuild <track> elements and update the selector dropdown.
  // This is the authoritative source — it also resets the fetch generation so
  // any in-flight fetchSubtitles() calls from a previous upload are ignored.
  socket.on('room:subtitles', ({ tracks }) => {
    subtitlesRequestId++;
    subtitles = (tracks || []).map((t) => ({
      ...t,
      vttUrl: t.vttUrl || `/api/rooms/${encodeURIComponent(roomCode)}/subtitles/${t.index}.vtt`,
    }));
    if (
      subtitles.length > 0 &&
      (subtitlesSelectedIndex == null || !subtitles.some((t) => t.index === subtitlesSelectedIndex))
    ) {
      subtitlesSelectedIndex = subtitles[0].index;
    }
    renderSubtitleTracks();
    showSubtitleSelector();
  });

  // An unauthorized playback command was denied by the server. Revert to the
  // server's authoritative state so the client stays in sync.
  socket.on('room:command-denied', ({ type, currentState }) => {
    applyRemoteState(currentState);
    if (type === 'subtitle') {
      // Our subtitle change was rejected; revert to the server's selection.
      subtitlesSelectedIndex = currentState.subtitleIndex;
      renderSubtitleTracks();
    }
    showToast('Playback action not allowed — you do not have control access.');
  });

  // Volume and fullscreen commands are always accepted (local actions). The ack
  // is just confirmation; no state change needed on the client side.
  socket.on('room:command-ack', ({ type, allowed }) => {
    // Nothing to do — volume/fullscreen are already applied locally.
  });

  // Host updates the authorized-control list; refresh our local copy and re-apply role.
  socket.on('room:control-list', ({ controlList: newCtrl, uploadList: newUl }) => {
    controlList = newCtrl || [];
    uploadList = newUl || [];
    applyRole();
    if (video.style.display !== 'none') startControlStatusPoll();
    renderMembers(members);
  });

  // Someone uploaded a new video. Reload the player source so everyone sees it.
  socket.on('room:video', ({ videoName }) => {
    subtitlesSelectedIndex = null;
    setVideoAvailability(true);
    const el = document.getElementById('no-video-text');
    if (el) el.textContent = `Now playing: ${videoName}`;
    showToast(`New video uploaded — playing: ${videoName}`);
    // The video src just changed; if we're a viewer, request an immediate sync
    // so we don't sit at time 0 while the room is mid-playback.
    if (!isHost && video.style.display !== 'none') {
      socket.emit('room:sync-request', { requesterId: socket.id });
    }
    // Also fetch the subtitle tracks for the newly-uploaded video.
    fetchSubtitles();
  });

  socket.on('room:ended', ({ message }) => {
    showToast(message || 'The screening has ended.');
    setTimeout(() => (window.location.href = '/lobby.html'), 1500);
  });

  // Show who is currently in the room.
  socket.on('room:members', ({ members: newMembers }) => {
    members = newMembers || [];
    renderMembers(members);
  });

  // Sync-request: whoever receives it responds with their current playback state.
  // The server routes sync-requests only to authorized controllers, and the
  // server-side handler re-validates authorization before forwarding the response.
  socket.on('room:sync-request', ({ requesterId }) => {
    socket.emit('room:sync-response', {
      requesterId,
      playing: !video.paused && !video.ended,
      time: video.currentTime || 0,
      subtitleIndex: subtitlesSelectedIndex,
    });
  });

}

function updateViewerCount(n) {
  document.getElementById('viewer-count').textContent = `${n} watching`;
}

function canControl() {
  if (isHost || (me && (me.isAdmin || me.is_admin))) return true;
  return controlList.includes(myProfileId);
}

function applyRole() {
  const controlsContainer = document.getElementById('center-controls');
  const privBtn = document.getElementById('private-toggle-btn');
  const isAdmin = Boolean(me && (me.isAdmin || me.is_admin));
  const effectiveHost = isHost || isAdmin;

  if (effectiveHost) {
    document.getElementById('host-controls').style.display = 'flex';
    document.getElementById('viewer-note').style.display = 'none';
    document.getElementById('role-badge').style.display = 'inline-block';
    document.getElementById('role-badge').textContent = isAdmin && !isHost ? 'Admin' : 'Host';
    document.getElementById('end-room-btn').style.display = 'inline-block';
    if (controlsContainer) controlsContainer.style.display = 'flex';
    if (privBtn) privBtn.style.display = 'inline-block';
    video.controls = true;
    video.muted = false;
  } else {
    document.getElementById('host-controls').style.display = 'none';
    document.getElementById('viewer-note').style.display = 'flex';
    document.getElementById('role-badge').style.display = 'none';
    document.getElementById('end-room-btn').style.display = 'none';
    if (controlsContainer) controlsContainer.style.display = 'flex';
    if (privBtn) privBtn.style.display = 'none';
    video.muted = true;

    const canCtrl = canControl();
    video.controls = true;
    if (canCtrl) {
      video.muted = false;
    }

    // Show upload UI for viewers who have upload permission.
    const canUpload = uploadList.includes(myProfileId) || isAdmin;
    const viewerUploadLabel = document.getElementById('viewer-upload-label');
    const viewerUploadProgress = document.getElementById('viewer-upload-progress');
    const viewerFileInput = document.getElementById('viewer-file-input');
    if (viewerUploadLabel) viewerUploadLabel.style.display = canUpload ? 'inline-flex' : 'none';
    if (viewerUploadProgress) viewerUploadProgress.style.display = canUpload ? 'inline' : 'none';
    if (viewerFileInput) viewerFileInput.disabled = !canUpload;
    if (canUpload && viewerFileInput && !viewerFileInput._uploadHandlerAttached) {
      viewerFileInput.addEventListener('change', onViewerFileChosen);
      viewerFileInput._uploadHandlerAttached = true;
    }
  }

  // Either the host or an authorized viewer emits playback state to the server.
  attachControlEmitters();
}

// --- Command-based control: every playback action is a room:command ---
// The server authorizes play/pause/seek (host or control-list member) and cancels
// unauthorized ones back to the sender, who reverts to the server's current state.
// Volume and fullscreen are purely local and never gated.
//
// applyRemoteState drives the video element to match the server's authoritative
// state. Its own actions (setting currentTime, play(), pause()) fire async events
// (seeked, play, pause) that would normally trigger emitCommand — but those must
// be suppressed, otherwise an unauthorized viewer's command-denied handler calls
// applyRemoteState again and the events it fires trigger another deny → loop.
// We keep applyingRemoteState = true until every event caused by the change has
// fired, using a counter of expected events and one-shot listeners.
let controlEmittersAttached = false;
function attachControlEmitters() {
  if (controlEmittersAttached) return;
  controlEmittersAttached = true;

  let lastEmit = 0;
  let lastEmitState = null; // { playing, time } — skip heartbeat if unchanged
  const emitCommand = (type, payload) => {
    if (!socket || !socket.connected) return;
    const now = Date.now();
    if (now - lastEmit < 200) return;
    lastEmit = now;

    // Volume is purely local — only the sender needs the ack.
    if (type === 'volume') {
      socket.emit('room:command', { type, data: payload });
      return;
    }

    // Play/pause/seek carry the current video time.
    socket.emit('room:command', { type, data: { time: video.currentTime || 0 } });
  };

  video.addEventListener('play', () => {
    // Suppress emissions while we're applying remote state — the server is the
    // source of truth and we already received the command that caused this.
    if (applyingRemoteState) return;
    emitCommand('play');
  });
  video.addEventListener('pause', () => {
    if (applyingRemoteState) return;
    emitCommand('pause');
  });
  video.addEventListener('seeked', () => {
    if (applyingRemoteState) return;
    emitCommand('seek');
  });

  // Periodically ping the server so it knows this client is alive. This is a
  // silent heartbeat — it is not a playback command and is not broadcast to other
  // clients. The server tracks liveness via socket disconnect events already, but
  // this gives slow/flaky networks a chance to recover before the server declares
  // the client gone.
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!socket || !socket.connected) return;
    socket.emit('room:heartbeat', {});
  }, 2000);
}

// Periodically ask the controlling socket for the latest playback state so
// late-joiners and drift-prone clients stay in sync between user events.
let controlStatusPollTimer = null;
function startControlStatusPoll() {
  clearInterval(controlStatusPollTimer);
  controlStatusPollTimer = setInterval(() => {
    if (!socket || isHost || video.style.display === 'none') return;
    socket.emit('room:sync-request', { requesterId: socket.id });
  }, 3000);
}


function applyRemoteState(state) {
  if (!state || video.style.display === 'none') return;
  applyingRemoteState = true;

  const applyNow = () => {
    const drift = Math.abs(video.currentTime - state.time);
    const timeChanged = drift > 0.5;
    const playingChanged = (video.paused !== !state.playing);

    // Count how many async events we expect to fire from this change.
    // Each one will decrement the counter; when it reaches 0 we clear
    // the flag so normal event handling resumes. This prevents the
    // seeked/play/pause events generated by our own actions from
    // triggering emitCommand (and a deny loop for unauthorized viewers).
    let pendingEvents = 0;

    if (timeChanged) {
      video.currentTime = state.time;
      pendingEvents++;
    }

    if (state.playing && playingChanged) {
      video.play().catch(() => {
        video.muted = true;
        video.play().catch(() => {});
      });
      pendingEvents++;
    } else if (!state.playing && playingChanged) {
      video.pause();
      pendingEvents++;
    }

    if (pendingEvents === 0) {
      // No DOM action taken — nothing to wait for; we're done.
      applyingRemoteState = false;
      return;
    }

    // One-shot listeners that clear the flag once all expected events fire.
    // A seek while playing fires both 'seeked' and 'play'; a pause fires 'pause';
    // a seek while paused fires only 'seeked'. We wait for all of them.
    const onSeeked = () => {
      pendingEvents--;
      if (pendingEvents <= 0) {
        applyingRemoteState = false;
      }
    };
    const onPlayOrPause = () => {
      pendingEvents--;
      if (pendingEvents <= 0) {
        applyingRemoteState = false;
      }
    };

    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('play', onPlayOrPause, { once: true });
    video.addEventListener('pause', onPlayOrPause, { once: true });

    // Fallback: if any expected event fails to fire (e.g. seeking a live
    // stream where the browser never emits 'seeked'), clear the flag after
    // a short grace period so we don't stay suppressed forever.
    setTimeout(() => {
      if (applyingRemoteState) {
        applyingRemoteState = false;
      }
    }, 500);
  };

  if (video.readyState >= 1) {
    applyNow();
  } else {
    video.addEventListener('loadedmetadata', applyNow, { once: true });
  }
}

// After the role (host / viewer / control-list) changed, refresh the subtitle
// selector visibility and re-sync its selection to the current server state.
function refreshSubtitleSelector() {
  if (!video.style.display || video.style.display === 'none') return;
  showSubtitleSelector();
  if (subtitles.length) {
    syncSubtitleSelect(subtitles.find((s) => s.index === subtitlesSelectedIndex));
  }
}

const _origApplyRole = applyRole;
applyRole = function () {
  _origApplyRole();
  refreshSubtitleSelector();
};

function toggleControlPanel() {
  controlPanelOpen = !controlPanelOpen;
  const panel = document.getElementById('control-panel');
  const btn = document.getElementById('control-panel-toggle');
  if (controlPanelOpen) {
    panel.style.display = 'block';
    btn.textContent = 'Close control panel';
    btn.classList.add('btn-danger');
    btn.classList.remove('btn-ghost');
    renderMembers(members);
  } else {
    panel.style.display = 'none';
    btn.textContent = 'Manage who can control';
    btn.classList.remove('btn-danger');
    btn.classList.add('btn-ghost');
  }
}

function renderMembers(memberList) {
  const container = document.getElementById('control-panel-list');
  if (!container) return;
  container.innerHTML = '';
  if (!memberList || memberList.length === 0) {
    container.innerHTML = '<div class="empty-room">No one else is here yet.</div>';
    return;
  }
  memberList.forEach((m) => {
    const isMe = m.profileId === myProfileId;
    const canControl = controlList.includes(m.profileId);
    const canUpload = uploadList.includes(m.profileId);
    const row = document.createElement('div');
    row.className = 'member-row';
    row.innerHTML = `
      <div class="member-avatar" style="background:${m.avatarColor || '#888'}">${ initials(m.displayName) }</div>
      <div class="member-name">
        <span class="member-display">${escapeHtml(m.displayName)}${isMe ? ' (you)' : ''}</span>
        <div class="member-perms">
          <span class="member-badge ${canControl ? 'authorized' : 'viewer'}">${canControl ? 'Can control' : 'Viewer'}</span>
          <span class="member-badge ${canUpload ? 'authorized' : 'viewer'}">${canUpload ? 'Can upload' : 'No upload'}</span>
        </div>
      </div>
      <div class="member-actions">
        ${isMe ? '' : (canControl
          ? `<button class="btn-ghost btn-tiny" data-action="remove-control" data-id="${m.profileId}">Remove control</button>`
          : `<button class="btn-ghost btn-tiny" data-action="add-control" data-id="${m.profileId}">Allow control</button>`)}
        ${isMe ? '' : (canUpload
          ? `<button class="btn-ghost btn-tiny" data-action="remove-upload" data-id="${m.profileId}">Remove upload</button>`
          : `<button class="btn-ghost btn-tiny" data-action="add-upload" data-id="${m.profileId}">Allow upload</button>`)}
      </div>
    `;
    container.appendChild(row);
  });

  // Wire action buttons.
  container.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const raw = btn.getAttribute('data-action');
      const id = parseInt(btn.getAttribute('data-id'), 10);
      const isAdmin = Boolean(me && (me.isAdmin || me.is_admin));
      if (!(isHost || isAdmin) || !socket) return;
      const [act, scope] = raw.split('-');
      socket.emit('room:control-list-update', { action: act, list: scope, profileId: id });
    });
  });
}

function initials(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function onFileChosen(e) {
  const file = e.target.files[0];
  if (!file) return;
  uploadFile(file, 'upload-progress', 'Video ready — press play to start for everyone.');
  e.target.value = '';
}

function onViewerFileChosen(e) {
  const file = e.target.files[0];
  if (!file) return;
  uploadFile(file, 'viewer-upload-progress', 'Video ready — press play to start for everyone.');
  e.target.value = '';
}

function uploadFile(file, progressId, successMsg) {
  const form = new FormData();
  form.append('video', file);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/rooms/${encodeURIComponent(roomCode)}/upload`);
  xhr.upload.addEventListener('progress', (ev) => {
    if (ev.lengthComputable) {
      const pct = Math.round((ev.loaded / ev.total) * 100);
      document.getElementById(progressId).textContent = `Uploading… ${pct}%`;
    }
  });
  xhr.onload = () => {
    document.getElementById(progressId).textContent = '';
    if (xhr.status >= 200 && xhr.status < 300) {
      showToast(successMsg);
      // Only trigger setVideoAvailability if the room:video socket event hasn't
      // already recreated the video element in the last few seconds. Recreating
      // the video element twice destroys the <track> elements added by room:subtitles!
      if (video.style.display === 'none' || Date.now() - _lastVideoLoadedAt > 4000) {
        subtitlesSelectedIndex = null;
        setVideoAvailability(true);
      }
      fetchSubtitles();
    } else {
      let msg = 'Upload failed.';
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) {}
      showToast(msg, 5000);
    }
  };
  xhr.onerror = () => {
    document.getElementById(progressId).textContent = '';
    showToast('Upload failed — check your connection.');
  };
  xhr.send(form);
  document.getElementById(progressId).textContent = 'Uploading… 0%';
}

async function endRoom() {
  if (!confirm('End this screening for everyone? The video will be deleted from the server shortly after.')) return;
  try {
    await api('POST', `/api/rooms/${encodeURIComponent(roomCode)}/end`);
    window.location.href = '/lobby.html';
  } catch (err) {
    showToast(err.message);
  }
}

window.addEventListener('beforeunload', () => {
  if (socket) socket.emit('room:leave');
});

init();