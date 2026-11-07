// 163 邮箱的只读收件：IMAP 拉收件箱的信封头部（发件人 / 主题 / 时间 / 已读与否），
// 不下载正文、不标已读、不删不移——这一格只负责「看一眼」，要回信走网页邮箱。
//
// 三条纪律（和 QODER.md 硬纪律一一对上）：
//   1. 出网只发生在这里。渲染层 CSP 是 connect-src 'self'，它自己抓不到外部。
//   2. 授权码只存在 userData/mail-auth.bin（safeStorage / Windows DPAPI），
//      不进 toolbar.config.json、不进 state.json、不进日志、不跨 IPC 回传，只回一个 hint。
//   3. 渲染层只递 id；能对外打开的地址（webmail）从 config 读，不接渲染层给的字符串。
//
// 连接复用：一台机器上反复重连 163 会被限流，所以客户端连着不放，出错才丢。
// imapflow 自己会在登录后补发 IMAP ID（163 不给 ID 就回「Unsafe Login」），这里不用管。

const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const { ImapFlow } = require('imapflow');

// 离线自检（tools/mail-check.js）是拿普通 node 跑的，那时候 require('electron') 只会给出
// 一个二进制路径字符串，这两个都解出 undefined。所以一律可选调用，不假设它们在。
const safeStorage = electron.safeStorage;
const shell = electron.shell;

const AUTH_FILE = 'mail-auth.bin';
const CACHE_TTL_MS = 60000;
const MAX_WINDOW = 200; // 一次最多拉多少封头部，写死上限，免得配置里填个 5000 把收件箱整本拖下来
const MIN_POLL_MS = 30000; // 看护轮询的下限，和渲染层原来那条一样：来回切页 / 填个 1 秒都会把 163 打到限流

const FALLBACK = {
  enabled: true,
  account: '',
  host: 'imap.163.com',
  port: 993,
  secure: true,
  mailbox: 'INBOX',
  maxMessages: 20,
  pollMs: 120000,
  timeoutMs: 20000,
  webmail: 'https://mail.163.com',
  // 新邮件提醒：宠物动一下 + 一句固定文案的语音。提醒本身在主进程判，渲染层只收事件——
  // 轮询原来挂在生活面板那个组件上，停在别的面板就不会有新邮件可报
  notify: true,
  notifyVoice: true
};

function mask(plain) {
  return `${plain.length} 位 · 尾 ${plain.slice(-2)}`;
}

// 授权码的落盘：形状和 ai-key.js 一样（DPAPI、同机同用户才解得开），但校验规则、
// 文件名、提示语都跟着邮箱这条路走，所以留在本文件里，不去改动 AI 那套已经跑通的密钥。
class MailAuth {
  constructor(dir) {
    this.file = path.join(dir, AUTH_FILE);
    this.plain = null;
    this.load();
  }

  available() {
    return Boolean(safeStorage?.isEncryptionAvailable?.());
  }

  load() {
    let packed;
    try {
      packed = fs.readFileSync(this.file);
    } catch {
      return;
    }
    if (!this.available()) {
      console.warn('[mail] safeStorage 当前不可用，已保存的授权码暂时读不出来');
      return;
    }
    try {
      this.plain = safeStorage.decryptString(packed);
    } catch (err) {
      console.warn(`[mail] 授权码解密失败（${err.message}），需要重新填写`);
      this.plain = null;
    }
  }

  status() {
    return { set: Boolean(this.plain), hint: this.plain ? mask(this.plain) : null, encrypted: this.available() };
  }

  get() {
    return this.plain;
  }

  set(value) {
    if (!this.available()) return { ok: false, error: '本机 safeStorage 不可用，拒绝明文保存授权码' };
    const plain = typeof value === 'string' ? value.trim() : '';
    if (!plain) return { ok: false, error: '授权码是空的' };
    if (!/^[A-Za-z0-9]{8,64}$/.test(plain)) {
      return { ok: false, error: '看着不像授权码：应是 8–64 位连续字母数字（163 给的是 16 位小写字母），中间不能有空格' };
    }
    const packed = safeStorage.encryptString(plain);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, packed);
    } catch (err) {
      return { ok: false, error: `写入失败：${err.message}` };
    }
    this.plain = plain;
    return { ok: true, ...this.status() };
  }

  clear() {
    this.plain = null;
    try {
      fs.unlinkSync(this.file);
    } catch {}
    return { ok: true, ...this.status() };
  }
}

class Mail {
  // clientFactory / openExternal / getAuth / onEvent 是留给离线自检的接缝：注入一个假客户端 + 一个假授权码，
  // 就能验「取哪几封、怎么排序、错误怎么翻成人话、什么时候报新邮件」，一台真邮箱都不用碰。应用里走默认值。
  constructor({ getConfig, dir, clientFactory, openExternal, getAuth, onEvent } = {}) {
    this.getConfig = getConfig || (() => ({}));
    this.auth = dir ? new MailAuth(dir) : null;
    this.getAuth = getAuth || (() => this.auth?.get() || null);
    this.createClient = clientFactory || ((options) => new ImapFlow(options));
    this.openExternal = openExternal || ((url) => shell?.openExternal(url));
    this.emitEvent = onEvent || (() => {});
    this.rows = [];
    this.stats = { unseen: 0, total: 0, window: 0 };
    this.fetchedAt = 0;
    this.lastError = null;
    this.client = null;
    this.pending = null;
    this.timer = null;
    // 新邮件的基线：uid 随到达递增，所以「比基线大」就是这一轮新到的。
    // null = 还没成功拉过——第一轮只打基线不播报，否则开机就被几十条未读一起喊。
    this.baseline = null;
  }

  cfg() {
    const raw = this.getConfig()?.mail || {};
    const out = {};
    for (const [key, value] of Object.entries(FALLBACK)) out[key] = raw[key] === undefined || raw[key] === null ? value : raw[key];
    // toolbar.config.json 是他手改的：空串不该把默认值抹没，主机/目录/网页地址一律兜回 FALLBACK
    out.host = String(out.host ?? '').trim() || FALLBACK.host;
    out.mailbox = String(out.mailbox ?? '').trim() || FALLBACK.mailbox;
    out.webmail = String(out.webmail ?? '').trim() || FALLBACK.webmail;
    out.account = String(out.account ?? '').trim();
    out.maxMessages = Math.max(1, Math.min(MAX_WINDOW, Number(out.maxMessages) || FALLBACK.maxMessages));
    out.port = Number(out.port) || (out.secure ? 993 : 143);
    out.timeoutMs = Math.max(3000, Number(out.timeoutMs) || FALLBACK.timeoutMs);
    out.pollMs = Math.max(0, Number(out.pollMs) || 0);
    out.notify = out.notify !== false;
    out.notifyVoice = out.notifyVoice !== false;
    return out;
  }

  // 错误对象翻成人话。两条规矩：授权码一定替掉（imapflow 有可能把命令原文带进 message），
  // 以及不抛裸错误码——他是靠这句话决定下一步点哪里的。
  errorText(err, cfg) {
    const message = String((err && (err.serverResponse || err.message)) || err || '未知错误');
    const secret = this.getAuth();
    const scrubbed = secret ? message.split(secret).join('••••') : message;
    const clipped = scrubbed.length > 300 ? `${scrubbed.slice(0, 300)}…` : scrubbed;
    const code = String((err && err.code) || '');

    if (/unsafe login/i.test(clipped)) {
      return '163 认为这次登录不安全：到网页邮箱 设置 → POP3/SMTP/IMAP 里确认「IMAP 服务」已开启，并使用那页给的授权密码';
    }
    if (code === 'EAUTH' || /authenticat|login failed|invalid credentials|\b535\b/i.test(clipped)) {
      return `登录被拒（账号 ${cfg.account}）：授权码不对，或没在网页设置里开启 IMAP 服务`;
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(code) || /getaddrinfo/i.test(clipped)) {
      return `域名解析失败：这台机器连不上 ${cfg.host}`;
    }
    if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket timeout|connection/i.test(`${code} ${clipped}`)) {
      return `连不上 ${cfg.host}:${cfg.port}：检查网络、防火墙或代理`;
    }
    if (/noMailboxSelected|does not exist|mailbox/i.test(`${code} ${clipped}`)) {
      return `打不开「${cfg.mailbox}」这个邮箱目录：163 的收件箱一般就叫 INBOX`;
    }
    return `邮箱读取失败：${clipped}`;
  }

  async ensureClient(cfg) {
    if (this.client?.connected) return this.client;
    const pass = this.getAuth();
    const client = this.createClient({
      host: cfg.host,
      port: cfg.port,
      secure: Boolean(cfg.secure),
      auth: { user: cfg.account, pass },
      logger: false,
      connTimeout: cfg.timeoutMs,
      greetingTimeout: cfg.timeoutMs,
      socketTimeout: cfg.timeoutMs,
      clientInfo: { name: 'screen-toolbar', version: '0.1', vendor: 'screen-toolbar' }
    });
    // 没人听 'error' 的话，imapflow 会把异常冒到主进程顶层（Electron 弹模态框，run.log 干干净净）。
    // 这里只记账，真正的返回路径是下面 await 的那几条。
    client.on('error', (err) => {
      this.lastError = this.errorText(err, cfg);
    });
    await client.connect();
    this.client = client;
    return client;
  }

  async dropClient() {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {}
    }
  }

  // imapflow 把 ENVELOPE 收在 msg.envelope 里（from/subject/date 全在里面），不是平铺在 msg 上。
  // 平铺读法每一条都落到兜底文案，症状是「整屏未知发件人 /（无主题）」，看着像邮箱坏了。
  // date 能解析时是 Date，服务器给的日期串认不出来时是原样字符串；subject/from 缺字段就不存在。
  rowOf(msg) {
    const env = msg.envelope || {};
    const from = Array.isArray(env.from) && env.from.length ? env.from[0] : null;
    const at = env.date instanceof Date ? env.date : new Date(env.date ?? 0);
    const stamp = Number.isFinite(at.getTime()) ? at.getTime() : 0;
    const flags = msg.flags instanceof Set ? msg.flags : new Set(msg.flags || []);
    return {
      seq: Number(msg.seq) || 0,
      uid: Number(msg.uid) || 0,
      name: from?.name || from?.address || '未知发件人',
      address: from?.address || '',
      subject: env.subject || '（无主题）',
      date: stamp,
      unseen: !flags.has('\\Seen')
    };
  }

  // 取收件箱尾部 maxMessages 封的头部：序列号是到达顺序，所以窗口是 total-N+1 : *。
  // 未读数走 SEARCH UNSEEN（整箱口径），不是「这一窗里几条没读」——两个数他会分开问。
  async pull(cfg) {
    const client = await this.ensureClient(cfg);
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      const total = Number(client.mailbox?.exists) || 0;
      const rows = [];
      if (total > 0) {
        const from = Math.max(1, total - cfg.maxMessages + 1);
        for await (const msg of client.fetch(`${from}:*`, { envelope: true, flags: true, source: false })) {
          rows.push(this.rowOf(msg));
        }
      }
      // 最新的在前：他打开这一格先看的是「刚来了什么」，不是「最老的那封还在不在」
      rows.sort((a, b) => b.date - a.date || b.seq - a.seq);
      let unseen = 0;
      try {
        const ids = await client.search({ unseen: true });
        unseen = Array.isArray(ids) ? ids.length : 0;
      } catch {
        unseen = rows.filter((row) => row.unseen).length;
      }
      this.rows = rows.map((row, id) => ({ ...row, id }));
      this.stats = { unseen, total, window: rows.length };
      this.fetchedAt = Date.now();
      this.lastError = null;
      const news = this.noteNew();
      this.emitEvent('mail:updated', { at: this.fetchedAt, stats: this.stats });
      if (news && cfg.notify) this.emitEvent('mail:new', news);
      return { ok: true, rows: this.rows, stats: this.stats, account: cfg.account, fetchedAt: this.fetchedAt };
    } finally {
      lock.release();
    }
  }

  // 新邮件只看 uid：IMAP 的 uid 随到达递增，比基线大就是这一轮新到的。
  // 第一次成功拉取只把基线打下来、不播报——否则开机那一下会把几十条未读一起念出来。
  noteNew() {
    const maxUid = this.rows.reduce((max, row) => Math.max(max, Number(row.uid) || 0), 0);
    if (this.baseline === null || maxUid < this.baseline) {
      // 后者是 uid 空间整体变小（换了目录 / 邮箱被重建），「比基线大」这时候没有意义：重打基线，同样不播报
      this.baseline = maxUid;
      return null;
    }
    const fresh = this.rows.filter((row) => (Number(row.uid) || 0) > this.baseline);
    this.baseline = maxUid;
    if (!fresh.length) return null;
    const newest = fresh.reduce((a, b) => (b.uid > a.uid ? b : a));
    return {
      count: fresh.length,
      unseen: this.stats.unseen,
      total: this.stats.total,
      name: newest.name,
      at: this.fetchedAt
    };
  }

  // 看护轮询由主进程计时，不是挂在生活面板那个组件上——停在任何面板都要能发现新邮件。
  // applyPolling() 在每次「保存并应用」后调，所以改间隔不用重启应用。
  sync() {
    this.stop();
    const cfg = this.cfg();
    if (!cfg.enabled || !cfg.pollMs) return;
    this.timer = setInterval(() => { this.list(false).catch(() => {}); }, Math.max(MIN_POLL_MS, cfg.pollMs));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // 渲染层唯一的取数入口。force=false 时 60 秒内的结果直接复用；同一时刻只允许一条 IMAP 在飞。
  async list(force = false) {
    const cfg = this.cfg();
    if (!cfg.enabled) return { ok: false, rows: this.rows, stats: this.stats, error: '邮箱在设置里被关了' };
    if (!cfg.account || !cfg.account.includes('@')) {
      return { ok: false, rows: this.rows, stats: this.stats, error: '还没填邮箱地址（设置 → 邮箱 → 账号，要写全 xxx@163.com）' };
    }
    if (!this.getAuth()) {
      return { ok: false, rows: this.rows, stats: this.stats, error: '还没保存授权码（163 网页设置里那串「客户端授权密码」，不是登录密码）' };
    }
    if (!force && this.rows.length && Date.now() - this.fetchedAt < CACHE_TTL_MS) {
      return { ok: true, cached: true, rows: this.rows, stats: this.stats, account: cfg.account, fetchedAt: this.fetchedAt };
    }
    if (this.pending) return this.pending;
    this.pending = this.pull(cfg)
      .catch(async (err) => {
        this.lastError = this.errorText(err, cfg);
        // 连不上就把手里那条连接丢掉：下次点刷新是重新握手，而不是在一条死连接上再撞一次
        await this.dropClient();
        return { ok: false, rows: this.rows, stats: this.stats, stale: true, error: this.lastError };
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  // 只报状态，不碰网络（设置面板和组件的兜底文案用它）。
  status() {
    const cfg = this.cfg();
    return {
      supported: true,
      enabled: cfg.enabled,
      account: cfg.account,
      host: cfg.host,
      port: cfg.port,
      mailbox: cfg.mailbox,
      maxMessages: cfg.maxMessages,
      pollMs: cfg.pollMs,
      notify: cfg.notify,
      notifyVoice: cfg.notifyVoice,
      timeoutMs: cfg.timeoutMs,
      auth: this.auth ? this.auth.status() : { set: false, hint: null, encrypted: false },
      connected: Boolean(this.client?.connected),
      fetchedAt: this.fetchedAt,
      stats: this.stats,
      lastError: this.lastError
    };
  }

  setAuth(value) {
    if (!this.auth) return { ok: false, error: '本机没有可用的 userData 目录，拒绝保存授权码' };
    const result = this.auth.set(value);
    if (result.ok) {
      // 换码之后手里那条连接用的还是旧凭据，直接丢，下一次拉取重新握手
      this.dropClient().catch(() => {});
    }
    return result;
  }

  clearAuth() {
    const result = this.auth ? this.auth.clear() : { ok: false, error: '没有可清除的授权码' };
    this.dropClient().catch(() => {});
    return result;
  }

  // 交给系统浏览器：地址只从 config 读，渲染层递什么都不认
  openWebmail() {
    const cfg = this.cfg();
    if (!/^https?:\/\//i.test(cfg.webmail)) return { ok: false, error: `网页地址不像 URL：${cfg.webmail}` };
    Promise.resolve()
      .then(() => this.openExternal(cfg.webmail))
      .catch((err) => console.warn(`[mail] 打开网页邮箱失败：${err.message}`));
    return { ok: true, url: cfg.webmail };
  }

  dispose() {
    this.stop();
    this.dropClient().catch(() => {});
  }
}

module.exports = { Mail, MailAuth, FALLBACK, AUTH_FILE, CACHE_TTL_MS };
