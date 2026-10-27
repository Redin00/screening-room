const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('./db');

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
      // Non-standard alignment (top, mid, or left/right)
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
    // Note: if alignNum === 2 (standard bottom dialogue), cueSettings is empty,
    // allowing native WebVTT layout to handle automatic line stacking without collision!

    text = text.replace(/\\N/g, '\n').replace(/\\n/g, '\n');
    text = text.replace(/\{\\b1\}/gi, '<b>').replace(/\{\\b0\}/gi, '</b>');
    text = text.replace(/\{\\i1\}/gi, '<i>').replace(/\{\\i0\}/gi, '</i>');
    text = text.replace(/\{\\u1\}/gi, '<u>').replace(/\{\\u0\}/gi, '</u>');
    // Remove all remaining ASS override tags like {\...}
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

// Probe a video file for embedded subtitle streams.
// Returns an array of { index, codec, language, title } for each subtitle track.
function probeSubtitleStreams(videoPath) {
  let out;
  try {
    out = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_streams',
      '-of', 'json',
      videoPath,
    ], { encoding: 'utf8', timeout: 30000 }).trim();
  } catch (err) {
    console.error(`ffprobe failed for ${videoPath}:`, err.message);
    return [];
  }
  if (!out) return [];

  let parsed;
  try { parsed = JSON.parse(out); } catch (_) { return []; }
  if (!parsed || !Array.isArray(parsed.streams)) return [];

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

// Extract a single subtitle stream to a WebVTT file alongside the video.
// If the stream is ASS/SSA, attempts lossless copy and exact WebVTT generation
// to preserve positioning tags, sign placements, and alignments.
function extractSubtitleToVtt(videoPath, streamIndex, outDir, codec) {
  const base = path.basename(videoPath, path.extname(videoPath));
  const vttName = `${base}.s${streamIndex}.vtt`;
  const vttPath = path.join(outDir, vttName);

  const isAss = codec === 'ass' || codec === 'ssa';
  if (isAss) {
    const assName = `${base}.s${streamIndex}.ass`;
    const assPath = path.join(outDir, assName);
    try {
      execFileSync('ffmpeg', [
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

  // Fallback or non-ASS subtitle streams
  let extractionDone = false;
  try {
    execFileSync('ffmpeg', [
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
      execFileSync('ffmpeg', [
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

  if (!fs.existsSync(vttPath)) {
    throw new Error(`ffmpeg did not produce ${vttName}`);
  }

  // Clean and sanitize any formatting/positioning tags
  try {
    sanitizeAndEnhanceVtt(vttPath);
  } catch (err) {
    console.warn(`sanitizeAndEnhanceVtt warning: ${err.message}`);
  }

  return vttPath;
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
    th: 'th', ind: 'id', msa: 'ms', fil: 'fil',
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
  const streams = probeSubtitleStreams(videoPath);
  if (streams.length === 0) {
    db.prepare('UPDATE rooms SET subtitles = NULL WHERE id = ?').run(roomId);
    return [];
  }

  const outDir = path.dirname(videoPath);
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

