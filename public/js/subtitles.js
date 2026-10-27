// Subtitles (Crunchyroll Style & Customizable WebVTT Engine)
// Rebuilds <track> elements, styles cues using Crunchyroll typography and solid
// outlines across all viewing modes (including browser fullscreen), and provides
// a live customizable settings modal.
//
// Global inputs (declared in room.js):
// video, subtitles, subtitlesSelectedIndex, subtitlesRequestId,
// socket, roomCode, showToast, canControl, api.

const DEFAULT_SUB_SETTINGS = {
  preset: 'crunchyroll',
  fontFamily: "'Trebuchet MS', 'Lucida Sans Unicode', sans-serif",
  fontSizeScale: 1.0,
  textColor: '#ffffff',
  borderStyle: 'crunchyroll', // 'crunchyroll' | 'thick' | 'medium' | 'thin' | 'shadow' | 'none'
  borderColor: '#000000',
  backgroundStyle: 'none', // 'none' | 'semi-black' | 'dark' | 'solid-black'
  bottomOffset: 8,
};

let subSettings = loadSubtitleSettings();
let _renderedSubtitlesSignature = null;
let _suppressTrackChange = false;
let _suppressTrackChangeUntil = 0;

// Load user settings from localStorage
function loadSubtitleSettings() {
  try {
    const raw = localStorage.getItem('screening_room_sub_settings');
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_SUB_SETTINGS, ...parsed };
    }
  } catch (_) {}
  return { ...DEFAULT_SUB_SETTINGS };
}

// Save user settings to localStorage
function saveSubtitleSettings(settings) {
  subSettings = { ...subSettings, ...settings };
  try {
    localStorage.setItem('screening_room_sub_settings', JSON.stringify(subSettings));
  } catch (_) {}
  applySubtitleSettings();
}

// Compute CSS text-shadow based on outline settings and scaled proportionally to font size
function computeOutlineCss(borderStyle, borderColor, fontSizePx = 24) {
  const color = borderColor || '#000000';
  const factor = Math.max(0.48, Math.min(2.2, (Number(fontSizePx) || 24) / 24));
  const px = (n) => `${(n * factor).toFixed(2)}px`;

  if (borderStyle === 'crunchyroll') {
    // Crunchyroll iconic 12-point solid thick outline, scaled to font size
    const o2 = px(2);
    const n2 = px(-2);
    const o1 = px(1);
    const n1 = px(-1);
    const blur = px(3);
    const shadow = [
      `${n2} ${n2} 0px ${color}`,
      `${o2} ${n2} 0px ${color}`,
      `${n2} ${o2} 0px ${color}`,
      `${o2} ${o2} 0px ${color}`,
      `${n2} 0px 0px ${color}`,
      `${o2} 0px 0px ${color}`,
      `0px ${n2} 0px ${color}`,
      `0px ${o2} 0px ${color}`,
      `${n1} ${n1} 0px ${color}`,
      `${o1} ${n1} 0px ${color}`,
      `${n1} ${o1} 0px ${color}`,
      `${o1} ${o1} 0px ${color}`,
      `0px 0px ${blur} rgba(0,0,0,0.85)`
    ].join(', ');
    return { shadow, stroke: `${px(1.5)} ${color}` };
  } else if (borderStyle === 'thick') {
    const o3 = px(2.8);
    const n3 = px(-2.8);
    const o15 = px(1.4);
    const n15 = px(-1.4);
    const shadow = [
      `${n3} ${n3} 0px ${color}`,
      `${o3} ${n3} 0px ${color}`,
      `${n3} ${o3} 0px ${color}`,
      `${o3} ${o3} 0px ${color}`,
      `${n3} 0px 0px ${color}`,
      `${o3} 0px 0px ${color}`,
      `0px ${n3} 0px ${color}`,
      `0px ${o3} 0px ${color}`,
      `${n15} ${n15} 0px ${color}`,
      `${o15} ${n15} 0px ${color}`,
      `${n15} ${o15} 0px ${color}`,
      `${o15} ${o15} 0px ${color}`
    ].join(', ');
    return { shadow, stroke: `${px(2)} ${color}` };
  } else if (borderStyle === 'medium') {
    const o = px(1.5);
    const n = px(-1.5);
    const shadow = [
      `${n} ${n} 0px ${color}`,
      `${o} ${n} 0px ${color}`,
      `${n} ${o} 0px ${color}`,
      `${o} ${o} 0px ${color}`,
      `${n} 0px 0px ${color}`,
      `${o} 0px 0px ${color}`,
      `0px ${n} 0px ${color}`,
      `0px ${o} 0px ${color}`
    ].join(', ');
    return { shadow, stroke: `${px(1.2)} ${color}` };
  } else if (borderStyle === 'thin') {
    const o = px(1);
    const n = px(-1);
    const shadow = [
      `${n} ${n} 0px ${color}`,
      `${o} ${n} 0px ${color}`,
      `${n} ${o} 0px ${color}`,
      `${o} ${o} 0px ${color}`
    ].join(', ');
    return { shadow, stroke: `${px(0.8)} ${color}` };
  } else if (borderStyle === 'shadow') {
    return { shadow: `${px(2)} ${px(2)} ${px(4)} ${color}`, stroke: 'none' };
  }
  return { shadow: 'none', stroke: 'none' };
}

// Compute fullscreen outline shadow (scaled for fullscreen font size)
function computeFullscreenOutlineCss(borderStyle, borderColor, fsFontSizePx = 60) {
  return computeOutlineCss(borderStyle, borderColor, fsFontSizePx).shadow;
}

// Compute background color CSS (Chromium WebVTT strictly requires background-color)
function computeBackgroundCss(bgStyle) {
  if (bgStyle === 'semi-black') return 'rgba(0, 0, 0, 0.55)';
  if (bgStyle === 'dark') return 'rgba(0, 0, 0, 0.8)';
  if (bgStyle === 'solid-black') return 'rgba(0, 0, 0, 0.98)';
  return 'transparent';
}

// Apply settings directly to the document and ::cue pseudo-elements in all display modes
function applySubtitleSettings() {
  const bg = computeBackgroundCss(subSettings.backgroundStyle);
  const fontFam = subSettings.fontFamily || "'Trebuchet MS', sans-serif";
  const textColor = subSettings.textColor || '#ffffff';
  const scale = Number(subSettings.fontSizeScale) || 1.0;
  const bottomOffset = Number.isFinite(subSettings.bottomOffset) ? subSettings.bottomOffset : 8;

  const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
  const vh = (typeof window !== 'undefined' && window.innerHeight) || 720;
  const screenW = (typeof window !== 'undefined' && window.screen && window.screen.width) || vw;
  const screenH = (typeof window !== 'undefined' && window.screen && window.screen.height) || vh;

  const isFs = !!(
    typeof document !== 'undefined' &&
    (document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement)
  );

  // 1. Windowed mode font size: adapt to actual <video> dimensions or viewport width
  // so mobile phones get compact, proportional subtitles (~12-15px) while desktop gets ~24px.
  const vid = (typeof video !== 'undefined' && video) || (typeof document !== 'undefined' && document.getElementById('player'));
  let baseNormalPx = 24;
  if (vid && vid.clientWidth > 0 && vid.clientHeight > 0 && !isFs) {
    const renderedVideoH = Math.min(vid.clientHeight, Math.round(vid.clientWidth * (9 / 16)));
    baseNormalPx = Math.max(11, Math.min(26, Math.round(renderedVideoH * 0.055)));
  } else if (vw <= 480) {
    const estVideoH = Math.round((vw - 16) * (9 / 16));
    baseNormalPx = Math.max(11, Math.min(14, Math.round(estVideoH * 0.056)));
  } else if (vw <= 768) {
    baseNormalPx = Math.max(13, Math.min(18, Math.round(vw * 0.024)));
  } else if (vw <= 1024) {
    baseNormalPx = 20;
  }
  const normalPx = Math.max(10, Math.round(baseNormalPx * scale));

  // 2. Fullscreen mode font size: differentiate mobile/tablet screens from desktop monitors
  const minScreenSide = Math.min(screenW, screenH);
  const isMobileOrTablet = minScreenSide <= 768 || (vw <= 900 && vh <= 900);
  let baseFsPx;
  if (isMobileOrTablet) {
    if (isFs) {
      // Use actual fullscreen 16:9 video height
      const fsVideoH = Math.min(vh, Math.round(vw * (9 / 16)));
      baseFsPx = Math.max(12, Math.min(22, Math.round(fsVideoH * 0.052)));
    } else {
      // Pre-computed rule for mobile native fullscreen (usually landscape ~360-430px high)
      const mobileLandscapeH = Math.min(minScreenSide, Math.round(Math.max(screenW, screenH) * (9 / 16)));
      baseFsPx = Math.max(14, Math.min(20, Math.round(mobileLandscapeH * 0.048)));
    }
  } else {
    // Desktop / large monitor fullscreen (~5.6% of screen height, e.g. ~60px on 1080p)
    const desktopFsH = Math.max(screenH, vh, 1080);
    baseFsPx = Math.max(48, Math.round(desktopFsH * 0.056));
  }
  const fullscreenPx = Math.max(12, Math.round(baseFsPx * scale));

  const { shadow, stroke } = computeOutlineCss(subSettings.borderStyle, subSettings.borderColor, normalPx);
  const fsShadow = computeFullscreenOutlineCss(subSettings.borderStyle, subSettings.borderColor, fullscreenPx);

  const styleElId = 'sr-sub-dynamic-styles';
  let styleEl = document.getElementById(styleElId);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleElId;
    document.head.appendChild(styleEl);
  }

  // Inject rules for standard and fullscreen contexts (including distinct Gecko/WebKit rules)
  styleEl.textContent = `
    :root {
      --sub-font-family: ${fontFam};
      --sub-color: ${textColor};
      --sub-scale: ${scale};
      --sub-text-shadow: ${shadow};
      --sub-fullscreen-shadow: ${fsShadow};
      --sub-stroke: ${stroke};
      --sub-bg: ${bg};
      --sub-bottom-offset: ${bottomOffset}%;
    }
    video::-webkit-media-text-track-container {
      bottom: ${bottomOffset}% !important;
      overflow: visible !important;
    }
    ::cue,
    video::cue,
    *::cue {
      font-family: ${fontFam} !important;
      font-weight: 700 !important;
      color: ${textColor} !important;
      background-color: ${bg} !important;
      text-shadow: ${shadow} !important;
      font-size: ${normalPx}px !important;
      line-height: 1.35 !important;
      white-space: pre-line !important;
    }

    /* Standard Fullscreen */
    :fullscreen::cue,
    video:fullscreen::cue,
    .screen-wrap:fullscreen video::cue,
    :fullscreen video::cue {
      font-family: ${fontFam} !important;
      font-weight: 700 !important;
      color: ${textColor} !important;
      background-color: ${bg} !important;
      text-shadow: ${fsShadow} !important;
      font-size: ${fullscreenPx}px !important;
      line-height: 1.35 !important;
      white-space: pre-line !important;
    }

    /* Firefox Fullscreen (Gecko) */
    :-moz-full-screen::cue,
    video:-moz-full-screen::cue,
    .screen-wrap:-moz-full-screen video::cue,
    :-moz-full-screen video::cue {
      font-family: ${fontFam} !important;
      font-weight: 700 !important;
      color: ${textColor} !important;
      background-color: ${bg} !important;
      text-shadow: ${fsShadow} !important;
      font-size: ${fullscreenPx}px !important;
      line-height: 1.35 !important;
      white-space: pre-line !important;
    }

    /* WebKit & Chromium Fullscreen */
    :-webkit-full-screen::cue,
    video:-webkit-full-screen::cue,
    .screen-wrap:-webkit-full-screen video::cue,
    :-webkit-full-screen video::cue {
      font-family: ${fontFam} !important;
      font-weight: 700 !important;
      color: ${textColor} !important;
      background-color: ${bg} !important;
      text-shadow: ${fsShadow} !important;
      font-size: ${fullscreenPx}px !important;
      line-height: 1.35 !important;
      white-space: pre-line !important;
    }

    /* Modern forgiving :is() selector */
    :is(:fullscreen, :-webkit-full-screen, :-moz-full-screen)::cue,
    video:is(:fullscreen, :-webkit-full-screen, :-moz-full-screen)::cue,
    :is(:fullscreen, :-webkit-full-screen, :-moz-full-screen) video::cue {
      font-family: ${fontFam} !important;
      font-weight: 700 !important;
      color: ${textColor} !important;
      background-color: ${bg} !important;
      text-shadow: ${fsShadow} !important;
      font-size: ${fullscreenPx}px !important;
      line-height: 1.35 !important;
      white-space: pre-line !important;
    }

    /* Fullscreen JS fallback class */
    body.is-video-fullscreen ::cue,
    body.is-video-fullscreen video::cue,
    video.is-video-fullscreen::cue {
      font-family: ${fontFam} !important;
      font-weight: 700 !important;
      color: ${textColor} !important;
      background-color: ${bg} !important;
      text-shadow: ${fsShadow} !important;
      font-size: ${fullscreenPx}px !important;
      line-height: 1.35 !important;
      white-space: pre-line !important;
    }
  `;

  applyBottomOffsetToTracks(bottomOffset);
  updateModalPreview();
}

// Shifts bottom dialogue cues upward to leave the user-configured bottom clearance
function applyBottomOffsetToTracks(offsetPercent) {
  const vid = (typeof video !== 'undefined' && video) || document.getElementById('player');
  if (!vid || !vid.textTracks) return;
  const offset = Number.isFinite(offsetPercent) ? offsetPercent : (subSettings.bottomOffset || 8);
  const targetLine = Math.max(50, 100 - offset);

  for (let i = 0; i < vid.textTracks.length; i++) {
    const tt = vid.textTracks[i];
    if (!tt.cues || tt.cues.length === 0) continue;

    for (let j = 0; j < tt.cues.length; j++) {
      const cue = tt.cues[j];
      try {
        if (cue._isBottomDialogue === undefined) {
          cue._isBottomDialogue = (cue.snapToLines || cue.line === 'auto' || cue.line >= 60);
        }
        // Only adjust bottom dialogue cues! (Do NOT touch top signs or mid cues with line < 60)
        if (cue._isBottomDialogue) {
          cue.snapToLines = false;
          cue.lineAlign = 'end';
          cue.line = targetLine;
        }
      } catch (_) {}
    }
  }
}

function updateModalPreview() {
  const cue = document.getElementById('sub-preview-cue');
  const topCue = document.getElementById('sub-preview-top-cue');
  if (!cue || !topCue) return;

  const { shadow, stroke } = computeOutlineCss(subSettings.borderStyle, subSettings.borderColor);
  const bg = computeBackgroundCss(subSettings.backgroundStyle);
  const scale = Number(subSettings.fontSizeScale) || 1.0;
  const offset = Number.isFinite(subSettings.bottomOffset) ? subSettings.bottomOffset : 8;

  const applyToEl = (el, baseSize) => {
    el.style.fontFamily = subSettings.fontFamily;
    el.style.color = subSettings.textColor;
    el.style.fontSize = `${Math.round(baseSize * scale)}px`;
    el.style.textShadow = shadow;
    el.style.webkitTextStroke = stroke;
    el.style.backgroundColor = bg;
  };

  applyToEl(cue, 18);
  applyToEl(topCue, 15);
  cue.style.bottom = `${offset}%`;
}

function subtitlesSignature(list) {
  return list.map((s) => `${s.index}:${s.vttUrl}`).join('|');
}

function resetSubtitleTracking() {
  _renderedSubtitlesSignature = null;
}

// Helper to enforce showing/hidden mode on all textTracks matching subtitlesSelectedIndex
function enforceActiveSubtitleTrack() {
  const vid = (typeof video !== 'undefined' && video) || document.getElementById('player');
  if (!vid || !vid.textTracks || !subtitles || !subtitles.length) return;

  _suppressTrackChange = true;
  _suppressTrackChangeUntil = Date.now() + 600;

  const currentSelected = subtitlesSelectedIndex != null
    ? subtitles.find((s) => s.index === subtitlesSelectedIndex)
    : null;

  for (let i = 0; i < vid.textTracks.length; i++) {
    const tt = vid.textTracks[i];
    const matchingTrack = subtitles.find((s) => {
      const el = vid.querySelector(`track[data-index="${s.index}"]`);
      return el && el.track === tt;
    });
    if (matchingTrack) {
      const targetMode = (currentSelected && matchingTrack === currentSelected) ? 'showing' : 'hidden';
      if (tt.mode !== targetMode) {
        tt.mode = targetMode;
      }
    } else {
      tt.mode = 'disabled';
    }
    if (!tt._offsetAttached) {
      tt.addEventListener('cuechange', () => applyBottomOffsetToTracks());
      tt._offsetAttached = true;
    }
  }

  applyBottomOffsetToTracks();
  setTimeout(() => {
    _suppressTrackChange = false;
  }, 150);
}

// Rebuild track elements & sync native video captions
function renderSubtitleTracks() {
  const vid = (typeof video !== 'undefined' && video) || document.getElementById('player');
  if (!vid) return;

  _suppressTrackChange = true;
  _suppressTrackChangeUntil = Date.now() + 1000;

  if (
    subtitles.length > 0 &&
    subtitlesSelectedIndex !== -1 &&
    (subtitlesSelectedIndex == null || !subtitles.some((s) => s.index === subtitlesSelectedIndex))
  ) {
    subtitlesSelectedIndex = subtitles[0].index;
  }

  const signature = subtitlesSignature(subtitles);
  const hasNoTracksInDom = vid.querySelectorAll('track').length === 0 && subtitles.length > 0;
  const listChanged = (signature !== _renderedSubtitlesSignature) || hasNoTracksInDom;

  if (listChanged) {
    vid.querySelectorAll('track').forEach((t) => t.remove());
    _renderedSubtitlesSignature = signature;

    if (!subtitles.length) {
      syncSubtitleSelect(null);
      _suppressTrackChange = false;
      return;
    }

    if (vid.textTracks) {
      for (let i = 0; i < vid.textTracks.length; i++) {
        vid.textTracks[i].mode = 'disabled';
      }
    }

    const selectedForCreate = subtitlesSelectedIndex != null
      ? subtitles.find((s) => s.index === subtitlesSelectedIndex)
      : (subtitles.length > 0 ? subtitles[0] : null);

    for (const s of subtitles) {
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = s.label;
      track.srclang = s.srclang || '';
      track.default = (s === selectedForCreate);
      track.src = s.vttUrl;
      track.dataset.index = String(s.index);

      track.addEventListener('load', () => {
        _suppressTrackChange = true;
        _suppressTrackChangeUntil = Date.now() + 600;
        if (track.track) {
          track.track.mode = (subtitlesSelectedIndex != null && s.index === subtitlesSelectedIndex) ? 'showing' : 'hidden';
        }
        applyBottomOffsetToTracks();
        setTimeout(() => {
          _suppressTrackChange = false;
        }, 150);
      });

      track.addEventListener('error', (err) => {
        console.warn(`Subtitle track failed to load: ${s.label} (${s.vttUrl})`, err);
      });

      vid.appendChild(track);
      if (track.track) {
        track.track.mode = (s === selectedForCreate) ? 'showing' : 'hidden';
      }
    }
  } else if (!subtitles.length) {
    syncSubtitleSelect(null);
    _suppressTrackChange = false;
    return;
  }

  const selected = subtitlesSelectedIndex != null
    ? subtitles.find((s) => s.index === subtitlesSelectedIndex)
    : null;

  syncSubtitleSelect(selected);
  enforceActiveSubtitleTrack();

  // Sync mode on video.textTracks in next animation frame as well
  requestAnimationFrame(() => {
    enforceActiveSubtitleTrack();
  });
}

function syncSubtitleSelect(selected) {
  const sel = document.getElementById('subtitle-select');
  if (!sel) return;
  sel.innerHTML = '';

  const off = document.createElement('option');
  off.value = '-1';
  off.textContent = 'Subtitles: Off';
  sel.appendChild(off);

  for (const s of subtitles) {
    const o = document.createElement('option');
    o.value = String(s.index);
    o.textContent = s.label + (s.srclang ? ` (${s.srclang.toUpperCase()})` : '');
    sel.appendChild(o);
  }

  sel.value = (subtitlesSelectedIndex != null) ? String(subtitlesSelectedIndex) : '-1';
  if (selected) {
    sel.value = String(selected.index);
  }
}

function showSubtitleSelector() {
  const btn = document.getElementById('subtitle-settings-btn');
  const vid = (typeof video !== 'undefined' && video) || document.getElementById('player');
  if (btn) {
    const hasVid = Boolean(vid && vid.style.display !== 'none');
    btn.style.display = (hasVid || (subtitles && subtitles.length > 0)) ? 'inline-flex' : 'none';
  }
}

function selectSubtitle(index) {
  subtitlesSelectedIndex = index;
  const vid = (typeof video !== 'undefined' && video) || document.getElementById('player');
  if (!vid) return;

  _suppressTrackChange = true;
  _suppressTrackChangeUntil = Date.now() + 600;

  vid.querySelectorAll('track').forEach((t) => {
    t.default = false;
  });

  const selectedTrack = subtitles.find((s) => s.index === index);
  if (index >= 0 && selectedTrack) {
    const track = vid.querySelector(`track[data-index="${index}"]`);
    if (track) {
      track.default = true;
      if (track.track) track.track.mode = 'showing';
    }
  }

  syncSubtitleSelect(selectedTrack || null);
  enforceActiveSubtitleTrack();

  if (typeof canControl === 'function' && canControl() && socket && socket.connected) {
    socket.emit('room:subtitle', { index });
  }
}

async function fetchSubtitles() {
  if (!video.src) return;
  const myRequestId = ++subtitlesRequestId;
  try {
    const res = await api('GET', `/api/rooms/${encodeURIComponent(roomCode)}/subtitles`);
    if (myRequestId === subtitlesRequestId) {
      subtitles = res.tracks || [];
      if (
        subtitles.length > 0 &&
        subtitlesSelectedIndex !== -1 &&
        (subtitlesSelectedIndex == null || !subtitles.some((t) => t.index === subtitlesSelectedIndex))
      ) {
        subtitlesSelectedIndex = subtitles[0].index;
      }
      renderSubtitleTracks();
      showSubtitleSelector();
    }
  } catch (err) {
    console.warn('fetchSubtitles failed:', err.message);
  }
}

// ----------------------------------------------------------------------
// Subtitle Settings Modal & Controls Wiring
// ----------------------------------------------------------------------

function initSubtitleModal() {
  const modalBackdrop = document.getElementById('sub-modal-backdrop');
  const openBtn = document.getElementById('subtitle-settings-btn');
  const closeBtn = document.getElementById('sub-modal-close');
  const saveBtn = document.getElementById('sub-save-btn');
  const resetBtn = document.getElementById('sub-reset-btn');

  const presetSelect = document.getElementById('sub-preset-select');
  const fontSelect = document.getElementById('sub-font-family');
  const sizeSlider = document.getElementById('sub-font-size');
  const sizeVal = document.getElementById('sub-size-val');
  const textColorInput = document.getElementById('sub-text-color');
  const textColorHex = document.getElementById('sub-text-color-hex');
  const borderStyleSelect = document.getElementById('sub-border-style');
  const borderColorInput = document.getElementById('sub-border-color');
  const borderColorHex = document.getElementById('sub-border-color-hex');
  const bgStyleSelect = document.getElementById('sub-bg-style');
  const offsetSlider = document.getElementById('sub-bottom-offset');
  const offsetVal = document.getElementById('sub-offset-val');

  if (!modalBackdrop || !openBtn) return;

  function syncModalInputsFromSettings() {
    if (presetSelect) presetSelect.value = subSettings.preset || 'custom';
    if (fontSelect) fontSelect.value = subSettings.fontFamily;
    if (sizeSlider) {
      sizeSlider.value = Math.round(subSettings.fontSizeScale * 100);
      if (sizeVal) sizeVal.textContent = `${sizeSlider.value}%`;
    }
    if (textColorInput) {
      textColorInput.value = subSettings.textColor;
      if (textColorHex) textColorHex.textContent = subSettings.textColor;
    }
    if (borderStyleSelect) borderStyleSelect.value = subSettings.borderStyle;
    if (borderColorInput) {
      borderColorInput.value = subSettings.borderColor;
      if (borderColorHex) borderColorHex.textContent = subSettings.borderColor;
    }
    if (bgStyleSelect) bgStyleSelect.value = subSettings.backgroundStyle;
    if (offsetSlider) {
      offsetSlider.value = subSettings.bottomOffset;
      if (offsetVal) offsetVal.textContent = `${subSettings.bottomOffset}%`;
    }
    updateModalPreview();
  }

  function applyPreset(presetName) {
    if (presetName === 'crunchyroll') {
      subSettings.fontFamily = "'Trebuchet MS', 'Lucida Sans Unicode', sans-serif";
      subSettings.fontSizeScale = 1.0;
      subSettings.textColor = '#ffffff';
      subSettings.borderStyle = 'crunchyroll';
      subSettings.borderColor = '#000000';
      subSettings.backgroundStyle = 'none';
      subSettings.preset = 'crunchyroll';
      subSettings.bottomOffset = 8;
    } else if (presetName === 'crunchyroll-yellow') {
      subSettings.fontFamily = "'Trebuchet MS', 'Lucida Sans Unicode', sans-serif";
      subSettings.fontSizeScale = 1.0;
      subSettings.textColor = '#ffe600';
      subSettings.borderStyle = 'crunchyroll';
      subSettings.borderColor = '#000000';
      subSettings.backgroundStyle = 'none';
      subSettings.preset = 'crunchyroll-yellow';
      subSettings.bottomOffset = 8;
    } else if (presetName === 'high-contrast') {
      subSettings.fontFamily = "Arial, Helvetica, sans-serif";
      subSettings.fontSizeScale = 1.0;
      subSettings.textColor = '#ffffff';
      subSettings.borderStyle = 'thin';
      subSettings.borderColor = '#000000';
      subSettings.backgroundStyle = 'dark';
      subSettings.preset = 'high-contrast';
      subSettings.bottomOffset = 8;
    } else if (presetName === 'minimalist') {
      subSettings.fontFamily = "'Roboto', 'Segoe UI', sans-serif";
      subSettings.fontSizeScale = 0.95;
      subSettings.textColor = '#ffffff';
      subSettings.borderStyle = 'thin';
      subSettings.borderColor = '#000000';
      subSettings.backgroundStyle = 'none';
      subSettings.preset = 'minimalist';
      subSettings.bottomOffset = 8;
    }
    syncModalInputsFromSettings();
    saveSubtitleSettings(subSettings);
    applySubtitleSettings();
    applyBottomOffsetToTracks(subSettings.bottomOffset);
  }

  openBtn.addEventListener('click', () => {
    syncModalInputsFromSettings();
    modalBackdrop.style.display = 'flex';
  });

  closeBtn.addEventListener('click', () => {
    modalBackdrop.style.display = 'none';
  });

  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      modalBackdrop.style.display = 'none';
    });
  }

  modalBackdrop.addEventListener('click', (e) => {
    if (e.target === modalBackdrop) {
      modalBackdrop.style.display = 'none';
    }
  });

  if (presetSelect) {
    presetSelect.addEventListener('change', () => {
      applyPreset(presetSelect.value);
    });
  }

  if (fontSelect) {
    fontSelect.addEventListener('change', () => {
      subSettings.fontFamily = fontSelect.value;
      subSettings.preset = 'custom';
      if (presetSelect) presetSelect.value = 'custom';
      saveSubtitleSettings(subSettings);
    });
  }

  if (sizeSlider) {
    sizeSlider.addEventListener('input', () => {
      subSettings.fontSizeScale = parseInt(sizeSlider.value, 10) / 100;
      if (sizeVal) sizeVal.textContent = `${sizeSlider.value}%`;
      subSettings.preset = 'custom';
      if (presetSelect) presetSelect.value = 'custom';
      saveSubtitleSettings(subSettings);
    });
  }

  if (textColorInput) {
    textColorInput.addEventListener('input', () => {
      subSettings.textColor = textColorInput.value;
      if (textColorHex) textColorHex.textContent = textColorInput.value;
      subSettings.preset = 'custom';
      if (presetSelect) presetSelect.value = 'custom';
      saveSubtitleSettings(subSettings);
    });
  }

  if (borderStyleSelect) {
    borderStyleSelect.addEventListener('change', () => {
      subSettings.borderStyle = borderStyleSelect.value;
      subSettings.preset = 'custom';
      if (presetSelect) presetSelect.value = 'custom';
      saveSubtitleSettings(subSettings);
    });
  }

  if (borderColorInput) {
    borderColorInput.addEventListener('input', () => {
      subSettings.borderColor = borderColorInput.value;
      if (borderColorHex) borderColorHex.textContent = borderColorInput.value;
      subSettings.preset = 'custom';
      if (presetSelect) presetSelect.value = 'custom';
      saveSubtitleSettings(subSettings);
    });
  }

  if (bgStyleSelect) {
    bgStyleSelect.addEventListener('change', () => {
      subSettings.backgroundStyle = bgStyleSelect.value;
      subSettings.preset = 'custom';
      if (presetSelect) presetSelect.value = 'custom';
      saveSubtitleSettings(subSettings);
    });
  }

  if (offsetSlider) {
    offsetSlider.addEventListener('input', () => {
      subSettings.bottomOffset = parseInt(offsetSlider.value, 10);
      if (offsetVal) offsetVal.textContent = `${offsetSlider.value}%`;
      subSettings.preset = 'custom';
      if (presetSelect) presetSelect.value = 'custom';
      saveSubtitleSettings(subSettings);
      applySubtitleSettings();
      applyBottomOffsetToTracks(subSettings.bottomOffset);
      updateModalPreview();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      applyPreset('crunchyroll');
    });
  }
}

function initSubtitleVideoListeners() {
  const vid = (typeof video !== 'undefined' && video) || document.getElementById('player');
  if (!vid) return;

  vid.addEventListener('loadedmetadata', () => {
    applySubtitleSettings();
    enforceActiveSubtitleTrack();
  });
  vid.addEventListener('canplay', () => {
    applySubtitleSettings();
    enforceActiveSubtitleTrack();
  });
  vid.addEventListener('play', () => {
    applySubtitleSettings();
    enforceActiveSubtitleTrack();
  });

  if (typeof ResizeObserver !== 'undefined' && !vid._subResizeObserver) {
    vid._subResizeObserver = new ResizeObserver(() => {
      applySubtitleSettings();
    });
    vid._subResizeObserver.observe(vid);
  }

  if (vid.textTracks && !vid.textTracks._hasSubChangeListener) {
    vid.textTracks._hasSubChangeListener = true;
    vid.textTracks.addEventListener('change', () => {
      if (_suppressTrackChange || Date.now() < _suppressTrackChangeUntil || !subtitles || !subtitles.length) {
        return;
      }
      // If video metadata hasn't loaded yet, browser-internal track resets should
      // not clobber our selected track index.
      if (vid.readyState < 1) {
        enforceActiveSubtitleTrack();
        return;
      }

      let activeIdx = -1;
      for (let i = 0; i < vid.textTracks.length; i++) {
        const tt = vid.textTracks[i];
        if (tt.mode === 'showing') {
          const matchingTrack = subtitles.find((s) => {
            const el = vid.querySelector(`track[data-index="${s.index}"]`);
            return el && el.track === tt;
          });
          if (matchingTrack) {
            activeIdx = matchingTrack.index;
            break;
          }
        }
      }
      if (activeIdx !== subtitlesSelectedIndex) {
        subtitlesSelectedIndex = activeIdx;
        syncSubtitleSelect(subtitles.find(s => s.index === activeIdx) || null);
        if (typeof canControl === 'function' && canControl() && socket && socket.connected) {
          socket.emit('room:subtitle', { index: activeIdx });
        }
      }
    });
  }
}

function initSubtitleEvents() {
  initSubtitleVideoListeners();

  const sel = document.getElementById('subtitle-select');
  if (sel) {
    sel.addEventListener('change', (e) => {
      const idx = parseInt(e.target.value, 10);
      selectSubtitle(idx);
    });
  }

  // Re-apply style rules whenever fullscreen state or window size changes
  function onFullscreenStateChanged() {
    const isFs = !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement
    );
    const vid = (typeof video !== 'undefined' && video) || document.getElementById('player');
    if (isFs) {
      document.body.classList.add('is-video-fullscreen');
      if (vid) vid.classList.add('is-video-fullscreen');
    } else {
      document.body.classList.remove('is-video-fullscreen');
      if (vid) vid.classList.remove('is-video-fullscreen');
    }

    applySubtitleSettings();

    if (vid && vid.textTracks && subtitlesSelectedIndex != null) {
      for (let i = 0; i < vid.textTracks.length; i++) {
        const tt = vid.textTracks[i];
        const matchingTrack = subtitles.find((s) => {
          const el = vid.querySelector(`track[data-index="${s.index}"]`);
          return el && el.track === tt;
        });
        if (matchingTrack) {
          tt.mode = (matchingTrack.index === subtitlesSelectedIndex) ? 'showing' : 'hidden';
        }
      }
    }
  }

  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(evt => {
    document.addEventListener(evt, () => {
      onFullscreenStateChanged();
      setTimeout(onFullscreenStateChanged, 120);
      setTimeout(onFullscreenStateChanged, 350);
    });
  });
  window.addEventListener('resize', onFullscreenStateChanged);
  window.addEventListener('orientationchange', () => {
    setTimeout(onFullscreenStateChanged, 150);
    setTimeout(onFullscreenStateChanged, 400);
  });
}

// Initial bootstrap
applySubtitleSettings();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initSubtitleModal();
    initSubtitleEvents();
  });
} else {
  initSubtitleModal();
  initSubtitleEvents();
}
