// 工作面板第 3 列那一整块（officezone）：把一个文件夹里的办公文档列出来，点开交给系统默认程序。
//
// 两条纪律和 trainers 那条一样：
// 1) 渲染层永远拿不到「给我一个路径我帮你打开」的口子。列表由主进程扫出来后缓存在这里，
//    打开/定位只认这次缓存里的 id；文件夹路径只从 config.office 读，不从渲染层接。
// 2) 扫描是同步 fs，但只在缓存过期（60 秒）、改了文件夹或显式点「重扫」时跑；切面板不会重扫。
//
// 收哪些后缀：Word（doc/docx/docm）、Excel（xls/xlsx/xlsm/csv）、PPT（ppt/pptx/pptm）、PDF。
// 带宏的 .docm/.xlsm/.pptm 和正本同族，Office 一样打得开，没有理由挡；
// .odt/.pages/.numbers 这类本机没装对应软件、点开只会「没有应用」的后缀不收。
// 另外挡掉 Office 自己写的锁文件：同目录里那份「~$预算表.xlsx」是打开时生成的临时属主文件，
// 只有几百字节，点开只会报错，列表里出现一次就让人怀疑一次。

const fs = require('node:fs');
const path = require('node:path');
const { shell } = require('electron');
const { redactPaths } = require('./spawn-result');

const CACHE_TTL_MS = 60000;
const DOUBLE_CLICK_GUARD_MS = 3000;
const MAX_DEPTH = 4;
const DEFAULT_LIMIT = 300;
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git', '.onedrive', 'onedatacache']);
// Office 的属主/临时文件：~ 开头且以 $ 结尾前缀都算（~$xxx 是文档锁，~WRS{...}.tmp 是自动恢复）
const LOCK_RE = /^~[$]/;

const KIND = {
  word: { label: '文档', exts: ['.doc', '.docx', '.docm'] },
  sheet: { label: '表格', exts: ['.xls', '.xlsx', '.xlsm', '.csv'] },
  slides: { label: '演示', exts: ['.ppt', '.pptx', '.pptm'] },
  pdf: { label: 'PDF', exts: ['.pdf'] }
};

// 后缀 → 类别。反查表在模块级建一次，扫描循环里只做一次 Map.get。
const EXT_TO_KIND = new Map();
for (const [kind, def] of Object.entries(KIND)) {
  for (const ext of def.exts) EXT_TO_KIND.set(ext, kind);
}

function kindLabel(kind) {
  return KIND[kind]?.label || '文档';
}

function readableDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

function walk(dir, recursive, depth, out, limit) {
  const entries = readableDir(dir);
  if (!entries) return;
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  for (const entry of entries) {
    if (out.length >= limit) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive && depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name.toLowerCase())) walk(full, recursive, depth + 1, out, limit);
      continue;
    }
    if (!entry.isFile()) continue;
    if (LOCK_RE.test(entry.name)) continue;
    const ext = path.extname(entry.name).toLowerCase();
    const kind = EXT_TO_KIND.get(ext);
    if (!kind) continue;
    let stat = null;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    out.push({
      // id 是小写全路径：Windows 不分大小写，同一份文件从两个根扫到也只算一条
      id: full.toLowerCase(),
      path: full,
      folder: dir,
      dir: path.basename(dir),
      file: entry.name,
      ext: ext.replace('.', ''),
      kind,
      kindLabel: kindLabel(kind),
      title: path.basename(entry.name, path.extname(entry.name)),
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs / 1000)
    });
  }
}

class Office {
  constructor({ getConfig, openPath, revealPath } = {}) {
    this.getConfig = getConfig;
    // 自检注入替身：openPath / showItemInFolder 会真的把 Word、资源管理器拉起来，
    // 跑自检的机器上不该出现那种窗口，所以这两条走注入。
    this.openPath = openPath || ((target) => shell.openPath(target));
    this.revealPath = revealPath || ((target) => shell.showItemInFolder(target));
    this.items = [];
    this.byKey = new Map();
    this.folder = null;
    this.scannedAt = 0;
    this.lastOpen = { id: null, at: 0 };
  }

  folderPath() {
    return String(this.getConfig()?.office?.folder || '').trim();
  }

  // 「没东西可看」的五句话各说各的：没配置 / 写错成相对路径 / 目录没了 / 不是目录 / 目录读不了。
  // 合成一句「打不开」的话，他得自己猜是哪一个。
  scan(force = false) {
    const folder = this.folderPath();
    if (!folder) return { folder, items: [], error: '还没配置办公文档文件夹（设置 → 办公文档 → 文件夹）' };
    if (!path.isAbsolute(folder)) return { folder, items: [], error: `文件夹路径要写绝对路径：${folder}` };
    // 改了文件夹必须重扫：缓存是按 folder 记的，换根就等于缓存作废，不能让他点「重扫」才看见新目录
    if (this.folder === folder && !force && Date.now() - this.scannedAt < CACHE_TTL_MS) {
      return { folder, items: this.items, cached: true };
    }

    let stat = null;
    try {
      stat = fs.statSync(folder);
    } catch (err) {
      return { folder, items: [], error: `文件夹不存在或不可读（${err.code || err.message}）` };
    }
    if (!stat.isDirectory()) return { folder, items: [], error: '所选路径不是文件夹' };
    // 顶层读不动就是没权限；这条必须在 walk 之前——walk 里读不到目录是静悄悄跳过的，
    // 放在它后面只会得到「没有 Word 文件」那句，把权限问题说成空文件夹。
    if (!readableDir(folder)) return { folder, items: [], error: '没有读取权限' };

    const limit = Number(this.getConfig()?.office?.limit) > 0 ? Number(this.getConfig().office.limit) : DEFAULT_LIMIT;
    const recursive = this.getConfig()?.office?.recursive !== false;
    const found = [];
    walk(folder, recursive, 0, found, limit);

    // 和相册一样按修改时间倒序：办公这块看的就是「最近动过的那份」，同秒再按路径保证顺序稳定
    found.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    this.items = found;
    this.byKey = new Map(found.map((item) => [item.id, item]));
    this.folder = folder;
    this.scannedAt = Date.now();
    // 这一份是带 `path` 的：一格一个文档，悬停提示要写明它在哪个子目录（递归扫的时候 dir 才是区分点）。
    // 这是**只出不进**——渲染层能显示路径，但打开/定位只认 id，任何它递回来的路径都不接。
    // `empty` 只有这一条有：扫成功了、里面就是没有文档，和上面那五种「压根没扫成」不是一件事，
    // 计数牌要能分辨（把正常空文件夹说成「未就绪」等于报了一个假故障）。
    return { folder, items: this.items, empty: !found.length, error: found.length ? null : '该文件夹里没有 Word / Excel / PPT / PDF 文件' };
  }

  // 只认缓存里那批 id：渲染层递来任何路径都不接，过期就让它去刷新
  pick(id) {
    const key = typeof id === 'string' ? id.toLowerCase() : '';
    return this.byKey.get(key) || null;
  }

  async open(id) {
    const item = this.pick(id);
    if (!item) return { ok: false, error: '列表已过期，请点「重扫」' };
    if (this.lastOpen.id === item.id && Date.now() - this.lastOpen.at < DOUBLE_CLICK_GUARD_MS) {
      return { ok: false, error: '刚刚已经点开过同一个，等它起来' };
    }
    this.lastOpen = { id: item.id, at: Date.now() };

    // openPath 回一个字符串：空串是成功，其余是系统原话（「没有应用打得开这种文件」之类）。
    // 原话里带路径的要洗掉——渲染层那句提示不该出现盘符。
    let message = '';
    try {
      message = String(await this.openPath(item.path)) || '';
    } catch (err) {
      return { ok: false, error: redactPaths(err?.message) || '打开失败' };
    }
    if (message) return { ok: false, error: redactPaths(message) || '打开失败' };
    return { ok: true, name: item.title, kind: item.kind };
  }

  reveal(id) {
    const item = this.pick(id);
    if (!item) return { ok: false, error: '列表已过期，请点「重扫」' };
    this.revealPath(item.path);
    return { ok: true };
  }

  status() {
    return { folder: this.folderPath(), count: this.items.length, scannedAt: this.scannedAt };
  }
}

module.exports = { Office, KIND, kindLabel, EXT_TO_KIND, CACHE_TTL_MS, DEFAULT_LIMIT };
