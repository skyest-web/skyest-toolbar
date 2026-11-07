// 生活面板左侧那一整块（邮箱）的真机验证：附着到真实运行的工具栏（需带 --remote-debugging-port 启动）。
//
// 验的是「他眼睛看到的那一格」：
//   1) 点 tab 真的切到生活面板，leftzone 挂的是 mail，旧的 clock/player 不再存在；
//   2) 没配授权码时格子里直接写「去哪儿填」，而不是转圈或空白；
//   3) 列表的几何：头部/列表/页脚三段都在格子内，页脚永远露出来，长主题被省略号截断而不是撑破右边界，
//      字形矩形（Range 量的）不能被行高裁掉，列表自己滚且刚进来停在顶部；
//   4) 时间写法四种都对（几点 / 昨天 / 几月几日 / 跨年带年份）；
//   5) 「只看未读」「刷新」「网页邮箱」点下去各是什么，且这个组件一次都没调写侧的 IPC；
//   6) 切几次面板只剩一个轮询定时器（叠定时器会把 163 打到限流）。
//      —— 现在这条反过来验：轮询整个搬进了主进程，渲染层一条邮箱定时器都不许开，
//         onUpdated 只许绑一次，否则停在别的面板就永远不会有新邮件提醒。
//   7) 来了新邮件：宠物做一个动作 + 念一句固定模板，且 ai.* 一次都没被调用（这就是「不走 DeepSeek」）。
//
// IMAP 那一层全程换成只记账的替身：不发握手、不读真邮箱，也不需要他的授权码。
// 协议侧的形状由 tools/mail-check.js 离线验。
//
// 用法（Git Bash）:
//   1) unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
//   2) node tools/mail-appprobe.js [端口] [--shot] [--reload] [--watch[=秒]]
//      --shot：存 samples/mail-panel-fallback.png（真服务当前状态）和 -rows.png（替身数据）
//      --reload：改了渲染层代码后先重载一次页面，不用重启应用
//      --watch：收尾后再等主进程真推一条 mail:updated 过来，验的是通道本身，默认 200 秒
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv.slice(2).find((arg) => /^\d+$/.test(arg)) || 9223);
const SHOTS = process.argv.includes('--shot');
const RELOAD = process.argv.includes('--reload');
// --watch[=秒]：收尾后再等一条主进程真的推过来的 mail:updated（默认 200 秒，够跑一轮 120 秒的看护轮询）
const WATCH_ARG = process.argv.find((arg) => arg.startsWith('--watch'));
const WATCH = WATCH_ARG ? Number(WATCH_ARG.split('=')[1]) || 200 : 0;
const PAGE_ID = 'life';
const SLOT = 'leftzone';
const HOUR = 3600000;
const DAY = 86400000;
// 「不走 DeepSeek」这条只盯真会发消息的那两个口。ai.keyStatus 是一次本地配置读取（密钥存没存），
// refresh('ai') 每次渲染都会读一遍，它不联网、不烧 token，算进来就是自己给自己报错。
const ASK_MODEL = ['send', 'retry'];

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

function evaluate(target, expression, timeoutMs = 60000) {
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP 超时')); }, timeoutMs);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) reject(new Error(msg.error.message));
      else if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.text));
      else resolve(msg.result?.result?.value);
    });
    ws.on('error', reject);
  });
}

// 刚起来那几秒渲染层还没 boot 完，量不到别当失败，等它一等
async function evaluateReady(target, expression, tries = 30) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      const value = await evaluate(target, expression, 20000);
      if (typeof value === 'string' && value.startsWith('{')) return value;
      last = '渲染层还没就绪（返回为空）';
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`等渲染层就绪超时：${last}`);
}

function capture(target, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('截图超时')); }, 30000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }));
      ws.send(JSON.stringify({ id: 2, method: 'Page.captureScreenshot', params: { format: 'png' } }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id === 2 && msg.result) {
        clearTimeout(timer);
        fs.writeFileSync(file, Buffer.from(msg.result.data, 'base64'));
        ws.close();
        resolve(file);
      }
    });
    ws.on('error', reject);
  });
}

const MEASURE = `(() => {
  if (!TB?.app?.state?.grid) throw new Error('渲染层还没 boot 完');
  const sec = document.querySelector('#shell > section[data-slot="${SLOT}"]');
  const host = document.getElementById('mail');
  const list = host?.querySelector('.ml-list');
  const rows = [...(list?.querySelectorAll('.ml-item') || [])];
  const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  // 字形矩形自己量，不量容器：容器上写 overflow:hidden 会在自动行高里把内容盒塌成 0，
  // DOM 全在、探针全绿，人却看不清（游戏面板那一格踩过一次，这里照同样的规矩来）。
  const glyphOf = (row) => {
    if (!row) return null;
    const name = row.querySelector('.ml-from');
    if (!name) return null;
    const range = document.createRange();
    range.selectNodeContents(name);
    const t = range.getBoundingClientRect();
    const p = row.getBoundingClientRect();
    return { h: Math.round(t.height * 10) / 10, top: Math.round(t.top - p.top), bottomGap: Math.round(p.bottom - t.bottom), rowH: Math.round(p.height) };
  };
  const style = list ? getComputedStyle(list) : null;
  return JSON.stringify({
    activePage: TB.app.state.page,
    registered: TB.components.has('mail'),
    module: sec?.dataset.module || null,
    leftovers: ['clock', 'player'].filter((at) => document.querySelector(\`#shell > section[data-slot="\${at}"]\`)),
    count: document.querySelector('#mail .ml-count')?.textContent ?? null,
    foot: document.querySelector('#mail .ml-who')?.textContent ?? null,
    footTitle: document.querySelector('#mail .ml-who')?.title ?? null,
    notes: [...(host?.querySelectorAll('.ml-note') || [])].map((n) => n.textContent),
    domRows: rows.length,
    domUnread: rows.filter((r) => r.classList.contains('unread')).length,
    dots: (host?.querySelectorAll('.ml-dot') || []).length,
    firstText: rows[0] ? { from: rows[0].querySelector('.ml-from').textContent, when: rows[0].querySelector('.ml-when').textContent, subject: rows[0].querySelector('.ml-subject').textContent } : null,
    whenAll: rows.map((r) => r.querySelector('.ml-when').textContent),
    titleTip: rows[0]?.title ?? null,
    glyph: glyphOf(rows[0]),
    fromFontPx: rows.length ? Math.round(parseFloat(getComputedStyle(rows[0].querySelector('.ml-from')).fontSize) * 10) / 10 : null,
    subjectFontPx: rows.length ? Math.round(parseFloat(getComputedStyle(rows[0].querySelector('.ml-subject')).fontSize) * 10) / 10 : null,
    ellipsis: [...(host?.querySelectorAll('.ml-from, .ml-subject') || [])].filter((n) => n.scrollWidth > n.clientWidth + 1).length,
    secBox: box(sec),
    hostBox: box(host),
    headBox: box(host?.querySelector('.ml-head')),
    listBox: box(list),
    footBox: box(host?.querySelector('.ml-foot')),
    rowBox: box(rows[0]),
    lastRowBox: box(rows[rows.length - 1]),
    wideRows: list ? [...list.querySelectorAll('.ml-item')].filter((n) => n.getBoundingClientRect().right > list.getBoundingClientRect().right + 1).length : 0,
    listStyle: style ? { overflowY: style.overflowY, sh: Math.round(list.scrollHeight), ch: Math.round(list.clientHeight), scrollTop: Math.round(list.scrollTop), anchor: style.overflowAnchor } : null,
    hostClip: host ? Math.round(host.scrollHeight - host.getBoundingClientRect().height) : null,
    secClip: sec ? Math.round(sec.scrollHeight - sec.getBoundingClientRect().height) : null
  });
})()`;

// 替身给的那批行：4 种时间写法各占一行，一条超长主题、一条无主题、每 4 条一封未读
function fakeRows() {
  const now = Date.now();
  const dateOf = (i) => {
    if (i === 0) return now - 60000;
    if (i === 3) return now - DAY;
    if (i === 5) return now - 120 * DAY;
    if (i === 7) return now - 500 * DAY;
    return now - i * HOUR;
  };
  return Array.from({ length: 25 }, (_, i) => ({
    id: i,
    seq: 300 - i,
    uid: 9000 - i,
    name: i === 0 ? '招商银行信用卡中心 · 账单与还款提醒' : `发件人${i}`,
    address: `sender${i}@163.com`,
    subject: i === 1
      ? '这是一封主题特别长的邮件，用来验证它会被省略号截断而不是把这一格的右边撑破，所以还得再长一点才够长'
      : i === 2
        ? '（无主题）'
        : `主题 ${i}`,
    date: dateOf(i),
    unseen: i % 4 === 0
  }));
}

async function main() {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((item) => item.type === 'page' && item.url.includes('renderer/index.html'));
  if (!page) throw new Error(`CDP 端口 ${PORT} 上找不到工具栏渲染层，先跑: ./node_modules/electron/dist/electron.exe . --remote-debugging-port=${PORT}`);

  const failures = [];
  // 改了渲染层代码/样式后不用重启应用：--reload 走一次 Page.reload，新代码立刻生效
  // （这一段验的宠物动作抢占就在渲染层，不重载量的还是旧 behaviour）
  if (RELOAD) {
    await evaluate(page, `setTimeout(() => location.reload(), 0); 'reloading'`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    console.log('已重载渲染层（--reload）');
  }
  const boot = JSON.parse(await evaluateReady(page, MEASURE));
  if (!boot.registered) failures.push('组件注册表里没有 "mail"（loader 没注入 src/renderer/js/components/mail.js？）');

  // 先问一句真配成什么样了：账号或授权码缺一个，主进程就不会去握手，这一趟就真的一个包都不发；
  // 两个都配好了（他已经填过授权码）时，兜底那两条断言不该再套上去——本探针自己不主动强制真连接。
  const realStatus = JSON.parse(await evaluate(page, `(async () => {
    const st = await TB.api.mail.status();
    return JSON.stringify({ account: st.account || '', authSet: Boolean(st.auth?.set), enabled: Boolean(st.enabled), host: st.host, port: st.port, pollMs: st.pollMs });
  })()`));
  const configured = realStatus.account && realStatus.authSet;
  console.log(`主进程现状：账号「${realStatus.account || '未填'}」@ ${realStatus.host}:${realStatus.port}，授权码${realStatus.authSet ? '已存' : '没存'}，开关${realStatus.enabled ? '开' : '关'}，轮询 ${realStatus.pollMs}ms${configured ? '（已配好：跳过兜底文案断言，本探针不强制真握手）' : ''}`);

  // ---------- 1. 真点 tab 切过去：leftzone 挂 mail，旧的 clock/player 不在了 ----------
  await evaluate(page, `document.querySelector('.topbar .page-tab[data-page="${PAGE_ID}"]').click();'ok'`);
  const out = JSON.parse(await evaluateReady(page, MEASURE));
  console.log(`面板 ${out.activePage} / ${SLOT} => ${out.module}（旧格子残留：${out.leftovers.join(',') || '无'}）`);
  console.log(`计数牌「${out.count}」/ 页脚「${out.foot}」/ 列表 ${out.listStyle?.ch}px 可视 · ${out.listStyle?.sh}px 内容 · scrollTop ${out.listStyle?.scrollTop}`);
  console.log(`格子 ${out.secBox?.w}x${out.secBox?.h} @(${out.secBox?.x},${out.secBox?.y})`);

  if (out.activePage !== PAGE_ID) failures.push(`点 tab 没切到 "${PAGE_ID}"，还在 "${out.activePage}"`);
  if (out.module !== 'mail') failures.push(`「${SLOT}」这格挂的是 "${out.module}"，layout.json 里生活面板左侧那一整块应写 "mail"`);
  if (out.leftovers.length) failures.push(`生活面板还留着旧格子 "${out.leftovers.join(',')}"：clock 和 player 本该合成 leftzone`);

  // ---------- 2. 没配好时格子里直接说清去哪儿填（而不是转圈或空白） ----------
  if (!configured) {
    if (!out.notes.length) failures.push('没填授权码时列表是空白的：他不知道该去哪里配');
    else if (!/设置 → 邮箱|授权码|账号/.test(out.notes.join(' '))) failures.push(`兜底文案没指出去哪儿配：${JSON.stringify(out.notes)}`);
    if (out.count !== '未就绪') failures.push(`主进程还没给数据时计数牌是「${out.count}」，应是「未就绪」`);
    if (out.domRows) failures.push(`还没配好就已经渲染了 ${out.domRows} 行`);
  }
  if (SHOTS) {
    try {
      const file = path.join(APP_ROOT, 'samples', 'mail-panel-fallback.png');
      await capture(page, file);
      console.log(`截图 ${file}`);
    } catch (error) {
      console.log(`截图失败（不影响功能判定）：${error.message}`);
    }
  }

  // ---------- 3. 换成记账替身，喂一批形状齐全的数据 ----------
  const rows = fakeRows();
  const status = { supported: true, enabled: true, account: 'abc@163.com', host: 'imap.163.com', port: 993, mailbox: 'INBOX', maxMessages: 20, pollMs: 120000, timeoutMs: 20000, auth: { set: true, hint: '16 位 · 尾 qz', encrypted: true }, connected: false, fetchedAt: Date.now(), stats: { unseen: 7, total: 300, window: 25 }, lastError: null };
  const payloads = {
    list: { ok: true, rows, stats: { unseen: 7, total: 300, window: 25 }, account: 'abc@163.com', fetchedAt: Date.now() },
    error: { ok: false, rows: [], stats: {}, error: '还没保存授权码（163 网页设置里那串「客户端授权密码」，不是登录密码）' },
    stale: { ok: false, stale: true, rows: rows.slice(0, 6), stats: { unseen: 2, total: 300, window: 6 }, fetchedAt: Date.now() - 3 * DAY, error: '连不上 imap.163.com:993：检查网络、防火墙或代理' },
    empty: { ok: true, rows: [], stats: { unseen: 0, total: 0, window: 0 }, account: 'abc@163.com', fetchedAt: Date.now() }
  };
  const dry = JSON.parse(await evaluate(page, `(async () => {
    const real = TB.api;
    // deskToolbar 是 contextBridge 造的，属性只读且不可配置，Proxy 拦不住（会直接抛）。
    // 所以把键浅拷成一份普通对象，只换掉 mail / voice / ai 这三层。
    const wrap = (overlays) => { const copy = {}; for (const key of Object.keys(real)) copy[key] = real[key]; Object.assign(copy, overlays); return copy; };
    const calls = [];
    const spoken = [];
    const aiCalls = [];
    const handlers = { updated: [], new: [] };
    const payloads = ${JSON.stringify(payloads)};
    const status = ${JSON.stringify(status)};
    const fake = {
      status: () => { calls.push('status'); return Promise.resolve(status); },
      list: (force) => { calls.push(\`list:\${force ? 'force' : 'cache'}\`); return Promise.resolve(payloads.next || payloads.list); },
      openWebmail: () => { calls.push('openWebmail'); return Promise.resolve({ ok: true, url: 'https://mail.163.com' }); },
      setAuth: (v) => { calls.push('setAuth'); return Promise.resolve({ ok: true }); },
      clearAuth: () => { calls.push('clearAuth'); return Promise.resolve({ ok: true }); },
      // 主进程那两条推送的订阅口：记下 handler，探针自己按次数调用，顺便数「绑了几次」
      onUpdated: (handler) => { handlers.updated.push(handler); },
      onNew: (handler) => { handlers.new.push(handler); }
    };
    // 语音只换 speak：返回 ok:false 让 TB.voice 的分句循环干净地停下，不播任何音频
    const voiceSpy = Object.assign({}, real.voice, {
      speak: (sentence) => { spoken.push(sentence); return Promise.resolve({ ok: false }); }
    });
    // AI 那一层逐个函数记账：提醒这条链路一次都不该走到 DeepSeek
    const aiSpy = {};
    for (const key of Object.keys(real.ai)) {
      aiSpy[key] = typeof real.ai[key] === 'function'
        ? (...args) => { aiCalls.push(key); return real.ai[key](...args); }
        : real.ai[key];
    }
    TB.api = wrap({ mail: fake, voice: voiceSpy, ai: aiSpy });
    window.__mailDry = { real, calls, fake, payloads, handlers, spoken, aiCalls };
    TB.mail.onlyUnread = false;
    // 开机时组件已经用真 API 绑过一条 onUpdated，bound 守卫会挡住第二次绑定。
    // 这里把它放开：下一次 init 才会绑到替身身上，探针才推得动、也才数得到「只绑一次」。
    // 真 API 那条监听解不掉，但主进程 120 秒才推一次，这一段几百毫秒的窗口里撞不上。
    // 收尾时不再放开它（bound 保持 true），所以恢复真 API 后仍然是开机那一条监听在跑。
    TB.mail.bound = false;
    // 页脚的账号、轮询间隔都来自 status()，所以这一步也要换成替身给的，否则量的还是真配置
    TB.mail.status = await fake.status();
    await TB.mail.load(true);
    return JSON.stringify({ calls: [...calls], armTimerGone: typeof TB.mail.armTimer === 'undefined' });
  })()`));
  console.log(`装上替身 => ${JSON.stringify(dry.calls)}（一个 IMAP 包都不发；组件自己不再计时：armTimer ${dry.armTimerGone ? '已移除' : '还在'}）`);
  if (!dry.armTimerGone) failures.push('渲染层组件还留着 armTimer：轮询必须只剩主进程那一条，否则停在别的面板就收不到提醒、切回这一格又会多一条');

  // ---------- 4. 列表几何：三段都不出格子，页脚永远露出来，长主题被截断 ----------
  const shot = JSON.parse(await evaluateReady(page, MEASURE));
  console.log(`喂数据后 ${shot.domRows} 行（未读 ${shot.domUnread}），计数牌「${shot.count}」，页脚「${shot.foot}」，省略号 ${shot.ellipsis} 处`);
  console.log(`首行「${shot.firstText?.from} / ${shot.firstText?.when} / ${shot.firstText?.subject}」，行高 ${shot.glyph?.rowH}px（字形 ${shot.glyph?.h}px，上留 ${shot.glyph?.top}、下留 ${shot.glyph?.bottomGap}）`);

  if (shot.domRows !== 25) failures.push(`喂了 25 行，DOM 只渲染 ${shot.domRows} 行`);
  if (shot.domUnread !== 7) failures.push(`未读标记 ${shot.domUnread} 行，数据里是 7 行`);
  if (shot.dots !== shot.domRows) failures.push(`${shot.domRows} 行只有 ${shot.dots} 个未读圆点占位`);
  if (shot.count !== '未读 7 · 共 300') failures.push(`计数牌说的是「${shot.count}」，应是「未读 7 · 共 300」`);
  if (shot.foot !== 'abc@163.com') failures.push(`页脚账号是「${shot.foot}」`);
  if (!shot.footTitle?.includes('未读数取整箱')) failures.push(`页脚提示没解释「未读按整箱算」：${JSON.stringify(shot.footTitle)}`);
  if (shot.notes.length) failures.push(`正常数据里还留着提示条：${JSON.stringify(shot.notes)}`);
  if (!shot.titleTip?.includes('未读') || !shot.titleTip.includes('序号 0')) failures.push(`行提示没写清已读/未读或序号：${JSON.stringify(shot.titleTip)}`);

  // 四种时间写法：几点 / 昨天 / 几月几日 / 跨年带年份
  const when = shot.whenAll || [];
  if (!/^\d{2}:\d{2}$/.test(when[0] || '')) failures.push(`今天那封的时间不是「时:分」：${JSON.stringify(when[0])}`);
  if (when[3] !== '昨天') failures.push(`昨天那封写的是 ${JSON.stringify(when[3])}`);
  if (!/^\d{1,2}月\d{1,2}日$/.test(when[5] || '')) failures.push(`今年早些那封写的是 ${JSON.stringify(when[5])}`);
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(when[7] || '')) failures.push(`跨年那封没带年份：${JSON.stringify(when[7])}`);

  if (shot.glyph) {
    if (shot.glyph.top < 0 || shot.glyph.bottomGap < 1) failures.push(`发件人被行高裁掉了：行 ${shot.glyph.rowH}px，字形 ${shot.glyph.h}px，上留 ${shot.glyph.top}、下留 ${shot.glyph.bottomGap}`);
    if (shot.glyph.h < 12) failures.push(`发件人字形只有 ${shot.glyph.h}px，低于 12px 的可读下限`);
  } else failures.push('一行都没量到字形矩形');
  if (shot.fromFontPx !== null && shot.fromFontPx < 12) failures.push(`发件人字号 ${shot.fromFontPx}px 偏小`);
  if (shot.subjectFontPx !== null && shot.subjectFontPx < 12) failures.push(`主题字号 ${shot.subjectFontPx}px 偏小`);
  if (shot.ellipsis < 1) failures.push('那条超长主题/长发件人没有被省略号截断（要么撑破了，要么数据没进去）');

  if (shot.secBox && shot.footBox && shot.footBox.bottom > shot.secBox.bottom + 1) failures.push(`页脚掉到格子外面：${shot.footBox.bottom} > ${shot.secBox.bottom}`);
  if (shot.listBox && shot.footBox && shot.listBox.bottom > shot.footBox.top + 1) failures.push('列表压到页脚上了：两者上下重叠');
  if (shot.hostClip > 1) failures.push(`#mail 内容比自己高 ${shot.hostClip}px，底部会被裁掉`);
  if (shot.secClip > 1) failures.push(`「${SLOT}」格里内容超了 ${shot.secClip}px`);
  if (shot.wideRows) failures.push(`${shot.wideRows} 行的右边缘越过列表可视宽度，会被 .area 裁掉`);
  if (shot.listStyle?.overflowY !== 'auto') failures.push(`列表不是自己滚的：overflow-y=${shot.listStyle?.overflowY}`);
  if (shot.listStyle?.anchor !== 'none') failures.push(`列表没关掉滚动锚定（overflow-anchor=${shot.listStyle?.anchor}）：重绘时会被弹到底部`);
  if (shot.listStyle?.scrollTop > 2) failures.push(`刚进这一格列表就停在 ${shot.listStyle.scrollTop}px（该在顶部）`);
  if (shot.listStyle && !(shot.listStyle.sh > shot.listStyle.ch)) failures.push(`25 行还没有超出可视高度（内容 ${shot.listStyle.sh} ≤ 可视 ${shot.listStyle.ch}），这一格能显示多少行？`);
  if (shot.rowBox && shot.secBox && shot.rowBox.bottom > shot.secBox.bottom + 1) failures.push(`第一行本身就在格子外面：${shot.rowBox.bottom} > ${shot.secBox.bottom}`);

  if (SHOTS) {
    try {
      const file = path.join(APP_ROOT, 'samples', 'mail-panel-rows.png');
      await capture(page, file);
      console.log(`截图 ${file}（列表数据来自替身，不是真邮箱）`);
    } catch (error) {
      console.log(`截图失败（不影响功能判定）：${error.message}`);
    }
  }

  // ---------- 5. 三个按钮各干什么 + 「只读」这条纪律 ----------
  const clickDry = JSON.parse(await evaluate(page, `(async () => {
    const { calls, payloads } = window.__mailDry;
    const before = calls.length;
    const list = document.querySelector('#mail .ml-list');
    list.scrollTop = 99999;
    const scrolled = Math.round(list.scrollTop);
    list.scrollTop = 0;
    const rows = [...document.querySelectorAll('#mail .ml-item')];
    const unreadBtn = [...document.querySelectorAll('#mail .ml-head .link-btn')].find((b) => b.textContent === '只看未读');
    const shots = [];
    unreadBtn.click();
    shots.push({ dom: document.querySelectorAll('#mail .ml-item').length, on: unreadBtn.classList.contains('on') });
    unreadBtn.click();
    shots.push({ dom: document.querySelectorAll('#mail .ml-item').length, on: unreadBtn.classList.contains('on') });
    // #toast 是堆叠的（活 3.1 秒），先清空再点，读到的才是这一次的效果
    document.getElementById('toast').innerHTML = '';
    const toastBefore = document.querySelectorAll('#toast .toast').length;
    rows[0].click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const stack = [...document.querySelectorAll('#toast .toast')].map((n) => n.textContent);
    const toast = stack[stack.length - 1] || null;
    const toastAdded = stack.length > toastBefore;
    document.getElementById('toast').innerHTML = '';
    payloads.next = payloads.error;
    document.querySelector('#mail .ml-head .link-btn:last-child').click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const afterRefresh = { count: document.querySelector('#mail .ml-count').textContent, notes: [...document.querySelectorAll('#mail .ml-note')].map((n) => n.textContent) };
    document.querySelector('#mail .ml-foot .link-btn').click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    return JSON.stringify({ scrolled, shots, toast, toastAdded, afterRefresh, newCalls: calls.slice(before) });
  })()`));
  console.log(`只看未读 => ${clickDry.shots[0].dom} 行（按钮高亮 ${clickDry.shots[0].on}），再点 => ${clickDry.shots[1].dom} 行（高亮 ${clickDry.shots[1].on}）；点行 toast「${clickDry.toast}」；刷新后「${clickDry.afterRefresh.count}」+${JSON.stringify(clickDry.afterRefresh.notes)}`);
  console.log(`点击序列（IPC 记账）=> ${JSON.stringify(clickDry.newCalls)}，滚到底 scrollTop=${clickDry.scrolled}`);

  if (!(clickDry.scrolled > 0)) failures.push('列表滚不动：滚动条没生效，超出的行看不到');
  if (clickDry.shots[0].dom !== 7 || clickDry.shots[0].on !== true) failures.push(`「只看未读」后 ${clickDry.shots[0].dom} 行（应 7 行）、按钮高亮 ${clickDry.shots[0].on}`);
  if (clickDry.shots[1].dom !== 25 || clickDry.shots[1].on !== false) failures.push(`再点一次「只看未读」没切回全部：${clickDry.shots[1].dom} 行、高亮 ${clickDry.shots[1].on}`);
  if (!/未读|已读/.test(clickDry.toast || '')) failures.push(`点一行什么都没提示：${JSON.stringify(clickDry.toast)}`);
  if (!clickDry.toastAdded) failures.push('点行没有 toast 反馈');
  if (!clickDry.afterRefresh.notes.some((t) => /授权码/.test(t))) failures.push(`主进程报错时格子里没写原因：${JSON.stringify(clickDry.afterRefresh.notes)}`);
  if (clickDry.afterRefresh.count !== '未就绪') failures.push(`报错时计数牌是「${clickDry.afterRefresh.count}」`);
  if (!clickDry.newCalls.includes('list:force')) failures.push(`点「刷新」没按 force 重拉：${JSON.stringify(clickDry.newCalls)}`);
  if (!clickDry.newCalls.includes('openWebmail')) failures.push('点「网页邮箱」没走到主进程');
  if (clickDry.newCalls.some((c) => c === 'setAuth' || c === 'clearAuth')) failures.push(`这个只读组件调了写侧的 IPC：${JSON.stringify(clickDry.newCalls)}`);
  // 点行、点标签都不该再发一次 list：只读组件不能顺手把邮件标成已读
  if (clickDry.newCalls.filter((c) => c.startsWith('list')).length !== 1) failures.push(`一次刷新触发了 ${clickDry.newCalls.filter((c) => c.startsWith('list')).length} 次 list（点行不该再拉一遍）`);

  // ---------- 6. 报错但手里还有旧结果：两句都要说，旧行还得能看 ----------
  const stale = JSON.parse(await evaluate(page, `(async () => {
    const { payloads } = window.__mailDry;
    payloads.next = payloads.stale;
    await TB.mail.load(true);
    return JSON.stringify({
      count: document.querySelector('#mail .ml-count').textContent,
      notes: [...document.querySelectorAll('#mail .ml-note')].map((n) => n.textContent),
      dom: document.querySelectorAll('#mail .ml-item').length
    });
  })()`));
  console.log(`带旧结果的失败 => 「${stale.count}」/ ${JSON.stringify(stale.notes)} / ${stale.dom} 行`);
  if (stale.dom !== 6) failures.push(`失败时旧列表被清空了：${stale.dom} 行`);
  if (!stale.notes.some((t) => /连不上 imap/.test(t))) failures.push(`失败原因没写进格子里：${JSON.stringify(stale.notes)}`);
  if (!stale.notes.some((t) => /旧结果/.test(t))) failures.push('没告诉他现在看的是上次的旧结果');

  // 两种「列表里没东西」要分开说：箱子里真没信 vs 信都读完了（后者是他开了「只看未读」）
  const notes2 = JSON.parse(await evaluate(page, `(async () => {
    const { payloads } = window.__mailDry;
    const allSeen = { ok: true, rows: payloads.list.rows.map((row) => ({ ...row, unseen: false })), stats: { unseen: 0, total: 300, window: 25 } };
    TB.mail.onlyUnread = true;
    payloads.next = allSeen;
    await TB.mail.load(true);
    const allRead = { note: document.querySelector('#mail .ml-note')?.textContent || null, dom: document.querySelectorAll('#mail .ml-item').length };
    TB.mail.onlyUnread = false;
    payloads.next = payloads.empty;
    await TB.mail.load(true);
    const emptyBox = { note: document.querySelector('#mail .ml-note')?.textContent || null, dom: document.querySelectorAll('#mail .ml-item').length, count: document.querySelector('#mail .ml-count').textContent };
    payloads.next = payloads.list;
    await TB.mail.load(true);
    return JSON.stringify({ allRead, emptyBox, back: document.querySelectorAll('#mail .ml-item').length });
  })()`));
  console.log(`都读完了 => 「${notes2.allRead.note}」/${notes2.allRead.dom} 行；空箱 => 「${notes2.emptyBox.note}」/${notes2.emptyBox.dom} 行，计数牌「${notes2.emptyBox.count}」；恢复 ${notes2.back} 行`);
  if (notes2.allRead.dom !== 0 || notes2.allRead.note !== '没有未读的邮件') failures.push(`只看未读却没有未读时说的是「${notes2.allRead.note}」（${notes2.allRead.dom} 行）`);
  if (notes2.emptyBox.note !== '收件箱是空的') failures.push(`空收件箱说的是「${notes2.emptyBox.note}」`);
  if (notes2.emptyBox.count !== '全读完 · 共 0') failures.push(`空箱时计数牌是「${notes2.emptyBox.count}」`);
  if (notes2.back !== 25) failures.push(`换回正常数据后只剩 ${notes2.back} 行`);

  // ---------- 7. 轮询搬进主进程之后：渲染层一条邮箱定时器都不该开 ----------
  // 原来这一格自己 setInterval——停在别的面板就没有轮询，也就没有提醒；现在换成主进程看护 + 事件推送。
  // 两条都要守住：① 切几次面板都不开出 pollMs 那个间隔的定时器；② onUpdated 只绑一次（绑两次一次推送取两遍数据）。
  const timers = JSON.parse(await evaluate(page, `(async () => {
    const realSet = window.setInterval;
    const realClear = window.clearInterval;
    const created = new Map();
    window.setInterval = (fn, ms) => { const id = realSet(fn, ms); created.set(id, ms); return id; };
    window.clearInterval = (id) => { created.delete(id); return realClear(id); };
    const want = Math.max(30000, Number(TB.mail.status.pollMs) || 0);
    for (const at of ['home', 'life', 'work', 'life', 'home', 'life']) {
      document.querySelector(\`.topbar .page-tab[data-page="\${at}"]\`)?.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    // 点 tab 会顺带切 Windows 虚拟桌面，主进程把桌面挑好的那一页再推回来（layout.onSync）。
    // 这一推可能比上面的 500ms 慢，撞进推送窗口就把面板重建走、mail 的 root 脱离文档，
    // load() 的守卫照样直接返回——那时「取数 0 次」量的就不是我们要验的东西。等它稳住。
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let settled = false;
    for (let i = 0; i < 20 && !settled; i += 1) {
      settled = TB.app.state.page === 'life' && Boolean(TB.mail.root?.isConnected);
      if (!settled) await wait(250);
    }
    const before = window.__mailDry.calls.length;
    window.__mailDry.handlers.updated.forEach((handler) => handler({ at: Date.now() }));
    await wait(300);
    const out = {
      want,
      settled,
      page: TB.app.state.page,
      mailTimers: [...created.values()].filter((ms) => ms === want).length,
      updatedHandlers: window.__mailDry.handlers.updated.length,
      newHandlers: window.__mailDry.handlers.new.length,
      timerField: TB.mail.timer === undefined || TB.mail.timer === null,
      pushFetches: window.__mailDry.calls.slice(before).filter((at) => at.startsWith('list:')).length,
      onNewExists: typeof window.__mailDry.real.mail.onNew === 'function',
      // 推送后一条数据都没取，只会是 load() 开头那三个守卫挡的：把三个都记下来，别让人猜
      guardBusy: TB.mail.busy,
      guardRoot: Boolean(TB.mail.root?.isConnected),
      guardCount: Boolean(TB.mail.count),
      notifyFn: typeof TB.app.notifyMail === 'function'
    };
    window.setInterval = realSet;
    window.clearInterval = realClear;
    return JSON.stringify(out);
  })()`));
  console.log(`切三次面板 => 邮箱定时器 ${timers.mailTimers} 条，onUpdated 绑了 ${timers.updatedHandlers} 次，一条推送取数 ${timers.pushFetches} 次（停在 ${timers.page}，面板稳住=${timers.settled}；推送后守卫：busy=${timers.guardBusy} root 在文档=${timers.guardRoot} 计数牌在=${timers.guardCount}）`);
  if (!timers.settled) failures.push(`切完面板停不住（page=${timers.page}，root 在文档=${timers.guardRoot}）：推送断言这一段量不到东西`);
  if (timers.mailTimers) failures.push(`渲染层还开着 ${timers.mailTimers} 条 ${timers.want}ms 的邮箱定时器（轮询必须只剩主进程那一条）`);
  if (!timers.timerField) failures.push('组件上还留着 timer 字段：轮询该整个交给主进程');
  if (timers.updatedHandlers !== 1) {
    failures.push(`onUpdated 绑了 ${timers.updatedHandlers} 次：切面板重新 init 会再绑一遍，一次推送取两遍数据（TB.mail.bound 那条守卫没生效）`);
  }
  if (timers.pushFetches !== 1) failures.push(`主进程推来一条 updated，组件取了 ${timers.pushFetches} 次数据（应为 1 次）`);
  if (timers.newHandlers) failures.push(`邮箱组件自己绑了 ${timers.newHandlers} 次 onNew：提醒归 app.js 一处，组件再绑就会响两遍`);
  if (!timers.onNewExists || !timers.notifyFn) failures.push(`提醒这条链子缺一段：onNew=${timers.onNewExists}，TB.app.notifyMail=${timers.notifyFn}`);

  // ---------- 8. 新邮件提醒：宠物动一下 + 一句固定文案，一次都不问 DeepSeek ----------
  // 探针直接调主进程推给渲染层的那个 handler 函数（TB.app.notifyMail），
  // 因为「mail:new 什么时候发」由主进程定，那边由 tools/mail-check.js 离线验；这一段验的是「响了会怎样」。
  // 动作和语音是一先一后发的：poke() 先让宠物播一次性片段，speak() 紧接着把 speaking 置真，
  // 那次 refresh('ai') 会把口型片段压上来。pet-video 里「循环片段遇到正在播的一次性动作就不抢占画面、
  // 只改状态」就是为了让下面这几条断言成立——少了它，有语音的那两次肉眼只看得到嘴在动。
  const notify = JSON.parse(await evaluate(page, `(async () => {
    const dry = window.__mailDry;
    const pet = TB.ai.pet === TB.petVideo ? 'video' : 'svg';
    const host = document.querySelector('.ai-pet');
    const snapshot = () => (pet === 'svg'
      ? { hop: host?.getAttribute('data-hop') === 'on', mood: host?.querySelector('svg')?.getAttribute('data-mood') }
      : { current: TB.ai.petHandle?.current, loop: TB.ai.petHandle?.loop, once: TB.ai.petHandle?.once, talk: TB.ai.petHandle?.talk });
    // 「做了动作」= 这一刻宠物身上正挂着一次性片段（video）/ 正在跳（svg），而且这个片段是这次提醒换上去的。
    // 必须比 before：上一轮的回应可能还在播，不比我就会把它的尾巴当成这一轮的动作。
    const isAct = (at, before) => (pet === 'svg'
      ? at.hop || (at.mood === 'happy' && before.mood !== 'happy')
      : at.loop === false && at.current !== before.current
        && at.current !== TB.petVideo.IDLE && at.current !== TB.petVideo.TALK);
    const clearToasts = () => document.querySelectorAll('#toasts .toast, .toast').forEach((n) => n.remove());
    const run = (news, options = {}) => {
      dry.spoken.length = 0;
      dry.aiCalls.length = 0;
      clearToasts();
      const wasVoice = TB.voice.speaking;
      const wasFlag = TB.app.config?.mail?.notifyVoice;
      TB.voice.speaking = Boolean(options.busy);
      if (TB.app.config?.mail) TB.app.config.mail.notifyVoice = options.voice === undefined ? wasFlag : options.voice;
      const before = snapshot();
      TB.app.notifyMail(news);
      // notifyMail 返回的那一刻就读：poke() 和 speak() 里的 setSpeaking(true) 都是同步的。
      // 等 120 毫秒再读就不行了——回应片段只有零点几秒，播完自己回待机，量的成了「上一轮的尾巴」，
      // 连着跑几条必然有一条中招（这就是它以前误报 voiceOff 没动作的原因）。
      const sync = snapshot();
      TB.voice.speaking = wasVoice;
      if (TB.app.config?.mail) TB.app.config.mail.notifyVoice = wasFlag;
      return {
        acted: isAct(sync, before),
        sync,
        spoken: [...dry.spoken],
        aiCalls: [...dry.aiCalls],
        toast: [...document.querySelectorAll('#toasts .toast, .toast')].map((n) => n.textContent).join(' / ')
      };
    };
    const out = {
      pet,
      // 语音得「就绪」才念：这里只把就绪判断打开，不碰真播放——speak 已经被记账替身换掉了
      tts: (() => { const st = TB.voice.status; window.__mailTts = st; TB.voice.status = { ...(st || {}), running: true, tts: { ok: true } }; return st; })(),
      enabled: TB.app.state.config?.voice?.enabled,
      many: run({ count: 3, unseen: 12, total: 66, name: '招商银行信用卡中心' }),
      single: run({ count: 1, unseen: 5, total: 66, name: '张三' }),
      longName: run({ count: 1, unseen: 5, total: 66, name: 'no-reply@cmbchina.com' }),
      voiceOff: run({ count: 2, unseen: 5, total: 66, name: '李四' }, { voice: false }),
      busy: run({ count: 2, unseen: 5, total: 66, name: '李四' }, { busy: true }),
      empty: run({ count: 0, unseen: 0, total: 66, name: '王五' })
    };
    return JSON.stringify(out);
  })()`));
  console.log(`提醒（宠物后端=${notify.pet}，voice.enabled=${notify.enabled}）`);
  console.log(`  3 封 => 念「${notify.many.spoken.join(' / ') || '没念'}」，动作=${JSON.stringify(notify.many.sync)}，AI 调用=${JSON.stringify(notify.many.aiCalls)}，提示条「${notify.many.toast}」`);
  console.log(`  1 封 => 念「${notify.single.spoken.join(' / ') || '没念'}」，动作=${JSON.stringify(notify.single.sync)}；发件人是地址时 => 念「${notify.longName.spoken.join(' / ') || '没念'}」`);
  console.log(`  语音开关关掉 => 念了 ${notify.voiceOff.spoken.length} 句、动作=${JSON.stringify(notify.voiceOff.sync)}；正在念 AI 回复 => 念了 ${notify.busy.spoken.length} 句；count=0 => 念了 ${notify.empty.spoken.length} 句`);

  const acted = (at) => at.acted;
  if (!acted(notify.many)) failures.push(`3 封新邮件宠物没动作：${JSON.stringify(notify.many.sync)}`);
  if (!acted(notify.single)) failures.push(`1 封新邮件宠物没动作：${JSON.stringify(notify.single.sync)}`);
  if (!acted(notify.voiceOff)) failures.push(`关掉语音开关把宠物动作也一起关了（那条只该管声音）：${JSON.stringify(notify.voiceOff.sync)}`);
  // 念一句 = speaking 置真 = 那次 refresh('ai') 要把口型片段压上来。它只能改状态，不能把刚起来的动作掐掉：
  // 所以这一刻 talk 已经是 true，画面却还挂着那个一次性片段。
  if (notify.pet === 'video') {
    for (const [key, at] of Object.entries({ many: notify.many, single: notify.single })) {
      if (at.spoken.length && at.sync.talk !== true) failures.push(`${key} 念了却没把口型状态记进宠物（talk=${JSON.stringify(at.sync.talk)}）`);
      if (at.spoken.length && at.sync.loop !== false) failures.push(`${key} 念了就把动作掐掉了（画面变成循环片段 ${JSON.stringify(at.sync.current)} loop=${at.sync.loop}）`);
    }
  }
  if (notify.many.spoken.join('') !== '邮箱来了 3 封新邮件') failures.push(`3 封的文案是「${notify.many.spoken.join('')}」`);
  if (notify.single.spoken.join('') !== '邮箱来了新邮件，来自张三') failures.push(`1 封带短名的文案是「${notify.single.spoken.join('')}」`);
  if (notify.longName.spoken.join('') !== '邮箱来了 1 封新邮件') failures.push(`发件人是个地址时不该念地址：「${notify.longName.spoken.join('')}」`);
  if (notify.voiceOff.spoken.length) failures.push(`语音开关关掉了还是念了：${JSON.stringify(notify.voiceOff.spoken)}`);
  if (notify.busy.spoken.length) failures.push(`正在念 AI 回复时被邮件提醒插嘴：${JSON.stringify(notify.busy.spoken)}`);
  if (notify.empty.spoken.length || acted(notify.empty)) failures.push('count=0 也响了（那是没有新邮件）');
  const aiTouched = [notify.many, notify.single, notify.longName, notify.voiceOff, notify.busy, notify.empty]
    .map((at) => at.aiCalls.filter((key) => ASK_MODEL.includes(key)))
    .filter((at) => at.length);
  if (aiTouched.length) failures.push(`提醒走了 DeepSeek 那条路（ai.send/ai.retry 被调用 ${JSON.stringify(aiTouched)}）`);
  if (!/新邮件/.test(notify.many.toast || '')) failures.push(`提示条没提新邮件：「${notify.many.toast}」`);

  // ---------- 9. 设置里那张卡片：授权码框不回显明文 ----------
  const settings = JSON.parse(await evaluate(page, `(async () => {
    TB.settings.open();
    // 卡片里那行连接状态是 status() 回来后才填的，等它一等再读
    await new Promise((resolve) => setTimeout(resolve, 400));
    const host = document.getElementById('settings');
    const card = [...host.querySelectorAll('.card')].find((c) => c.querySelector('h3')?.textContent === '邮箱（163 · IMAP 只读）');
    const pass = card?.querySelector('input[type="password"]');
    const text = card?.textContent || '';
    const hints = [...(card?.querySelectorAll('.field-hint') || [])].map((n) => n.textContent);
    const out = {
      found: Boolean(card),
      fields: ['启用', '账号', '服务器', '邮箱目录', '每次拉取', '自动刷新', '新邮件提醒', '语音提示', '超时', '网页地址', '授权码', '连接状态'].filter((at) => !text.includes(at)),
      checks: [...(card?.querySelectorAll('input[type="checkbox"]') || [])].map((n) => n.checked),
      passType: pass ? pass.type : null,
      passValue: pass ? pass.value : null,
      hint: hints.join(' | '),
      status: hints[hints.length - 1] || null
    };
    TB.settings.close();
    return JSON.stringify(out);
  })()`));
  console.log(`设置卡片 => ${settings.found ? '在' : '不在'}，密码框 type=${settings.passType} value=${JSON.stringify(settings.passValue)}，勾选框 ${JSON.stringify(settings.checks)}，状态「${settings.status}」，缺的字段：${settings.fields.join('/') || '无'}`);
  if (!settings.found) failures.push('设置里没有「邮箱（163 · IMAP 只读）」这张卡片');
  if (settings.fields.length) failures.push(`邮箱卡片少了这些字段：${settings.fields.join('、')}`);
  // 三个勾选框：启用 / 新邮件提醒 / 语音提示——后两个默认开，关掉语音不该连带关掉动作
  if ((settings.checks || []).length !== 3) failures.push(`邮箱卡片上的勾选框是 ${(settings.checks || []).length} 个，应为 3 个（启用 / 新邮件提醒 / 语音提示）`);
  else if (settings.checks[1] !== true || settings.checks[2] !== true) failures.push(`新邮件提醒或语音提示没按默认打开：${JSON.stringify(settings.checks)}`);
  if (settings.passType !== 'password') failures.push(`授权码输入框是 type=${settings.passType}，旁桌看得见明文`);
  if (settings.passValue !== '') failures.push('授权码输入框里回显了内容：主进程不该把授权码交给渲染层');
  if (!settings.hint?.includes('mail-auth.bin')) failures.push(`卡片没写清授权码存在哪儿：${JSON.stringify(settings.hint)}`);
  if (!/imap\.163\.com:993/.test(settings.status || '')) failures.push(`连接状态那行没报出服务器：${JSON.stringify(settings.status)}`);

  // ---------- 10. 收尾：换成真 IPC、切回他原来那个面板 ----------
  await evaluate(page, `(() => { const { real } = window.__mailDry; TB.api = real; if (window.__mailTts !== undefined) TB.voice.status = window.__mailTts; delete window.__mailTts; delete window.__mailDry; TB.mail.onlyUnread = false; TB.mail.load(true); return 'restored'; })()`);
  try {
    await evaluate(page, `TB.app.setPage(${JSON.stringify(boot.activePage)});'ok'`);
  } catch (error) {
    failures.push(`切回原面板 "${boot.activePage}" 失败：${error.message}`);
  }

  // ---------- 11. --watch：真跑一遍「主进程推 → preload → 渲染层」这条通道 ----------
  // 前面几段验的是「响了会怎样」（探针自己调 notifyMail / 自己按次数调替身 handler）。
  // 这一条验的是通道本身：push() 的窗口引用没了、通道名对不上，替身测不出来，只有真推送能测出来。
  // 所以它等的是主进程那条看护轮询真的推一条 mail:updated 过来（pollMs=120000 → 最多等 3 分钟）。
  if (WATCH) {
    const seen = JSON.parse(await evaluate(page, `(async () => {
      const out = { updated: 0, fresh: 0, at: 0 };
      TB.api.mail.onUpdated((payload) => { out.updated += 1; out.at = Number(payload?.at) || 0; });
      TB.api.mail.onNew(() => { out.fresh += 1; });
      const until = Date.now() + ${WATCH} * 1000;
      while (Date.now() < until && !out.updated) await new Promise((resolve) => setTimeout(resolve, 1000));
      return JSON.stringify(out);
    })()`, (WATCH + 60) * 1000));
    console.log(`等真推送（${WATCH}s）=> mail:updated ${seen.updated} 条${seen.updated ? `（at=${new Date(seen.at).toLocaleTimeString('zh-CN')}）` : ''}，mail:new ${seen.fresh} 条（没有新邮件时 0 条才对）`);
    if (!seen.updated) failures.push(`${WATCH} 秒里主进程一条 mail:updated 都没推过来：看护轮询没起（main.js 开机那趟 mail.sync()），或 push()/preload 的通道断了`);
  }

  if (failures.length) {
    for (const line of failures) console.log(`✗ ${line}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ 邮箱那一格全绿：点 tab 切到生活面板后 leftzone 挂 mail（clock/player 已合块），没配授权码时格子里直接说清去哪儿配，` +
      `25 行替身数据的几何是「头部 / 自己滚的列表 / 页脚」且长主题被省略号截断、四种时间写法都对，` +
      `只看未读 / 刷新 / 网页邮箱 三个按钮各走各的 IPC、点行只出 toast（一次都没调写侧），失败还留着旧结果，` +
      `切三次面板渲染层一条邮箱定时器都不开、onUpdated 只绑一次、一条推送只取数一次，` +
      `来了新邮件宠物做一次性动作且口型片段只改状态不抢占画面、文案按封数走、ai.send/ai.retry 一次都没被调用`);
  }
}

main().catch((error) => {
  console.error(`[mail-appprobe] 失败：${error.message}`);
  process.exitCode = 1;
});
