// 生活面板 slot2 那一格（本地视频）的真机验证：附着到真实运行的工具栏（需带 --remote-debugging-port 启动）。
//
// 验的是「他眼睛看到的那一格」：
//   1) 点 tab 切到生活面板，slot2 挂 video、slot1 挂原来的音乐、左边那一整块还是邮箱，
//      中间两格并肩同高（他把 slot1/slot2 点名要放的地方）；
//   2) 没配文件夹时格子里直接写清去哪儿选，而不是黑屏骗人；
//   3) 真扫一次 src/renderer/assets/pet：走的是真 IPC + 真 track://，11 个 webm 都排进列表，
//      每条都带 track://play/ 而不是 file://（file:// 直连媒体元素会被跨源策略挡住）；
//   4) 真播一条：readyState/时长/画面宽高都有值（时长报成 Infinity 就是分段响应没给 Content-Length），
//      track:// 无 Range 回 200 + 整条大小、带 Range 回 206 + 正好 1024 字节 + Content-Range 对得上，
//      content-type 是 video/webm（认不出来 Electron 就当下载，<video> 直接不播）；
//   5) 切走再切回：还是同一个 <video> 元素、src 和时间都没丢，而且一次都不重扫
//      —— 组件每次重建都重扫一遍文件夹，切三次面板就是三次 IO；
//   6) 列表的几何（替身喂 25 行）：舞台/清单并肩、列表自己滚、刚进来停顶部、长标题被省略号截断、
//      行高不裁字形，所有内容都不出格子；
//   7) 两种「没东西可播」的文案分得开：文件夹不存在 vs 里没有支持的格式；
//   8) 点「选文件夹」= pickFolder 一次 + config.save 一次，且那条 IPC 只带 video 这一段
//      （别把整份配置重写一遍），并且探针一次都没让真磁盘背这个锅。
//
// 用法（Git Bash）:
//   1) unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
//   2) node tools/video-appprobe.js [端口] [--shot] [--reload]
//      --shot：存 samples/video-panel.png（真文件夹）和 samples/video-rows.png（替身 25 行）
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
const SLOT = 'slot2';
// 真播那一段的片源：仓库自带的宠物片段，全是 webm，不依赖他机器上有没有视频文件夹
const PET_DIR = path.join(APP_ROOT, 'src', 'renderer', 'assets', 'pet');
const PLAY_TITLE = '待机呼吸休闲';
// 中间那两格是他点名的位置，另一格（slot1）必须还是原来的音乐播放器
const WANT = { slot2: 'video', slot1: 'player', leftzone: 'mail' };

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

// userGesture 只有「真播那一段」用：CDP 的 evaluate 默认不算用户手势，
// 带声音的媒体不放行，play() 会被 autoplay 策略拒掉——所以先静音，再按需要把手势带上。
function evaluate(target, expression, timeoutMs = 60000, userGesture = false) {
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP 超时')); }, timeoutMs);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture } }));
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
  const host = document.getElementById('video');
  const list = host?.querySelector('.vd-list');
  const rows = [...(list?.querySelectorAll('.vd-item') || [])];
  const el = TB.video?.el || null;
  const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  const moduleAt = (at) => document.querySelector(\`#shell > section[data-slot="\${at}"]\`)?.dataset.module || null;
  // 字形矩形自己量，不量容器：容器上写 overflow:hidden 会在自动行高里把内容盒塌成 0，
  // DOM 全在、探针全绿，人却看不清（邮箱那一格同样的规矩）。
  const glyphOf = (row) => {
    const name = row?.querySelector('.vd-item-name');
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
    registered: TB.components.has('video'),
    module: sec?.dataset.module || null,
    slot1: moduleAt('slot1'),
    leftzone: moduleAt('leftzone'),
    modules: { slot1: moduleAt('slot1'), slot2: moduleAt('slot2'), leftzone: moduleAt('leftzone'), gauges: moduleAt('gauges') },
    count: host?.querySelector('.vd-count')?.textContent ?? null,
    countTitle: host?.querySelector('.vd-count')?.title ?? null,
    line: host?.querySelector('.vd-line')?.textContent ?? null,
    noneText: host?.querySelector('.vd-none')?.textContent ?? null,
    domRows: rows.length,
    activeRow: host?.querySelector('.vd-item.active')?.querySelector('.vd-item-name')?.textContent ?? null,
    firstRow: rows.length ? { name: rows[0].querySelector('.vd-item-name').textContent, tag: rows[0].querySelector('.vd-item-tag').textContent, title: rows[0].title } : null,
    glyph: glyphOf(rows[0]),
    nameFontPx: rows.length ? Math.round(parseFloat(getComputedStyle(rows[0].querySelector('.vd-item-name')).fontSize) * 10) / 10 : null,
    ellipsis: [...(host?.querySelectorAll('.vd-item-name') || [])].filter((n) => n.scrollWidth > n.clientWidth + 1).length,
    secBox: box(sec),
    hostBox: box(host),
    headBox: box(host?.querySelector('.vd-head')),
    bodyBox: box(host?.querySelector('.vd-body')),
    stageBox: box(host?.querySelector('.vd-stage')),
    sideBox: box(host?.querySelector('.vd-side')),
    listBox: box(list),
    rowBox: box(rows[0]),
    lastRowBox: box(rows[rows.length - 1]),
    playerBox: box(el),
    wideRows: list ? [...list.querySelectorAll('.vd-item')].filter((n) => n.getBoundingClientRect().right > list.getBoundingClientRect().right + 1).length : 0,
    listStyle: style ? { overflowY: style.overflowY, sh: Math.round(list.scrollHeight), ch: Math.round(list.clientHeight), scrollTop: Math.round(list.scrollTop), anchor: style.overflowAnchor } : null,
    hostClip: host ? Math.round(host.scrollHeight - host.getBoundingClientRect().height) : null,
    secClip: sec ? Math.round(sec.scrollHeight - sec.getBoundingClientRect().height) : null,
    player: el ? {
      src: el.currentSrc || el.src || '',
      hasSrc: Boolean(el.currentSrc || el.src),
      readyState: el.readyState,
      durationRaw: String(el.duration),
      currentTime: Math.round(el.currentTime * 100) / 100,
      videoWidth: el.videoWidth,
      videoHeight: el.videoHeight,
      paused: el.paused,
      muted: el.muted,
      controls: el.controls,
      objectFit: getComputedStyle(el).objectFit,
      inStage: el.parentNode === host?.querySelector('.vd-stage')
    } : null,
    toasts: [...document.querySelectorAll('#toast .toast')].map((n) => n.textContent)
  });
})()`;

// 替身喂的那 25 行：标题都指向真文件（点得动），只是数量、长度和错误分支由探针说了算
function fakeClips(realUrl, realPath) {
  return Array.from({ length: 25 }, (_, i) => ({
    id: `fake-${i}`,
    path: realPath,
    folder: PET_DIR,
    dir: 'pet',
    file: `片段${i}.webm`,
    ext: 'webm',
    title: i === 1 ? '这是一个长得会把右边那一列撑破的标题，所以它应该被省略号截断，而不是压到舞台那一侧去' : `片段 ${String(i).padStart(2, '0')}`,
    size: 240000 + i * 1024,
    mtime: Math.floor(Date.now() / 1000) - i * 60,
    url: realUrl
  }));
}

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
  if (!boot.registered) failures.push('组件注册表里没有 "video"（loader 没注入 src/renderer/js/components/video.js？）');

  // 这版应用没带上主进程那段的话，下面全是假绿——先问一句，不对就直接停
  const api = JSON.parse(await evaluate(page, `JSON.stringify({ hasVideo: Boolean(TB.api?.video), methods: TB.api?.video ? Object.keys(TB.api.video) : [], cfg: TB.app.state.config?.video ?? null, saved: TB.app.state.video ?? null })`));
  if (!api.hasVideo) throw new Error('TB.api.video 不存在：跑的还是旧的主进程，重启应用（npm run dev 那条）再跑本探针');
  console.log(`preload => video.${api.methods.join('/')}；他的视频文件夹 ${JSON.stringify(api.cfg?.folder ?? '')}`);
  if (!fs.existsSync(PET_DIR)) throw new Error(`片源目录不在：${PET_DIR}`);

  const orig = { page: boot.activePage, folder: api.cfg?.folder ?? '', saved: api.saved };
  if (orig.folder) console.log(`他已经配了视频文件夹「${orig.folder}」：跳过「没设置文件夹」那组兜底断言`);

  // ---------- 1. 真点 tab 切过去：slot2=video、slot1 还是音乐、左边那块还是邮箱 ----------
  await evaluate(page, `document.querySelector('.topbar .page-tab[data-page="${PAGE_ID}"]').click();'ok'`);
  const out = JSON.parse(await evaluateReady(page, MEASURE));
  console.log(`面板 ${out.activePage} / ${SLOT} => ${out.module}（slot1=${out.slot1}，leftzone=${out.leftzone}，gauges=${out.modules.gauges}）`);
  console.log(`计数牌「${out.count}」/ 说明行「${out.line}」/ 列表 ${out.listStyle?.ch}px 可视 · ${out.listStyle?.sh}px 内容`);
  console.log(`格子 ${out.secBox?.w}x${out.secBox?.h} @(${out.secBox?.x},${out.secBox?.y}) · 舞台 ${out.stageBox?.w}x${out.stageBox?.h} · 清单列 ${out.sideBox?.w}px`);

  if (out.activePage !== PAGE_ID) failures.push(`点 tab 没切到 "${PAGE_ID}"，还在 "${out.activePage}"`);
  for (const [at, want] of Object.entries(WANT)) {
    if (out.modules[at] !== want) failures.push(`「${at}」这格挂的是 "${out.modules[at]}"，应为 "${want}"（layout.json 里生活面板那一格）`);
  }
  if (out.slot1 === out.module) failures.push('slot1 和 slot2 挂了同一个模块，中间那两格本该一格音乐一格视频');
  // 中间两格并肩同高：他把 slot1/slot2 点名放在同一行
  const s1 = JSON.parse(await evaluate(page, `(() => { const n = document.querySelector('#shell > section[data-slot="slot1"]')?.getBoundingClientRect(); return JSON.stringify(n ? { left: Math.round(n.left), right: Math.round(n.right), top: Math.round(n.top), bottom: Math.round(n.bottom), h: Math.round(n.height) } : null); })()`));
  if (!s1) failures.push('量不到 slot1 那一格');
  else if (out.secBox) {
    if (Math.abs(s1.top - out.secBox.top) > 1 || Math.abs(s1.h - out.secBox.h) > 1) failures.push(`slot1/slot2 不同高不同行：slot1 ${s1.top}+${s1.h}，slot2 ${out.secBox.top}+${out.secBox.h}`);
    if (!(s1.right <= out.secBox.left + 1)) failures.push(`slot1 的右边缘 ${s1.right} 越过了 slot2 的左边缘 ${out.secBox.left}：两格叠在一起了`);
  }

  // ---------- 2. 没配文件夹时格子里说清去哪儿选（而不是黑屏） ----------
  if (!orig.folder) {
    if (out.count !== '没设置文件夹') failures.push(`没配文件夹时计数牌是「${out.count}」，应是「没设置文件夹」`);
    if (!/选文件夹/.test(out.line || '')) failures.push(`说明行没指出去哪儿选：「${out.line}」`);
    if (out.noneText !== '还没选视频文件夹') failures.push(`列表里那句提示是「${out.noneText}」，应是「还没选视频文件夹」`);
    if (out.domRows) failures.push(`还没选文件夹就已经渲染了 ${out.domRows} 行`);
    if (!out.player) failures.push('没配文件夹时连 <video> 都没建（舞台该一直在，只是没源）');
    if (out.player?.hasSrc) failures.push('没配文件夹时 <video> 却有源');
  }

  // ---------- 3. 真扫一次：走真 IPC + 真 track://，片源用仓库自带的宠物片段 ----------
  const scanned = JSON.parse(await evaluate(page, `(async () => {
    const real = TB.api;
    const calls = [];
    const wrap = (overlays) => { const copy = {}; for (const key of Object.keys(real)) copy[key] = real[key]; Object.assign(copy, overlays); return copy; };
    const videoApi = Object.assign({}, real.video, {
      // 透明记一笔：IPC 真走，只把通道和参数记下来（这一格不该有假数据）
      scan: (folder) => { calls.push(['scan', folder]); return real.video.scan(folder); },
      save: (v) => { calls.push(['save', v]); return real.video.save(v); },
      pickFolder: () => { calls.push(['pickFolder', null]); return real.video.pickFolder(); }
    });
    const configApi = Object.assign({}, real.config, { save: (partial) => { calls.push(['config.save', partial]); return real.config.save(partial); } });
    TB.api = wrap({ video: videoApi, config: configApi });
    window.__videoDry = { real, calls };
    TB.video.folder = null;
    TB.app.state.config.video = { folder: ${JSON.stringify(PET_DIR)}, recursive: true };
    TB.app.refresh('video');
    const until = Date.now() + 10000;
    while (Date.now() < until && !TB.video.clips.length) await new Promise((resolve) => setTimeout(resolve, 100));
    return JSON.stringify({
      calls: calls.map(([at, arg]) => [at, at === 'save' ? arg : String(arg ?? '').slice(-24)]),
      clipCount: TB.video.clips.length,
      error: TB.video.error,
      folder: TB.video.folder,
      urls: [...new Set(TB.video.clips.map((clip) => clip.url.slice(0, 16)))],
      exts: [...new Set(TB.video.clips.map((clip) => clip.ext))],
      dirs: [...new Set(TB.video.clips.map((clip) => clip.dir))],
      titles: TB.video.clips.map((clip) => clip.title).slice(0, 4),
      first: TB.video.clips[0] || null
    });
  })()`, 30000));
  console.log(`真扫 ${scanned.clipCount} 条（error=${JSON.stringify(scanned.error)}）=> ${JSON.stringify(scanned.titles)}；url 前缀 ${JSON.stringify(scanned.urls)}，扩展名 ${JSON.stringify(scanned.exts)}，目录 ${JSON.stringify(scanned.dirs)}`);
  console.log(`IPC 记账 => ${JSON.stringify(scanned.calls.map((c) => c[0]))}`);

  if (scanned.error) failures.push(`真扫 assets/pet 报错了：${scanned.error}`);
  if (scanned.clipCount < 11) failures.push(`assets/pet 里 11 个 webm，扫出来只有 ${scanned.clipCount} 条`);
  if (!scanned.urls.every((u) => u.startsWith('track://play/'))) failures.push(`播放地址不是 track://：${JSON.stringify(scanned.urls)}（file:// 直连媒体元素会被跨源策略挡住）`);
  if (scanned.calls.filter((c) => c[0] === 'scan').length !== 1) failures.push(`换一次文件夹扫了 ${scanned.calls.filter((c) => c[0] === 'scan').length} 遍，应只 1 遍`);
  if (scanned.calls.some(([at]) => at === 'config.save')) failures.push('只是渲染层换了个文件夹，就写了 toolbar.config.json');
  if (!scanned.exts.every((e) => e === 'webm')) failures.push(`扫进来了别的格式：${JSON.stringify(scanned.exts)}`);
  if (scanned.titles.some((t) => /\.webm$/i.test(t))) failures.push('标题里还带着 .webm 后缀');
  if (!scanned.first?.path || !path.isAbsolute(scanned.first.path)) failures.push(`条目没带绝对路径：${JSON.stringify(scanned.first)}`);

  const shot = JSON.parse(await evaluateReady(page, MEASURE));
  console.log(`列表 ${shot.domRows} 行，计数牌「${shot.count}」，首行「${shot.firstRow?.name} / ${shot.firstRow?.tag}」，行高 ${shot.glyph?.rowH}px（字形 ${shot.glyph?.h}px，上留 ${shot.glyph?.top}、下留 ${shot.glyph?.bottomGap}）`);
  if (shot.domRows !== scanned.clipCount) failures.push(`扫到 ${scanned.clipCount} 条，DOM 只渲染 ${shot.domRows} 行`);
  if (shot.count !== `${scanned.clipCount} 个文件`) failures.push(`计数牌说的是「${shot.count}」，应是「${scanned.clipCount} 个文件」`);
  if (shot.firstRow?.tag !== 'WEBM') failures.push(`行尾那个格式标签是 ${JSON.stringify(shot.firstRow?.tag)}，应是大写 WEBM`);
  if (!shot.firstRow?.title?.includes(PET_DIR)) failures.push(`行提示没写出完整路径：${JSON.stringify(shot.firstRow?.title)}`);
  if (!shot.player?.inStage) failures.push('<video> 没挂在舞台那一格里');
  if (shot.player?.controls !== true) failures.push('<video> 没开原生控制条（播放/进度/音量/全屏都靠它）');
  if (shot.player?.objectFit !== 'contain') failures.push(`画面是 ${shot.player?.objectFit}，应 contain（拉伸会变形）`);

  // ---------- 4. 真播一条：元数据、时长、分段响应、content-type ----------
  const play = JSON.parse(await evaluate(page, `(async () => {
    const idx = TB.video.clips.findIndex((clip) => clip.title === ${JSON.stringify(PLAY_TITLE)});
    const el = TB.video.el;
    el.muted = true;
    TB.video.play(idx);
    const url = el.currentSrc || el.src;
    const until = Date.now() + 10000;
    while (Date.now() < until && el.readyState < 1) await new Promise((resolve) => setTimeout(resolve, 100));
    const t0 = el.currentTime;
    await new Promise((resolve) => setTimeout(resolve, 700));
    const t1 = el.currentTime;
    await new Promise((resolve) => setTimeout(resolve, 800));
    const saves = window.__videoDry.calls.filter(([at]) => at === 'save').map(([, v]) => v);
    const row = document.querySelector('#video .vd-item.active');
    return JSON.stringify({
      idx,
      url,
      readyState: el.readyState,
      durationRaw: String(el.duration),
      videoWidth: el.videoWidth,
      videoHeight: el.videoHeight,
      t0: Math.round(t0 * 100) / 100,
      t1: Math.round(t1 * 100) / 100,
      paused: el.paused,
      line: document.querySelector('#video .vd-line')?.textContent,
      lineTitle: document.querySelector('#video .vd-line')?.title,
      activeName: row?.querySelector('.vd-item-name')?.textContent,
      saves,
      saveCount: saves.length
    });
  })()`, 30000));
  console.log(`真播「${play.activeName}」readyState ${play.readyState} · 时长 ${play.durationRaw} · 画面 ${play.videoWidth}x${play.videoHeight} · ${play.t0}s → ${play.t1}s（paused=${play.paused}）`);
  console.log(`说明行「${play.line}」/ 写盘 ${play.saveCount} 次 ${JSON.stringify(play.saves[play.saves.length - 1])}`);

  if (play.idx < 0) failures.push(`宠物片段「${PLAY_TITLE}」不在扫出来的列表里，播不了`);
  if (!play.url.startsWith('track://play/')) failures.push(`<video> 的源不是 track://：${JSON.stringify(play.url)}`);
  if (play.readyState < 1) failures.push(`元数据都没到（readyState=${play.readyState}）：track:// 那条分段响应没喂进去`);
  if (!Number.isFinite(Number(play.durationRaw)) || Number(play.durationRaw) <= 0) failures.push(`时长报成 ${play.durationRaw}：缺 Content-Length 时 Chromium 就把 duration 弄成 Infinity，进度条整个废掉`);
  if (!(play.videoWidth > 0 && play.videoHeight > 0)) failures.push(`画面尺寸是 ${play.videoWidth}x${play.videoHeight}，解不出视频轨`);
  if (play.t1 <= play.t0) failures.push(`播了 0.7 秒时间却没走（${play.t0} → ${play.t1}）：静音了还被 autoplay 挡住，或源根本没加载`);
  if (!play.activeName) failures.push('点一行后没有高亮当前条');
  if (!play.line?.includes(PLAY_TITLE)) failures.push(`说明行没写当前这条：「${play.line}」`);
  if (!/\d{1,2}:\d{2}\s*\/\s*\d{1,2}:\d{2}/.test(play.line || '')) failures.push(`说明行不是「当前 / 总长」的写法：「${play.line}」`);
  if (!play.lineTitle?.includes(PET_DIR)) failures.push(`说明行的 title 没带完整路径：${JSON.stringify(play.lineTitle)}`);
  // 记一次就够：pause/volumechange/timeupdate 都挂了 persist，600ms 去抖要真把它压住
  if (play.saveCount < 1) failures.push('播了却没记住「看到哪儿」：video:save 一次都没走');
  else if (play.saveCount > 3) failures.push(`0.7 秒的播放写了 ${play.saveCount} 次盘，去抖没生效`);
  const saved = play.saves[play.saves.length - 1] || {};
  // source / section 必须一起带上：store.set('video', …) 是整块替换，漏一个下次开机那一档和页签就回默认值
  if (JSON.stringify(Object.keys(saved).sort()) !== JSON.stringify(['clipId', 'muted', 'position', 'section', 'source', 'volume'])) failures.push(`写盘的形状变了：${JSON.stringify(Object.keys(saved))}`);
  if (saved.clipId !== path.join(PET_DIR, `${PLAY_TITLE}.webm`).toLowerCase()) failures.push(`记住的那条不是当前这条：${JSON.stringify(saved.clipId)}`);

  const http2 = JSON.parse(await evaluate(page, `(async () => {
    const url = TB.video.el.currentSrc || TB.video.el.src;
    const full = await fetch(url);
    const ranged = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
    const bytes = await ranged.arrayBuffer();
    return JSON.stringify({
      status: full.status,
      type: full.headers.get('content-type'),
      length: full.headers.get('content-length'),
      acceptRanges: full.headers.get('accept-ranges'),
      rangedStatus: ranged.status,
      rangedLength: ranged.headers.get('content-length'),
      contentRange: ranged.headers.get('content-range'),
      rangedBytes: bytes.byteLength
    });
  })()`, 60000));
  console.log(`track:// => 整条 ${http2.status} · ${http2.type} · ${http2.length}B · Accept-Ranges ${http2.acceptRanges}；带 Range 0-1023 => ${http2.rangedStatus} · ${http2.rangedLength}B · "${http2.contentRange}" · 实到 ${http2.rangedBytes}B`);
  if (http2.type !== 'video/webm') failures.push(`content-type 是 ${JSON.stringify(http2.type)}：认不出 MIME 时 Chromium 当下载处理，<video> 不播`);
  if (http2.status !== 200 || !Number(http2.length)) failures.push(`整条响应 ${http2.status} / Content-Length=${JSON.stringify(http2.length)}`);
  if (http2.acceptRanges !== 'bytes') failures.push('没声明 Accept-Ranges: bytes，进度条拖不动');
  if (http2.rangedStatus !== 206) failures.push(`带 Range 的请求回了 ${http2.rangedStatus}，应是 206（分段响应是手写的）`);
  if (http2.rangedBytes !== 1024 || http2.rangedLength !== '1024') failures.push(`Range 0-1023 实到 ${http2.rangedBytes}B / 头里写 ${JSON.stringify(http2.rangedLength)}`);
  if (!/^bytes 0-1023\/\d+$/.test(http2.contentRange || '')) failures.push(`Content-Range 对不上：${JSON.stringify(http2.contentRange)}`);

  if (SHOTS) {
    try {
      const file = path.join(APP_ROOT, 'samples', 'video-panel.png');
      await capture(page, file);
      console.log(`截图 ${file}（真扫 assets/pet + 真 track://）`);
    } catch (error) {
      console.log(`截图失败（不影响功能判定）：${error.message}`);
    }
  }

  // ---------- 5. 切走再切回：同一个 <video>、不重扫 ----------
  const swapped = JSON.parse(await evaluate(page, `(async () => {
    const el = TB.video.el;
    el.__probe = 'mark';
    const before = { time: Math.round(el.currentTime * 100) / 100, src: el.currentSrc || el.src, calls: window.__videoDry.calls.length };
    TB.app.setPage('home');
    const gone = !document.getElementById('video');
    TB.app.setPage('life');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const host = document.getElementById('video');
    return JSON.stringify({
      gone,
      sameEl: TB.video.el === el,
      marker: el.__probe,
      inStage: el.parentNode === host?.querySelector('.vd-stage'),
      srcAfter: el.currentSrc || el.src,
      timeAfter: Math.round(el.currentTime * 100) / 100,
      before,
      newCalls: window.__videoDry.calls.slice(before.calls).map(([at]) => at),
      rows: host?.querySelectorAll('.vd-item').length,
      activeName: host?.querySelector('.vd-item.active .vd-item-name')?.textContent
    });
  })()`, 30000));
  console.log(`切面板 => 走时格子拆掉 ${swapped.gone}，回来还是同一个 <video> ${swapped.sameEl}（标记 ${JSON.stringify(swapped.marker)}、挂在舞台 ${swapped.inStage}）· 时间 ${swapped.before.time}s → ${swapped.timeAfter}s · 新增 IPC ${JSON.stringify(swapped.newCalls)}`);
  if (!swapped.gone) failures.push('切到主界面后 #video 还在 DOM 里（格子本该跟着面板重建）');
  if (!swapped.sameEl) failures.push('切回生活面板时 <video> 被重建了：正在播的那条会从头开始');
  if (swapped.marker !== 'mark') failures.push('元素换了：__probe 标记丢了');
  if (!swapped.inStage) failures.push('切回来后 <video> 没挂进新的舞台格里');
  if (swapped.srcAfter !== swapped.before.src) failures.push(`回来时源被改掉了：${JSON.stringify(swapped.srcAfter)}`);
  if (swapped.timeAfter + 0.5 < swapped.before.time) failures.push(`回来时时间掉回 ${swapped.timeAfter}s（切之前 ${swapped.before.time}s）`);
  if (swapped.newCalls.includes('scan')) failures.push('切个面板就重扫一遍文件夹：update() 里的「文件夹没变就别扫」没生效');
  if (swapped.rows !== scanned.clipCount) failures.push(`切回来列表剩 ${swapped.rows} 行，应还是 ${scanned.clipCount} 行`);
  if (swapped.activeName !== PLAY_TITLE) failures.push(`切回来高亮的是「${swapped.activeName}」，应还是「${PLAY_TITLE}」`);

  // ---------- 6. 替身喂 25 行：列表几何 + 两种「没东西可播」分开说 ----------
  const url = play.url;
  const clips = fakeClips(url, play.lineTitle);
  const rows = JSON.parse(await evaluate(page, `(async () => {
    const { real } = window.__videoDry;
    const calls = window.__videoDry.calls;
    const before = calls.length;
    const byFolder = new Map();
    const fake = Object.assign({}, real.video, {
      scan: (folder) => {
        calls.push(['scan', folder]);
        const plan = byFolder.get(folder);
        if (!plan) return Promise.resolve({ clips: [], error: \`没这个剧本：\${folder}\`, folder });
        return Promise.resolve({ ...plan, folder });
      },
      // 选文件夹那一步只回一个假路径，真弹窗（会挡住探针）一次都不碰
      pickFolder: () => { calls.push(['pickFolder', null]); return Promise.resolve('D:/videos/fake-picked'); }
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
    TB.api = Object.assign((() => { const copy = {}; for (const key of Object.keys(real)) copy[key] = real[key]; return copy; })(), { video: fake, config: configApi });
    byFolder.set('L/rows', { clips: ${JSON.stringify(clips)} });
    byFolder.set('L/missing', { clips: [], error: '文件夹不存在：D:/videos/nope' });
    byFolder.set('L/empty', { clips: [], error: '该文件夹里没有可播放的视频文件' });
    window.__videoFake = { byFolder };
    TB.video.folder = 'L/none';
    TB.app.state.config.video = { folder: 'L/rows', recursive: true };
    TB.app.refresh('video');
    const until = Date.now() + 5000;
    while (Date.now() < until && document.querySelectorAll('#video .vd-item').length < 25) await new Promise((resolve) => setTimeout(resolve, 80));
    const list = document.querySelector('#video .vd-list');
    const scroller = { atStart: Math.round(list.scrollTop) };
    list.scrollTop = 99999;
    scroller.bottom = Math.round(list.scrollTop);
    list.scrollTop = 0;
    // 点第 12 行：靠 scrollIntoView 把它带进可视区，同时确认长列表中段也播得动
    document.querySelectorAll('#video .vd-item')[12].click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const active = document.querySelector('#video .vd-item.active');
    return JSON.stringify({
      domRows: document.querySelectorAll('#video .vd-item').length,
      newCalls: calls.slice(before).map(([at]) => at),
      scroller,
      activeName: active?.querySelector('.vd-item-name')?.textContent,
      activeVisible: active ? Math.round(active.getBoundingClientRect().top) >= Math.round(list.getBoundingClientRect().top) - 1 && Math.round(active.getBoundingClientRect().bottom) <= Math.round(list.getBoundingClientRect().bottom) + 1 : null,
      time: Math.round(TB.video.el.currentTime * 100) / 100
    });
  })()`, 30000));
  console.log(`替身 25 行 => DOM ${rows.domRows} 行，滚到底 scrollTop=${rows.scroller.bottom}，点第 12 行高亮「${rows.activeName}」并在可视区内 ${rows.activeVisible}`);
  console.log(`这一段 IPC => ${JSON.stringify(rows.newCalls)}`);

  const long = JSON.parse(await evaluateReady(page, MEASURE));
  console.log(`几何：格子 ${long.secBox?.w}x${long.secBox?.h} · 舞台 ${long.stageBox?.w}x${long.stageBox?.h} · 清单列 ${long.sideBox?.w}x${long.sideBox?.h} · 列表 ${long.listStyle?.ch}/${long.listStyle?.sh}px scrollTop ${long.listStyle?.scrollTop}`);
  console.log(`首行字形 ${long.glyph?.h}px（行 ${long.glyph?.rowH}px，上留 ${long.glyph?.top}、下留 ${long.glyph?.bottomGap}），省略号 ${long.ellipsis} 处，超出列表右边缘 ${long.wideRows} 行`);

  if (long.domRows !== 25) failures.push(`喂了 25 行，DOM 只渲染 ${long.domRows} 行`);
  if (long.count !== '25 个文件') failures.push(`计数牌说的是「${long.count}」，应是「25 个文件」`);
  if (!(long.listStyle?.sh > long.listStyle?.ch)) failures.push(`25 行还没超出可视高度（内容 ${long.listStyle?.sh} ≤ 可视 ${long.listStyle?.ch}）`);
  if (!(rows.scroller.bottom > rows.scroller.atStart)) failures.push('列表滚不动：滚动条没生效，后面的行看不到');
  if (rows.scroller.atStart > 2) failures.push(`刚扫完列表就停在 ${rows.scroller.atStart}px（该在顶部）`);
  if (!(long.listStyle?.scrollTop > 2)) failures.push(`点第 12 行后没跟着滚过去：scrollTop=${long.listStyle?.scrollTop}（scrollIntoView 该把它带进可视区）`);
  if (long.listStyle?.overflowY !== 'auto') failures.push(`列表不是自己滚的：overflow-y=${long.listStyle?.overflowY}`);
  if (long.listStyle?.anchor !== 'none') failures.push(`列表没关掉滚动锚定（overflow-anchor=${long.listStyle?.anchor}）：重绘时会被弹到底部`);
  if (!rows.activeVisible) failures.push('点中第 12 行后它不在可视区里：scrollIntoView 没生效');
  if (rows.activeName !== '片段 12') failures.push(`点第 12 行高亮的是「${rows.activeName}」`);
  if (long.ellipsis < 1) failures.push('那条超长标题没被省略号截断（要么撑破了，要么数据没进去）');
  if (long.wideRows) failures.push(`${long.wideRows} 行的右边缘越过列表可视宽度，会被 .area 裁掉`);
  if (long.glyph) {
    if (long.glyph.top < 0 || long.glyph.bottomGap < 1) failures.push(`标题被行高裁掉了：行 ${long.glyph.rowH}px，字形 ${long.glyph.h}px，上留 ${long.glyph.top}、下留 ${long.glyph.bottomGap}`);
    if (long.glyph.h < 12) failures.push(`标题字形只有 ${long.glyph.h}px，低于 12px 的可读下限`);
  } else failures.push('一行都没量到字形矩形');
  if (long.nameFontPx !== null && long.nameFontPx < 12) failures.push(`标题字号 ${long.nameFontPx}px 偏小`);
  if (long.stageBox && long.sideBox && Math.abs(long.stageBox.top - long.sideBox.top) > 1) failures.push(`舞台和清单列没并肩：top ${long.stageBox.top} vs ${long.sideBox.top}`);
  if (long.stageBox && long.sideBox && !(long.stageBox.right <= long.sideBox.left + 1)) failures.push('清单列压到舞台上了：两者左右重叠');
  for (const [name, box] of Object.entries({ head: long.headBox, body: long.bodyBox, stage: long.stageBox, side: long.sideBox, list: long.listBox, player: long.playerBox })) {
    if (box && long.secBox && (box.bottom > long.secBox.bottom + 1 || box.right > long.secBox.right + 1)) failures.push(`${name} 出了格子：${box.right},${box.bottom} > ${long.secBox.right},${long.secBox.bottom}`);
  }
  if (long.hostClip > 1) failures.push(`#video 内容比自己高 ${long.hostClip}px，底部会被裁掉`);
  if (long.secClip > 1) failures.push(`「${SLOT}」格里内容超了 ${long.secClip}px`);

  if (SHOTS) {
    try {
      const file = path.join(APP_ROOT, 'samples', 'video-rows.png');
      await capture(page, file);
      console.log(`截图 ${file}（列表数据来自替身，画面仍是真文件那条 track://）`);
    } catch (error) {
      console.log(`截图失败（不影响功能判定）：${error.message}`);
    }
  }

  // ---------- 7. 两种「没东西可播」要分开说 ----------
  const errors = JSON.parse(await evaluate(page, `(async () => {
    const out = [];
    document.getElementById('toast').innerHTML = '';
    const want = [
      ['L/missing', '文件夹不存在', '文件夹不存在：D:/videos/nope'],
      ['L/empty', '没有可播的', '该文件夹里没有可播放的视频文件']
    ];
    for (const [folder, label, text] of want) {
      TB.app.state.config.video = { folder, recursive: true };
      TB.app.refresh('video');
      // 只能等「这一次扫回来了」：.vd-none 从上一趟就一直在，照它等会在扫描途中读，
      // 读到的是上一格的旧文案，两条错误会被测成「说了同一句话」
      const until = Date.now() + 4000;
      while (Date.now() < until && (TB.video.folder !== folder || TB.video.busy || TB.video.error !== text)) {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      out.push({
        label,
        settled: TB.video.folder === folder && !TB.video.busy && TB.video.error === text,
        count: document.querySelector('#video .vd-count')?.textContent,
        none: document.querySelector('#video .vd-none')?.textContent,
        line: document.querySelector('#video .vd-line')?.textContent,
        domRows: document.querySelectorAll('#video .vd-item').length,
        toasts: [...document.querySelectorAll('#toast .toast')].map((n) => n.textContent)
      });
      document.getElementById('toast').innerHTML = '';
    }
    return JSON.stringify(out);
  })()`));
  for (const item of errors) {
    console.log(`${item.label} => 计数牌「${item.count}」/ 列表里「${item.none}」/ 说明行「${item.line}」/ toast ${JSON.stringify(item.toasts)}`);
  }
  if (errors.length !== 2) failures.push('两种空状态没都跑到');
  else {
    for (const item of errors) {
      if (!item.settled) failures.push(`${item.label}：等 4 秒这一趟扫描也没落定（busy/文案对不上），读到的可能是上一趟的结果`);
    }
    const [missing, empty] = errors;
    if (missing.none !== '文件夹不存在：D:/videos/nope') failures.push(`文件夹不存在的说法丢了：${JSON.stringify(missing.none)}`);
    if (empty.none !== '该文件夹里没有可播放的视频文件') failures.push(`「没有可播的」说法丢了：${JSON.stringify(empty.none)}`);
    if (missing.none === empty.none) failures.push('两种「没东西可播」说成了同一句话');
    for (const item of [missing, empty]) {
      if (item.count !== '没扫到') failures.push(`报错时计数牌是「${item.count}」，应是「没扫到」`);
      if (item.domRows) failures.push(`报错时还留着 ${item.domRows} 行上一次的数据`);
      if (!item.toasts.some((t) => t === item.none)) failures.push(`${item.label}：报错原因没弹 toast：${JSON.stringify(item.toasts)}`);
    }
  }

  // ---------- 8. 点「选文件夹」：pickFolder 一次 + config.save 只带 video 这一段 ----------
  const picked = JSON.parse(await evaluate(page, `(async () => {
    const calls = window.__videoDry.calls;
    const before = calls.length;
    document.getElementById('toast').innerHTML = '';
    const btn = [...document.querySelectorAll('#video .vd-head .link-btn')].find((b) => b.textContent === '选文件夹');
    btn.click();
    const until = Date.now() + 3000;
    while (Date.now() < until && document.querySelectorAll('#toast .toast').length === 0) await new Promise((resolve) => setTimeout(resolve, 80));
    return JSON.stringify({
      newCalls: calls.slice(before).map(([at, arg]) => [at, at === 'config.save' ? arg : String(arg ?? '').slice(-20)]),
      folder: TB.video.folder,
      count: document.querySelector('#video .vd-count')?.textContent,
      toasts: [...document.querySelectorAll('#toast .toast')].map((n) => n.textContent)
    });
  })()`, 20000));
  console.log(`点「选文件夹」=> ${JSON.stringify(picked.newCalls)}，之后这一格读的是「${picked.folder}」（计数牌「${picked.count}」），toast ${JSON.stringify(picked.toasts)}`);
  const pickCalls = picked.newCalls.map(([at]) => at);
  if (!pickCalls.includes('pickFolder')) failures.push('点「选文件夹」没走到主进程');
  if (!pickCalls.includes('config.save')) failures.push('选好文件夹后没写回配置：下次启动又空了');
  const saveArg = picked.newCalls.find(([at]) => at === 'config.save')?.[1];
  if (saveArg !== undefined && JSON.stringify(saveArg) !== JSON.stringify({ video: { folder: 'D:/videos/fake-picked' } })) failures.push(`config.save 带的不止 video 这一段：${JSON.stringify(saveArg)}`);
  if (pickCalls.filter((at) => at === 'pickFolder').length !== 1) failures.push('一次点击弹了好几回收选目录框');
  // applyConfigResult → renderAll → update() 已经重扫一遍，pickFolder() 里那句兜底不该再扫第二遍
  if (pickCalls.filter((at) => at === 'scan').length !== 1) failures.push(`选好一次文件夹扫了 ${pickCalls.filter((at) => at === 'scan').length} 遍（update() 那一趟和 pickFolder() 的兜底重复了）`);
  if (!/已加载视频文件夹/.test(picked.toasts.join(' '))) failures.push('选好文件夹后没告诉他加载了哪个：' + JSON.stringify(picked.toasts));

  // ---------- 9. 收尾：换成真 IPC、回到他原来的文件夹和面板 ----------
  // 「看到哪儿」那一条也写回开机时读到的原值：探针播的是仓库自带的片段，
  // 留在 state.json 里下次开机就会跳到宠物画面上，那不是他的视频。
  await evaluate(page, `(async () => {
    const { real } = window.__videoDry;
    TB.api = real;
    delete window.__videoDry;
    delete window.__videoFake;
    TB.video.el.pause();
    TB.video.el.muted = false;
    TB.video.el.removeAttribute('src');
    TB.video.el.load();
    TB.video.folder = null;
    TB.video.index = -1;
    TB.app.state.config.video = { folder: ${JSON.stringify(orig.folder)}, recursive: true };
    TB.app.refresh('video');
    await new Promise((resolve) => setTimeout(resolve, 500));
    TB.app.state.video = ${JSON.stringify(orig.saved ?? null)};
    await TB.api.video.save(${JSON.stringify(orig.saved ?? null)});
    return 'restored';
  })()`);
  try {
    await evaluate(page, `TB.app.setPage(${JSON.stringify(orig.page)});'ok'`);
  } catch (error) {
    failures.push(`切回原面板 "${orig.page}" 失败：${error.message}`);
  }

  if (failures.length) {
    for (const line of failures) console.log(`✗ ${line}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ 视频那一格全绿：点 tab 后 slot2=video / slot1=音乐 / leftzone=邮箱且中间两格并肩同高，` +
      `没选文件夹时格子里直接写清去哪儿选，真扫 assets/pet 走真 IPC 且只扫一次、11 条都排进列表并带 track://，` +
      `真播「${PLAY_TITLE}」元数据/时长/画面尺寸都对（不是 Infinity）、进度在走、整条 200 + 带 Range 206 且 content-type 是 video/webm，` +
      `切面板还是同一个 <video>、时间没丢、一次都不重扫，替身 25 行的几何是「舞台 / 并肩的清单列 / 自己滚的列表」且长标题被截断，` +
      `两种「没东西可播」分开说、报错必带 toast，点「选文件夹」只让 config.save 带 video 那一段`);
  }
}

main().catch((error) => {
  console.error(`[video-appprobe] 失败：${error.message}`);
  process.exitCode = 1;
});
