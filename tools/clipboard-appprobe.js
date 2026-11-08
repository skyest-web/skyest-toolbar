// 剪贴板历史那一格（工作面板右上 workbench）的真机验证：附着到真实运行的工具栏（需带 --remote-debugging-port 启动）。
//
// 验的是「他眼睛看到的那一格」：
//   1) 真点顶栏 tab 切到工作面板：workbench 挂 clipboard，另三格（projzone / gitzone / officezone）与常驻三格不动；
//      整份 DOM 里只有一个 #clipboard（这一格和右侧竖条不能同时挂它，组件是单例，挂两份后一份的 head/list 会指错）；
//   2) 几何：和第 4 列那条常驻竖条等宽同左 edge，高度等于 shell 现算出来的第 2 行行高（176px 那格，别写死像素）；
//   3) 真状态：主进程内存里有几条历史，格子里就渲染几行；空的时候那句「复制过的内容会出现在这里」必须在格子里；
//   4) 替身 30 行的几何：列表自己纵向滚（不是被 .area 静默裁掉）、行不被纵向 flex 压扁、横向不出格、
//      纵向落在列表的滚动内容里、正文 ≥13px / 时间列 ≥12px、长预览走两行截断而不是把格子撑破、图片行带缩略图；
//   5) 手势干跑：点一行只发 copy(id) 一次、点「清空」只发 clear() 一次，替身只记账不碰真剪贴板；
//   6) 跑完恢复真 API、真状态与他原来那一页；--shot 存 samples/clipboard-panel.png（真状态）和 clipboard-rows.png（替身 30 行）。
//
// 用法（Git Bash）:
//   1) unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
//   2) node tools/clipboard-appprobe.js [端口] [--shot] [--reload]
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv.slice(2).find((arg) => /^\d+$/.test(arg)) || 9223);
const SHOTS = process.argv.includes('--shot');
const RELOAD = process.argv.includes('--reload');
const PAGE_ID = 'work';
const SLOT = 'workbench';
const WANT = { workbench: 'clipboard', projzone: 'projects', gitzone: 'git', officezone: 'office' };
const EMPTY_NOTE = '复制过的内容会出现在这里（仅存在内存，退出即清空）';
// 1x1 透明 png：只验「图片行带缩略图」，不验解码内容
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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
      else if (msg.result?.exceptionDetails) {
        const detail = msg.result.exceptionDetails;
        const where = `${(detail.url || 'eval').split('/').pop()}:${detail.lineNumber + 1}:${detail.column}`;
        const reason = detail.exception?.description || detail.exception?.value || detail.text;
        reject(new Error(`${where} => ${reason}`));
      }
      else resolve(msg.result?.result?.value);
    });
    ws.on('error', reject);
  });
}

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

// location.reload() 和 Page.reload{ignoreCache} 都吃 file:// 子资源的内存缓存：改完 styles.css
// 重载，量到的还是旧规则（实测 .clip-item 仍 0.82rem）。得先在网络层把缓存关掉
// （Network.setCacheDisabled），而且这条 CDP 会话要一直连到页面 load 完——会话一断缓存就恢复，
// 重载还在半路就又会抓到旧的那份。所以这里等 loadEventFired 再断，不是收到 reload 的回执就走。
function reloadHard(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('重载超时')); }, 15000);
    let reloading = false;
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }));
      ws.send(JSON.stringify({ id: 2, method: 'Network.enable' }));
      ws.send(JSON.stringify({ id: 3, method: 'Network.setCacheDisabled', params: { cacheDisabled: true } }));
      ws.send(JSON.stringify({ id: 4, method: 'Page.reload', params: { ignoreCache: true } }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id === 4) reloading = true;
      if (reloading && (msg.method === 'Page.loadEventFired' || msg.method === 'Page.frameStoppedLoading')) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
  });
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

const MEASURE_FN = `(() => {
  if (!TB?.app?.state?.grid) throw new Error('渲染层还没 boot 完');
  const sec = (at) => document.querySelector('#shell > section[data-slot="' + at + '"]');
  const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  const moduleAt = (at) => sec(at)?.dataset.module || null;
  const font = (n) => (n ? Math.round(parseFloat(getComputedStyle(n).fontSize) * 10) / 10 : null);
  const host = document.getElementById('clipboard');
  const list = host?.querySelector('.clip-list');
  const rows = [...(host?.querySelectorAll('.clip-item') || [])];
  const style = list ? getComputedStyle(list) : null;
  const lr = list?.getBoundingClientRect();
  return JSON.stringify({
    activePage: TB.app.state.page,
    registered: TB.components?.has?.('clipboard') || false,
    copies: document.querySelectorAll('#clipboard').length,
    modules: { workbench: moduleAt('workbench'), projzone: moduleAt('projzone'), gitzone: moduleAt('gitzone'), officezone: moduleAt('officezone') },
    cells: Object.fromEntries(['workbench', 'projzone', 'gitzone', 'officezone', 'topbar', 'clipboard', 'dock'].map((at) => [at, box(sec(at))])),
    row2: Math.round(parseFloat(getComputedStyle(document.getElementById('shell')).gridTemplateRows.split(' ')[1])),
    slots: (TB.app.pages().find((p) => p.id === 'work')?.slots || []).map((s) => s.at).join(','),
    shared: ['topbar', 'clipboard', 'dock'].map((at) => moduleAt(at)).join(','),
    title: host?.querySelector('.panel-title')?.textContent || null,
    clearText: host?.querySelector('.clip-head .link-btn')?.textContent || null,
    note: host?.querySelector('.clip-list .muted')?.textContent || null,
    stateCount: (TB.app.state.clipboard || []).length,
    domRows: rows.length,
    rowBoxes: rows.map((n) => box(n)),
    rowFonts: rows.slice(0, 3).map((n) => ({ text: font(n.querySelector('.clip-text')), time: font(n.querySelector('.clip-time')) })),
    rowFlex: rows[0] ? getComputedStyle(rows[0]).flex : null,
    thumbs: rows.filter((n) => n.querySelector('.clip-thumb')).length,
    listBox: box(list),
    listScroll: list ? { sh: list.scrollHeight, ch: list.clientHeight, top: list.scrollTop } : null,
    listStyle: style ? { overflowY: style.overflowY, anchor: style.overflowAnchor } : null,
    cellBox: box(sec('${SLOT}'))
  });
})`;
const MEASURE = `${MEASURE_FN}()`;

// 替身只能换 TB.api 这个键本身：window.deskToolbar 由 contextBridge 造，属性只读且不可配置，
// TB.api.clipboard = 替身 会静默失败。浅拷的来源和收尾的还原目标都写 window.deskToolbar，
// 别写 TB.api——上一趟留下的替身此刻就挂在 TB.api 上，拿它当真的还回去，下一趟就站在替身身上跑。
const API_STUB = `
    const realApi = window.deskToolbar;
    const shallow = () => { const copy = {}; for (const key of Object.keys(window.deskToolbar)) copy[key] = window.deskToolbar[key]; return copy; };
`;

const FAKE_30 = `
  const mkFake = () => Array.from({ length: 30 }, (_, i) => ({
    id: 'fake-' + i,
    at: Date.now() - i * 60000,
    kind: i === 2 ? 'image' : 'text',
    preview: i === 2 ? '[图片 12 KB]' : (i === 0 ? '很长的一段复制内容'.repeat(12) : '第 ' + i + ' 条复制内容'),
    thumb: i === 2 ? '${TINY_PNG}' : undefined
  }));
`;

async function main() {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((item) => item.type === 'page' && item.url.includes('renderer/index.html'));
  if (!page) throw new Error(`CDP 端口 ${PORT} 上找不到工具栏渲染层，先跑: ./node_modules/electron/dist/electron.exe . --remote-debugging-port=${PORT}`);

  const failures = [];
  if (RELOAD) {
    await reloadHard(page);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    console.log('已硬重载渲染层（--reload：Network.setCacheDisabled + reload，会话连到 load 完才断，file:// 的 CSS 才重取磁盘）');
  }
  const boot = JSON.parse(await evaluateReady(page, MEASURE));
  if (!boot.registered) failures.push('组件注册表里没有 "clipboard"（loader 没注入 src/renderer/js/components/clipboard.js？）');

  const api = JSON.parse(await evaluate(page, `JSON.stringify({ has: Boolean(TB.api?.clipboard), methods: TB.api?.clipboard ? Object.keys(TB.api.clipboard).sort() : [] })`));
  if (!api.has) throw new Error('TB.api.clipboard 不存在：跑的还是旧的主进程，重启应用（带 --remote-debugging-port 那条）再跑本探针');
  console.log(`preload => clipboard.${api.methods.join('/')}`);

  const stale = JSON.parse(await evaluate(page, `(() => { const dirty = TB.api !== window.deskToolbar; if (dirty) TB.api = window.deskToolbar; return JSON.stringify({ dirty }); })()`));
  if (stale.dirty) console.log('起手发现 TB.api 还指着上一趟留下的替身，已指回 window.deskToolbar');

  const original = boot.activePage;

  // ---------- 1. 真点 tab 切过去：workbench=clipboard，另三格与常驻三格不动 ----------
  await evaluate(page, `document.querySelector('.topbar .page-tab[data-page="${PAGE_ID}"]').click();'ok'`);
  const out = JSON.parse(await evaluateReady(page, MEASURE));
  console.log(`面板 ${out.activePage} / ${SLOT} => ${out.modules.workbench}（projzone=${out.modules.projzone}，gitzone=${out.modules.gitzone}，officezone=${out.modules.officezone}）`);
  if (out.activePage !== PAGE_ID) failures.push(`点 tab 没切到 "${PAGE_ID}"，还在 "${out.activePage}"`);
  for (const [at, want] of Object.entries(WANT)) {
    if (out.modules[at] !== want) failures.push(`「${at}」这格挂的是 "${out.modules[at]}"，应为 "${want}"（layout.json 里工作面板那一格）`);
  }
  if (out.slots !== 'projzone,gitzone,officezone,workbench') failures.push(`工作面板的格子清单是 "${out.slots}"，应为 projzone,gitzone,officezone,workbench`);
  if (out.shared !== 'topbar,ai,dock') failures.push(`常驻三格跟着面板变了：${out.shared}`);
  if (out.copies !== 1) failures.push(`DOM 里有 ${out.copies} 个 #clipboard：组件是单例，挂两份以后 head/list 会指到后挂的那份上`);

  // ---------- 2. 几何：第 4 列上半格，和常驻竖条等宽同左、高等于现算的第 2 行 ----------
  const here = out.cellBox;
  const strip = out.cells?.clipboard;
  const office = out.cells?.officezone;
  if (!here) failures.push(`DOM 上没有 data-slot="${SLOT}" 这一格`);
  else {
    if (strip && Math.abs(here.w - strip.w) > 2) failures.push(`workbench 宽 ${here.w} 和第 4 列常驻竖条 ${strip.w} 不一样：同一列该等宽`);
    if (strip && Math.abs(here.x - strip.x) > 2) failures.push(`workbench 左边缘 ${here.x} 和常驻竖条 ${strip.x} 不齐`);
    if (Math.abs(here.h - out.row2) > 2) failures.push(`workbench 高 ${here.h} 不等于 shell 现算的第 2 行 ${out.row2}（这一格没被合并，就该是一行高）`);
    if (office && Math.abs(here.y - office.y) > 2) failures.push(`workbench 顶边 ${here.y} 和同排 officezone ${office.y} 不齐`);
    if (here.h > 200) failures.push(`workbench 有 ${here.h}px 高：右上那格只占第 2 行，别把常驻竖条的地也吃了`);
  }

  // ---------- 3. 真状态：内存里几条就渲染几行；空的时候那句必须在格子里 ----------
  console.log(`真状态 ${out.stateCount} 条 / DOM ${out.domRows} 行；标题「${out.title}」；清空牌「${out.clearText}」`);
  if (out.domRows !== out.stateCount) failures.push(`主进程内存里 ${out.stateCount} 条历史，DOM 渲染了 ${out.domRows} 行`);
  if (out.title !== '剪贴板历史') failures.push(`格子标题是「${out.title}」，应为「剪贴板历史」`);
  if (out.stateCount === 0) {
    if (out.note !== EMPTY_NOTE) failures.push(`空历史时格子里那句是「${out.note}」，应为「${EMPTY_NOTE}」`);
    if (out.clearText !== '清空') failures.push(`空历史时清空牌写「${out.clearText}」，应为「清空」`);
  } else if (out.clearText !== `清空 ${out.stateCount}`) {
    failures.push(`有 ${out.stateCount} 条时清空牌写「${out.clearText}」，应为「清空 ${out.stateCount}」`);
  }
  if (SHOTS) console.log(`  截图 ${await capture(page, path.join(APP_ROOT, 'samples', 'clipboard-panel.png'))}`);

  // ---------- 4. 替身 30 行：列表自己滚、行不被压扁、不出格、字号与截断 ----------
  const shot = JSON.parse(await evaluate(page, `(async () => {
    ${FAKE_30}
    TB.clipboard.update({ clipboard: mkFake() });
    await new Promise((r) => setTimeout(r, 60));
    return ${MEASURE_FN}();
  })()`));
  console.log(`替身 30 行：列表可视 ${shot.listScroll?.ch} / 内容 ${shot.listScroll?.sh}，格子 ${shot.cellBox?.w}x${shot.cellBox?.h}`);
  if (shot.domRows !== 30) failures.push(`替身喂 30 条只渲染了 ${shot.domRows} 行`);
  if (!shot.listScroll || shot.listScroll.sh <= shot.listScroll.ch) failures.push(`30 行时列表内容 ${shot.listScroll?.sh} 不比可视 ${shot.listScroll?.ch} 高：行被压扁了或者列表没在滚`);
  if (shot.listStyle?.overflowY !== 'auto') failures.push(`.clip-list 的 overflow-y 是 "${shot.listStyle?.overflowY}"，该是 auto（超出交给列表自己滚）`);
  if (shot.listStyle?.anchor !== 'none') failures.push(`.clip-list 没写 overflow-anchor:none（历史往头部插，滚动会被锚定拽着跳）`);
  // 行高断言咬不住删掉 .clip-list > * 的那版：flex 项 min-height:auto 兜着不让压到内容以下，
  // 画面看着没变但压缩开关还开着。直接钉 computed flex，删了这条规矩就红。
  if (shot.rowFlex !== '0 0 auto') failures.push(`行的 computed flex 是 "${shot.rowFlex}"，该是 0 0 auto（.clip-list > * 关掉纵向 flex 的压缩）`);
  const cell = shot.cellBox;
  const list = shot.listBox;
  for (const [i, r] of (shot.rowBoxes || []).entries()) {
    if (r.h < 24) failures.push(`第 ${i} 行只有 ${r.h}px 高：纵向 flex 把行压扁了（.clip-list > * 该 flex:0 0 auto）`);
    if (r.h > 70) failures.push(`第 ${i} 行有 ${r.h}px 高：长预览没截断，把格子撑破了`);
    if (r.left < cell.left || r.right > cell.right) failures.push(`第 ${i} 行横向出格：[${r.left},${r.right}] 不在 [${cell.left},${cell.right}] 里`);
    const inContent = r.top - list.top + shot.listScroll.top;
    if (inContent < -1 || inContent + r.h > shot.listScroll.sh + 1) failures.push(`第 ${i} 行不在列表的滚动内容里（内容坐标 ${Math.round(inContent)}，内容高 ${shot.listScroll.sh}）`);
  }
  for (const f of shot.rowFonts || []) {
    if (f.text !== null && f.text < 13) failures.push(`行正文只有 ${f.text}px（这屏 dpr=1，正文下限 13px）`);
    if (f.time !== null && f.time < 12) failures.push(`时间列只有 ${f.time}px（meta 下限 12px）`);
  }
  if (shot.thumbs !== 1) failures.push(`图片行缩略图有 ${shot.thumbs} 个，替身里只喂了 1 条图片`);
  if (SHOTS) console.log(`  截图 ${await capture(page, path.join(APP_ROOT, 'samples', 'clipboard-rows.png'))}`);

  // ---------- 5. 手势干跑：点行只发 copy(id)、清空只发 clear()，不碰真剪贴板 ----------
  const gestures = JSON.parse(await evaluate(page, `(async () => {
    ${API_STUB}
    const calls = { copy: [], clear: 0 };
    TB.api = Object.assign(shallow(), { clipboard: { copy: (id) => { calls.copy.push(id); return Promise.resolve(true); }, clear: () => { calls.clear += 1; return Promise.resolve(); }, onUpdate: realApi.clipboard.onUpdate } });
    const installed = TB.api.clipboard !== realApi.clipboard;
    if (!installed) return JSON.stringify({ installed: false });
    const rows = [...document.querySelectorAll('#clipboard .clip-item')];
    rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    document.querySelector('#clipboard .clip-head .link-btn').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    const ids = { copy: [...calls.copy], clear: calls.clear };
    TB.api = realApi;
    return JSON.stringify({ installed: true, ids, wantId: rows[1] ? 'fake-1' : null });
  })()`));
  if (!gestures.installed) failures.push('干跑那一步的 IPC 替身没换上（TB.api 换不动？）——手势断言全是假的');
  console.log(`干跑：点行 => copy ${gestures.ids?.copy?.length} 次；清空 => clear ${gestures.ids?.clear} 次`);
  if (gestures.ids?.copy?.length !== 1) failures.push(`点一行发了 ${gestures.ids?.copy?.length} 次 copy，应为 1 次`);
  if (gestures.ids?.copy?.[0] !== 'fake-1') failures.push(`copy 收到的不是点的那条 id：${JSON.stringify(gestures.ids?.copy?.[0])}`);
  if (gestures.ids?.clear !== 1) failures.push(`点清空发了 ${gestures.ids?.clear} 次 clear，应为 1 次`);

  // ---------- 6. 收尾：真 API、真状态、他原来那一页 ----------
  await evaluate(page, `TB.clipboard.update(TB.app.state);'ok'`);
  const after = JSON.parse(await evaluate(page, `(() => { const host = document.getElementById('clipboard'); return JSON.stringify({ rows: host.querySelectorAll('.clip-item').length, state: (TB.app.state.clipboard || []).length, apiReal: TB.api === window.deskToolbar && TB.api.clipboard === window.deskToolbar.clipboard }); })()`));
  if (!after.apiReal) failures.push('收尾时 TB.api 还指着替身（后面再跑别的探针就全在这一份假 API 上）');
  if (after.rows !== after.state) failures.push(`恢复真状态后 DOM ${after.rows} 行、内存 ${after.state} 条，对不上`);
  await evaluate(page, `TB.app.setPage(${JSON.stringify(original)});'ok'`);
  const restored = JSON.parse(await evaluate(page, `JSON.stringify({ page: TB.app.state.page })`));
  if (restored.page !== original) failures.push(`收尾没切回原来的面板 "${original}"，现在停在 "${restored.page}"`);

  if (failures.length) {
    for (const line of failures) console.log(`✗ ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ 剪贴板格子真机全绿：点 tab 后 workbench=clipboard 且另三格与常驻三格不动、整份 DOM 只有一个 #clipboard；` +
    `几何和第 4 列常驻竖条等宽同左、高等于现算的第 2 行；真状态 ${out.stateCount} 条与 DOM 行数一致${out.stateCount === 0 ? '、空态那句在格子里' : ''}；` +
    `替身 30 行列表自己滚、行不被压扁也不出格、正文 ≥13px / 时间 ≥12px、图片行带缩略图；点行只发 1 次 copy(id)、清空只发 1 次 clear；收尾真 API、真状态与原面板都回来了`);
}

main().catch((error) => {
  console.error(`[clipboard-appprobe] 失败：${error.message}`);
  process.exitCode = 1;
});