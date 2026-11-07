// 生活面板 gauges 那一整条（本地照片墙）的真机验证：附着到真实运行的工具栏（需带 --remote-debugging-port 启动）。
//
// 验的是「他眼睛看到的那一格」：
//   1) 点 tab 切到生活面板，gauges 挂 photos、slot1 还是音乐、slot2 还是视频、左边那一整块还是邮箱；
//      gauges 是第 2 行中间两列合成的一整条，比旁边任何一格都宽，且不跟下面那行重叠；
//   2) 没配文件夹时格子里写清去哪儿选，浮层不在（一开机就盖住界面是 bug）；
//   3) 真扫一次仓库自带的 samples/：走真 IPC + 真 file://，扫出来的张数 = 目录里的 png 数，
//      日志音频一张都不进来；每条 url 都是 file:/// 而不是 track://（图片不受跨源媒体策略限制）；
//   4) 真点开一张：浮层挂在 document.body 上、盖满整窗、大图真解码了（naturalWidth>0，
//      file:// 被 CSP 挡住或者地址拼错就是 0）、没越出窗口、说明条写着「第几张 / 共几张」；
//      ←/→ 翻页换图、Esc 关、点暗色背景也关，关掉后把 src 摘掉；
//   5) 切走再切回：还是同一个浮层节点、一次都不重扫（每次重建都扫一遍就是白白的 IO）；
//   6) 替身喂 30 张的几何：整条自己横向滚、刚扫完停最左、点中间某张会滚进可视区、
//      缩略图定高不变形、说明文字 ≥12px、所有内容都不出格子；
//   7) 三种「没东西可看」分开说：没设置文件夹 vs 文件夹不存在 vs 里面没有能显示的图；
//   8) 点「选文件夹」= pickFolder 一次 + config.save 一次，且那条 IPC 只带 photos 这一段，
//      并且选好之后只扫一遍（update() 那趟和兜底那句不能各扫一次）。
//
// 用法（Git Bash）:
//   1) unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
//   2) node tools/photos-appprobe.js [端口] [--shot] [--reload]
//      --shot：存 samples/photos-panel.png（真扫 samples）和 samples/photos-lightbox.png（浮层开着）
//      --reload：改了渲染层代码后先重载一次页面，不用重启应用
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv.slice(2).find((arg) => /^\d+$/.test(arg)) || 9223);
const SHOTS = process.argv.includes('--shot');
const RELOAD = process.argv.includes('--reload');
const PAGE_ID = 'life';
const SLOT = 'gauges';
// 图源：仓库自带的界面截图，全是 png，不依赖他机器上有没有照片文件夹
const SAMPLE_DIR = path.join(APP_ROOT, 'samples');
const WANT = { gauges: 'photos', slot1: 'player', slot2: 'video', leftzone: 'mail' };

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
  const host = document.getElementById('photos');
  const strip = host?.querySelector('.ph-strip') || null;
  const items = [...(strip?.querySelectorAll('.ph-item') || [])];
  const thumbs = items.map((n) => n.querySelector('.ph-thumb'));
  const view = TB.photos?.el || null;
  const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  const moduleAt = (at) => document.querySelector(\`#shell > section[data-slot="\${at}"]\`)?.dataset.module || null;
  const glyphOf = (n) => { if (!n) return null; const range = document.createRange(); range.selectNodeContents(n); const t = range.getBoundingClientRect(); const p = n.getBoundingClientRect(); return { h: Math.round(t.height * 10) / 10, px: Math.round(parseFloat(getComputedStyle(n).fontSize) * 10) / 10, clipped: t.width > p.width + 1 }; };
  const style = strip ? getComputedStyle(strip) : null;
  return JSON.stringify({
    activePage: TB.app.state.page,
    registered: TB.components.has('photos'),
    modules: { gauges: moduleAt('gauges'), slot1: moduleAt('slot1'), slot2: moduleAt('slot2'), leftzone: moduleAt('leftzone') },
    count: host?.querySelector('.ph-count')?.textContent ?? null,
    countTitle: host?.querySelector('.ph-count')?.title ?? null,
    noneText: host?.querySelector('.ph-none')?.textContent ?? null,
    domItems: items.length,
    opened: TB.photos?.opened ?? null,
    index: TB.photos?.index ?? null,
    folder: TB.photos?.folder ?? null,
    error: TB.photos?.error ?? null,
    busy: Boolean(TB.photos?.busy),
    items: items.length ? {
      prefixes: [...new Set(items.map((n) => (n.querySelector('.ph-thumb')?.getAttribute('src') || '').slice(0, 9)))],
      exts: [...new Set(TB.photos.items.map((item) => item.ext))],
      titles: TB.photos.items.slice(0, 3).map((item) => item.title),
      firstTitle: items[0].title,
      openClass: items.filter((n) => n.classList.contains('open')).length,
      decodable: thumbs.filter((n) => n.complete && n.naturalWidth > 0).length,
      broken: thumbs.filter((n) => n.complete && n.naturalWidth === 0).map((n) => n.getAttribute('src')).slice(0, 3),
      lazy: items.filter((n) => n.querySelector('.ph-thumb')?.loading === 'lazy').length
    } : null,
    view: view ? {
      inBody: view.parentNode === document.body,
      hidden: view.hidden,
      display: getComputedStyle(view).display,
      z: getComputedStyle(view).zIndex,
      position: getComputedStyle(view).position,
      box: box(view),
      full: box(TB.photos.full),
      naturalWidth: TB.photos.full.naturalWidth,
      naturalHeight: TB.photos.full.naturalHeight,
      src: TB.photos.full.getAttribute('src') || '',
      currentSrc: TB.photos.full.currentSrc || '',
      fit: getComputedStyle(TB.photos.full).objectFit,
      cap: TB.photos.cap.textContent,
      capBox: box(TB.photos.cap),
      capGlyph: glyphOf(TB.photos.cap),
      barBox: box(TB.photos.bar)
    } : null,
    secBox: box(sec),
    hostBox: box(host),
    headBox: box(host?.querySelector('.ph-head')),
    stripBox: box(strip),
    itemBox: box(items[0]),
    thumbBox: box(thumbs[0]),
    countGlyph: glyphOf(host?.querySelector('.ph-count')),
    noneGlyph: glyphOf(host?.querySelector('.ph-none')),
    stripStyle: style ? { overflowX: style.overflowX, overflowY: style.overflowY, anchor: style.overflowAnchor, sw: Math.round(strip.scrollWidth), cw: Math.round(strip.clientWidth), sl: Math.round(strip.scrollLeft) } : null,
    hostClip: host ? Math.round(host.scrollHeight - host.getBoundingClientRect().height) : null,
    secClip: sec ? Math.round(sec.scrollHeight - sec.getBoundingClientRect().height) : null,
    win: { w: Math.round(window.innerWidth), h: Math.round(window.innerHeight) },
    toasts: [...document.querySelectorAll('#toast .toast')].map((n) => n.textContent)
  });
})()`;

// 替身喂的那 30 张在页面里就地生成：url/path 全部指向 samples/ 的真 png（点得动、解得了），
// 只有张数、文件名和空态分支由探针说了算
const FAKE_30 = `
  const mkFake = () => {
    const items = TB.photos.items.length ? TB.photos.items : [{ path: ${JSON.stringify(path.join(SAMPLE_DIR, 'agent-panel.png'))}, url: 'file:///', ext: 'png' }];
    return Array.from({ length: 30 }, (_, i) => {
      const src = items[i % items.length];
      const file = i === 2 ? '这是一张名字长得离谱的照片，悬浮提示应该自己截断而不要把格子撑破.png' : \`照片 \${String(i).padStart(2, '0')}.png\`;
      return {
        id: \`fake-\${i}\`,
        path: src.path,
        url: src.url,
        folder: 'L/rows',
        dir: 'rows',
        file,
        ext: src.ext,
        title: file.replace(/\\.png$/, ''),
        size: 90000 + i * 512,
        mtime: Math.floor(Date.now() / 1000) - i * 3600
      };
    });
  };
`;

async function main() {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((item) => item.type === 'page' && item.url.includes('renderer/index.html'));
  if (!page) throw new Error(`CDP 端口 ${PORT} 上找不到工具栏渲染层，先跑: ./node_modules/electron/dist/electron.exe . --remote-debugging-port=${PORT}`);

  const failures = [];
  if (RELOAD) {
    await evaluate(page, `setTimeout(() => location.reload(), 0); 'reloading'`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    console.log('已重载渲染层（--reload）');
  }
  const boot = JSON.parse(await evaluateReady(page, MEASURE));
  if (!boot.registered) failures.push('组件注册表里没有 "photos"（loader 没注入 src/renderer/js/components/photos.js？）');

  // 这版应用没带上主进程那段的话，下面全是假绿——先问一句，不对就直接停
  const api = JSON.parse(await evaluate(page, `JSON.stringify({ hasPhotos: Boolean(TB.api?.photos), methods: TB.api?.photos ? Object.keys(TB.api.photos) : [], cfg: TB.app.state.config?.photos ?? null })`));
  if (!api.hasPhotos) throw new Error('TB.api.photos 不存在：跑的还是旧的主进程，重启应用（npm run dev 那条）再跑本探针');
  console.log(`preload => photos.${api.methods.join('/')}；他的照片文件夹 ${JSON.stringify(api.cfg?.folder ?? '')}`);
  if (!fs.existsSync(SAMPLE_DIR)) throw new Error(`图源目录不在：${SAMPLE_DIR}`);

  const orig = { page: boot.activePage, folder: api.cfg?.folder ?? '' };
  if (orig.folder) console.log(`他已经配了照片文件夹「${orig.folder}」：跳过「没设置文件夹」那组兜底断言`);

  // ---------- 1. 真点 tab 切过去：gauges=photos，其余三格还是原来的 ----------
  await evaluate(page, `document.querySelector('.topbar .page-tab[data-page="${PAGE_ID}"]').click();'ok'`);
  const out = JSON.parse(await evaluateReady(page, MEASURE));
  console.log(`面板 ${out.activePage} / ${SLOT} => ${out.modules.gauges}（slot1=${out.modules.slot1}，slot2=${out.modules.slot2}，leftzone=${out.modules.leftzone}）`);
  console.log(`计数牌「${out.count}」· 格子 ${out.secBox?.w}x${out.secBox?.h} @(${out.secBox?.x},${out.secBox?.y}) · 整条 ${out.stripBox?.w}x${out.stripBox?.h}`);
  console.log(`浮层：挂 body ${out.view?.inBody}、hidden ${out.view?.hidden}、position ${out.view?.position}、z-index ${out.view?.z}`);

  if (out.activePage !== PAGE_ID) failures.push(`点 tab 没切到 "${PAGE_ID}"，还在 "${out.activePage}"`);
  for (const [at, want] of Object.entries(WANT)) {
    if (out.modules[at] !== want) failures.push(`「${at}」这格挂的是 "${out.modules[at]}"，应为 "${want}"（layout.json 里生活面板那一格）`);
  }
  const below = JSON.parse(await evaluate(page, `(() => { const n = document.querySelector('#shell > section[data-slot="slot2"]')?.getBoundingClientRect(); return JSON.stringify(n ? { left: Math.round(n.left), right: Math.round(n.right), top: Math.round(n.top) } : null); })()`));
  if (!below) failures.push('量不到 slot2 那一格，没法比 gauges 的宽度');
  else if (out.secBox) {
    // gauges 是第 2 行中间两列合成的一整条：比 slot2 宽、盖到 slot2 的右边缘、且在它上面那一行
    if (!(out.secBox.w > below.right - below.left)) failures.push(`gauges 只有 ${out.secBox.w}px，不比 slot2（${below.right - below.left}px）宽——那一整条没合成成功`);
    // 第 2 行中间两列合成的一整条：跨第 2、3 列，所以左边缘在 slot1 那边，右边缘和 slot2 对齐。
    // 别要求左边缘也相等——那是把「一整条」当成「一格」了。
    if (Math.abs(out.secBox.right - below.right) > 2) failures.push(`gauges 右边缘没和 slot2 对齐：${out.secBox.right} vs ${below.right}`);
    if (!(out.secBox.left <= below.left + 1)) failures.push(`gauges 没往左延伸到 slot2 之外：左 ${out.secBox.left} > slot2 左 ${below.left}`);
    if (!(out.secBox.bottom <= below.top + 1)) failures.push(`gauges 压到下面那一行了：底 ${out.secBox.bottom} > slot2 顶 ${below.top}`);
  }

  // ---------- 2. 没配文件夹时格子里说清去哪儿选（浮层不能在） ----------
  if (!orig.folder) {
    if (out.count !== '没设置文件夹') failures.push(`没配文件夹时计数牌是「${out.count}」，应是「没设置文件夹」`);
    if (out.noneText !== '还没选照片文件夹') failures.push(`整条里那句提示是「${out.noneText}」，应是「还没选照片文件夹」`);
    if (!/选文件夹/.test(out.countTitle || '')) failures.push(`计数牌的 title 没指出去哪儿选：「${out.countTitle}」`);
    if (out.domItems) failures.push(`还没选文件夹就已经渲染了 ${out.domItems} 张缩略图`);
    if (!out.view) failures.push('浮层节点没建出来（init 里 ensureOverlay 没跑？）');
    if (out.view && !out.view.hidden) failures.push('没配文件夹时浮层却是开着的，界面被整块盖住');
    if (out.view?.hidden && out.view.display !== 'none') failures.push(`浮层 hidden 了却还占着布局（display=${out.view.display}）：[hidden] 那条规则没生效`);
    if (out.view?.src) failures.push('浮层没开却还挂着图片（白白占一张解码后的位图）');
  }

  // ---------- 3. 真扫一次：走真 IPC + 真 file:///，图源用仓库自带的 samples/ ----------
  const scanned = JSON.parse(await evaluate(page, `(async () => {
    const real = TB.api;
    const calls = [];
    const wrap = (overlays) => { const copy = {}; for (const key of Object.keys(real)) copy[key] = real[key]; Object.assign(copy, overlays); return copy; };
    const photosApi = Object.assign({}, real.photos, {
      // 透明记一笔：IPC 真走，只把通道和参数记下来（这一格不该有假数据）
      scan: (folder) => { calls.push(['scan', folder]); return real.photos.scan(folder); },
      pickFolder: () => { calls.push(['pickFolder', null]); return real.photos.pickFolder(); }
    });
    const configApi = Object.assign({}, real.config, { save: (partial) => { calls.push(['config.save', partial]); return real.config.save(partial); } });
    TB.api = wrap({ photos: photosApi, config: configApi });
    window.__photosDry = { real, calls };
    TB.photos.folder = null;
    TB.photos.opened = -1;
    TB.app.state.config.photos = { folder: ${JSON.stringify(SAMPLE_DIR)}, recursive: true, limit: 400 };
    TB.app.refresh('photos');
    const until = Date.now() + 10000;
    while (Date.now() < until && !TB.photos.items.length) await new Promise((resolve) => setTimeout(resolve, 100));
    return JSON.stringify({
      calls: calls.map(([at, arg]) => [at, String(arg ?? '').slice(-24)]),
      itemCount: TB.photos.items.length,
      error: TB.photos.error,
      folder: TB.photos.folder,
      prefixes: [...new Set(TB.photos.items.map((item) => item.url.slice(0, 9)))],
      exts: [...new Set(TB.photos.items.map((item) => item.ext))],
      files: TB.photos.items.map((item) => item.file).slice(0, 3),
      mtimes: TB.photos.items.slice(0, 4).map((item) => item.mtime),
      first: TB.photos.items[0] || null
    });
  })()`, 30000));
  const pngs = fs.readdirSync(SAMPLE_DIR).filter((name) => name.toLowerCase().endsWith('.png'));
  console.log(`真扫 ${scanned.itemCount} 张（目录里 png ${pngs.length} 个，error=${JSON.stringify(scanned.error)}）=> ${JSON.stringify(scanned.files)}；url 前缀 ${JSON.stringify(scanned.prefixes)}，扩展名 ${JSON.stringify(scanned.exts)}`);
  console.log(`IPC 记账 => ${JSON.stringify(scanned.calls.map((c) => c[0]))}；最前四张的 mtime ${JSON.stringify(scanned.mtimes)}`);

  if (scanned.error) failures.push(`真扫 samples/ 报错了：${scanned.error}`);
  if (scanned.itemCount !== pngs.length) failures.push(`samples/ 里 ${pngs.length} 个 png，扫出来 ${scanned.itemCount} 张`);
  if (!scanned.prefixes.every((u) => u.startsWith('file:///'))) failures.push(`图片地址不是 file:///：${JSON.stringify(scanned.prefixes)}`);
  if (!scanned.exts.every((e) => e === 'png')) failures.push(`扫进来了别的东西：${JSON.stringify(scanned.exts)}（日志/音频不该进来）`);
  if (scanned.calls.filter((c) => c[0] === 'scan').length !== 1) failures.push(`换一次文件夹扫了 ${scanned.calls.filter((c) => c[0] === 'scan').length} 遍，应只 1 遍`);
  if (scanned.calls.some(([at]) => at === 'config.save')) failures.push('只是渲染层换了个文件夹，就写了 toolbar.config.json');
  if (scanned.mtimes.some((v, i) => i && v > scanned.mtimes[i - 1])) failures.push(`不是按修改时间倒序：${JSON.stringify(scanned.mtimes)}`);
  if (!scanned.first?.path || !path.isAbsolute(scanned.first.path)) failures.push(`条目没带绝对路径：${JSON.stringify(scanned.first)}`);

  const list = JSON.parse(await evaluateReady(page, MEASURE));
  console.log(`整条 ${list.domItems} 张，计数牌「${list.count}」，缩略图 ${list.thumbBox?.w}x${list.thumbBox?.h}，解码成功 ${list.items?.decodable} 张，坏了 ${JSON.stringify(list.items?.broken)}`);
  console.log(`滚动：可视 ${list.stripStyle?.cw}px / 内容 ${list.stripStyle?.sw}px · scrollLeft ${list.stripStyle?.sl} · overflow-x ${list.stripStyle?.overflowX} · anchor ${list.stripStyle?.anchor}`);

  if (list.domItems !== scanned.itemCount) failures.push(`扫到 ${scanned.itemCount} 张，DOM 只渲染 ${list.domItems} 张`);
  if (list.count !== `${scanned.itemCount} 张`) failures.push(`计数牌说的是「${list.count}」，应是「${scanned.itemCount} 张」`);
  if (!list.items?.prefixes.every((u) => u.startsWith('file:///'))) failures.push(`<img> 的 src 不是 file:///：${JSON.stringify(list.items?.prefixes)}`);
  if (list.items?.broken.length) failures.push(`${list.items.broken.length} 张图加载失败（CSP 挡了 file://，或地址拼错）：${JSON.stringify(list.items.broken)}`);
  if (list.items && list.items.decodable < Math.min(5, list.domItems)) failures.push(`前 ${list.domItems} 张里只有 ${list.items.decodable} 张解得开：file:// 根本没读到文件`);
  if (list.items?.lazy) failures.push(`${list.items.lazy} 张缩略图带 loading="lazy"：滚过去是一片白（游戏列表那条教训）`);
  if (list.items?.firstTitle && !list.items.firstTitle.includes('.png')) failures.push(`缩略图的悬浮提示没带文件名：${JSON.stringify(list.items.firstTitle)}`);
  if (!(list.stripStyle?.sw > list.stripStyle?.cw)) failures.push(`${list.domItems} 张还没超出可视宽度（内容 ${list.stripStyle?.sw} ≤ 可视 ${list.stripStyle?.cw}），没法验横向滚`);
  if (list.stripStyle?.overflowX !== 'auto') failures.push(`整条不横向滚：overflow-x=${list.stripStyle?.overflowX}`);
  if (list.stripStyle?.anchor !== 'none') failures.push(`整条没关滚动锚定（overflow-anchor=${list.stripStyle?.anchor}）：重绘时会被弹走`);
  if (list.stripStyle?.sl > 2) failures.push(`刚扫完就停在 ${list.stripStyle.sl}px（该在最左）`);
  if (list.thumbBox && !(list.thumbBox.h >= 60 && list.thumbBox.h <= list.stripBox.h + 1)) failures.push(`缩略图高 ${list.thumbBox.h}px，超出整条的 ${list.stripBox.h}px 或矮得没法看`);

  // ---------- 4. 真点开一张：浮层、解码、翻页、两种关法 ----------
  const opened = JSON.parse(await evaluate(page, `(async () => {
    const wait = async (ms) => await new Promise((resolve) => setTimeout(resolve, ms));
    const items = document.querySelectorAll('#photos .ph-item');
    items[2].click();
    const until = Date.now() + 8000;
    while (Date.now() < until && !(TB.photos.full.complete && TB.photos.full.naturalWidth > 0)) await wait(80);
    const boxOf = (n) => { const r = n.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
    return JSON.stringify({
      hidden: TB.photos.el.hidden,
      display: getComputedStyle(TB.photos.el).display,
      inBody: TB.photos.el.parentNode === document.body,
      opened: TB.photos.opened,
      index: TB.photos.index,
      src: TB.photos.full.getAttribute('src'),
      naturalWidth: TB.photos.full.naturalWidth,
      naturalHeight: TB.photos.full.naturalHeight,
      fit: getComputedStyle(TB.photos.full).objectFit,
      fullBox: boxOf(TB.photos.full),
      viewBox: boxOf(TB.photos.el),
      cap: TB.photos.cap.textContent,
      capTitle: TB.photos.cap.title,
      win: { w: window.innerWidth, h: window.innerHeight },
      // openClass/itemTitle 都要重查：点开那一下 renderStrip() 把整条重建了，点之前抓的那批节点已经脱离 DOM
      openClass: [...document.querySelectorAll('#photos .ph-item')].filter((n) => n.classList.contains('open')).length,
      openIsThird: document.querySelector('#photos .ph-item.open') === document.querySelectorAll('#photos .ph-item')[2],
      itemTitle: document.querySelectorAll('#photos .ph-item')[2].title
    });
  })()`, 30000));
  console.log(`点开第 3 张 => 浮层 display ${opened.display}、挂 body ${opened.inBody}、解码 ${opened.naturalWidth}x${opened.naturalHeight}、${opened.fit}`);
  console.log(`说明条「${opened.cap}」· 大图 ${opened.fullBox.w}x${opened.fullBox.h} 在 ${opened.win.w}x${opened.win.h} 窗口里 · 高亮 open 的缩略图 ${opened.openClass} 张`);

  if (opened.hidden) failures.push('点了缩略图浮层却没开');
  if (opened.display === 'none') failures.push('浮层 display:none，点了等于没点');
  if (!opened.inBody) failures.push('浮层不在 document.body 上：会被 .area 的 overflow:hidden 裁掉');
  if (!(opened.naturalWidth > 0 && opened.naturalHeight > 0)) failures.push(`大图没解出来（${opened.naturalWidth}x${opened.naturalHeight}）：file:// 被 CSP 挡住或地址不对`);
  if (opened.fit !== 'contain') failures.push(`大图是 ${opened.fit}，应 contain（cover 会把照片裁掉一圈）`);
  if (!String(opened.src).startsWith('file:///')) failures.push(`大图 src 不是 file:///：${JSON.stringify(opened.src)}`);
  if (opened.opened !== 2 || opened.index !== 2) failures.push(`点开第 3 张后 opened/index 是 ${opened.opened}/${opened.index}`);
  if (opened.openClass !== 1) failures.push(`整条里有 ${opened.openClass} 张标了 open，应只有正在放大的那一张`);
  if (!opened.openIsThird) failures.push('带 open 的那张不是刚点开的第 3 张');
  if (!new RegExp(`3/${scanned.itemCount}$`).test(opened.cap || '')) failures.push(`说明条没写「第几张/共几张」：「${opened.cap}」`);
  if (!opened.capTitle?.includes(SAMPLE_DIR)) failures.push(`说明条的 title 没带完整路径：${JSON.stringify(opened.capTitle)}`);
  if (!opened.itemTitle?.includes(SAMPLE_DIR)) failures.push(`缩略图悬浮提示没带完整路径：${JSON.stringify(opened.itemTitle)}`);
  const inside = opened.fullBox.left >= -1 && opened.fullBox.top >= -1 && opened.fullBox.right <= opened.win.w + 1 && opened.fullBox.bottom <= opened.win.h + 1;
  if (!inside) failures.push(`大图越出窗口：${JSON.stringify(opened.fullBox)} vs ${JSON.stringify(opened.win)}`);
  if (opened.viewBox.w < opened.win.w - 1 || opened.viewBox.h < opened.win.h - 1) failures.push(`浮层没盖满整窗：${opened.viewBox.w}x${opened.viewBox.h} vs ${opened.win.w}x${opened.win.h}`);

  const stepped = JSON.parse(await evaluate(page, `(async () => {
    const wait = async (ms) => await new Promise((resolve) => setTimeout(resolve, ms));
    const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    const before = { idx: TB.photos.opened, src: TB.photos.full.getAttribute('src') };
    key('ArrowRight');
    let until = Date.now() + 6000;
    while (Date.now() < until && (TB.photos.opened !== before.idx + 1 || !(TB.photos.full.complete && TB.photos.full.naturalWidth > 0))) await wait(80);
    const right = { idx: TB.photos.opened, src: TB.photos.full.getAttribute('src'), naturalWidth: TB.photos.full.naturalWidth, cap: TB.photos.cap.textContent };
    key('ArrowLeft');
    until = Date.now() + 6000;
    while (Date.now() < until && TB.photos.opened !== before.idx) await wait(80);
    const left = { idx: TB.photos.opened, src: TB.photos.full.getAttribute('src') };
    // 头一张再按 ← 应该绕到最后一张（照片墙从头翻和从尾翻都要能连上）
    TB.photos.open(0);
    await wait(200);
    key('ArrowLeft');
    until = Date.now() + 6000;
    while (Date.now() < until && TB.photos.opened === 0) await wait(80);
    const wrapped = TB.photos.opened;
    const total = TB.photos.items.length;
    return JSON.stringify({ before, right, left, wrapped, total, items: document.querySelectorAll('#photos .ph-item').length });
  })()`, 40000));
  console.log(`翻页 => 第 ${stepped.before.idx} 张 →(→) ${stepped.right.idx} 张（解码 ${stepped.right.naturalWidth}px，「${stepped.right.cap}」）→(←) ${stepped.left.idx} 张；第 0 张按 ← 绕到 ${stepped.wrapped}/${stepped.total - 1}`);
  if (stepped.right.idx !== stepped.before.idx + 1) failures.push(`按 → 没翻到下一张（${stepped.before.idx} → ${stepped.right.idx}）`);
  if (stepped.right.src === stepped.before.src) failures.push('按 → 之后大图 src 没换：翻页换的是同一张');
  if (!(stepped.right.naturalWidth > 0)) failures.push('翻到的下一张没解码成功');
  if (!new RegExp(`${stepped.right.idx + 1}/${stepped.total}$`).test(stepped.right.cap || '')) failures.push(`翻页后说明条没跟上：「${stepped.right.cap}」`);
  if (stepped.left.idx !== stepped.before.idx) failures.push(`按 ← 没翻回上一张（到了 ${stepped.left.idx}）`);
  if (stepped.left.src !== stepped.before.src) failures.push('翻回来不是原来那张');
  if (stepped.wrapped !== stepped.total - 1) failures.push(`第 1 张按 ← 没绕到最后一张（到了 ${stepped.wrapped}，应 ${stepped.total - 1}）`);

  const closed = JSON.parse(await evaluate(page, `(async () => {
    const wait = async (ms) => await new Promise((resolve) => setTimeout(resolve, ms));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(120);
    const byEsc = { hidden: TB.photos.el.hidden, display: getComputedStyle(TB.photos.el).display, src: TB.photos.full.getAttribute('src'), openClass: document.querySelectorAll('#photos .ph-item.open').length };
    // 再开一次，用「点暗色背景」关
    document.querySelectorAll('#photos .ph-item')[1].click();
    await wait(300);
    const reopened = !TB.photos.el.hidden;
    TB.photos.el.querySelector('.ph-stage').click();
    await wait(120);
    const byBg = { hidden: TB.photos.el.hidden, opened: TB.photos.opened };
    // 说明条上的按钮不能顺手把浮层关掉：点「上一张」时浮层还得在
    document.querySelectorAll('#photos .ph-item')[4].click();
    await wait(300);
    const navBtn = [...TB.photos.el.querySelectorAll('.ph-nav')].find((b) => b.textContent === '‹');
    navBtn.click();
    await wait(400);
    const viaNav = { hidden: TB.photos.el.hidden, opened: TB.photos.opened };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(120);
    return JSON.stringify({ byEsc, reopened, byBg, viaNav, finalHidden: TB.photos.el.hidden });
  })()`, 30000));
  console.log(`Esc 关 => hidden ${closed.byEsc.hidden}、display ${closed.byEsc.display}、src 摘掉 ${closed.byEsc.src === null}、open 标记剩 ${closed.byEsc.openClass} 张`);
  console.log(`点背景关 => 重开 ${closed.reopened}、关掉 ${closed.byBg.hidden}；点‹上一张 => 浮层还在 ${!closed.viaNav.hidden}、翻到第 ${closed.viaNav.opened} 张`);
  if (closed.byEsc.hidden !== true) failures.push('按 Esc 浮层没关');
  if (closed.byEsc.display !== 'none') failures.push(`关掉后还占着布局（display=${closed.byEsc.display}）`);
  if (closed.byEsc.src !== null) failures.push(`关掉后 src 还挂着（${JSON.stringify(closed.byEsc.src)}）：那张全屏位图一直占内存`);
  if (closed.byEsc.openClass !== 0) failures.push(`关掉后仍有 ${closed.byEsc.openClass} 张缩略图带 open 标记`);
  if (!closed.reopened) failures.push('关掉后点缩略图重开不了');
  if (closed.byBg.hidden !== true) failures.push('点暗色背景没关掉');
  if (closed.viaNav.hidden !== false) failures.push('点说明条上的翻页按钮把整个浮层关掉了（背景点击判定把按钮算成了背景）');
  if (closed.finalHidden !== true) failures.push('收尾的 Esc 没关掉浮层');

  if (SHOTS) {
    try {
      const panel = path.join(APP_ROOT, 'samples', 'photos-panel.png');
      await evaluate(page, `TB.photos.close();'ok'`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await capture(page, panel);
      const file = path.join(APP_ROOT, 'samples', 'photos-lightbox.png');
      // 别开自己那两张：samples/ 既是图源又是截图的落点，开到 photos-lightbox.png 就是
      // 「截图里套着上一次的截图」，一层层套下去，这张图反而看不出浮层长什么样
      const shotIndex = JSON.parse(await evaluate(page, `JSON.stringify(TB.photos.items.findIndex((item) => !/photos-(lightbox|panel)\\.png$/i.test(item.path)))`));
      await evaluate(page, `TB.photos.open(${shotIndex >= 0 ? shotIndex : 0});'ok'`);
      await new Promise((resolve) => setTimeout(resolve, 600));
      await capture(page, file);
      await evaluate(page, `TB.photos.close();'ok'`);
      console.log(`截图 ${panel}（真扫 samples 的整条缩略图）和 ${file}（浮层开着的大图）`);
    } catch (error) {
      console.log(`截图失败（不影响功能判定）：${error.message}`);
    }
  }

  // ---------- 5. 切走再切回：同一个浮层节点、一次都不重扫 ----------
  const swapped = JSON.parse(await evaluate(page, `(async () => {
    const el = TB.photos.el;
    el.__probe = 'mark';
    const before = { items: TB.photos.items.length, calls: window.__photosDry.calls.length, src: TB.photos.items[0].url };
    TB.app.setPage('home');
    const gone = !document.getElementById('photos');
    TB.app.setPage('life');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const host = document.getElementById('photos');
    return JSON.stringify({
      gone,
      sameEl: TB.photos.el === el,
      marker: el.__probe,
      inBody: el.parentNode === document.body,
      hiddenAfter: el.hidden,
      items: TB.photos.items.length,
      domItems: host.querySelectorAll('.ph-item').length,
      firstSrc: host.querySelector('.ph-thumb')?.getAttribute('src'),
      before,
      newCalls: window.__photosDry.calls.slice(before.calls).map(([at]) => at),
      count: host.querySelector('.ph-count')?.textContent
    });
  })()`, 30000));
  console.log(`切面板 => 走时格子拆掉 ${swapped.gone}，回来还是同一个浮层节点 ${swapped.sameEl}（标记 ${JSON.stringify(swapped.marker)}、仍挂 body ${swapped.inBody}、关着的 ${swapped.hiddenAfter}）· ${swapped.domItems} 张 · 新增 IPC ${JSON.stringify(swapped.newCalls)}`);
  if (!swapped.gone) failures.push('切到主界面后 #photos 还在 DOM 里（格子本该跟着面板重建）');
  if (!swapped.sameEl) failures.push('切回来浮层被重建了：body 上会攒出第二层遮罩');
  if (swapped.marker !== 'mark') failures.push('浮层元素换了：__probe 标记丢了');
  if (!swapped.inBody) failures.push('切回来后浮层不在 body 上了');
  if (swapped.hiddenAfter !== true) failures.push('切面板时浮层没收起：会盖住顶栏下不来');
  if (swapped.newCalls.includes('scan')) failures.push('切个面板就重扫一遍文件夹：update() 里的「文件夹没变就别扫」没生效');
  if (swapped.domItems !== scanned.itemCount) failures.push(`切回来整条剩 ${swapped.domItems} 张，应还是 ${scanned.itemCount} 张`);
  if (swapped.count !== `${scanned.itemCount} 张`) failures.push(`切回来计数牌是「${swapped.count}」`);

  // ---------- 6. 替身喂 30 张：横向滚的几何 + 中段点一张能滚进可视区 ----------
  const rows = JSON.parse(await evaluate(page, `(async () => {
    const { real, calls } = window.__photosDry;
    const before = calls.length;
    ${FAKE_30}
    const byFolder = new Map();
    const fake = Object.assign({}, real.photos, {
      scan: (folder) => {
        calls.push(['scan', folder]);
        const plan = byFolder.get(folder);
        if (!plan) return Promise.resolve({ photos: [], error: \`没这个剧本：\${folder}\`, folder });
        return Promise.resolve({ ...plan, folder });
      },
      // 选文件夹那一步只回一个假路径，真弹窗（会挡住探针）一次都不碰
      pickFolder: () => { calls.push(['pickFolder', null]); return Promise.resolve('D:/photos/fake-picked'); }
    });
    const configApi = Object.assign({}, real.config, {
      save: (partial) => {
        calls.push(['config.save', partial]);
        return Promise.resolve({
          config: { ...TB.app.state.config, ...(partial || {}) },
          placement: TB.app.state.placement,
          displays: TB.app.state.displays
        });
      }
    });
    TB.api = Object.assign((() => { const copy = {}; for (const key of Object.keys(real)) copy[key] = real[key]; return copy; })(), { photos: fake, config: configApi });
    byFolder.set('L/rows', { photos: mkFake(), error: null });
    byFolder.set('L/missing', { photos: [], error: '文件夹不存在：D:/photos/nope' });
    byFolder.set('L/empty', { photos: [], error: '该文件夹里没有能显示的图片' });
    window.__photosFake = { byFolder };
    TB.photos.folder = 'L/none';
    TB.app.state.config.photos = { folder: 'L/rows', recursive: true, limit: 400 };
    TB.app.refresh('photos');
    const wait = async (ms) => await new Promise((resolve) => setTimeout(resolve, ms));
    const until = Date.now() + 5000;
    while (Date.now() < until && document.querySelectorAll('#photos .ph-item').length < 30) await wait(80);
    const strip = document.querySelector('#photos .ph-strip');
    const scroller = { atStart: Math.round(strip.scrollLeft) };
    strip.scrollLeft = 99999;
    scroller.right = Math.round(strip.scrollLeft);
    strip.scrollLeft = 0;
    // 滚到第 20 张：step() 里的 scrollIntoView 得把当前那张带回可视区。
    // 别直接 .click() 一个在可视区外的节点——那是程序化点击，不是他真会走的路径；
    // 真人是点最左边那张，再用 → 一路翻过去。
    document.querySelectorAll('#photos .ph-item')[0].click();
    const until2 = Date.now() + 6000;
    while (Date.now() < until2 && !(TB.photos.full.complete && TB.photos.full.naturalWidth > 0)) await wait(80);
    const scrollFrom = Math.round(strip.scrollLeft);
    for (let k = 0; k < 20; k += 1) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await wait(30);
    }
    const active = document.querySelector('#photos .ph-item.open');
    const stripRect = strip.getBoundingClientRect();
    const activeRect = active ? active.getBoundingClientRect() : null;
    const out = {
      domItems: document.querySelectorAll('#photos .ph-item').length,
      newCalls: calls.slice(before).map(([at]) => at),
      scroller,
      opened: TB.photos.opened,
      inView: activeRect ? (activeRect.left >= stripRect.left - 1 && activeRect.right <= stripRect.right + 1) : false,
      scrollTo: Math.round(strip.scrollLeft),
      scrollFrom,
      naturalWidth: TB.photos.full.naturalWidth,
      thumbH: activeRect ? Math.round(activeRect.height) : 0,
      stripH: Math.round(stripRect.height)
    };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(120);
    return JSON.stringify(out);
  })()`, 40000));
  console.log(`替身 30 张 => DOM ${rows.domItems} 张，滚到最右 scrollLeft=${rows.scroller.right}，从第 0 张按 20 次 → 到第 ${rows.opened} 张：scrollLeft ${rows.scrollFrom}→${rows.scrollTo}，在当前可视区里 ${rows.inView}（大图解码 ${rows.naturalWidth}px）`);
  console.log(`这一段 IPC => ${JSON.stringify(rows.newCalls)}`);

  const long = JSON.parse(await evaluateReady(page, MEASURE));
  console.log(`几何：格子 ${long.secBox?.w}x${long.secBox?.h} · 整条 ${long.stripBox?.w}x${long.stripBox?.h} · 单张 ${long.thumbBox?.w}x${long.thumbBox?.h}`);
  console.log(`滚动：可视 ${long.stripStyle?.cw} / 内容 ${long.stripStyle?.sw} · anchor ${long.stripStyle?.anchor} · overflow-y ${long.stripStyle?.overflowY}`);
  console.log(`文字：计数牌字形 ${long.countGlyph?.h}px（字号 ${long.countGlyph?.px}px）；内容超出格子 host ${long.hostClip} / sec ${long.secClip}px`);

  if (long.domItems !== 30) failures.push(`喂了 30 张，DOM 只渲染 ${long.domItems} 张`);
  if (long.count !== '30 张') failures.push(`计数牌说的是「${long.count}」，应是「30 张」`);
  if (!(long.stripStyle?.sw > long.stripStyle?.cw)) failures.push(`30 张还没超出可视宽度（内容 ${long.stripStyle?.sw} ≤ 可视 ${long.stripStyle?.cw}）`);
  if (!(rows.scroller.right > rows.scroller.atStart)) failures.push('整条滚不动：后面的照片看不到');
  if (rows.scroller.atStart > 2) failures.push(`刚扫完就停在 ${rows.scroller.atStart}px（该在最左）`);
  if (rows.opened !== 20) failures.push(`按了 20 次 → 停在第 ${rows.opened} 张，应是第 20 张（键盘没接到，或 step 的取模不对）`);
  if (!rows.inView) failures.push('连按 20 次 → 后当前那张不在可视区里：step() 里的 scrollIntoView 没跟着走');
  if (!(rows.scrollTo > rows.scrollFrom)) failures.push(`翻到第 20 张整条没往右滚（scrollLeft ${rows.scrollFrom}→${rows.scrollTo}）：后面的照片翻到了也看不见`);
  if (!(rows.naturalWidth > 0)) failures.push('替身那批点开后大图没解码（url 指的是真文件却解不开）');
  if (long.stripStyle?.overflowY !== 'hidden') failures.push(`整条纵向没锁住（overflow-y=${long.stripStyle?.overflowY}）：第二条滚动条会把缩略图顶出格子`);
  if (long.stripStyle?.anchor !== 'none') failures.push('整条没关滚动锚定：重绘时 scrollLeft 会被弹走');
  if (rows.thumbH > rows.stripH + 1) failures.push(`单张 ${rows.thumbH}px 比整条 ${rows.stripH}px 还高，底部被裁`);
  for (const [name, b] of Object.entries({ head: long.headBox, strip: long.stripBox, item: long.itemBox, thumb: long.thumbBox })) {
    if (b && long.secBox && (b.bottom > long.secBox.bottom + 1 || b.right > long.secBox.right + 1)) failures.push(`${name} 出了格子：${b.right},${b.bottom} > ${long.secBox.right},${long.secBox.bottom}`);
  }
  if (long.hostClip > 1) failures.push(`#photos 内容比自己高 ${long.hostClip}px，底部会被裁掉`);
  if (long.secClip > 1) failures.push(`「${SLOT}」格里内容超了 ${long.secClip}px`);
  for (const [name, g] of Object.entries({ 计数牌: long.countGlyph })) {
    if (!g) { failures.push(`${name}没量到字形矩形`); continue; }
    if (g.px < 11) failures.push(`${name}字号 ${g.px}px 偏小`);
    if (g.clipped) failures.push(`${name}的字形比容器宽，会被截断`);
  }
  if (long.noneText) failures.push(`有 30 张时空态提示没清掉：「${long.noneText}」还挂在整条里`);

  // ---------- 7. 三种「没东西可看」要分开说 ----------
  const errors = JSON.parse(await evaluate(page, `(async () => {
    const wait = async (ms) => await new Promise((resolve) => setTimeout(resolve, ms));
    const out = [];
    document.getElementById('toast').innerHTML = '';
    const want = [
      ['', '没设置', null],
      ['L/missing', '文件夹不存在：D:/photos/nope', '文件夹不存在：D:/photos/nope'],
      ['L/empty', '没有能显示的图', '该文件夹里没有能显示的图片']
    ];
    for (const [folder, label, text] of want) {
      TB.app.state.config.photos = { folder, recursive: true, limit: 400 };
      TB.app.refresh('photos');
      // 只能等「这一次落定了」：.ph-none 从上一趟就一直在，照它等会在扫描途中读，
      // 读到的是上一格的旧文案，几种空状态会被测成「说了同一句话」
      const until = Date.now() + 4000;
      while (Date.now() < until && (TB.photos.folder !== (folder || '') || TB.photos.busy || TB.photos.error !== text)) await wait(80);
      out.push({
        label,
        settled: TB.photos.folder === (folder || '') && !TB.photos.busy && TB.photos.error === text,
        count: document.querySelector('#photos .ph-count')?.textContent,
        none: document.querySelector('#photos .ph-none')?.textContent,
        nonePx: (() => { const n = document.querySelector('#photos .ph-none'); return n ? Math.round(parseFloat(getComputedStyle(n).fontSize) * 10) / 10 : null; })(),
        domItems: document.querySelectorAll('#photos .ph-item').length,
        toasts: [...document.querySelectorAll('#toast .toast')].map((n) => n.textContent)
      });
      document.getElementById('toast').innerHTML = '';
    }
    return JSON.stringify(out);
  })()`, 30000));
  for (const item of errors) {
    console.log(`${item.label} => 计数牌「${item.count}」/ 整条里「${item.none}」（字号 ${item.nonePx}px）/ toast ${JSON.stringify(item.toasts)}`);
  }
  if (errors.length !== 3) failures.push('三种空状态没都跑到');
  else {
    for (const item of errors) {
      if (!item.settled) failures.push(`${item.label}：等 4 秒这一趟也没落定（busy/文案对不上），读到的可能是上一趟的结果`);
      if (item.domItems) failures.push(`${item.label}：没东西可看却还留着 ${item.domItems} 张`);
      if (!(item.nonePx >= 12)) failures.push(`${item.label}：空态提示字号 ${item.nonePx}px，比 12px 还小，这一格里读不动`);
    }
    const [none, missing, empty] = errors;
    if (none.none !== '还没选照片文件夹') failures.push(`没设置文件夹那句是「${none.none}」，应是「还没选照片文件夹」`);
    if (none.count !== '没设置文件夹') failures.push(`没设置文件夹时计数牌是「${none.count}」`);
    if (missing.none !== '文件夹不存在：D:/photos/nope') failures.push(`文件夹不存在的说法丢了：${JSON.stringify(missing.none)}`);
    if (empty.none !== '该文件夹里没有能显示的图片') failures.push(`「没有能显示的图」说法丢了：${JSON.stringify(empty.none)}`);
    if (missing.none === empty.none || none.none === empty.none) failures.push('几种「没东西可看」说成了同一句话');
    for (const item of [missing, empty]) {
      if (item.count !== '没扫到') failures.push(`${item.label}：计数牌是「${item.count}」，应是「没扫到」`);
      if (!item.toasts.some((t) => t === item.none)) failures.push(`${item.label}：报错原因没弹 toast：${JSON.stringify(item.toasts)}`);
    }
    if (none.toasts.length) failures.push(`没设置文件夹不该弹 toast：${JSON.stringify(none.toasts)}`);
  }

  // ---------- 8. 点「选文件夹」：pickFolder 一次 + config.save 只带 photos 这一段 ----------
  const picked = JSON.parse(await evaluate(page, `(async () => {
    const { calls } = window.__photosDry;
    const before = calls.length;
    document.getElementById('toast').innerHTML = '';
    // 剧本：选好之后指向替身那 30 张，真磁盘不背这个锅
    window.__photosFake.byFolder.set('D:/photos/fake-picked', window.__photosFake.byFolder.get('L/rows'));
    const btn = [...document.querySelectorAll('#photos .ph-head .link-btn')].find((b) => b.textContent === '选文件夹');
    btn.click();
    const until = Date.now() + 3000;
    while (Date.now() < until && document.querySelectorAll('#toast .toast').length === 0) await new Promise((resolve) => setTimeout(resolve, 80));
    return JSON.stringify({
      newCalls: calls.slice(before).map(([at, arg]) => [at, at === 'config.save' ? arg : String(arg ?? '')]),
      folder: TB.photos.folder,
      count: document.querySelector('#photos .ph-count')?.textContent,
      domItems: document.querySelectorAll('#photos .ph-item').length,
      toasts: [...document.querySelectorAll('#toast .toast')].map((n) => n.textContent)
    });
  })()`, 20000));
  console.log(`点「选文件夹」=> ${JSON.stringify(picked.newCalls)}，之后这一格读的是「${picked.folder}」（计数牌「${picked.count}」· ${picked.domItems} 张），toast ${JSON.stringify(picked.toasts)}`);
  const pickCalls = picked.newCalls.map(([at]) => at);
  if (!pickCalls.includes('pickFolder')) failures.push('点「选文件夹」没走到主进程');
  if (!pickCalls.includes('config.save')) failures.push('选好文件夹后没写回配置：下次启动又空了');
  const saveArg = picked.newCalls.find(([at]) => at === 'config.save')?.[1];
  if (saveArg !== undefined && JSON.stringify(saveArg) !== JSON.stringify({ photos: { folder: 'D:/photos/fake-picked' } })) failures.push(`config.save 带的不止 photos 这一段：${JSON.stringify(saveArg)}`);
  if (pickCalls.filter((at) => at === 'pickFolder').length !== 1) failures.push('一次点击弹了好几回收选目录框');
  // applyConfigResult → renderAll → update() 已经重扫一遍，pickFolder() 里那句兜底不该再扫第二遍
  if (pickCalls.filter((at) => at === 'scan').length !== 1) failures.push(`选好一次文件夹扫了 ${pickCalls.filter((at) => at === 'scan').length} 遍（update() 那一趟和 pickFolder() 的兜底重复了）`);
  if (picked.domItems !== 30) failures.push(`选好之后整条是 ${picked.domItems} 张，应是剧本里的 30 张`);
  if (!/已加载照片文件夹/.test(picked.toasts.join(' '))) failures.push('选好文件夹后没告诉他加载了哪个：' + JSON.stringify(picked.toasts));

  // ---------- 9. 收尾：换成真 IPC、回到他原来的文件夹和面板 ----------
  await evaluate(page, `(async () => {
    const { real } = window.__photosDry;
    TB.api = real;
    delete window.__photosDry;
    delete window.__photosFake;
    TB.photos.close();
    TB.photos.folder = null;
    TB.photos.index = -1;
    TB.photos.opened = -1;
    TB.app.state.config.photos = { folder: ${JSON.stringify(orig.folder)}, recursive: true, limit: 400 };
    TB.app.refresh('photos');
    await new Promise((resolve) => setTimeout(resolve, 500));
    return 'restored';
  })()`);
  try {
    await evaluate(page, `TB.app.setPage(${JSON.stringify(orig.page)});'ok'`);
  } catch (error) {
    failures.push(`切回原面板 "${orig.page}" 失败：${error.message}`);
  }
  const after = JSON.parse(await evaluateReady(page, MEASURE));
  if (after.view?.hidden !== true) failures.push('收尾时浮层还开着');
  if (after.modules?.gauges !== 'photos') failures.push(`收尾后 ${SLOT} 不是 photos 了：${after.modules?.gauges}`);

  if (failures.length) {
    for (const line of failures) console.log(`✗ ${line}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ 相册那一格全绿：点 tab 后 gauges=photos 且 slot1/slot2/leftzone 都没动、那一整条比旁边一格宽且不压下面那行，` +
      `没选文件夹时格子里写清去哪儿选、浮层不在，真扫 samples/ 的 ${pngs.length} 张走真 IPC 且只扫一次、url 全是 file:/// 且真解得开（不是 track://），` +
      `点开一张浮层挂 body 盖满整窗、大图 naturalWidth>0 且不越界，←/→ 换图、第一张按 ← 绕到最后一张、Esc 与点背景都关得掉而点翻页键不会误关，` +
      `切面板还是同一个浮层节点、一次都不重扫，替身 30 张是「整条自己横向滚 + 点哪张滚到哪张」且缩略图不超格，` +
      `三种「没东西可看」分开说、报错必带 toast，点「选文件夹」只让 config.save 带 photos 那一段且只扫一遍`);
  }
}

main().catch((error) => {
  console.error(`[photos-appprobe] 失败：${error.message}`);
  process.exitCode = 1;
});
