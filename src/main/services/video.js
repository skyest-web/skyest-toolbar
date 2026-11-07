// 本地视频库：扫一个文件夹里的视频文件，只读。
//
// 和 music.js 同一套规矩——路径只从 config 来、渲染层拿不到 fs、播放走 track:// 那个自定义协议
// （音频视频共用一个 handler：分段响应是手写的，缺 Content-Length 时 Chromium 把 duration 报成 Infinity）。
//
// 只收 Chromium 真能解的容器：mp4 / m4v / mov（H.264 + AAC，走 Electron 自带 ffmpeg）、webm（VP8/VP9/AV1）、
// mkv（容器认，里面是 H.264 才放得动）。.avi / .flv / .wmv 这些解不了，扫进来也是给用户一个黑屏，所以不收。
const fs = require('node:fs');
const path = require('node:path');

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv']);
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git']);

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska'
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// 文件名前那段「01.」「03 -」是下载时带的集数，列表里碍事；扩展名本来也不该显示在标题上
function titleFromBase(base) {
  const cleaned = base.replace(/^\d{1,3}\s*[.)\]-]\s*/, '').trim();
  return cleaned || base;
}

function walk(dir, recursive, depth, out, limit) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  for (const entry of entries) {
    if (out.length >= limit) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive && depth < 4 && !SKIP_DIRS.has(entry.name.toLowerCase())) walk(full, recursive, depth + 1, out, limit);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!VIDEO_EXT.has(ext)) continue;
    let stat = null;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    out.push({
      id: full.toLowerCase(),
      path: full,
      folder: dir,
      dir: path.basename(dir),
      file: entry.name,
      ext: ext.replace('.', ''),
      title: titleFromBase(path.basename(entry.name, path.extname(entry.name))),
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs / 1000)
    });
  }
}

function scan(folder, { recursive = true, limit = 400 } = {}) {
  if (!folder) return { clips: [], error: '未设置视频文件夹' };
  let stat = null;
  try {
    stat = fs.statSync(folder);
  } catch {
    return { clips: [], error: `文件夹不存在：${folder}` };
  }
  if (!stat.isDirectory()) return { clips: [], error: '所选路径不是文件夹' };
  const clips = [];
  walk(folder, recursive, 0, clips, limit);
  clips.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  return { clips, error: clips.length ? null : '该文件夹里没有可播放的视频文件' };
}

module.exports = { scan, mimeFor, VIDEO_EXT };
