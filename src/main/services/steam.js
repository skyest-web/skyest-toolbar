// Steam 库扫描 + 通过 Steam 启动。
//
// 数据源是 <库>/steamapps/appmanifest_<appid>.acf——那是 Steam 自己的 keyvalues 清单，
// 每个已安装应用一份，里面有 appid / name / installdir / LastPlayed / SizeOnDisk。
// 只读这些文件，不去 common/ 里翻 exe：翻 common 既慢又分不清游戏、演示版和工具，
// 而且真正的启动权在 Steam 手里。
//
// 启动一律交回 Steam：shell.openExternal('steam://rungameid/<appid>')。
// 好处是启动选项、兼容性、云存档、在线状态都按他在客户端里的设置走；Steam 没开时系统会先把客户端拉起来。
// 坏处的边界要说清：我们只保证"把这个 appid 交给了 Steam"，至于 Steam 有没有真的把游戏跑起来，这里看不到。
//
// 纪律和修改器那条一样：渲染层只递 id，路径和 appid 都留在主进程这次的缓存里。

const fs = require('node:fs');
const path = require('node:path');
const { shell } = require('electron');

const CACHE_TTL_MS = 60000;
const GUARD_MS = 4000;
const ACF_RE = /^appmanifest_(\d+)\.acf$/i;

// 不是游戏的东西也会占一份 appmanifest。228980 是 Steamworks Common Redistributables，
// 剩下的按名字挡运行库/工具类，宁可少挡也别误伤真游戏。
const NOT_A_GAME_RE = /(common redistributables|directx|visual c\+\+|vcredist|dotnet|openal|dedicated server|tool sdk|soundtrack|ost)/i;

function field(text, key) {
  // acf 是「"键"<tab><tab>"值"」一行一条；同一个键只取第一次出现（InstalledDepots 里也有 size）
  const m = text.match(new RegExp('"' + key + '"[^"\\r\\n]*"([^"]*)"', 'i'));
  return m ? m[1] : '';
}

function unescape(value) {
  return String(value).replace(/\\\\/g, '\\');
}

function steamappsDir(folder) {
  const clean = String(folder || '').trim().replace(/[\\/]+$/, '');
  if (!clean) return null;
  // 他给的是 ...\steamapps，但很多人会指到库根目录（SteamLibrary），两种都接下来
  return path.basename(clean).toLowerCase() === 'steamapps' ? clean : path.join(clean, 'steamapps');
}

function readableDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return null;
  }
}

class Steam {
  // openExternal / openPath 是留给离线自检的接缝：node 里跑没有 electron 的 shell，
  // 注入一个记录用的函数就能验到"拼出来的到底是哪个 steam:// 地址"。应用里走默认值。
  constructor({ getConfig, openExternal, openPath } = {}) {
    this.getConfig = getConfig;
    this.openExternal = openExternal || ((url) => shell.openExternal(url));
    this.openPath = openPath || ((dir) => shell.openPath(dir));
    this.items = [];
    this.folder = null;
    this.scannedAt = 0;
    this.lastLaunch = { id: null, at: 0 };
  }

  folderPath() {
    return String(this.getConfig()?.steam?.folder || '').trim();
  }

  // 给渲染层的那一份：`dir`（安装目录）和 `clientRoot`（客户端根，图标在那儿）只留在主进程，
  // 跨 IPC 的每条路都要过这里——缓存命中的那条以前直接回 `this.items`，路径就跟着漏出去了
  publicItems() {
    return this.items.map(({ dir, clientRoot, ...rest }) => rest);
  }

  scan(force = false) {
    const folder = this.folderPath();
    if (!folder) return { folder, items: [], error: '还没配置 Steam 库（设置 → Steam → 库文件夹）' };
    if (!path.isAbsolute(folder)) return { folder, items: [], error: `库路径要写绝对路径：${folder}` };

    const apps = steamappsDir(folder);
    if (this.folder === apps && !force && Date.now() - this.scannedAt < CACHE_TTL_MS) {
      return { folder, items: this.publicItems(), cached: true };
    }

    let stat = null;
    try {
      stat = fs.statSync(apps);
    } catch (err) {
      return { folder, items: [], error: `找不到 steamapps 目录（${err.code || err.message}）：${apps}` };
    }
    if (!stat.isDirectory()) return { folder, items: [], error: `${apps} 不是目录` };

    const entries = readableDir(apps);
    if (!entries) return { folder, items: [], error: `没有读取权限：${apps}` };

    const found = [];
    for (const ent of entries) {
      const m = ACF_RE.exec(ent.name);
      if (!ent.isFile() || !m) continue;
      let text = '';
      try {
        text = fs.readFileSync(path.join(apps, ent.name), 'utf8');
      } catch (err) {
        continue;
      }
      const appid = field(text, 'appid') || m[1];
      const name = field(text, 'name');
      if (!name || NOT_A_GAME_RE.test(name)) continue;
      // StateFlags=4 才是「已安装」；其他值是更新中、待安装、已卸载残留
      if (field(text, 'StateFlags') !== '4') continue;
      const installdir = field(text, 'installdir');
      // LauncherPath 是这份清单写下的 steam.exe 位置。一台机器可以有多个库，
      // 但图标/头像一律在**客户端**那个根的 appcache 里，所以要的是它的父目录。
      const launcher = unescape(field(text, 'LauncherPath'));
      found.push({
        appid: Number(appid),
        name: name || `App ${appid}`,
        played: Number(field(text, 'LastPlayed')) || 0,
        size: Number(field(text, 'SizeOnDisk')) || 0,
        clientRoot: launcher ? path.dirname(launcher) : null,
        // 安装目录只用来「在资源管理器里定位」，启动不碰它
        dir: installdir ? path.join(apps, 'common', unescape(installdir)) : null
      });
    }

    // 最近玩过的排前面，从没玩过的按名字排在后面：开列表多半是为了接着上次那个
    found.sort((a, b) => {
      if (a.played !== b.played) return b.played - a.played;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    this.items = found.map((item, id) => ({ ...item, id }));
    this.folder = apps;
    this.scannedAt = Date.now();
    return { folder, items: this.publicItems() };
  }

  // 图标在客户端根的 appcache/librarycache 下，按 appid 一个子目录。
  // 清单里写的 LauncherPath 不一定都有效（这台机器就有指向不存在目录的），
  // 所以把所有出现过的根都收集起来、留下真的存在的，让调用方逐个试。
  appCacheDirs() {
    const roots = new Set();
    for (const item of this.items) if (item.clientRoot) roots.add(item.clientRoot);
    if (!roots.size && this.folder) roots.add(path.dirname(this.folder));
    return [...roots]
      .map((root) => path.join(root, 'appcache', 'librarycache'))
      .filter((dir) => {
        try {
          return fs.statSync(dir).isDirectory();
        } catch (err) {
          return false;
        }
      });
  }

  pick(id) {
    const n = Number(id);
    if (!Number.isInteger(n)) return null;
    return this.items.find((item) => item.id === n) || null;
  }

  // 交给 Steam：rungameid 是 Steam 自己认的协议，我们只从缓存里取 appid 拼，不接渲染层给的任何字符串
  launch(id) {
    const item = this.pick(id);
    if (!item) return { ok: false, error: '列表已过期，请点「重扫」' };
    if (this.lastLaunch.id === item.id && Date.now() - this.lastLaunch.at < GUARD_MS) {
      return { ok: false, error: '刚刚已经交给 Steam 了，等它起来' };
    }
    this.lastLaunch = { id: item.id, at: Date.now() };
    const url = `steam://rungameid/${item.appid}`;
    this.lastUrl = url;
    Promise.resolve()
      .then(() => this.openExternal(url))
      .then((ok) => {
        if (ok === false) console.warn(`[steam] 系统没接 steam:// 协议（${url}）`);
      })
      .catch((err) => console.warn(`[steam] 交给 Steam 失败（${url}）：${err.message}`));
    return { ok: true, name: item.name, appid: item.appid };
  }

  reveal(id) {
    const item = this.pick(id);
    if (!item) return { ok: false, error: '列表已过期，请点「重扫」' };
    if (!item.dir) return { ok: false, error: '这份清单里没写安装目录' };
    if (!fs.existsSync(item.dir)) return { ok: false, error: `安装目录不存在：${item.dir}` };
    Promise.resolve()
      .then(() => this.openPath(item.dir))
      .catch((err) => console.warn(`[steam] 定位失败（${item.dir}）：${err.message}`));
    return { ok: true, name: item.name };
  }

  status() {
    return { folder: this.folderPath(), steamapps: this.folder, count: this.items.length, scannedAt: this.scannedAt };
  }
}

module.exports = { Steam, steamappsDir, field };
