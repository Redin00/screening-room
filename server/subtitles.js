const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('./db');

// Resolve binary path for ffprobe / ffmpeg across PATH, standard Linux locations, and optional npm packages
const _resolvedBinaries = {};
function findBinary(name, envKey, candidatePaths, npmPackages) {
  if (_resolvedBinaries[name] !== undefined) return _resolvedBinaries[name];

  const candidates = [];
  if (process.env[envKey]) candidates.push(process.env[envKey]);
  for (const pkg of npmPackages || []) {
    try {
      const mod = require(pkg);
      const binPath = typeof mod === 'string' ? mod : (mod && mod.path);
      if (binPath) candidates.push(binPath);
    } catch (_) {}
  }
  candidates.push(name);
  for (const p of candidatePaths || []) {
    candidates.push(p);
  }

  for (const cmd of candidates) {
    try {
      const res = spawnSync(cmd, ['-version'], { stdio: 'ignore', timeout: 5000 });
      if (res && !res.error && res.status === 0) {
        _resolvedBinaries[name] = cmd;
        return cmd;
      }
    } catch (_) {}
  }

  _resolvedBinaries[name] = null;
  return null;
}

function getFfprobeBin() {
  return findBinary(
    'ffprobe',
    'FFPROBE_PATH',
    ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe', '/snap/bin/ffprobe', '/bin/ffprobe', '/opt/homebrew/bin/ffprobe'],
    ['ffprobe-static', '@ffprobe-installer/ffprobe']
  );
}

function getFfmpegBin() {
  return findBinary(
    'ffmpeg',
    'FFMPEG_PATH',
    ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/snap/bin/ffmpeg', '/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'],
    ['ffmpeg-static', '@ffmpeg-installer/ffmpeg']
  );
}

// Convert seconds (float) to WebVTT timestamp (HH:MM:SS.mmm)
function secToVttTime(sec) {
  const sTotal = Math.max(0, Number(sec) || 0);
  const totalMs = Math.round(sTotal * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

// Convert seconds (float) to ASS timestamp (H:MM:SS.cs)
function secToAssTime(sec) {
  const sTotal = Math.max(0, Number(sec) || 0);
  const totalCs = Math.round(sTotal * 100);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// Convert ASS timestamp (H:MM:SS.cs) to WebVTT timestamp (HH:MM:SS.mmm).
function assTimeToVtt(t) {
  if (!t) return '00:00:00.000';
  const parts = t.trim().split(':');
  if (parts.length < 2) return '00:00:00.000';
  let h = '00', m = '00', s = '00', ms = '000';
  if (parts.length === 3) {
    h = parts[0].padStart(2, '0');
    m = parts[1].padStart(2, '0');
    const sParts = parts[2].split('.');
    s = sParts[0].padStart(2, '0');
    ms = (sParts[1] || '0').padEnd(3, '0').slice(0, 3);
  } else if (parts.length === 2) {
    m = parts[0].padStart(2, '0');
    const sParts = parts[1].split('.');
    s = sParts[0].padStart(2, '0');
    ms = (sParts[1] || '0').padEnd(3, '0').slice(0, 3);
  }
  return `${h}:${m}:${s}.${ms}`;
}

// Convert ASS/SSA script content to WebVTT preserving positions, alignments,
// and styling tags without ffmpeg's lossy flattening.
function convertAssToVtt(assContent) {
  let playResX = 1920;
  let playResY = 1080;
  const styles = {};

  const lines = assContent.split(/\r?\n/);
  let section = '';
  const events = [];
  let eventFormat = [];
  let styleFormat = [];

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';')) continue;
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      section = trimmed.slice(1, -1).trim();
      continue;
    }

    if (section === 'Script Info') {
      const matchX = trimmed.match(/^PlayResX\s*:\s*(\d+)/i);
      if (matchX) playResX = parseInt(matchX[1], 10);
      const matchY = trimmed.match(/^PlayResY\s*:\s*(\d+)/i);
      if (matchY) playResY = parseInt(matchY[1], 10);
    } else if (section === 'V4+ Styles' || section === 'V4 Styles') {
      if (trimmed.startsWith('Format:')) {
        styleFormat = trimmed.substring(7).split(',').map((s) => s.trim().toLowerCase());
      } else if (trimmed.startsWith('Style:')) {
        const parts = trimmed.substring(6).split(',').map((s) => s.trim());
        const styleName = parts[0];
        let align = 2;
        const alignIdx = styleFormat.indexOf('alignment');
        if (alignIdx !== -1 && parts[alignIdx] != null) {
          align = parseInt(parts[alignIdx], 10) || 2;
        } else if (parts.length >= 19) {
          align = parseInt(parts[18], 10) || 2;
        } else if (parts.length >= 14) {
          align = parseInt(parts[parts.length - 5], 10) || 2;
        }

        // Handle legacy SSA alignment (section === 'V4 Styles')
        if (section === 'V4 Styles') {
          if (align === 6) align = 8;
          else if (align === 5) align = 7;
          else if (align === 7) align = 9;
          else if (align === 9) align = 4;
          else if (align === 10) align = 5;
          else if (align === 11) align = 6;
        }

        styles[styleName] = { alignment: align };
      }
    } else if (section === 'Events') {
      if (trimmed.startsWith('Format:')) {
        eventFormat = trimmed.substring(7).split(',').map((s) => s.trim().toLowerCase());
      } else if (trimmed.startsWith('Dialogue:')) {
        const firstColon = trimmed.indexOf(':');
        const rest = trimmed.substring(firstColon + 1).trim();
        const numFields = eventFormat.length > 0 ? eventFormat.length : 10;
        const parts = [];
        let cur = '';
        let count = 0;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === ',' && count < numFields - 1) {
            parts.push(cur.trim());
            cur = '';
            count++;
          } else {
            cur += rest[i];
          }
        }
        parts.push(cur);

        const startIndex = eventFormat.indexOf('start') !== -1 ? eventFormat.indexOf('start') : 1;
        const endIndex = eventFormat.indexOf('end') !== -1 ? eventFormat.indexOf('end') : 2;
        const styleIndex = eventFormat.indexOf('style') !== -1 ? eventFormat.indexOf('style') : 3;

        events.push({
          start: parts[startIndex] || '',
          end: parts[endIndex] || '',
          style: parts[styleIndex] || 'Default',
          rawText: parts[parts.length - 1] || '',
        });
      }
    }
  }

  let vtt = 'WEBVTT\n\n';
  for (const ev of events) {
    if (/\{\\p[1-9]\}/.test(ev.rawText)) continue; // Skip vector drawing commands

    const startVtt = assTimeToVtt(ev.start);
    const endVtt = assTimeToVtt(ev.end);
    let text = ev.rawText;

    const styleInfo = styles[ev.style] || { alignment: 2 };
    let alignNum = styleInfo.alignment || 2;

    const anMatch = text.match(/\\an(\d)/);
    if (anMatch) {
      alignNum = parseInt(anMatch[1], 10);
    }

    const posMatch = text.match(/\\pos\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)/);
    let cueSettings = '';

    if (posMatch) {
      const px = parseFloat(posMatch[1]);
      const py = parseFloat(posMatch[2]);
      const xPct = Math.max(0, Math.min(100, (px / playResX) * 100)).toFixed(1);
      const yPct = Math.max(0, Math.min(100, (py / playResY) * 100)).toFixed(1);
      cueSettings = `line:${yPct}% position:${xPct}% align:center`;
    } else if (alignNum !== 2) {
      let linePct = '88%';
      let posPct = '50%';
      let align = 'center';

      if (alignNum >= 7 && alignNum <= 9) {
        linePct = '8%';
      } else if (alignNum >= 4 && alignNum <= 6) {
        linePct = '50%';
      } else {
        linePct = '90%';
      }

      if (alignNum === 7 || alignNum === 4 || alignNum === 1) {
        posPct = '10%';
        align = 'left';
      } else if (alignNum === 9 || alignNum === 6 || alignNum === 3) {
        posPct = '90%';
        align = 'right';
      } else {
        posPct = '50%';
        align = 'center';
      }

      cueSettings = `line:${linePct} position:${posPct} align:${align}`;
    }

    text = text.replace(/\\N/g, '\n').replace(/\\n/g, '\n');
    text = text.replace(/\{\\b1\}/gi, '<b>').replace(/\{\\b0\}/gi, '</b>');
    text = text.replace(/\{\\i1\}/gi, '<i>').replace(/\{\\i0\}/gi, '</i>');
    text = text.replace(/\{\\u1\}/gi, '<u>').replace(/\{\\u0\}/gi, '</u>');
    text = text.replace(/\{[^}]*\}/g, '');
    text = text.replace(/-->/g, '->');
    text = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n');

    if (!text || startVtt === endVtt) continue;
    vtt += `${startVtt} --> ${endVtt}${cueSettings ? ' ' + cueSettings : ''}\n${text}\n\n`;
  }
  return vtt;
}

// Sanitize WebVTT files generated from SRT or ffmpeg conversions to parse
// positioning tags (e.g. {\an8}, { n8}, {\pos(X,Y)}) and eliminate raw bracket tags.
function sanitizeAndEnhanceVtt(vttPath) {
  if (!fs.existsSync(vttPath)) return;
  const content = fs.readFileSync(vttPath, 'utf8');
  const lines = content.split(/\r?\n/);
  const outLines = [];
  let inCue = false;
  let currentTimingIdx = -1;
  let currentCueHasText = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('-->')) {
      if (inCue && !currentCueHasText && currentTimingIdx === outLines.length - 1) {
        outLines.pop();
      }
      outLines.push(line);
      currentTimingIdx = outLines.length - 1;
      inCue = true;
      currentCueHasText = false;
      continue;
    }
    if (!line.trim()) {
      if (inCue && !currentCueHasText && currentTimingIdx === outLines.length - 1) {
        outLines.pop();
      } else {
        outLines.push('');
      }
      inCue = false;
      currentTimingIdx = -1;
      currentCueHasText = false;
      continue;
    }

    if (inCue && currentTimingIdx !== -1) {
      let text = line;
      const anMatch = text.match(/(?:\{\\an(\d)\}|\{\s*n(\d)\})/);
      let posSettings = '';
      if (anMatch) {
        const alignNum = parseInt(anMatch[1] || anMatch[2], 10);
        if (alignNum !== 2) {
          let linePct = '90%';
          let posPct = '50%';
          let align = 'center';
          if (alignNum >= 7 && alignNum <= 9) linePct = '8%';
          else if (alignNum >= 4 && alignNum <= 6) linePct = '50%';
          else linePct = '90%';

          if (alignNum === 7 || alignNum === 4 || alignNum === 1) {
            posPct = '10%'; align = 'left';
          } else if (alignNum === 9 || alignNum === 6 || alignNum === 3) {
            posPct = '90%'; align = 'right';
          }
          posSettings = `line:${linePct} position:${posPct} align:${align}`;
        }
      }

      const posMatch = text.match(/\{\\pos\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)\}/);
      if (posMatch) {
        const x = parseFloat(posMatch[1]);
        const y = parseFloat(posMatch[2]);
        const xPct = Math.max(0, Math.min(100, (x / 1920) * 100)).toFixed(1);
        const yPct = Math.max(0, Math.min(100, (y / 1080) * 100)).toFixed(1);
        posSettings = `line:${yPct}% position:${xPct}% align:center`;
      }

      if (posSettings && !outLines[currentTimingIdx].includes('line:')) {
        outLines[currentTimingIdx] = `${outLines[currentTimingIdx].trim()} ${posSettings}`;
      }

      text = text.replace(/\\N/g, '\n').replace(/\\n/g, '\n');
      text = text.replace(/\{\\b1\}/gi, '<b>').replace(/\{\\b0\}/gi, '</b>');
      text = text.replace(/\{\\i1\}/gi, '<i>').replace(/\{\\i0\}/gi, '</i>');
      text = text.replace(/\{\\u1\}/gi, '<u>').replace(/\{\\u0\}/gi, '</u>');
      text = text.replace(/\{[^}]*\}/g, '').replace(/-->/g, '->');
      const subLines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (subLines.length > 0) {
        outLines.push(subLines.join('\n'));
        currentCueHasText = true;
      }
    } else {
      outLines.push(line);
    }
  }

  if (inCue && !currentCueHasText && currentTimingIdx === outLines.length - 1) {
    outLines.pop();
  }

  fs.writeFileSync(vttPath, outLines.join('\n'), 'utf8');
}

// ----------------------------------------------------------------------
// Built-in Pure Node.js Matroska (.mkv / .webm) EBML Subtitle Parser & Extractor
// Used automatically if ffprobe/ffmpeg are not installed on the server (ENOENT).
// ----------------------------------------------------------------------

function readVint(buf, offset, stripMarker = true) {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && (first & mask) === 0) {
    len++;
    mask >>= 1;
  }
  if (len > 8 || offset + len > buf.length) return null;
  let val = stripMarker ? (first & (mask - 1)) : first;
  let allOnes = (first & (mask - 1)) === (mask - 1);
  for (let i = 1; i < len; i++) {
    val = val * 256 + buf[offset + i];
    if (buf[offset + i] !== 0xff) allOnes = false;
  }
  if (stripMarker && allOnes) val = -1;
  return { value: val, length: len };
}

function readUint(buf, offset, len) {
  let val = 0;
  for (let i = 0; i < len; i++) {
    val = val * 256 + buf[offset + i];
  }
  return val;
}

function isMatroskaFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const b = Buffer.alloc(4);
    const n = fs.readSync(fd, b, 0, 4, 0);
    fs.closeSync(fd);
    return n === 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
  } catch (_) {
    return false;
  }
}

function parseMkvSubtitles(filePath, extractEvents = false) {
  if (!isMatroskaFile(filePath)) return [];
  const fd = fs.openSync(filePath, 'r');
  const fileSize = fs.fstatSync(fd).size;
  const hdrBuf = Buffer.alloc(24);

  function readAt(pos, len) {
    const safeLen = Math.min(len, Math.max(0, fileSize - pos));
    const b = Buffer.alloc(safeLen);
    if (safeLen > 0) fs.readSync(fd, b, 0, safeLen, pos);
    return b;
  }

  let timestampScale = 1000000;
  const subTracks = [];
  const trackByNum = new Map();

  function parseCompression(encodingsBuf) {
    let compAlgo = null;
    let compSettings = null;
    let p = 0;
    while (p < encodingsBuf.length) {
      const id = readVint(encodingsBuf, p, false);
      if (!id) break;
      const sz = readVint(encodingsBuf, p + id.length, true);
      if (!sz) break;
      const dStart = p + id.length + sz.length;
      const dEnd = sz.value < 0 ? encodingsBuf.length : Math.min(encodingsBuf.length, dStart + sz.value);
      const sub = encodingsBuf.subarray(dStart, dEnd);
      if (id.value === 0x6240 || id.value === 0x5034) {
        const inner = parseCompression(sub);
        if (inner.compAlgo !== null) compAlgo = inner.compAlgo;
        if (inner.compSettings !== null) compSettings = inner.compSettings;
      } else if (id.value === 0x4254) {
        compAlgo = readUint(sub, 0, sub.length);
      } else if (id.value === 0x4255) {
        compSettings = Buffer.from(sub);
      }
      p = dEnd;
    }
    return { compAlgo, compSettings };
  }

  function parseTracksElement(buf) {
    let pos = 0;
    let streamIdx = 0;
    while (pos < buf.length) {
      const id = readVint(buf, pos, false);
      if (!id) break;
      const size = readVint(buf, pos + id.length, true);
      if (!size) break;
      const dataStart = pos + id.length + size.length;
      const dataEnd = size.value < 0 ? buf.length : Math.min(buf.length, dataStart + size.value);
      if (id.value === 0xae) { // TrackEntry
        const entryBuf = buf.subarray(dataStart, dataEnd);
        let ePos = 0;
        let trackNum = 0, trackType = 0, codecId = '', lang = '', langBcp = '', name = '';
        let codecPrivate = Buffer.alloc(0);
        let compAlgo = null, compSettings = null;
        while (ePos < entryBuf.length) {
          const eid = readVint(entryBuf, ePos, false);
          if (!eid) break;
          const esize = readVint(entryBuf, ePos + eid.length, true);
          if (!esize) break;
          const eStart = ePos + eid.length + esize.length;
          const eEnd = esize.value < 0 ? entryBuf.length : Math.min(entryBuf.length, eStart + esize.value);
          const eData = entryBuf.subarray(eStart, eEnd);
          if (eid.value === 0xd7) trackNum = readUint(eData, 0, eData.length);
          else if (eid.value === 0x83) trackType = readUint(eData, 0, eData.length);
          else if (eid.value === 0x86) codecId = eData.toString('utf8').replace(/\0+$/, '');
          else if (eid.value === 0x22b59c) lang = eData.toString('utf8').replace(/\0+$/, '');
          else if (eid.value === 0x22b59d) langBcp = eData.toString('utf8').replace(/\0+$/, '');
          else if (eid.value === 0x536e) name = eData.toString('utf8').replace(/\0+$/, '');
          else if (eid.value === 0x63a2) codecPrivate = Buffer.from(eData);
          else if (eid.value === 0x6d80) {
            const c = parseCompression(eData);
            compAlgo = c.compAlgo;
            compSettings = c.compSettings;
          }
          ePos = eEnd;
        }
        // Only text subtitle codecs (S_TEXT/ASS, S_TEXT/SSA, S_TEXT/UTF8, S_TEXT/WEBVTT)
        if (trackType === 0x11 && (codecId.startsWith('S_TEXT') || codecId.includes('ASS') || codecId.includes('SSA') || codecId.includes('UTF8') || codecId.includes('WEBVTT'))) {
          let codec = 'subrip';
          if (codecId.includes('ASS') || codecId.includes('SSA')) codec = 'ass';
          else if (codecId.includes('WEBVTT')) codec = 'webvtt';
          const tObj = {
            trackNumber: trackNum,
            index: streamIdx,
            codec,
            codecId,
            language: (langBcp || lang || '').trim(),
            title: (name || '').trim(),
            codecPrivate: codecPrivate.toString('utf8'),
            compAlgo,
            compSettings,
            events: [],
          };
          subTracks.push(tObj);
          trackByNum.set(trackNum, tObj);
        }
        streamIdx++;
      }
      pos = dataEnd;
    }
  }

  function decodeBlockPayload(track, rawBuf) {
    let data = rawBuf;
    if (track.compAlgo === 0) {
      try { data = zlib.inflateSync(data); } catch (_) {}
    } else if (track.compAlgo === 3 && track.compSettings) {
      data = Buffer.concat([track.compSettings, data]);
    }
    return data.toString('utf8').replace(/\0+$/, '');
  }

  function handleBlock(blockBuf, clusterPts, durationTicks) {
    const trk = readVint(blockBuf, 0, true);
    if (!trk) return;
    const track = trackByNum.get(trk.value);
    if (!track) return;
    const hdrLen = trk.length + 3;
    if (blockBuf.length <= hdrLen) return;
    const relPts = blockBuf.readInt16BE(trk.length);
    const payload = decodeBlockPayload(track, blockBuf.subarray(hdrLen));
    const startSec = ((clusterPts + relPts) * timestampScale) / 1e9;
    const durSec = ((durationTicks || 3000) * timestampScale) / 1e9;
    const endSec = startSec + durSec;
    track.events.push({ startSec, endSec, payload });
  }

  function parseCluster(startPos, endPos) {
    let pos = startPos;
    let clusterPts = 0;
    while (pos < endPos) {
      const nRead = fs.readSync(fd, hdrBuf, 0, Math.min(24, endPos - pos), pos);
      if (nRead < 2) break;
      const id = readVint(hdrBuf, 0, false);
      if (!id) break;
      const size = readVint(hdrBuf, id.length, true);
      if (!size) break;
      const dataStart = pos + id.length + size.length;
      const dataEnd = size.value < 0 ? endPos : Math.min(endPos, dataStart + size.value);

      if (id.value === 0xe7) { // Timestamp
        const b = readAt(dataStart, dataEnd - dataStart);
        clusterPts = readUint(b, 0, b.length);
      } else if (id.value === 0xa3) { // SimpleBlock
        const peekOffset = id.length + size.length;
        const trk = peekOffset < nRead ? readVint(hdrBuf, peekOffset, true) : readVint(readAt(dataStart, 8), 0, true);
        if (trk && trackByNum.has(trk.value)) {
          const full = readAt(dataStart, dataEnd - dataStart);
          handleBlock(full, clusterPts, 3000);
        }
      } else if (id.value === 0xa0) { // BlockGroup
        // Scan inside BlockGroup without loading non-subtitle blocks
        let bp = dataStart;
        let blockBuf = null;
        let blockDur = 0;
        while (bp < dataEnd) {
          const bn = fs.readSync(fd, hdrBuf, 0, Math.min(24, dataEnd - bp), bp);
          if (bn < 2) break;
          const bid = readVint(hdrBuf, 0, false);
          if (!bid) break;
          const bsz = readVint(hdrBuf, bid.length, true);
          if (!bsz) break;
          const bStart = bp + bid.length + bsz.length;
          const bEnd = bsz.value < 0 ? dataEnd : Math.min(dataEnd, bStart + bsz.value);
          if (bid.value === 0xa1) { // Block
            const pOff = bid.length + bsz.length;
            const trk = pOff < bn ? readVint(hdrBuf, pOff, true) : readVint(readAt(bStart, 8), 0, true);
            if (trk && trackByNum.has(trk.value)) {
              blockBuf = readAt(bStart, bEnd - bStart);
            }
          } else if (bid.value === 0x9b) { // BlockDuration
            const dbuf = readAt(bStart, bEnd - bStart);
            blockDur = readUint(dbuf, 0, dbuf.length);
          }
          bp = bEnd;
        }
        if (blockBuf) {
          handleBlock(blockBuf, clusterPts, blockDur);
        }
      }
      pos = dataEnd;
    }
  }

  function scanContainer(startPos, endPos) {
    let pos = startPos;
    while (pos < endPos) {
      const nRead = fs.readSync(fd, hdrBuf, 0, Math.min(24, endPos - pos), pos);
      if (nRead < 2) break;
      const id = readVint(hdrBuf, 0, false);
      if (!id) break;
      const size = readVint(hdrBuf, id.length, true);
      if (!size) break;
      const dataStart = pos + id.length + size.length;
      const dataEnd = size.value < 0 ? endPos : Math.min(endPos, dataStart + size.value);

      if (id.value === 0x18538067) { // Segment
        scanContainer(dataStart, dataEnd);
      } else if (id.value === 0x1549a966) { // Info
        const infoBuf = readAt(dataStart, dataEnd - dataStart);
        let ip = 0;
        while (ip < infoBuf.length) {
          const iid = readVint(infoBuf, ip, false);
          if (!iid) break;
          const isz = readVint(infoBuf, ip + iid.length, true);
          if (!isz) break;
          const iStart = ip + iid.length + isz.length;
          const iEnd = iStart + isz.value;
          if (iid.value === 0x2ad7b1) {
            timestampScale = readUint(infoBuf, iStart, isz.value);
          }
          ip = iEnd;
        }
      } else if (id.value === 0x1654ae6b) { // Tracks
        const tracksBuf = readAt(dataStart, dataEnd - dataStart);
        parseTracksElement(tracksBuf);
        if (!extractEvents) return;
      } else if (id.value === 0x1f43b675) { // Cluster
        if (!extractEvents || subTracks.length === 0) break;
        parseCluster(dataStart, dataEnd);
      }
      pos = dataEnd;
    }
  }

  try {
    scanContainer(0, fileSize);
  } catch (err) {
    console.warn('Pure-JS MKV subtitle parser warning:', err.message);
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }

  return subTracks;
}

function buildVttFromMkvTrack(track, outVttPath) {
  if (track.codec === 'ass') {
    // Reconstruct full ASS file from CodecPrivate + Block events
    const sorted = [...track.events].sort((a, b) => a.startSec - b.startSec);
    let assText = track.codecPrivate || '[Script Info]\nPlayResX: 1920\nPlayResY: 1080\n';
    if (!assText.includes('[Events]')) {
      assText += '\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
    } else if (!/Format\s*:.*Start/i.test(assText.slice(assText.indexOf('[Events]')))) {
      assText += '\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
    }
    for (const ev of sorted) {
      // Matroska ASS block format: ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
      const c1 = ev.payload.indexOf(',');
      if (c1 === -1) continue;
      const rest = ev.payload.slice(c1 + 1);
      const c2 = rest.indexOf(',');
      if (c2 === -1) continue;
      const layer = rest.slice(0, c2).trim() || '0';
      const afterLayer = rest.slice(c2 + 1);
      assText += `Dialogue: ${layer},${secToAssTime(ev.startSec)},${secToAssTime(ev.endSec)},${afterLayer}\n`;
    }
    const vttContent = convertAssToVtt(assText);
    fs.writeFileSync(outVttPath, vttContent, 'utf8');
    return outVttPath;
  }

  // SRT / UTF8 / WebVTT track in MKV
  const sorted = [...track.events].sort((a, b) => a.startSec - b.startSec);
  let vtt = 'WEBVTT\n\n';
  for (const ev of sorted) {
    const text = (ev.payload || '').trim();
    if (!text) continue;
    vtt += `${secToVttTime(ev.startSec)} --> ${secToVttTime(ev.endSec)}\n${text}\n\n`;
  }
  fs.writeFileSync(outVttPath, vtt, 'utf8');
  try { sanitizeAndEnhanceVtt(outVttPath); } catch (_) {}
  return outVttPath;
}

// Probe a video file for embedded subtitle streams.
// Returns an array of { index, codec, language, title } for each subtitle track.
function probeSubtitleStreams(videoPath) {
  const ffprobeBin = getFfprobeBin();
  if (ffprobeBin) {
    try {
      const out = execFileSync(ffprobeBin, [
        '-v', 'error',
        '-show_streams',
        '-of', 'json',
        videoPath,
      ], { encoding: 'utf8', timeout: 30000 }).trim();
      if (out) {
        const parsed = JSON.parse(out);
        if (parsed && Array.isArray(parsed.streams)) {
          const subs = [];
          for (const s of parsed.streams) {
            if (s.codec_type !== 'subtitle') continue;
            const tags = s.tags || {};
            const lang = tags.language || tags.LANGUAGE || s.language || '';
            const title = tags.title || tags.TITLE || '';
            subs.push({
              index: s.index,
              codec: s.codec_name || '',
              language: String(lang).trim(),
              title: String(title).trim(),
            });
          }
          return subs;
        }
      }
    } catch (err) {
      console.warn(`ffprobe failed for ${videoPath}:`, err.message);
    }
  }

  // Fallback 1: parse ffmpeg -i output if ffmpeg is available
  const ffmpegBin = getFfmpegBin();
  if (ffmpegBin) {
    try {
      const res = spawnSync(ffmpegBin, ['-hide_banner', '-i', videoPath], { encoding: 'utf8', timeout: 15000 });
      const stderr = (res && res.stderr) || '';
      const subs = [];
      const lines = stderr.split(/\r?\n/);
      let currentSub = null;
      for (const line of lines) {
        const m = line.match(/^\s*Stream #0:(\d+)(?:\(([^)]+)\))?:\s*Subtitle:\s*([a-zA-Z0-9_]+)/);
        if (m) {
          if (currentSub) subs.push(currentSub);
          currentSub = {
            index: parseInt(m[1], 10),
            codec: m[3].toLowerCase(),
            language: (m[2] || '').trim(),
            title: '',
          };
          continue;
        }
        if (currentSub && /^\s*Stream #/.test(line)) {
          subs.push(currentSub);
          currentSub = null;
        } else if (currentSub) {
          const tm = line.match(/^\s*title\s*:\s*(.+)$/i);
          if (tm && !currentSub.title) currentSub.title = tm[1].trim();
        }
      }
      if (currentSub) subs.push(currentSub);
      if (subs.length > 0) return subs;
    } catch (_) {}
  }

  // Fallback 2: Pure Node.js Matroska (.mkv / .webm) EBML subtitle prober
  if (isMatroskaFile(videoPath)) {
    const mkvTracks = parseMkvSubtitles(videoPath, false);
    return mkvTracks.map((t) => ({
      index: t.index,
      codec: t.codec,
      language: t.language,
      title: t.title,
    }));
  }

  return [];
}

// Extract a single subtitle stream to a WebVTT file alongside the video.
function extractSubtitleToVtt(videoPath, streamIndex, outDir, codec) {
  const base = path.basename(videoPath, path.extname(videoPath));
  const vttName = `${base}.s${streamIndex}.vtt`;
  const vttPath = path.join(outDir, vttName);

  const ffmpegBin = getFfmpegBin();
  if (ffmpegBin) {
    const isAss = codec === 'ass' || codec === 'ssa';
    if (isAss) {
      const assName = `${base}.s${streamIndex}.ass`;
      const assPath = path.join(outDir, assName);
      try {
        execFileSync(ffmpegBin, [
          '-y',
          '-i', videoPath,
          '-map', `0:s:${streamIndex}`,
          '-c:s', 'copy',
          assPath,
        ], { encoding: 'utf8', timeout: 120000, stdio: 'pipe' });

        if (fs.existsSync(assPath)) {
          const assContent = fs.readFileSync(assPath, 'utf8');
          try { fs.unlinkSync(assPath); } catch (_) {}
          const vttContent = convertAssToVtt(assContent);
          if (vttContent && vttContent.includes('-->')) {
            fs.writeFileSync(vttPath, vttContent, 'utf8');
            return vttPath;
          }
        }
      } catch (err) {
        console.warn(`ASS lossless extraction failed for stream ${streamIndex}, falling back to ffmpeg webvtt:`, err.message);
      }
    }

    let extractionDone = false;
    try {
      execFileSync(ffmpegBin, [
        '-y',
        '-i', videoPath,
        '-map', `0:s:${streamIndex}`,
        '-c:s', 'webvtt',
        vttPath,
      ], { encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
      extractionDone = fs.existsSync(vttPath);
    } catch (err) {
      console.warn(`ffmpeg -map 0:s:${streamIndex} failed, trying stream index fallback:`, err.message);
    }

    if (!extractionDone) {
      try {
        execFileSync(ffmpegBin, [
          '-y',
          '-i', videoPath,
          '-map', `0:${streamIndex}`,
          '-c:s', 'webvtt',
          vttPath,
        ], { encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
      } catch (err2) {
        console.error(`ffmpeg fallback -map 0:${streamIndex} failed:`, err2.message);
      }
    }

    if (fs.existsSync(vttPath)) {
      try {
        sanitizeAndEnhanceVtt(vttPath);
      } catch (err) {
        console.warn(`sanitizeAndEnhanceVtt warning: ${err.message}`);
      }
      return vttPath;
    }
  }

  // Pure Node.js Matroska fallback when ffmpeg is not installed on the server
  if (isMatroskaFile(videoPath)) {
    const mkvTracks = parseMkvSubtitles(videoPath, true);
    const target = mkvTracks[streamIndex] || mkvTracks.find((t) => t.index === streamIndex);
    if (target) {
      return buildVttFromMkvTrack(target, vttPath);
    }
  }

  throw new Error(`Could not extract subtitle ${vttName} (ffmpeg not found and fallback unavailable)`);
}

// Map common 3-letter ISO 639-2/B language codes to ISO 639-1 codes.
function mapLanguageCode(code) {
  if (!code) return '';
  const table = {
    eng: 'en', eng_usa: 'en-US', eng_gb: 'en-GB',
    spa: 'es', spa_us: 'es-US', fra: 'fr', fre: 'fr',
    deu: 'de', ger: 'de', ita: 'it', ita_us: 'it-US',
    jpn: 'ja', chn: 'zh', cmn: 'zh', zho: 'zh',
    kor: 'ko', dan: 'da', dut: 'nl', nld: 'nl',
    rus: 'ru', pol: 'pl', swe: 'sv', fin: 'fi',
    nor: 'no', tur: 'tr', heb: 'he', ara: 'ar',
    cat: 'ca', glg: 'gl', afr: 'af', vie: 'vi',
    th: 'th', tha: 'th', ind: 'id', msa: 'ms', fil: 'fil',
    por: 'pt', pt_br: 'pt-BR', pt_pt: 'pt-PT',
    ces: 'cs', cze: 'cs', slk: 'sk', slv: 'sl',
    est: 'et', lav: 'lv', lit: 'lt',
    hrv: 'hr', bos: 'bs', srp: 'sr', srp_latn: 'sr-Latn',
    rum: 'ro', ron: 'ro', mac: 'mk', mkd: 'mk',
    sqi: 'sq', alb: 'sq', hun: 'hu', ell: 'el',
  };
  const key = code.toLowerCase();
  return table[key] || code;
}

// Human-readable label for a language code (ISO 639-1 or normalized).
function langLabel(langCode) {
  const names = {
    en: 'English', 'en-US': 'English (US)', 'en-GB': 'English (UK)',
    es: 'Spanish', 'es-US': 'Spanish (US)', fr: 'French', de: 'German',
    it: 'Italian', 'it-US': 'Italian (US)', ja: 'Japanese', zh: 'Chinese',
    ko: 'Korean', da: 'Danish', nl: 'Dutch', ru: 'Russian', pl: 'Polish',
    sv: 'Swedish', fi: 'Finnish', no: 'Norwegian', tr: 'Turkish', he: 'Hebrew',
    ar: 'Arabic', ca: 'Catalan', gl: 'Galician', af: 'Afrikaans', vi: 'Vietnamese',
    th: 'Thai', id: 'Indonesian', ms: 'Malay', fil: 'Filipino',
    pt: 'Portuguese', 'pt-BR': 'Portuguese (Brazil)', 'pt-PT': 'Portuguese (Portugal)',
    cs: 'Czech', sk: 'Slovak', sl: 'Slovenian', et: 'Estonian', lv: 'Latvian',
    lt: 'Lithuanian', hr: 'Croatian', bs: 'Bosnian', sr: 'Serbian', 'sr-Latn': 'Serbian (Latin)',
    ro: 'Romanian', mk: 'Macedonian', sq: 'Albanian', hu: 'Hungarian', el: 'Greek',
  };
  return names[langCode] || langCode.toUpperCase() || '';
}

// Build a human-readable label for a subtitle track.
function labelForTrack(streams, s, subIndex) {
  const lang = mapLanguageCode(s.language);
  const langName = langLabel(lang);
  let baseLabel = '';

  if (s.title) {
    baseLabel = s.title;
    if (langName && !s.title.toLowerCase().includes(langName.toLowerCase())) {
      return `${s.title} (${langName})`;
    }
    return baseLabel;
  }

  if (langName && langName !== lang.toUpperCase()) return langName;
  if (lang && lang.toUpperCase() !== lang) return lang.toUpperCase();
  return `Subtitle ${subIndex + 1}`;
}

// After a video is uploaded, probe and extract all subtitle tracks.
// Persist the metadata on the room row. Returns the list of track objects.
function extractAndPersistSubtitles(videoPath, roomId) {
  const outDir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  const ffmpegBin = getFfmpegBin();

  // Fast single-pass path when ffmpeg is not installed and file is Matroska (.mkv/.webm)
  if (!ffmpegBin && isMatroskaFile(videoPath)) {
    const mkvTracks = parseMkvSubtitles(videoPath, true);
    if (mkvTracks.length === 0) {
      db.prepare('UPDATE rooms SET subtitles = NULL WHERE id = ?').run(roomId);
      return [];
    }
    const tracks = [];
    let subIndex = 0;
    for (const mt of mkvTracks) {
      const vttName = `${base}.s${subIndex}.vtt`;
      const vttPath = path.join(outDir, vttName);
      try {
        buildVttFromMkvTrack(mt, vttPath);
        const lang = mapLanguageCode(mt.language);
        const label = labelForTrack(mkvTracks, mt, subIndex);
        tracks.push({
          index: mt.index,
          subIndex,
          srclang: lang,
          label,
          vttPath,
        });
      } catch (err) {
        console.error(`Pure-JS MKV subtitle extraction failed for stream ${mt.index}:`, err.message);
      }
      subIndex++;
    }
    db.prepare('UPDATE rooms SET subtitles = ? WHERE id = ?').run(
      tracks.length > 0 ? JSON.stringify(tracks) : null,
      roomId
    );
    return tracks;
  }

  const streams = probeSubtitleStreams(videoPath);
  if (streams.length === 0) {
    db.prepare('UPDATE rooms SET subtitles = NULL WHERE id = ?').run(roomId);
    return [];
  }

  const tracks = [];
  let subIndex = 0;

  for (const s of streams) {
    let vttPath;
    try {
      vttPath = extractSubtitleToVtt(videoPath, subIndex, outDir, s.codec);
    } catch (err) {
      console.error(`Failed to extract subtitle stream ${s.index} for room ${roomId}:`, err.message);
      subIndex++;
      continue;
    }
    const lang = mapLanguageCode(s.language);
    const label = labelForTrack(streams, s, subIndex);
    tracks.push({
      index: s.index,
      subIndex,
      srclang: lang,
      label,
      vttPath,
    });
    subIndex++;
  }

  if (tracks.length === 0) {
    db.prepare('UPDATE rooms SET subtitles = NULL WHERE id = ?').run(roomId);
    return [];
  }

  db.prepare('UPDATE rooms SET subtitles = ? WHERE id = ?').run(
    JSON.stringify(tracks),
    roomId,
  );
  return tracks;
}

module.exports = {
  probeSubtitleStreams,
  convertAssToVtt,
  sanitizeAndEnhanceVtt,
  extractSubtitleToVtt,
  extractAndPersistSubtitles,
};
