// 主进程这一侧只管四件事：把工作进程拉起来、把查询转进去并把超时/丢弃兜住、
// Everything 没在跑时用 vendor 里的便携版把它带起来、以及把"打开结果"这条路守住。
//
// 打开文件不接渲染层给的路径，只接 (列表 id, 序号)：渲染层能拿到的永远是
// 我们自己刚缓存下来的那批结果，免得这条 IPC 变成"任何路径都能帮你 openPath"的口子。
const path = require('path');
const { utilityProcess, shell } = require('electron');
const { spawn } = require('child_process');
const { exePath, ensureHostConfig, IS_WIN, SORT } = require('./everything-sdk');

const WORKER = path.join(__dirname, 'everything-worker.js');
const LIST_LIMIT = 8; // 缓存最近几页结果，够键盘+鼠标来回点，又不会一直涨


function pickConfig(config) {
  const s = (config && config.search) || {};
  return {
    enabled: s.enabled !== false,
    maxResults: Math.max(1, Math.min(100, s.maxResults || 20)),
    minChars: Math.max(1, s.minChars == null ? 2 : s.minChars),
    timeoutMs: s.timeoutMs || 1500,
    autoStart: s.autoStart !== false,
    sort: SORT[s.sort] || SORT.NAME_ASCENDING
  };
}

class EverythingSearch {
  constructor({ appRoot, getConfig, emit }) {
    this.root = appRoot;
    this.getConfig = getConfig;
    this.emit = emit || (() => {});
    this.child = null;
    this.starting = null;
    this.seq = 0;
    this.pending = new Map();
    this.gate = Promise.resolve();
    this.lists = new Map();
    this.hostStarting = null;
    // 字段必须叫 state：下面有个 status() 方法，构造函数里再写 this.status = {...}
    // 会把自己的方法盖掉，第一次探测就在事件回调里抛 "not a function" 把整个应用带走。
    this.state = {
      platform: process.platform,
      supported: IS_WIN,
      installed: IS_WIN && Boolean(exePath(this.root)),
      workerReady: false,
      running: false,
      dbLoaded: false,
      admin: false,
      sdkVersion: null,
      lastError: null
    };
  }

  report(patch) {
    Object.assign(this.state, patch);
    this.emit('search:state', this.status());
  }

  status() {
    // 只报状态，不带任何结果路径
    return { ...this.state };
  }

  ensureWorker() {
    if (this.child && this.state.workerReady) return Promise.resolve(true);
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve) => {
      // 注意：utilityProcess 本身就是 Node 环境，不能再设 ELECTRON_RUN_AS_NODE（语音那条链路踩过，会 code 9 退出）
      const child = utilityProcess.fork(WORKER, [], { env: { ...process.env, TB_APP_ROOT: this.root }, stdio: 'pipe' });
      this.child = child;
      child.on('spawn', () => {
        this.report({ workerReady: true, lastError: null });
        resolve(true);
      });
      child.on('exit', () => {
        this.child = null;
        this.starting = null;
        for (const [, entry] of this.pending) entry.settle({ ok: false, message: '搜索工作进程已退出' });
        this.pending.clear();
        this.report({ workerReady: false, lastError: '搜索工作进程退出了，下次查询会重新拉起' });
        resolve(false);
      });
      child.on('message', (message) => this.onMessage(message));
    });
    return this.starting;
  }

  onMessage(message) {
    if (!message || message.id == null) return;
    const entry = this.pending.get(message.id);
    if (!entry) return; // 超时之后才回来的那一条，丢掉
    this.pending.delete(message.id);
    entry.settle(message);
  }

  // 一次只让一条查询进工作进程：Everything 的查询是阻塞调用，两条并进去等于让工作进程
  // 自己排队，超时判断就会算错。排队（而不是丢弃）是必须的——面板一打开就先发探测、
  // 紧接着用户回车发第一条查询，谁都不该因为"占了位子"而失败。
  call(op, payload, timeoutMs) {
    if (!this.child) return Promise.resolve({ ok: false, message: '搜索工作进程还没起来' });
    const id = ++this.seq;
    const slot = this.gate.then(
      () =>
        new Promise((resolve) => {
          const settle = (result) => {
            clearTimeout(timer);
            resolve(result);
          };
          const timer = setTimeout(() => {
            this.pending.delete(id);
            settle({ ok: false, timedOut: true, message: `查询超过 ${timeoutMs}ms 没回来` });
          }, timeoutMs);
          this.pending.set(id, { settle });
          this.child.postMessage({ op, id, ...payload });
        })
    );
    this.gate = slot;
    return slot;
  }

  async probe(timeoutMs = 2000) {
    await this.ensureWorker();
    const r = await this.call('probe', {}, timeoutMs);
    if (r && r.ok !== false) {
      this.report({ running: Boolean(r.running), dbLoaded: Boolean(r.dbLoaded), admin: Boolean(r.admin), sdkVersion: r.sdkVersion || this.state.sdkVersion, lastError: r.message || null });
    } else {
      this.report({ running: false, dbLoaded: false, lastError: (r && r.message) || '探测失败' });
    }
    return this.status();
  }

  // Everything 客户端没在跑：用 vendor 里的便携版拉一个，然后等它的索引可用。
  // 全盘首次索引可能要几分钟，所以这里只等"能连上"，索引没好就先回 dbLoaded:false。
  async startHost(waitMs = 15000) {
    if (!IS_WIN) return { ok: false, message: 'Everything 只有 Windows 版' };
    if (this.hostStarting) return this.hostStarting;
    const exe = exePath(this.root);
    if (!exe) return { ok: false, message: '没找到 vendor/everything/app/everything.exe' };
    this.hostStarting = (async () => {
      try {
        // 缺 ini 时补一份 starter（index=1，见 everything-sdk.js）；写不进去就算了，别挡住拉起
        try {
          ensureHostConfig(exe);
        } catch {
          this.report({ lastError: '没能写入 vendor/everything/app/Everything.ini' });
        }
        spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
      } catch (error) {
        this.hostStarting = null;
        this.report({ lastError: `拉起 Everything 失败：${error.message}` });
        return { ok: false, message: error.message };
      }
      const until = Date.now() + waitMs;
      for (;;) {
        const st = await this.probe(3000);
        if (st.running) {
          this.hostStarting = null;
          return { ok: true, dbLoaded: st.dbLoaded };
        }
        if (Date.now() > until) {
          this.hostStarting = null;
          this.report({ lastError: 'Everything 拉起来了但连不上（可能没开 IPC，或索引还没就绪）' });
          return { ok: false, message: 'Everything 连不上' };
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    })();
    return this.hostStarting;
  }

  async search(query) {
    const cfg = pickConfig(this.getConfig());
    const q = String(query == null ? '' : query).trim();
    if (!cfg.enabled) return { ok: false, message: '文件搜索在设置里被关了', items: [] };
    if (!IS_WIN) return { ok: false, message: 'Everything 只有 Windows 版', items: [] };
    if (q.length < cfg.minChars) return { ok: false, tooShort: true, items: [] };

    await this.ensureWorker();
    let result = await this.call('search', { query: q, max: cfg.maxResults, sort: cfg.sort }, cfg.timeoutMs);
    if (!result.ok && result.ipcDown && cfg.autoStart) {
      const host = await this.startHost();
      if (host.ok) result = await this.call('search', { query: q, max: cfg.maxResults, sort: cfg.sort }, cfg.timeoutMs);
    }
    if (!result.ok) {
      this.report({ running: result.ipcDown ? false : this.state.running, lastError: result.message || null });
      return { ok: false, message: result.message, ipcDown: Boolean(result.ipcDown), items: [] };
    }
    this.report({ running: true, dbLoaded: result.dbLoaded == null ? this.state.dbLoaded : Boolean(result.dbLoaded), admin: Boolean(result.admin), lastError: null });

    const listId = `l${++this.seq}`;
    this.lists.set(listId, result.items || []);
    while (this.lists.size > LIST_LIMIT) this.lists.delete(this.lists.keys().next().value);
    return { ok: true, listId, total: result.total, returned: result.returned, items: result.items };
  }

  async open(listId, index) {
    const items = this.lists.get(listId);
    if (!items) return { ok: false, message: '这批结果已经过期，重新搜一次' };
    const item = items[Number(index)];
    if (!item || typeof item.path !== 'string' || !item.path) return { ok: false, message: '没有这条结果' };
    const failure = await shell.openPath(item.path);
    return failure ? { ok: false, message: failure } : { ok: true, name: item.name };
  }

  dispose() {
    if (!this.child) return;
    try {
      this.child.postMessage({ op: 'dispose', id: ++this.seq });
    } catch {
      // 已经断了就不用装模作样收尾
    }
    this.child.kill();
    this.child = null;
  }
}

module.exports = { EverythingSearch };
