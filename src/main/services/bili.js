// B 站（bilibili）只读列表：稍后再看 / 观看历史 / 我的收藏夹。
//
// 这一档**不播任何东西**。点一行只把 https://www.bilibili.com/video/<bvid> 交给系统浏览器（这台机器是 Edge），
// 和 Steam 那条 `steam://` 同一个套路：只保证「交出去了」，页面起没起这里看不到。
// 为什么不嵌进格子：B 站的流是 DASH 分片 + 签名地址 + 必须回 Referer，`<video src>` 吃不下；
// 要嵌只能开 webviewTag（当初为了不给远程内容攻击面明确关掉的那条），自己拉流又踩用户协议、
// 他们改一次签名算法就坏一周。会员内容还多一层 DRM，那个不碰。
//
// 三条纪律（和 QODER.md 硬纪律一一对上）：
//   1. 出网只发生在这里。渲染层 CSP 是 connect-src 'self' track:，它自己抓不到 api.bilibili.com。
//   2. 登录 cookie（SESSDATA）只存在 userData/bili-auth.bin（safeStorage / Windows DPAPI），
//      不进 toolbar.config.json、不进 state.json、不进日志、不跨 IPC 回传，只回一个 hint。
//      这一条和 163 授权码完全一样，填也由他自己填。
//   3. 渲染层只递 section 名 + 我们刚返回的那批 id。地址一律由主进程拼，
//      绝不接渲染层递进来的 URL、mid 或 folderId 之外的字符串。
//
// WBI 签名没实现，是实测决定的：2026-11 这台机器上 `x/v2/history/toview/web`、`x/v2/history`、
// `x/v3/fav/folder/created/list-all` 未登录都回 -101「账号未登录」而不是 -403，说明这三条不吃签名。
// 哪天他们改口径，错误会被翻成「B 站风控拦了」，见 ERRORS。

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const electron = require('electron');

// 离线自检（tools/bili-check.js）用普通 node 跑，那时候 require('electron') 只是个路径字符串，
// 这两个都解出 undefined。所以一律可选调用，不假设它们在。
const safeStorage = electron.safeStorage;
const shell = electron.shell;

const AUTH_FILE = 'bili-auth.bin';
const CACHE_TTL_MS = 60000;
const API_HOST = 'api.bilibili.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SECTIONS = new Set(['toview', 'history', 'fav']);
const MAX_ITEMS = 30; // 一次最多列多少行，写死上限（B 站 ps 给到 100 也没意义，格子只有那么高）

const ENDPOINTS = {
  nav: '/x/web-interface/nav',
  // /web 那条比老的 /toview 多回 bvid，翻页进度也在里面
  toview: '/x/v2/history/toview/web',
  history: '/x/v2/history',
  favFolders: '/x/v3/fav/folder/created/list-all',
  favItems: '/x/v3/fav/resource/list'
};

function mask(plain) {
  return `${plain.length} 位 · 尾 ${plain.slice(-2)}`;
}

// 他从浏览器里复制出来的常常是整串 cookie（`name=value; name2=value2`），也可能只粘 SESSDATA 的值。
// 两种都接下来，但只留 SESSDATA 那一个值——只读接口不需要 bili_jct（那是写操作要的 csrf）。
function extractSessdata(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return '';
  if (raw.includes('=')) {
    for (const part of raw.split(/;\s*/)) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      if (part.slice(0, eq).trim().toLowerCase() === 'sessdata') return part.slice(eq + 1).trim();
    }
    return '';
  }
  return raw;
}

// SESSDATA 的形状实测是「字母数字 + %2C + 偶尔一个 *」这一类，不含空格、分号、等号。
// 校验宽松一点（长度 16–256），但把明显粘错的东西挡住：带空格说明粘了带空格的整段文本，
// 带分号说明只粘了一半的 cookie 头。
function looksLikeSessdata(value) {
  return /^[\w.%*-]{16,256}$/.test(value);
}

// 授权码的落盘：形状和 mail.js 的 MailAuth 一样（DPAPI、同机同用户才解得开），
// 但校验规则、文件名、提示语跟着 B 站这条路走。
class BiliAuth {
  constructor(dir) {
    this.dir = dir;
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
      console.warn('[bili] safeStorage 当前不可用，已保存的登录 cookie 暂时读不出来');
      return;
    }
    try {
      this.plain = safeStorage.decryptString(packed);
    } catch (err) {
      console.warn(`[bili] 登录 cookie 解密失败（${err.message}），需要重新填写`);
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
    if (!this.available()) return { ok: false, error: '本机 safeStorage 不可用，拒绝明文保存登录 cookie' };
    const plain = extractSessdata(value);
    if (!plain) return { ok: false, error: '没找到 SESSDATA：粘整串 cookie（含 SESSDATA=…）或只粘它的值都行' };
    if (!looksLikeSessdata(plain)) {
      return { ok: false, error: '看着不像 SESSDATA：应是 16–256 位连续字符，中间不能有空格或分号' };
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
    } catch {
      /* 本来就没有文件 */
    }
    return { ok: true, ...this.status() };
  }
}

// 一次 HTTPS JSON 请求。出网全在这一层，渲染层碰不到。
function httpJson(url, { cookie, timeoutMs = 12000 } = {}) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          Referer: 'https://www.bilibili.com/',
          Accept: 'application/json, text/plain, */*',
          ...(cookie ? { Cookie: `SESSDATA=${cookie}` } : {})
        },
        timeout: timeoutMs
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve({ ok: false, error: `HTTP ${res.statusCode}` });
            return;
          }
          try {
            resolve({ ok: true, json: JSON.parse(body) });
          } catch {
            // 网关/风控页回的是 HTML，不是 JSON——这条要单独说，别报成「解析失败」让人以为程序坏了
            resolve({ ok: false, error: 'not-json' });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => resolve({ ok: false, error: err.code || err.message || 'error' }));
  });
}

// B 站的 code 是业务码，HTTP 200 也照样能回 -101。翻成人话，且不许把 cookie 带进文案。
function translate(code, message) {
  if (code === 0) return null;
  if (code === -101) return 'B 站不认这个登录状态（-101）：cookie 过期或无效，到设置 → Bilibili 重填 SESSDATA';
  if (code === -403 || code === -799) return `B 站风控拦了这次请求（${code}）：过一会儿再点「刷新」，别连着猛点`;
  if (code === -400) return 'B 站说这个请求不对（-400）';
  if (code === -352 || code === -412) return `B 站拒了这次访问（${code}）：可能要先在浏览器里过一次验证`;
  return `B 站回了 ${code}：${message || '没有说明'}`;
}

function clock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const pad = (n) => String(n).padStart(2, '0');
  return total >= 3600 ? `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}` : `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

// 封面是 https 的图片地址，CSP 的 img-src 本来就放了 https:（和相册的 file:// 一样不用改）。
// B 站给的是无扩展名的裸地址（…bilibili.com/xxx.jpg@… 这种带尺寸后缀的也照原样用）。
function coverUrl(pic) {
  const raw = typeof pic === 'string' ? pic.trim() : '';
  if (!raw || !/^https?:\/\//i.test(raw)) return '';
  // http:// 的封面在 https 页面里会被混合内容挡掉，直接升级
  return raw.replace(/^http:\/\//i, 'https://');
}

function videoRow(item, extra = {}) {
  const bvid = String(item?.bvid || item?.bv_id || item?.bvId || '').trim();
  const aid = Number(item?.aid || item?.id || 0) || 0;
  if (!bvid && !aid) return null;
  const title = String(item?.title || '').trim() || (bvid ? `视频 ${bvid}` : '（没标题）');
  return {
    kind: 'video',
    id: bvid ? `v:${bvid}` : `a:${aid}`,
    bvid: bvid || null,
    aid: aid || null,
    title,
    up: String(item?.owner?.name || item?.upper?.name || '').trim() || null,
    duration: Number.isFinite(item?.duration) ? item.duration : Number.isFinite(item?.video_duration) ? item.video_duration : null,
    // 稍后再看会带 progress（上次看到第几秒），历史/收藏没有
    seenAt: Number.isFinite(item?.progress) && item.progress > 0 ? item.progress : null,
    at: Number(item?.pubdate || item?.pubtime || item?.view_at || item?.uptime || item?.add_time || 0) || null,
    cover: coverUrl(item?.pic || item?.cover || item?.covers?.[0] || ''),
    ...extra
  };
}

function folderRow(item) {
  const id = Number(item?.id || item?.fid || 0) || 0;
  if (!id) return null;
  return {
    kind: 'folder',
    id: `f:${id}`,
    folderId: id,
    title: String(item?.title || '').trim() || `收藏夹 ${id}`,
    count: Number(item?.media_count || item?.count || 0) || 0,
    cover: coverUrl(item?.cover || ''),
    // 收藏夹的属主 mid 只用来拼我们自己的接口，不接受渲染层递进来的 mid
    mid: Number(item?.mid || item?.upper?.mid || 0) || null
  };
}

class Bili {
  constructor(options = {}) {
    const { dir, transport } = options;
    this.auth = new BiliAuth(dir);
    // 离线自检注入这里，真机跑的是上面那个 httpJson
    this.request = transport || httpJson;
    this.cache = new Map(); // section(+folderId) -> { at, rows, error }
    this.nav = null; // { logged, mid, uname } —— 只在问过一次之后才有
  }

  cookie() {
    return this.auth.get() || '';
  }

  status() {
    const auth = this.auth.status();
    return {
      ...auth,
      // logged 来自上一次真问过 nav（开机后第一次点刷新才有）；没问过时是 null，界面写「没查过」
      logged: this.nav ? this.nav.logged : null,
      uname: this.nav?.uname || null,
      mid: this.nav?.mid ?? null,
      hasCookie: Boolean(this.cookie())
    };
  }

  // 换 cookie 必须把「上次问过谁」和列表缓存一起丢掉，否则新 cookie 还会读到旧账号的收藏
  setAuth(value) {
    const result = this.auth.set(value);
    if (result.ok) this.flush();
    return result;
  }

  clearAuth() {
    const result = this.auth.clear();
    this.flush();
    return result;
  }

  // 设置卡片上那个「测一下」：真问一次 nav，只回登录态，凭据一个字节都不出去
  async check() {
    this.flush();
    const res = await this.ensureNav(true);
    if (res.error) return { ok: false, error: res.error };
    return { ok: true, ...this.status() };
  }

  async url(pathname, query = {}) {
    const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    const search = params.toString();
    const result = await this.request(`https://${API_HOST}${pathname}${search ? `?${search}` : ''}`, { cookie: this.cookie() });
    if (!result.ok) {
      // 这一条不许带上 URL 之外的任何东西；cookie 在 header 里，本来也进不了日志
      if (result.error === 'not-json') return { error: 'B 站回的不是 JSON（可能被网关或验证页拦了）' };
      if (/timeout|ETIMEDOUT/i.test(String(result.error))) return { error: '连 B 站超时（12 秒），检查网络后再点「刷新」' };
      if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|EHOSTUNREACH/i.test(String(result.error))) {
        return { error: `连不上 api.bilibili.com（${result.error}）` };
      }
      return { error: `连 B 站失败：${result.error}` };
    }
    const json = result.json || {};
    const error = translate(json.code, json.message);
    if (error) return { error, code: json.code };
    return { data: json.data };
  }

  // 先问 nav：它同时干两件事——确认 cookie 还有效、拿到自己的 mid（收藏夹接口要 up_mid）。
  // 未登录时 nav 回的是 code 0 + isLogin:false，所以不能只看 code。
  async ensureNav(force) {
    if (this.nav?.mid && !force) return { nav: this.nav };
    if (!this.cookie()) return { error: '还没填 B 站登录 cookie：设置 → Bilibili → SESSDATA（只加密存在本机 userData，不跟仓库走）' };
    const res = await this.url(ENDPOINTS.nav);
    if (res.error) return res;
    const data = res.data || {};
    this.nav = { logged: Boolean(data.isLogin), mid: Number(data.mid) || 0, uname: String(data.uname || '').trim() || null };
    if (!this.nav.logged) {
      this.nav = null;
      return { error: 'B 站说这个 cookie 没登录（isLogin:false）：到设置 → Bilibili 重填 SESSDATA' };
    }
    return { nav: this.nav };
  }

  key(section, folderId) {
    return folderId ? `${section}:${folderId}` : section;
  }

  // 主入口：section = toview | history | fav，fav 带 folderId 时列那个收藏夹里的视频
  async list(section, { force = false, folderId = null } = {}) {
    const name = SECTIONS.has(String(section)) ? String(section) : 'toview';
    const folder = Number(folderId) || 0;
    const at = this.key(name, folder || null);
    const cached = this.cache.get(at);
    if (cached && !force && Date.now() - cached.at < CACHE_TTL_MS) {
      return { ...cached, section: name, folderId: folder || null, cached: true };
    }

    const rows = await this.pull(name, folder);
    const entry = { at: Date.now(), ...rows };
    this.cache.set(at, entry);
    return { ...entry, section: name, folderId: folder || null, cached: false };
  }

  async pull(name, folder) {
    if (!this.cookie()) {
      return { rows: [], error: '还没填 B 站登录 cookie：设置 → Bilibili → SESSDATA（只加密存在本机 userData，不跟仓库走）' };
    }
    const nav = await this.ensureNav(false);
    if (nav.error) return { rows: [], error: nav.error };

    if (name === 'toview') {
      const res = await this.url(ENDPOINTS.toview);
      if (res.error) return { rows: [], error: res.error };
      const list = Array.isArray(res.data?.list) ? res.data.list : [];
      return { rows: list.slice(0, MAX_ITEMS).map((item) => videoRow(item)).filter(Boolean), total: list.length };
    }

    if (name === 'history') {
      const res = await this.url(ENDPOINTS.history, { pn: 1, ps: MAX_ITEMS });
      if (res.error) return { rows: [], error: res.error };
      // 历史这条 data 直接就是数组（和别的接口不一样），别去找 data.list
      const list = Array.isArray(res.data) ? res.data : Array.isArray(res.data?.list) ? res.data.list : [];
      return { rows: list.slice(0, MAX_ITEMS).map((item) => videoRow(item, { viewAt: Number(item?.view_at || 0) || null })).filter(Boolean), total: list.length };
    }

    if (!folder) {
      const res = await this.url(ENDPOINTS.favFolders, { up_mid: nav.nav.mid });
      if (res.error) return { rows: [], error: res.error };
      const list = Array.isArray(res.data?.list) ? res.data.list : [];
      // 收藏夹这一层列的是「夹子」，点进去才列视频——一层导航，不是两个入口
      return { rows: list.map(folderRow).filter(Boolean), total: list.length };
    }

    const res = await this.url(ENDPOINTS.favItems, { media_id: folder, pn: 1, ps: MAX_ITEMS, platform: 'web' });
    if (res.error) return { rows: [], error: res.error };
    const list = Array.isArray(res.data?.medias) ? res.data.medias : [];
    return { rows: list.slice(0, MAX_ITEMS).map((item) => videoRow(item)).filter(Boolean), total: Number(res.data?.info?.media_count || 0) || list.length, folder };
  }

  // 交给浏览器：只认这次 list() 发出去的行 id，地址由主进程拼。
  // 渲染层递进来的任何字符串都到不了 shell.openExternal。
  open(id) {
    const row = this.byId(id);
    if (!row) return { ok: false, error: '这一行不在刚返回的列表里（先点「刷新」再点行）' };
    if (row.kind === 'folder') {
      const mid = row.mid || this.nav?.mid || 0;
      const url = `https://space.bilibili.com/${mid}/favlist?fid=${row.folderId}&ftype=create`;
      return this.external(url, `已交给浏览器打开收藏夹「${row.title}」`);
    }
    const url = row.bvid ? `https://www.bilibili.com/video/${row.bvid}` : `https://www.bilibili.com/video/av${row.aid}`;
    const tail = row.seenAt ? `，上次看到 ${clock(row.seenAt)}` : '';
    return this.external(url, `已交给浏览器打开「${row.title}」${tail}`);
  }

  external(url, toast) {
    // 兜一道：能交给系统的只可能是这两个站点的 https 地址
    if (!/^https:\/\/(www\.bilibili\.com\/video\/|space\.bilibili\.com\/\d+\/favlist)/.test(url)) {
      return { ok: false, error: '内部错误：要打开的地址形状不对' };
    }
    if (!shell?.openExternal) return { ok: false, error: '本机没有可用的 shell.openExternal' };
    shell.openExternal(url).then(
      () => {},
      (err) => console.warn(`[bili] 交给浏览器失败：${err.message}`)
    );
    return { ok: true, toast };
  }

  byId(id) {
    for (const entry of this.cache.values()) {
      const hit = (entry.rows || []).find((row) => row.id === String(id));
      if (hit) return hit;
    }
    return null;
  }

  // 换 cookie、点「测一下」之前清一次：缓存里那些行是带标题的观看记录，
  // 账号一换就不能再让新账号读到旧账号的收藏和历史
  flush() {
    this.cache.clear();
    this.nav = null;
  }
}

module.exports = { Bili, BiliAuth, clock, coverUrl, extractSessdata, looksLikeSessdata, translate, videoRow, folderRow, AUTH_FILE, CACHE_TTL_MS, MAX_ITEMS, ENDPOINTS };
