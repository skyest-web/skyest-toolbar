// 本地照片库：扫一个文件夹里的图片文件，只读。
//
// 和 video.js 同一套规矩——路径只从 config 来、渲染层拿不到 fs、四种「没东西可看」的文案各说各的。
// 唯一不同的是取图的方式：图片直接用 file:/// 交给 <img>（CSP 的 img-src 里本来就放了 file:，
// 游戏列表的图标一直是这么来的），不需要 track://。那条自定义协议是为**媒体元素**准备的——
// <audio>/<video> 走 file:// 会被跨源策略挡住，<img> 不会。
//
// 只收 Chromium 真解得动的位图：jpg / jpeg / png / webp / avif / gif / bmp。
// .heic（iPhone 默认格式）浏览器解不了，收进来就是一张破图，所以不收；
// .svg 是矢量，不是「照片」，也不收。
const fs = require('node:fs');
const path = require('node:path');

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.bmp']);
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git']);

// 渲染层拿到的是地址，不是路径。整串自己拼，不交给 new URL：
// 它把 # 当锚点、? 当查询串，后面那截直接丢（「2024 #1.png」只剩「2024 」），落单的 % 它又不补全。
// 按 / 拆开逐段 encodeURIComponent 才是对的形状；盘符那个冒号编回原样，否则 file:///D%3A/ 开不出来。
function fileUrl(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const encode = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ':');
  // \\nas\共享\目录\x.png：主机名要待在 host 位才是 file://nas/共享/... 那个连得上的形状。
  // 开头那对反斜杠变成斜杠之后会拆出两个空段，所以主机名在下标 2，不是 1。
  if (normalized.startsWith('//')) {
    const [, , host, ...rest] = normalized.split('/').map(encode);
    return `file://${host}/${rest.join('/')}`;
  }
  const body = normalized.split('/').map(encode).join('/');
  return normalized.startsWith('/') ? `file://${body}` : `file:///${body}`;
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
    if (!PHOTO_EXT.has(ext)) continue;
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
      url: fileUrl(full),
      folder: dir,
      dir: path.basename(dir),
      file: entry.name,
      ext: ext.replace('.', ''),
      // 照片不像剧集有「集数」可剥，相机名（IMG_20240601_…）本身就是他认得的东西，原样留着
      title: path.basename(entry.name, path.extname(entry.name)),
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs / 1000)
    });
  }
}

// 照片墙要的是「最近拍的在最前面」，所以按修改时间倒序；同一秒内再按名字，保证顺序稳定
function scan(folder, { recursive = true, limit = 400 } = {}) {
  if (!folder) return { photos: [], error: '未设置照片文件夹' };
  let stat = null;
  try {
    stat = fs.statSync(folder);
  } catch {
    return { photos: [], error: `文件夹不存在：${folder}` };
  }
  if (!stat.isDirectory()) return { photos: [], error: '所选路径不是文件夹' };
  const photos = [];
  walk(folder, recursive, 0, photos, limit);
  photos.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  return { photos, error: photos.length ? null : '该文件夹里没有能显示的图片' };
}

module.exports = { scan, fileUrl, PHOTO_EXT };
