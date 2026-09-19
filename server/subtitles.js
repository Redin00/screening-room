const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('./db');

// Probe a video file for embedded subtitle streams.
// Returns an array of { index, codec, language } for each subtitle track.
// Uses JSON output (not CSV) so column ordering is unambiguous across ffprobe
// versions — older/newer builds may emit CSV columns in different orders.
function probeSubtitleStreams(videoPath) {
  let out;
  try {
    out = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=index,codec_type,codec_name,language',
      '-of', 'json',
      videoPath,
    ], { encoding: 'utf8', timeout: 30000 }).trim();
  } catch (err) {
    // ffprobe failed — treat as no subs.
    return [];
  }
  if (!out) return [];

  let parsed;
  try { parsed = JSON.parse(out); } catch (_) { return []; }
  if (!parsed || !Array.isArray(parsed.streams)) return [];

  const subs = [];
  for (const s of parsed.streams) {
    if (s.codec_type !== 'subtitle') continue;
    subs.push({
      index: s.index,
      codec: s.codec_name || '',
      language: (s.language || '').trim() || '',
    });
  }
  return subs;
}

// Extract a single subtitle stream to a WebVTT file alongside the video.
// Returns the absolute VTT path, or throws.
function extractSubtitleToVtt(videoPath, streamIndex, outDir) {
  const base = path.basename(videoPath, path.extname(videoPath));
  const vttName = `${base}.s${streamIndex}.vtt`;
  const vttPath = path.join(outDir, vttName);
  // Use -map 0:s:N to pull just this subtitle stream (N = subtitle-stream
  // index, i.e. 0-based position within the subtitle streams only), and
  // transcode to WebVTT. The overall stream index (e.g. 2 for an MKV with
  // video=0, audio=1, subs=2) must NOT be used here — 0:s:2 would look for
  // the third subtitle stream, not the stream at overall position 2.
  execFileSync('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-map', `0:s:${streamIndex}`,
    '-c:s', 'webvtt',
    vttPath,
  ], { encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
  if (!fs.existsSync(vttPath)) {
    throw new Error(`ffmpeg did not produce ${vttName}`);
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
    tha: 'th', ind: 'id', msa: 'ms', fil: 'fil',
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
  if (langName && langName !== lang.toUpperCase()) return langName;
  if (lang && lang.toUpperCase() !== lang) return lang.toUpperCase();
  // Fallback: Subtitle N (1-based, by subtitle-stream order).
  return `Subtitle ${subIndex + 1}`;
}

// After a video is uploaded, probe and extract all subtitle tracks.
// Persist the metadata on the room row. Returns the list of track objects.
function extractAndPersistSubtitles(videoPath, roomId) {
  const streams = probeSubtitleStreams(videoPath);
  if (streams.length === 0) {
    // Clear any previously stored subtitle metadata for this room.
    db.prepare('UPDATE rooms SET subtitles = NULL WHERE id = ?').run(roomId);
    return [];
  }

  const outDir = path.dirname(videoPath);
  const tracks = [];
  let subIndex = 0; // 0-based index within the subtitle streams (for -map 0:s:N)

  for (const s of streams) {
    let vttPath;
    try {
      vttPath = extractSubtitleToVtt(videoPath, subIndex, outDir);
    } catch (err) {
      console.error(`Failed to extract subtitle stream ${s.index} for room ${roomId}:`, err.message);
      subIndex++;
      continue;
    }
    const lang = mapLanguageCode(s.language);
    const label = labelForTrack(streams, s, subIndex);
    tracks.push({
      index: s.index,
      subIndex, // 0-based subtitle-stream index (for VTT file naming)
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

module.exports = { probeSubtitleStreams, extractSubtitleToVtt, extractAndPersistSubtitles };
