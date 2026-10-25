const fs = require('node:fs');
const path = require('node:path');

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.wma']);
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git']);

function titleFromBase(base) {
  const cleaned = base.replace(/^\d{1,3}\s*[.)\]-]\s*/, '').trim();
  const parts = cleaned.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { artist: '', title: cleaned || base };
}

function walk(dir, recursive, depth, out, limit) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive && depth < 4 && !SKIP_DIRS.has(entry.name.toLowerCase())) walk(full, recursive, depth + 1, out, limit);
      continue;
    }
    if (!AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    const base = path.basename(entry.name, path.extname(entry.name));
    const { artist, title } = titleFromBase(base);
    const lyricPath = path.join(dir, `${base}.lrc`);
    out.push({
      id: full.toLowerCase(),
      path: full,
      folder: dir,
      file: entry.name,
      artist,
      title,
      album: path.basename(dir),
      hasLyrics: fs.existsSync(lyricPath) ? lyricPath : null
    });
  }
}

function scan(folder, { recursive = true, limit = 1200 } = {}) {
  if (!folder) return { tracks: [], error: '未设置音乐文件夹' };
  let stat = null;
  try {
    stat = fs.statSync(folder);
  } catch {
    return { tracks: [], error: `文件夹不存在：${folder}` };
  }
  if (!stat.isDirectory()) return { tracks: [], error: '所选路径不是文件夹' };
  const tracks = [];
  walk(folder, recursive, 0, tracks, limit);
  tracks.sort((a, b) => `${a.artist} ${a.title}`.localeCompare(`${b.artist} ${b.title}`, 'zh-Hans-CN'));
  return { tracks, error: tracks.length ? null : '该文件夹里没有支持的音频文件' };
}

const TIME_TAG = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

function parseLrc(text) {
  const cues = [];
  for (const line of String(text).split(/\r?\n/)) {
    const tags = [...line.matchAll(TIME_TAG)];
    if (!tags.length) continue;
    const content = line.replace(TIME_TAG, '').trim();
    if (!content) continue;
    for (const tag of tags) {
      const ms = Number(tag[3] ? `0.${tag[3]}` : 0);
      cues.push({ time: Number(tag[1]) * 60 + Number(tag[2]) + ms, text: content });
    }
  }
  return cues.sort((a, b) => a.time - b.time);
}

function lyricsFor(track) {
  if (!track?.hasLyrics) return [];
  try {
    return parseLrc(fs.readFileSync(track.hasLyrics, 'utf8'));
  } catch {
    return [];
  }
}

const MIME = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma'
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

module.exports = { scan, lyricsFor, parseLrc, mimeFor, AUDIO_EXT };
