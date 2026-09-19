// Subtitles
// Rebuilds the <track> elements on the video element from the global
// `subtitles` array (declared in room.js) so browsers can render them in
// their native controls. Shares state with room.js via globals.
//
// Global inputs (declared in room.js): video, subtitles, subtitlesSelectedIndex,
// socket, roomCode, showToast, canControl, api().

// Signature of the last subtitle list we actually built <track> elements for.
// Used so renderSubtitleTracks() only tears down and recreates DOM <track>
// elements when the underlying list really changed — not on every selection
// sync or duplicate push for the same video. Repeatedly removing and
// re-adding <track> elements on an unchanged list is what causes some
// browsers' native captions/CC menu to accumulate stale, duplicate entries
// that only clear on a full page refresh.
let _renderedSubtitlesSignature = null;

function subtitlesSignature(list) {
  return list.map((s) => `${s.index}:${s.vttUrl}`).join('|');
}

// Called whenever something OTHER than renderSubtitleTracks() removes the
// <track> elements directly (e.g. room.js clearing them immediately on a
// video src change), so our "already rendered" cache doesn't get out of
// sync with what's actually in the DOM.
function resetSubtitleTracking() {
  _renderedSubtitlesSignature = null;
}

function renderSubtitleTracks() {
  const signature = subtitlesSignature(subtitles);
  const listChanged = signature !== _renderedSubtitlesSignature;

  if (listChanged) {
    // Remove any tracks we previously added and rebuild from scratch. Each
    // vttUrl is unique per uploaded video (see server), so this only runs
    // when the video/track set genuinely changed.
    video.querySelectorAll('track[type="subtitles"]').forEach((t) => t.remove());
    _renderedSubtitlesSignature = signature;

    if (!subtitles.length) {
      syncSubtitleSelect(null);
      return;
    }

    // Clear any existing text track modes first.
    if (video.textTracks) {
      for (let i = 0; i < video.textTracks.length; i++) {
        video.textTracks[i].mode = 'disabled';
      }
    }

    const selectedForCreate = subtitlesSelectedIndex != null
      ? subtitles.find((s) => s.index === subtitlesSelectedIndex)
      : null;

    for (const s of subtitles) {
      const track = document.createElement('track');
      track.type = 'subtitles';
      track.label = s.label;
      track.srclang = s.srclang || '';
      track.default = s === selectedForCreate;
      track.src = s.vttUrl;
      // Tag the track with its source index so selection is O(1).
      track.dataset.index = String(s.index);
      video.appendChild(track);
    }
  } else if (!subtitles.length) {
    // List is (still) empty — nothing to sync.
    syncSubtitleSelect(null);
    return;
  }

  // Determine which track the server currently has selected. Recomputed
  // every call (not just on rebuild) so a pure selection change updates the
  // dropdown and text track modes without touching the DOM <track> elements.
  const selected = subtitlesSelectedIndex != null
    ? subtitles.find((s) => s.index === subtitlesSelectedIndex)
    : null;

  // Sync the selector dropdown to the same selection.
  syncSubtitleSelect(selected);

  // After DOM insertion, set modes via the textTracks collection.
  // Use a short delay to let the browser register the new track elements.
  requestAnimationFrame(() => {
    if (!video.textTracks) return;
    // Re-read the current selection state — this callback may fire after
    // a newer renderSubtitleTracks() call has already updated the state.
    const currentSubtitles = subtitles;
    if (!currentSubtitles.length) return;
    const currentSelectedIndex = subtitlesSelectedIndex;
    const currentSelected = currentSelectedIndex != null
      ? currentSubtitles.find((s) => s.index === currentSelectedIndex)
      : null;
    for (let i = 0; i < video.textTracks.length; i++) {
      const tt = video.textTracks[i];
      // Find which subtitle array entry matches this text track by comparing
      // the track element's dataset.index to the stored index.
      const matchingTrack = currentSubtitles.find((s) => {
        const el = video.querySelector(`track[type="subtitles"][data-index="${s.index}"]`);
        return el && el.track === tt;
      });
      if (matchingTrack) {
        tt.mode = (matchingTrack === currentSelected) ? 'showing' : 'hidden';
      } else {
        tt.mode = 'disabled';
      }
    }
  });
}

function syncSubtitleSelect(selected) {
  const sel = document.getElementById('subtitle-select');
  if (!sel) return;
  sel.innerHTML = '';
  // Always offer "Off" first.
  const off = document.createElement('option');
  off.value = '-1';
  off.textContent = 'Off';
  sel.appendChild(off);
  for (const s of subtitles) {
    const o = document.createElement('option');
    o.value = String(s.index);
    o.textContent = s.label + (s.srclang ? ` (${s.srclang.toUpperCase()})` : '');
    sel.appendChild(o);
  }
  sel.value = (subtitlesSelectedIndex != null)
    ? String(subtitlesSelectedIndex)
    : '-1';
  // If a specific track was passed for highlighting, set selection to it.
  if (selected) {
    sel.value = String(selected.index);
  }
}

function showSubtitleSelector() {
  const wrap = document.getElementById('subtitle-selector-wrap');
  if (!wrap) return;
  wrap.style.display = canControl() ? 'flex' : 'none';
  // Always sync the dropdown when the selector becomes visible — it may not
  // have been populated yet if tracks haven't arrived.
  syncSubtitleSelect(
    subtitles.length ? subtitles.find((s) => s.index === subtitlesSelectedIndex) : null
  );
}

function selectSubtitle(index) {
  // index == -1 means turn subtitles off.
  subtitlesSelectedIndex = index;
  // Reset all tracks' default flag and mode.
  video.querySelectorAll('track[type="subtitles"]').forEach((t) => {
    t.default = false;
  });
  if (index >= 0) {
    const track = video.querySelector(`track[type="subtitles"][data-index="${index}"]`);
    if (track) {
      track.default = true;
    }
  }
  // Sync the dropdown to match.
  syncSubtitleSelect(index >= 0 ? subtitles.find((s) => s.index === index) : null);
  // Update text track modes via the textTracks collection.
  if (video.textTracks) {
    for (let i = 0; i < video.textTracks.length; i++) {
      const tt = video.textTracks[i];
      const matchingTrack = subtitles.find((s) => {
        const el = video.querySelector(`track[type="subtitles"][data-index="${s.index}"]`);
        return el && el.track === tt;
      });
      if (matchingTrack) {
        tt.mode = (matchingTrack.index === index) ? 'showing' : 'hidden';
      } else {
        tt.mode = 'disabled';
      }
    }
  }
  if (socket && socket.connected) {
    socket.emit('room:subtitle', { index });
  }
}

async function fetchSubtitles() {
  if (!video.src) return;
  const myRequestId = ++subtitlesRequestId;
  try {
    const res = await api('GET', `/api/rooms/${encodeURIComponent(roomCode)}/subtitles`);
    // Only apply the result if no newer subtitle update (socket push or another
    // fetch) has occurred since this request started. This prevents a delayed
    // response from an earlier upload from overwriting the tracks of a newer video.
    if (myRequestId === subtitlesRequestId) {
      subtitles = res.tracks || [];
      renderSubtitleTracks();
      showSubtitleSelector();
    }
  } catch (err) {
    // Subtitle endpoint not reachable (e.g. older server) — keep any tracks
    // already pushed via room:subtitles; just don't clear them.
    console.warn('fetchSubtitles failed:', err.message);
  }
}