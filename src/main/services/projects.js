// 工作面板左下那一格（骨架里的 player 位置）：每个仓库根目录下的顶层文件夹算一个项目，
// 点开把项目路径交给对应的 JetBrains IDE。git 格（同一面板 clock 那一格）吃的是这里扫出来的同一批行。
//
// 三件事都留在主进程：
// 1) 用哪个 IDE —— 按项目里已有的标记文件判，判序见 RULES；本机装了哪几个由 findBinDir 现扫，
//    不写死一条安装路径（Program Files、D 盘、Toolbox 三种装法都认）。
// 2) 上次动过 —— 有 git 的读 .git/logs/HEAD 最后一行的时间戳。改一个源文件不会动项目目录自身的
//    mtime（只有增删顶层条目才动），光看目录会长期报「几天前」，那一格就失去意义了。
// 3) 启动 —— spawn(<ide>64.exe, [<项目路径>])。JetBrains 的 launcher 收到路径会自己并进已经开着的
//    那个实例，不用我们找窗口；代价是边界要说清：我们只保证"把这个路径交给了 <IDE>"，
//    IDE 里那个项目真开起来了没有，这里看不到（和 steam://rungameid 同一条边界）。
//
// 纪律照 steam / trainers 那两条：渲染层只递 id。IDE 的 exe 路径不进列表行、不跨 IPC；
// 项目目录路径只用于「在资源管理器里打开这一格」和悬浮说明，启动不接受渲染层递进来的任何字符串。
// openFile（git 格点改动文件）是唯一收到路径的那扇门，但那个路径是主进程自己拼的绝对路径，
// 而且落 spawn 参数位之前还要过 insideDir——渲染层那一侧照样只能递 id 和序号。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { shell } = require('electron');
const { spawnResult, explainSpawnError } = require('./spawn-result');

// 兜底用的根目录：配置里 repos.roots 给了就用配置的（项目格和 git 格共用这一份），
// 只有这段配置整个不存在时才回这里。自检脚本用构造参数把它指到临时目录。
const DEFAULT_ROOT = 'D:\\GitProject';
const CACHE_TTL_MS = 60000;
const GUARD_MS = 4000;
// 回收站和卷信息只有在根目录被指到整盘时才会出现；点开头的都当不是项目
const SKIP_DIR_RE = /^[.$]/;
// reflog 一行几十到几百字节，读尾部 4KB 足够拿到最后一条
const REFLOG_TAIL_BYTES = 4096;
const MAX_IML_FILES = 4;

const PRODUCTS = [
  { id: 'datagrip', label: 'DataGrip', exe: 'datagrip64.exe' },
  { id: 'pycharm', label: 'PyCharm', exe: 'pycharm64.exe' },
  { id: 'webstorm', label: 'WebStorm', exe: 'webstorm64.exe' }
];
const PRODUCT_BY_ID = new Map(PRODUCTS.map((product) => [product.id, product]));
// 判不出项目类型时兜底：三个里 WebStorm 覆盖面最广（前端、Rust、纯文本目录都开得了）
const FALLBACK_IDE = 'webstorm';
// .idea/<项目>.iml 上的 module type 是最准的一条：它记的是"这个模块当初由哪个 IDE 建"
const IML_TO_IDE = { PYTHON_MODULE: 'pycharm', WEB_MODULE: 'webstorm' };

// 每个根目录各带自己的下钻深度：Program Files 那种是 <产品>/bin，Toolbox 是 <产品>/ch-0/<版本号>/bin。
// 不把 %LOCALAPPDATA%\JetBrains 整个当根——那儿下面是各 IDE 的配置与索引缓存，目录数以万计，
// 扫它够得着一格列表的加载时间。
function defaultIdeRoots() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [
    { dir: 'C:\\Program Files\\JetBrains', depth: 2 },
    { dir: 'D:\\Program Files\\JetBrains', depth: 2 },
    { dir: path.join(localAppData, 'JetBrains', 'Toolbox', 'apps'), depth: 3 }
  ];
}

// 配置里那串根目录：去空、去重（Windows 路径不分大小写）、保持写的顺序。
// 不在这里判定绝对路径——那句话要原样报给他，所以留给 readRoot 说。
function normalizeRoots(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const root = typeof item === 'string' ? item.trim() : '';
    if (!root) continue;
    const key = root.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return null;
  }
}

// 绝对路径必须落在这个目录里面（含大小写不敏感，Windows 的路径不分大小写）。
// git 服务那边拼文件路径时已经核过一遍，这里再核是因为这是**整条链上唯一一处把路径放进 spawn 参数位**：
// 拦在参数进 CreateProcess 之前才是拦在点上，而且万一将来 openFile 多了别的调用方，规矩还跟着。
function insideDir(dir, target) {
  if (typeof target !== 'string' || !target || !path.isAbsolute(target)) return null;
  const full = path.resolve(target);
  const base = path.resolve(dir);
  return full.toLowerCase().startsWith(base.toLowerCase() + path.sep) ? full : null;
}

function binDirOf(dir, exe) {
  const bin = path.join(dir, 'bin');
  try {
    return fs.statSync(path.join(bin, exe)).isFile() ? bin : null;
  } catch (err) {
    return null;
  }
}

// Toolbox 的层级比 Program Files 深两级，所以深度由调用方按根目录给，这里只管往下走
function findBinDir(root, exe, depth) {
  const hit = binDirOf(root, exe);
  if (hit) return hit;
  if (!depth) return null;
  for (const ent of listDir(root) || []) {
    if (!ent.isDirectory() || SKIP_DIR_RE.test(ent.name)) continue;
    const nested = findBinDir(path.join(root, ent.name), exe, depth - 1);
    if (nested) return nested;
  }
  return null;
}

// .iml 是几百字节的 XML；读一遍只为了那一个 module type 属性
function imlIde(ideaDirents, ideaDir) {
  const imls = (ideaDirents || []).filter((ent) => /\.iml$/i.test(ent.name) && ent.isFile()).slice(0, MAX_IML_FILES);
  for (const ent of imls) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(ideaDir, ent.name), 'utf8');
    } catch (err) {
      continue;
    }
    const m = /module\s+type="([A-Z_]+)"/i.exec(text);
    const ide = m && IML_TO_IDE[m[1].toUpperCase()];
    if (ide) return ide;
  }
  return null;
}

// 判序：先特异后通用。
// 第一条排在语言条前面是有原因的：D:\GitProject\datagrip 里既有 dataSources.xml，
// 又有一份 module type="PYTHON_MODULE" 的 .iml（他那份库项目当初从 PyCharm 模板建的），
// 反过来排就把一个数据库工程判给了 PyCharm。
const RULES = [
  {
    ide: 'datagrip',
    why: '.idea 里有 dataSources —— DataGrip 的数据库单子',
    test: (p) => p.idea.has('datasources.xml') || p.idea.has('datasources')
  },
  {
    ide: 'pycharm',
    why: 'Python 工程（.iml 记的是 PYTHON_MODULE，或顶层有 requirements.txt / pyproject.toml / setup.py / .py）',
    test: (p) => p.iml === 'pycharm' || ['requirements.txt', 'pyproject.toml', 'setup.py', 'pipfile'].some((name) => p.top.has(name)) || p.hasPy
  },
  {
    ide: 'webstorm',
    why: '前端 / Node 工程（.iml 记的是 WEB_MODULE，或顶层有 package.json / tsconfig.json）',
    test: (p) => p.iml === 'webstorm' || p.top.has('package.json') || p.top.has('tsconfig.json')
  },
  {
    // 根目录下三个和 IDE 同名的文件夹是他给各 IDE 留的默认项目位置：里面空着（pycharm）
    // 或者只装子项目（webstorm）时也按名字认，别退到兜底那条去。
    ide: 'name',
    why: '文件夹名本身就是一个 IDE 名',
    test: (p) => PRODUCT_BY_ID.has(p.name)
  },
  { ide: 'fallback', why: '认不出工程类型，走默认 IDE', test: () => true }
];

// 名单一律小写：Windows 路径不分大小写，判据大小写敏感就会看菜下饭
function pickIde(projectName, files, dirs, ideaDirents, ideaDir) {
  const ctx = {
    name: projectName.toLowerCase(),
    top: new Set([...files, ...dirs].map((name) => name.toLowerCase())),
    idea: new Set((ideaDirents || []).map((ent) => ent.name.toLowerCase())),
    iml: imlIde(ideaDirents, ideaDir),
    hasPy: files.some((name) => /\.py$/i.test(name))
  };
  for (const rule of RULES) {
    if (!rule.test(ctx)) continue;
    const ide = rule.ide === 'name' ? ctx.name : rule.ide === 'fallback' ? FALLBACK_IDE : rule.ide;
    return { ide, why: rule.why };
  }
  return { ide: FALLBACK_IDE, why: '认不出工程类型，走默认 IDE' };
}

// 读 .git/logs/HEAD 的最后一行：`<旧sha> <新sha> 名字 <邮箱> <秒级时间> <时区>\t动作: 说明`
// 只要尾部那一小截，所以按 fd 从末尾倒着读，不把整条 reflog 灌进内存。
function reflogTime(gitPath) {
  let logs;
  try {
    logs = fs.statSync(gitPath);
  } catch (err) {
    return null;
  }
  // .git 是个文件的是 worktree / submodule，logs/HEAD 那条路径不存在，直接退回目录 mtime
  if (!logs.isDirectory()) return null;
  const file = path.join(gitPath, 'logs', 'HEAD');
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (!size) return null;
    const length = Math.min(size, REFLOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n').filter((line) => line.trim());
    const m = lines.length && / (\d{10}) [+-]\d{4}\t/.exec(lines[lines.length - 1]);
    return m ? Number(m[1]) : null;
  } catch (err) {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function inspect(root, name) {
  const dir = path.join(root, name);
  const entries = listDir(dir) || [];
  const files = entries.filter((ent) => ent.isFile()).map((ent) => ent.name);
  const dirs = entries.filter((ent) => ent.isDirectory()).map((ent) => ent.name);
  const ideaDir = path.join(dir, '.idea');
  const ideaDirents = fs.existsSync(ideaDir) ? listDir(ideaDir) : null;
  const { ide, why } = pickIde(name, files, dirs, ideaDirents, ideaDir);

  const touched = reflogTime(path.join(dir, '.git'));
  let mtime = 0;
  try {
    mtime = Math.floor(fs.statSync(dir).mtimeMs / 1000);
  } catch (err) {
    mtime = 0;
  }
  return {
    name,
    path: dir,
    // 从哪个根扫出来的：多个根时 git 格要说这句话，不用回头做字符串切割
    root,
    ide,
    why,
    // git 那条只到「最后一次提交 / 切分支」，目录 mtime 到「最后一次增删顶层条目」，两种分开说
    touched: touched || mtime,
    touchedBy: touched ? 'git' : 'dir',
    empty: files.length + dirs.length === 0,
    // .git 是目录（普通仓库）或文件（worktree / submodule）都算在版本控制里
    git: fs.existsSync(path.join(dir, '.git'))
  };
}

class Projects {
  // spawn / openPath 是留给离线自检的接缝（同 trainers、steam）：注入只记账的替身，
  // 才敢断言"点一下到底把哪个路径交给了哪个 exe"而不在自检机上真开六个 IDE 窗口。
  // roots 两条来路：生产用 getRoots（现读 config.repos.roots，项目格和 git 格共用这一份），
  // 自检用静态数组。都不给（undefined/null）才兜回 DEFAULT_ROOT；给了但一行都没有 =
  // 他真在设置里清空了，照实报「没有配置仓库根目录」，不偷偷替他扫 D:\GitProject。
  // 走 getRoots 是为了「保存并应用」之后不用重启应用，也不用点「重扫」：见 scan() 里那句 stale。
  constructor({ roots = null, getRoots = null, ideRoots = null, spawn, openPath } = {}) {
    this.getRoots = typeof getRoots === 'function' ? getRoots : null;
    this.staticRoots = this.getRoots ? null : roots;
    this.roots = this.resolveRoots();
    this.ideRoots = ideRoots && ideRoots.length ? ideRoots : defaultIdeRoots();
    this.spawn = spawn;
    this.openPath = openPath || ((dir) => shell.openPath(dir));
    this.items = [];
    this.warnings = [];
    this.exes = new Map();
    this.ides = [];
    this.scannedAt = 0;
    this.lastLaunch = { id: null, at: 0 };
  }

  // 每次扫之前现读一遍：「保存并应用」会把主进程那个 config 对象整个换掉，攥着旧值等于没配置项。
  // 手改 toolbar.config.json 时写成一根字符串也认（"roots": "D:\\x"），别的形状才回兜底。
  resolveRoots() {
    const value = this.getRoots ? this.getRoots() : this.staticRoots;
    if (typeof value === 'string') return normalizeRoots([value]);
    return normalizeRoots(Array.isArray(value) ? value : [DEFAULT_ROOT]);
  }

  // IDE 的位置基本不变，认出来一次就留着；force 重扫才重新找一遍（刚装完 IDE 点「重扫」就能认到）
  resolveIdes(force) {
    if (this.ides.length && !force) return;
    this.exes = new Map();
    this.ides = PRODUCTS.map((product) => {
      for (const { dir, depth } of this.ideRoots) {
        const bin = findBinDir(dir, product.exe, depth);
        if (bin) {
          this.exes.set(product.id, path.join(bin, product.exe));
          return { id: product.id, label: product.label, found: true };
        }
      }
      return { id: product.id, label: product.label, found: false };
    });
  }

  // 每个根各扫自己的顶层文件夹；同一个目录在两个根里都出现只收一次（小写绝对路径去重）。
  // 一个根读不到不掀整张表：它进 warnings，全都读不到才当错误报。
  scan(force = false) {
    const previous = this.roots;
    const roots = this.resolveRoots();
    this.roots = roots;
    // 设置里刚改过 repos.roots：这一份缓存属于上一批根目录，不作废就得重启应用才见效。
    // 比对按小写来——同一条路径他写大写小写都算同一个根。
    const stale = roots.join('\n').toLowerCase() !== previous.join('\n').toLowerCase();

    if (!roots.length) {
      // 根目录清空了：缓存的行一起清，否则旧 id 还能点到已经不该出现的项目
      this.items = [];
      this.warnings = [];
      this.scannedAt = 0;
      return { roots, items: [], ides: this.ides, warnings: [], error: '没有配置仓库根目录（repos.roots 是空的）' };
    }

    if (this.scannedAt && !force && !stale && Date.now() - this.scannedAt < CACHE_TTL_MS) {
      return { roots, items: this.items, ides: this.ides, warnings: this.warnings, cached: true };
    }

    const found = [];
    const seen = new Set();
    const warnings = [];
    for (const root of roots) {
      const problem = this.readRoot(root, found, seen);
      if (problem) warnings.push(problem);
    }

    if (!found.length && warnings.length === roots.length) {
      return { roots, items: [], ides: this.ides, warnings, error: warnings.join('；') };
    }

    this.resolveIdes(force);
    // 最近动过的排最前：开这一格多半是为了接着上次那个项目干
    found.sort((a, b) => {
      if (a.touched !== b.touched) return b.touched - a.touched;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    // ideLabel / ideReady 在这里盖：exe 路径只进 this.exes，行数据里最多说「这个 IDE 本机没装」
    this.items = found.map((item, id) => ({
      ...item,
      id,
      ideLabel: PRODUCT_BY_ID.get(item.ide)?.label || item.ide,
      ideReady: this.exes.has(item.ide)
    }));
    this.warnings = warnings;
    this.scannedAt = Date.now();
    return { roots, items: this.items, ides: this.ides, warnings: this.warnings };
  }

  // 返回错误文案（这一格该说的那句）或 null；成功时把项目行 push 进 found
  readRoot(root, found, seen) {
    if (!path.isAbsolute(root)) return `仓库根路径要写绝对路径：${root}`;

    let stat = null;
    let code = '';
    try {
      stat = fs.statSync(root);
    } catch (err) {
      code = err.code || '';
    }
    if (!stat) return `找不到仓库根目录（${code || '错误'}）：${root}`;
    if (!stat.isDirectory()) return `${root} 不是目录`;

    const entries = listDir(root);
    if (!entries) return `没有读取权限：${root}`;

    for (const ent of entries) {
      if (!ent.isDirectory() || SKIP_DIR_RE.test(ent.name)) continue;
      const dir = path.join(root, ent.name);
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(inspect(root, ent.name));
    }
    return null;
  }

  pick(id) {
    const n = Number(id);
    if (!Number.isInteger(n)) return null;
    return this.items.find((item) => item.id === n) || null;
  }

  // 路径只从这次缓存里取，渲染层递进来的任何字符串都进不到 spawn 的参数位上
  async launch(id) {
    const item = this.pick(id);
    if (!item) return { ok: false, error: '列表已过期，点「重扫」' };
    if (this.lastLaunch.id === item.id && Date.now() - this.lastLaunch.at < GUARD_MS) {
      return { ok: false, error: '刚刚已经把这个项目交给 IDE 了，等它开起来' };
    }
    const exe = this.exes.get(item.ide);
    const label = PRODUCT_BY_ID.get(item.ide)?.label || item.ide;
    if (!exe) return { ok: false, error: `本机没找到 ${label} 的启动器（认的是 JetBrains 目录下的 ${PRODUCT_BY_ID.get(item.ide)?.exe}）` };
    this.lastLaunch = { id: item.id, at: Date.now() };

    const res = await spawnResult(this.spawn, exe, [item.path]);
    return res.ok ? { ok: true, name: item.name, ide: item.ide, ideLabel: label } : { ok: false, error: explainSpawnError(res.error) };
  }

  // git 格点一个改动文件走这里：用哪个 IDE 仍然由上面那批规则判（这就是「git 格是项目格的第二个视图」
  // 在代码里的样子——第二视图不自己另判一套）。路径是主进程那边拼好的绝对路径，渲染层递不进来。
  // 返回的行只到文件名，绝对路径不回渲染层：那一路IPC上该露的只有「打开了哪个项目的哪个文件」。
  async openFile(id, target) {
    const item = this.pick(id);
    if (!item) return { ok: false, error: '列表已过期，点「重扫」' };
    const full = insideDir(item.path, target);
    if (!full) return { ok: false, error: '这个路径不在项目目录里面，不打开' };
    if (!fs.existsSync(full)) return { ok: false, error: `文件已经不在了：${path.basename(full)}` };
    const exe = this.exes.get(item.ide);
    const label = PRODUCT_BY_ID.get(item.ide)?.label || item.ide;
    if (!exe) return { ok: false, error: `本机没找到 ${label} 的启动器，打不开这个文件（项目格那一栏有同一句）` };

    const res = await spawnResult(this.spawn, exe, [full]);
    return res.ok
      ? { ok: true, name: item.name, file: path.basename(full), ide: item.ide, ideLabel: label }
      : { ok: false, error: explainSpawnError(res.error) };
  }

  // 「打开这个文件夹」走的是缓存里的项目路径，不是渲染层递来的路径
  async reveal(id) {
    const item = this.pick(id);
    if (!item) return { ok: false, error: '列表已过期，点「重扫」' };
    if (!fs.existsSync(item.path)) return { ok: false, error: `项目目录已经不在了：${item.name}` };
    const result = await this.openPath(item.path);
    return result ? { ok: false, error: result } : { ok: true, name: item.name };
  }

  status() {
    return { roots: this.roots, count: this.items.length, scannedAt: this.scannedAt, ides: this.ides, warnings: this.warnings };
  }
}

module.exports = { Projects, DEFAULT_ROOT, PRODUCTS, pickIde, findBinDir, reflogTime, insideDir };
