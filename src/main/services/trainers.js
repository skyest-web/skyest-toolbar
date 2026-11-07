// 修改器（FLiNG / 小幸 那类 trainer）的目录扫描与启动。
//
// 两条纪律和搜索那条一样：
// 1) 渲染层永远拿不到"给我一个路径我帮你启动"的口子。列表由主进程扫出来后缓存在这里，
//    启动/定位只认这次缓存里的 id，配置文件夹也只从 config 读，不从渲染层接。
// 2) 扫描是同步 fs，但只在缓存过期（60 秒）或显式刷新时跑；切面板不会重扫。
//
// 命名规则：顶层的 exe 用文件名（《Jump大乱斗》修改器.exe → 去掉 .exe）；
// 一层子目录里的 exe 用**目录名**当显示名——那才是人话（[小幸]《仙剑奇侠传七》修改器
// 方块、Steam、Wegame等平台版本），目录里不止一个 exe 时才把文件名拼在后面区分。

const fs = require('node:fs');
const path = require('node:path');
const { shell } = require('electron');
const { spawn: nodeSpawn } = require('node:child_process');
const { spawnResult, explainSpawnError, redactPaths } = require('./spawn-result');

const CACHE_TTL_MS = 60000;
const DOUBLE_CLICK_GUARD_MS = 3000;
const EXE_RE = /\.exe$/i;
// 卸载器和运行库安装器不是修改器，混在同一个目录里，按名字挡掉
const SKIP_RE = /^(unins|vcredist|dxsetup|dotnetfx|setup|install)/i;

function stripExt(name) {
  return name.replace(/\.exe$/i, '').trim();
}

function readableDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return null;
  }
}

// PowerShell 的单引号字符串：内部单引号要翻倍。路径来自我们自己扫的结果，
// 但这台机器上目录名里有中文、括号和空格，不转义就会把命令拆坏。
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

class Trainers {
  constructor({ getConfig, spawn } = {}) {
    this.getConfig = getConfig;
    // 自检注入只记账的替身，于是「EACCES 补发一次 RunAs」「取消 UAC」这两条能离线断言，
    // 又不会在跑自检的机器上真弹 UAC
    this.spawn = spawn || nodeSpawn;
    this.items = [];
    this.folder = null;
    this.scannedAt = 0;
    this.lastLaunch = { id: null, at: 0 };
  }

  folderPath() {
    return String(this.getConfig()?.trainers?.folder || '').trim();
  }

  scan(force = false) {
    const folder = this.folderPath();
    if (!folder) return { folder, items: [], error: '还没配置修改器文件夹（设置 → 修改器 → 文件夹）' };
    if (!path.isAbsolute(folder)) return { folder, items: [], error: `文件夹路径要写绝对路径：${folder}` };
    if (this.folder === folder && !force && Date.now() - this.scannedAt < CACHE_TTL_MS) {
      return { folder, items: this.items, cached: true };
    }

    let stat = null;
    try {
      stat = fs.statSync(folder);
    } catch (err) {
      return { folder, items: [], error: `文件夹不存在或不可读（${err.code || err.message}）` };
    }
    if (!stat.isDirectory()) return { folder, items: [], error: '这不是目录' };

    const found = [];
    const entries = readableDir(folder);
    if (!entries) return { folder, items: [], error: '没有读取权限' };

    for (const ent of entries) {
      if (!ent.isFile() || !EXE_RE.test(ent.name) || SKIP_RE.test(ent.name)) continue;
      found.push({ name: stripExt(ent.name), path: path.join(folder, ent.name) });
    }

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(folder, ent.name);
      const inner = readableDir(dir);
      if (!inner) continue;
      const exes = inner.filter((it) => it.isFile() && EXE_RE.test(it.name) && !SKIP_RE.test(it.name));
      if (!exes.length) continue;
      if (exes.length === 1) {
        found.push({ name: ent.name, path: path.join(dir, exes[0].name) });
      } else {
        for (const exe of exes) {
          found.push({ name: `${ent.name} · ${stripExt(exe.name)}`, path: path.join(dir, exe.name) });
        }
      }
    }

    found.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    this.items = found.map((item, id) => ({ ...item, id }));
    this.folder = folder;
    this.scannedAt = Date.now();
    // 这一份是带 `path` 的，和 Steam 那边"剥掉 dir/clientRoot"不一样：独立修改器格子的悬停提示
    // 要写明到底是哪个文件（一格一个 exe，光看目录名分不出）。这是**只出不进**——渲染层能显示
    // 路径，但启动/定位只认 id，任何它递回来的路径都不接。游戏面板那份行数据（library）不带 path。
    return { folder, items: this.items };
  }

  // 启动是异步的，而且把成败如实报回去：spawn 的失败有两条来路（见 spawn-result.js），
  // 以前只写了同步 try/catch，异步那条没人接，主进程就弹错误框
  async launch(id, { elevated = false } = {}) {
    const item = this.pick(id);
    if (!item) return { ok: false, error: '列表已过期，请点「重扫」' };
    if (this.lastLaunch.id === item.id && Date.now() - this.lastLaunch.at < DOUBLE_CLICK_GUARD_MS) {
      return { ok: false, error: '刚刚已经点过同一个，等它起来' };
    }
    this.lastLaunch = { id: item.id, at: Date.now() };

    if (elevated) return this.runAsAdmin(item);

    // 不用 shell.openPath：那不给工作目录，很多 trainer 找不到自己旁边的 dll/配置就静默退出
    const res = await spawnResult(this.spawn, item.path, [], { cwd: path.dirname(item.path) });
    if (res.ok) return { ok: true, name: item.name, elevated: false };
    // 本机 68 个 trainer exe 里 61 个的清单带 requireAdministrator，普通权限点必然被拒。
    // 与其把「拒绝访问」甩回给他，不如照他这一点的意图补发一次 UAC：弹窗还是系统弹的，
    // 提不提权仍然由他点「是」决定。
    if (res.error?.code === 'EACCES') {
      const up = await this.runAsAdmin(item);
      return up.ok ? { ...up, autoElevated: true } : up;
    }
    return { ok: false, error: explainSpawnError(res.error) };
  }

  // 提权只有系统这一条路：Start-Process -Verb RunAs。它只负责"把那个 exe 拉起来"，
  // 不等 trainer 退出，所以会等 UAC 答复、答复完就回来——正好让我们看清他点的是「是」
  // 还是「取消」，不再是"报成功然后什么都没发生"。
  runAsAdmin(item) {
    const cwd = path.dirname(item.path);
    const command = `Start-Process -FilePath ${psQuote(item.path)} -WorkingDirectory ${psQuote(cwd)} -Verb RunAs`;
    const args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command];

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child;
      try {
        // 这条不 detach，要读 stderr 和退出码
        child = this.spawn('powershell.exe', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      } catch (err) {
        finish({ ok: false, error: explainSpawnError(err) });
        return;
      }

      let stderr = '';
      child.stderr?.on?.('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (err) => finish({ ok: false, error: explainSpawnError(err) }));
      child.once('close', (code) => {
        if (!code) {
          finish({ ok: true, name: item.name, elevated: true });
          return;
        }
        const first = redactPaths(String(stderr).split(/\r?\n/).find((line) => line.trim()) || '');
        // UAC 点「否」是 ERROR_CANCELLED(1223)，中文系统写「操作已被用户取消」
        if (/cance|取消|1223/i.test(first)) finish({ ok: false, error: 'UAC 弹窗被取消，没有启动' });
        else finish({ ok: false, error: `启动失败：${first || `PowerShell 退出码 ${code}`}` });
      });
    });
  }
  // 只认缓存里那批 id：渲染层递来任何路径都不接，过期就让它去刷新
  pick(id) {
    const n = Number(id);
    if (!Number.isInteger(n)) return null;
    return this.items.find((item) => item.id === n) || null;
  }

  reveal(id) {
    const item = this.pick(id);
    if (!item) return { ok: false, error: '列表已过期，请点「重扫」' };
    shell.showItemInFolder(item.path);
    return { ok: true };
  }

  status() {
    return { folder: this.folderPath(), count: this.items.length, scannedAt: this.scannedAt };
  }
}

module.exports = { Trainers };
