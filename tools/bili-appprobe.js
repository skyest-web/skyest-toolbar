// 生活面板 slot2「B站」那一档的真机验证：附着到真实运行的工具栏（需带 --remote-debugging-port 启动）。
//
// 这一支一次都不出网：TB.api.bili 整个换成页内替身（假 transport 那条在 tools/bili-check.js 里测），
// 所以这里验的全是「他眼睛看到的东西」和「凭据有没有跟着界面数据跑出去」：
//   1) 默认是本地档：画面格在、页签行整条 hidden、「刷新」不占位，而且不为看不见的 B站 发一次请求；
//   2) 点「B站」：画面格收起、清单吃掉整格宽、三个页签（稍后再看/观看历史/我的收藏）、
//      <video> 被暂停（切档了还在背后放声音，最容易被当成 bug）；
//   3) 行怎么排：封面块定宽、标题被省略号截断、meta 那行是「UP · 时长 · 看到 m:ss」，
//      seenAt 为空的行不该冒出「看到 0:00」，封面挂了就把 <img> 摘掉、块子还在（行高不乱）；
//   4) 点一行只把 id 递回主进程，toast 说「已交给浏览器打开」；点夹子才下钻，「← 收藏夹列表」在页签行最右；
//   5) 三种「看不到东西」分开说：没填 cookie（带一个跳到设置 Bilibili 卡片的按钮）vs 账号没登录 vs 单子空的；
//   6) 切走面板再切回：还是 B站 那一档、一次都不重问（每次重建都重扫一遍就是白白的 IO）；切回本地：
//      画面格回来，且一次 bili 请求都不发；
//   7) 设置里那张卡片：密码框不回填、文案说清 cookie 只进 userData/bili-auth.bin，
//      并且 SESSDATA 的值在渲染层任何一处数据里都搜不到（state.json 的 video 段、DOM、IPC 参数）。
//
// 用法（Git Bash）:
//   1) unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
//   2) node tools/bili-appprobe.js [端口] [--shot] [--reload]
//      --shot：存 samples/bili-panel.png（稍后再看）和 samples/bili-fav.png（夹子下钻那层）
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
// 假 cookie：形状像真的，好在「漏了」的时候一眼能在断言输出里看见
const FAKE_SESS = 'probeSESSDATA%2C0123456789abcdef';

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
  const host = document.getElementById('video');
  const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right) }; };
  const rows = [...(host?.querySelectorAll('.bl-item') || [])];
  const local = [...(host?.querySelectorAll('.vd-item') || [])];
  const tabs = [...(host?.querySelectorAll('.bl-tab') || [])];
  const segs = [...(host?.querySelectorAll('.seg-btn') || [])];
  const btns = [...(host?.querySelectorAll('.vd-head .link-btn') || [])];
  const strip = getComputedStyle(host?.querySelector('.vd-body') || host || document.body);
  const style = (n) => (n ? getComputedStyle(n).display : null);
  return JSON.stringify({
    activePage: TB.app.state.page,
    module: sec?.dataset.module || null,
    isBili: host?.classList.contains('is-bili') || false,
    source: TB.video?.source ?? null,
    section: TB.video?.bili?.section ?? null,
    folderIn: TB.video?.bili?.folder?.folderId ?? null,
    biliLoaded: TB.video?.bili?.loaded ?? null,
    segOn: segs.filter((n) => n.classList.contains('on')).map((n) => n.textContent),
    headBtns: btns.map((n) => [n.textContent, n.hidden]),
    tabs: tabs.map((n) => [n.textContent, n.classList.contains('on') ? 1 : 0, n.classList.contains('bl-back') ? 1 : 0]),
    tabsDisplay: style(host?.querySelector('.bl-tabs')),
    stageDisplay: style(host?.querySelector('.vd-stage')),
    stageBox: box(host?.querySelector('.vd-stage')),
    sideBox: box(host?.querySelector('.vd-side')),
    listBox: box(host?.querySelector('.vd-list')),
    bodyBox: box(host?.querySelector('.vd-body')),
    count: host?.querySelector('.vd-count')?.textContent ?? null,
    line: host?.querySelector('.vd-line')?.textContent ?? null,
    lineErr: host?.querySelector('.vd-line')?.classList.contains('err') || false,
    noneText: host?.querySelector('.vd-none')?.textContent ?? null,
    noneBtn: host?.querySelector('.vd-none button')?.textContent ?? null,
    domBiliRows: rows.length,
    domLocalRows: local.length,
    // 组件内存里的封面地址：证明 https 就是 https，没被拼成 track:// 或 file://
    covers: (TB.video?.bili?.rows || []).map((r) => String(r.cover).slice(0, 30)),
    rows: rows.map((n) => {
      const img = n.querySelector('.bl-img');
      const title = n.querySelector('.bl-title');
      return {
        title: title?.textContent ?? null,
        meta: n.querySelector('.bl-meta')?.textContent ?? null,
        mark: n.querySelector('.bl-mark')?.textContent ?? null,
        isFolder: n.classList.contains('bl-folder') || false,
        coverBox: box(n.querySelector('.bl-cover')),
        imgSrc: img?.getAttribute('src') ?? null,
        imgW: img?.naturalWidth ?? null,
        imgOk: Boolean(img),
        titleClipped: title ? title.scrollWidth > title.clientWidth + 1 : null,
        titleFit: title ? [title.scrollWidth, title.clientWidth, Math.round(parseFloat(getComputedStyle(title).fontSize))] : null,
        titlePx: title ? Math.round(parseFloat(getComputedStyle(title).fontSize) * 10) / 10 : null,
        rowH: Math.round(n.getBoundingClientRect().height)
      };
    }),
    // 越出格子的：只看左右。上下越出去是清单自己在滚（.vd-list 是 overflow-y:auto），
    // 被滚出去的那一行 getBoundingClientRect 照样在格子下面，那不是 bug。
    // 格子有没有被清单撑高，看 hostBox 和 secBox 的高度差（下面单独断言）。
    outOfCell: (() => {
      const c = host?.getBoundingClientRect();
      if (!c) return [];
      return [...(host?.querySelectorAll('.bl-item, .bl-tab, .vd-count, .vd-line') || [])]
        .map((n) => {
          const r = n.getBoundingClientRect();
          return [n.className.split(' ')[0] || n.tagName, String(n.textContent).slice(0, 10), Math.round(r.right - c.right), Math.round(r.left - c.left)];
        })
        .filter(([cls, text, over, left]) => over > 1 || left < -1);
    })(),
    listBoxScroll: (() => { const n = host?.querySelector('.vd-list'); return n ? [n.scrollHeight, n.clientHeight, getComputedStyle(n).overflowY] : null; })(),
    secBox: box(sec),
    hostBox: box(host),
    player: TB.video?.el ? { paused: TB.video.el.paused, hasSrc: Boolean(TB.video.el.getAttribute('src')) } : null,
    toasts: [...document.querySelectorAll('#toast .toast')].map((n) => n.textContent)
  });
})()`;

// 页内替身：TB.api.bili 整个换掉，video.scan 透明记一笔（IPC 真走，清单要的是真数据），
// video.save 只记不落盘（见下面 copy.video.save 那条注释）
const INSTALL = `(() => {
  // 上一次跑到一半崩了会留下一个没拆掉的替身；先把它拆回真 API，否则这次装的替身套在替身外面，
  // 记账记到旧数组上，后面每组都会莫名其妙红一片
  if (window.__biliDry) { TB.api = window.__biliDry.real; delete window.__biliDry; }
  const real = TB.api;
  const copy = {};
  for (const key of Object.keys(real)) copy[key] = real[key];
  const calls = [];
  const box = {
    error: null,
    listDelay: 0,
    rows: {
      toview: [
        { kind: 'video', id: 'v:BV1probe1', bvid: 'BV1probe1', title: '探针稍后再看第一条，这个标题故意写得很长很长很长，长得必须让那一列自己用省略号把它截掉', up: 'UP甲', duration: 73, seenAt: 33, cover: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' },
        { kind: 'video', id: 'v:BV1probe2', bvid: 'BV1probe2', title: '探针稍后再看第二条', up: 'UP乙', duration: 3700, seenAt: null, cover: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' },
        { kind: 'video', id: 'v:BV1probe3', bvid: 'BV1probe3', title: '封面是 https 的那条', up: 'UP丙', duration: 42, seenAt: null, cover: 'https://i0.hdslb.com/bfs/seed/probe3.jpg' },
        { kind: 'video', id: 'v:BV1probe4', bvid: 'BV1probe4', title: '封面挂了的那条', up: 'UP丁', duration: 8, seenAt: null, cover: 'https://127.0.0.1:9/no-such-cover.jpg' }
      ],
      history: [
        { kind: 'video', id: 'v:BV1hist1', bvid: 'BV1hist1', title: '探针历史一条', up: 'UP丁', duration: 900, seenAt: null, cover: '' }
      ],
      fav: [
        { kind: 'folder', id: 'f:901', folderId: 901, title: '探针收藏夹甲', count: 13, cover: '' },
        { kind: 'folder', id: 'f:902', folderId: 902, title: '空的收藏夹', count: 0, cover: '' }
      ],
      'fav:901': [{ kind: 'video', id: 'v:BV1fav1', bvid: 'BV1fav1', title: '夹子里的第一条', up: 'UP戊', duration: 15, seenAt: null, cover: '' }],
      'fav:902': []
    },
    // sess 这一项是真主进程绝不会发出来的东西：替身故意带上，好在最后一组里验「渲染层只画自己认识的那几个字段」
    status: { set: true, hint: '26 位 · 尾 ef', encrypted: true, logged: true, uname: '探针账号名', mid: 2333, hasCookie: true, sess: ${JSON.stringify(FAKE_SESS)} }
  };
  const key = (section, opts) => (opts && opts.folderId ? section + ':' + opts.folderId : section);
  copy.bili = {
    status: () => { calls.push(['status']); return Promise.resolve(box.status); },
    list: (section, opts) => {
      calls.push(['list', section, opts || null]);
      const out = { section, folderId: (opts && opts.folderId) || null, cached: false, total: 0 };
      out.rows = box.rows[key(section, opts)] || [];
      out.total = out.rows.length;
      if (box.error) { out.error = box.error; out.rows = []; }
      return Promise.resolve(out);
    },
    open: (id) => { calls.push(['open', id]); return Promise.resolve({ ok: true, toast: '已交给浏览器打开「' + id + '」' }); },
    setAuth: (v) => { calls.push(['setAuth', v]); return Promise.resolve({ ok: true, set: true, hint: '26 位 · 尾 ef', encrypted: true }); },
    clearAuth: () => { calls.push(['clearAuth']); return Promise.resolve({ ok: true, set: false, hint: null, encrypted: true }); },
    check: () => { calls.push(['check']); return Promise.resolve(box.error ? { ok: false, error: box.error } : { ok: true, ...box.status }); }
  };
  copy.video = Object.assign({}, real.video, {
    scan: (folder) => { calls.push(['scan', folder]); return real.video.scan(folder); },
    // 记一笔要的是「写进 state.json 的那一串长什么样」，所以拆成 JSON 再存，别留活引用
    // 只记不落盘：断言要的是「写盘那串长什么样」，真落盘的话这趟跑到一半断了就把他的档位留在磁盘上，
    // 下一趟把它当成原状，越还越歪。档位只在收尾那一次真写回去。
    save: (v) => { calls.push(['video.save', JSON.parse(JSON.stringify(v))]); return Promise.resolve(true); }
  });
  window.__biliDry = { real, calls, box, pin: TB.app.applyPageFromDesktop, pushed: 0 };
  // 桌面会反过来驱动面板（Win+Ctrl+←/→ 那条 layout:onSync）。探针跑在这一格里时它要是把面板
  // 切走了，后面每一组量到的都是别的格子——先把那条入口按住，收尾再还回去。
  TB.app.applyPageFromDesktop = () => { window.__biliDry.pushed += 1; };
  TB.api = copy;
  return 'installed';
})()`;

// 收尾要能在「跑到一半崩了」那条路上也做成一次：崩在中途会把页内替身和他原来那一档都留在应用里，
// 下一趟探针（包括 video-appprobe）量到的就是脏状态。所以这段既在正常路径调，也在 catch 里调。
let TARGET = null;
let ORIG = null;
const failures = [];

async function restoreAll(page, orig) {
  await evaluate(page, `(async () => {
    const { real, pin, pushed } = window.__biliDry || {};
    if (real) TB.api = real;
    if (pin) TB.app.applyPageFromDesktop = pin; // 先把桌面那条入口还给应用
    delete window.__biliDry;
    TB.app.state.video = ${JSON.stringify(orig.saved ?? null)};
    await TB.api.video.save(${JSON.stringify(orig.saved ?? null)});
    TB.video.restored = true;
    TB.video.bili = { section: ${JSON.stringify(orig.section)}, folder: null, rows: [], error: null, busy: false, total: 0, loaded: false, account: null };
    // setSource 是唯一的收口：回到 B站 那一档时它会重问一次，他看到的不是空壳
    if (TB.video.source !== ${JSON.stringify(orig.source)}) await TB.video.setSource(${JSON.stringify(orig.source)});
    else { TB.video.syncControls(); TB.video.repaint(); }
    await new Promise((resolve) => setTimeout(resolve, 600));
    return JSON.stringify({ pushed: pushed || 0 });
  })()`).then((raw) => {
    const pushed = JSON.parse(raw).pushed || 0;
    if (pushed) console.log(`（跑探针期间桌面发过 ${pushed} 次「切面板」，已按住没让它切走）`);
  });
  try {
    await evaluate(page, `TB.app.setPage(${JSON.stringify(orig.page)});'ok'`);
  } catch (error) {
    failures.push(`切回原面板 "${orig.page}" 失败：${error.message}`);
  }
}

async function main() {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((item) => item.type === 'page' && item.url.includes('renderer/index.html'));
  if (!page) throw new Error(`CDP 端口 ${PORT} 上找不到工具栏渲染层，先跑: ./node_modules/electron/dist/electron.exe . --remote-debugging-port=${PORT}`);

  if (RELOAD) {
    await evaluate(page, `setTimeout(() => location.reload(), 0); 'reloading'`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    console.log('已重载渲染层（--reload）');
  }

  // 上一趟跑到一半断了（进程被 pipe 关掉杀掉时连 catch 都来不及跑），页内替身还挂在应用里：
  // 那时清单是假数据、档位也被我点到了 B站，而这一趟的「他原来停在哪一档」会把它当成原状写回磁盘，
  // 越还越歪。最省事的复位是重载一次页面：替身跟着页面一起没了，档位回到 state.json 里他真存下的那一档。
  const dirty = JSON.parse(await evaluateReady(page, `JSON.stringify({ dry: Boolean(window.__biliDry) })`)).dry;
  if (dirty) {
    console.log('上一趟跑到一半断了，页内替身还挂着：先重载一次页面把假清单和点歪的档位清掉，再量。');
    await evaluate(page, `setTimeout(() => location.reload(), 0); 'reloading'`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  // 「他原来停在哪一档」要问组件本身：TB.app.state.video 是主进程推送来的缓存，
  // 别的探针改过档位却没触发推送时，拿它当原状会把收尾写成错的那一档。
  const boot = JSON.parse(await evaluateReady(page, `JSON.stringify({ has: Boolean(TB?.api?.bili), keys: TB.api?.bili ? Object.keys(TB.api.bili) : [], source: TB.video?.source ?? null, saved: TB.video?.snapshot?.() ?? TB.app.state.video ?? null, registered: TB.components.has('video') })`));
  if (!boot.registered) failures.push('组件注册表里没有 "video"（loader 没注入 src/renderer/js/components/video.js？）');
  // 这版应用没带上 bili 那几条 IPC 的话，下面全是假绿——先问一句，不对就直接停
  if (!boot.has) throw new Error('TB.api.bili 不存在：跑的还是旧的主进程/preload，重启应用（npm run dev 那条）再跑本探针');
  console.log(`preload => bili.${boot.keys.join('/')}；开机时那一档是 ${JSON.stringify(boot.source)}`);

  const origPage = await evaluate(page, `String(TB.app.state.page)`);
  await evaluate(page, `document.querySelector('.topbar .page-tab[data-page="${PAGE_ID}"]').click();'ok'`);
  const before = JSON.parse(await evaluateReady(page, MEASURE));
  console.log(`面板 ${before.activePage} / ${SLOT} => ${before.module} · 档位 ${before.source} · 计数牌「${before.count}」`);
  const orig = { page: origPage, source: before.source || 'local', saved: boot.saved, section: boot.saved?.section || 'toview' };
  TARGET = page;
  ORIG = orig;

  await evaluate(page, INSTALL);
  // 他上次把这一格停在 B站 档的话，第一组「默认本地档」根本量不到——先按「本地」归位，收尾再还原
  if (orig.source === 'bili') {
    console.log('他上次停在 B站 那一档：第一组测的是默认本地档，先按「本地」归位（收尾会给他还原成 B站）');
    await evaluate(page, `(() => { [...document.querySelectorAll('#video .seg-btn')].find((n) => n.textContent === '本地').click(); return 'ok'; })()`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  // 组件内存里那套 B站 状态是跨面板活着的：上一趟跑到一半崩了会留下夹子/行/loaded，
  // 下一趟的「切档只问一次」之类的断言就会量到旧数据。每组都从干净状态开始。
  await evaluate(page, `(() => {
    TB.video.bili.folder = null;
    TB.video.bili.rows = [];
    TB.video.bili.error = null;
    TB.video.bili.total = 0;
    TB.video.bili.loaded = false;
    TB.video.bili.account = null;
    TB.video.bili.section = 'toview';
    TB.video.repaint?.();
    // 装替身之前可能正好被桌面切走了一次面板，这里再按一次 tab 把这一格拿回来
    document.querySelector('.topbar .page-tab[data-page="${PAGE_ID}"]')?.click();
    return 'ok';
  })()`);
  // 从替身装好到本地档那一组测量之间，一次 bili 请求都不该发：先把账清零
  await evaluate(page, `window.__biliDry.calls.length = 0; 'ok'`);

  // ---------- 1. 默认本地档：不为看不见的 B站 发请求，也不把页签摆出来 ----------
  const local = JSON.parse(await evaluateReady(page, MEASURE));
  if (local.module !== 'video') failures.push(`slot2 挂的是 "${local.module}"，应为 "video"`);
  if (local.isBili) failures.push('归位到本地档之后仍是 B站 排版（点「本地」那颗按钮没生效？）');
  if (local.stageDisplay === 'none') failures.push('本地档里画面格被藏起来了');
  if (local.tabsDisplay !== 'none') failures.push(`本地档里页签行该整条收掉，量到 display=${local.tabsDisplay}`);
  const headLabels = Object.fromEntries(local.headBtns);
  if (headLabels['刷新'] !== true) failures.push('本地档还挂着「刷新」按钮（那是 B站 那一档的）');
  if (headLabels['选文件夹'] !== false || headLabels['定位'] !== false) failures.push(`本地档把「选文件夹 / 定位」藏了：${JSON.stringify(local.headBtns)}`);
  if (local.domBiliRows) failures.push(`本地档却渲染了 ${local.domBiliRows} 行 B站 条目`);
  const afterLocal = JSON.parse(await evaluate(page, `JSON.stringify(window.__biliDry.calls)`));
  if (afterLocal.some((c) => c[0] === 'list' || c[0] === 'status')) failures.push(`停在本地档却去问了 B站：${JSON.stringify(afterLocal)}`);

  // ---------- 2. 点「B站」：排版换过来、视频停下、清单吃掉整格宽 ----------
  const wide = JSON.parse(await evaluate(page, `(() => { const r = document.querySelector('#shell > section[data-slot="slot1"]').getBoundingClientRect(); return JSON.stringify({ right: Math.round(r.right) }); })()`));
  // 「切档要停下」这条得能咬人：没源时 el.paused 恒为 true，光量 paused 就是假绿，
  // 所以给 pause() 记一笔——不管这一格之前播没播东西，切档那句 pause 都必须被调用过。
  // （不去真播一条：那会在他的屏幕上突然出声。）
  const prePlay = JSON.parse(await evaluate(page, `(() => {
    const el = TB.video.el;
    window.__biliDry.pauseCalls = 0;
    const realPause = el.pause.bind(el);
    el.pause = () => { window.__biliDry.pauseCalls += 1; return realPause(); };
    return JSON.stringify({ clips: TB.video.clips.length, hadSrc: Boolean(el.getAttribute('src')), paused: el.paused });
  })()`));
  const switched = await evaluate(page, `(async () => {
    window.__biliDry.calls.length = 0;
    [...document.querySelectorAll('#video .seg-btn')].find((n) => n.textContent === 'B站').click();
    const until = Date.now() + 5000;
    while (Date.now() < until && !document.querySelectorAll('#video .bl-item').length) await new Promise((resolve) => setTimeout(resolve, 60));
    await new Promise((resolve) => setTimeout(resolve, 260));
    return String(document.querySelectorAll('#video .bl-item').length);
  })()`);
  if (Number(switched) < 3) failures.push(`切到 B站 后只等到 ${switched} 行渲染`);
  const pauseState = JSON.parse(await evaluate(page, `(() => {
    const el = TB.video.el;
    const out = { calls: window.__biliDry.pauseCalls, paused: el.paused };
    delete el.pause;
    return JSON.stringify(out);
  })()`));
  const bili = JSON.parse(await evaluateReady(page, MEASURE));
  const biliCalls = JSON.parse(await evaluate(page, `JSON.stringify(window.__biliDry.calls)`));
  console.log(`B站 档：计数牌「${bili.count}」· 页签 ${JSON.stringify(bili.tabs)} · 画面格 display=${bili.stageDisplay} · 清单 ${bili.listBox?.w}px（slot1 右边缘 ${wide.right}）`);
  console.log(`切档停下 => pause() 记账 ${pauseState.calls} 次（本地清单 ${prePlay.clips} 条，切之前 src=${prePlay.hadSrc}/paused=${prePlay.paused}，切之后 paused=${pauseState.paused}）`);
  if (!bili.isBili) failures.push('点了「B站」却没换上 B站 排版');
  if (bili.source !== 'bili') failures.push(`TB.video.source 是 "${bili.source}"，应为 "bili"`);
  if (bili.stageDisplay !== 'none') failures.push(`切到 B站 后画面格还占着位（display=${bili.stageDisplay}）：清单被挤成半格宽`);
  if (!(bili.sideBox && bili.sideBox.w > 0 && Math.abs(bili.bodyBox.w - bili.sideBox.w) < 4)) failures.push(`清单没吃掉整格宽：body ${bili.bodyBox?.w} vs side ${bili.sideBox?.w}`);
  if (bili.tabsDisplay === 'none') failures.push('B站 档里三个页签没露出来');
  if (bili.tabs.map((t) => t[0]).join('') !== '稍后再看观看历史我的收藏') failures.push(`页签名不对：${JSON.stringify(bili.tabs.map((t) => t[0]))}`);
  if (bili.segOn.join('') !== 'B站') failures.push(`分段按钮高亮在 "${bili.segOn.join('')}"，应只有 B站`);
  if (bili.headBtns.find(([t]) => t === '刷新')?.[1] !== false) failures.push('B站 档里「刷新」还被藏着');
  if (bili.headBtns.find(([t]) => t === '选文件夹')?.[1] !== true) failures.push('B站 档里「选文件夹」还在（那是本地档的事）');
  if (pauseState.calls < 1) failures.push('切到 B站 一次都没调用 pause()：背后还在放声音最容易被当成 bug');
  if (!pauseState.paused) failures.push('切到 B站 后本地那条还在播：切档要停下');
  if (bili.player && !bili.player.paused) failures.push('量到的 <video> 还没停：切档要停下');
  if (bili.count !== `${bili.domBiliRows} 条`) failures.push(`计数牌是「${bili.count}」，DOM 有 ${bili.domBiliRows} 行`);
  if (!biliCalls.some((c) => c[0] === 'list' && c[1] === 'toview' && c[2]?.folderId == null)) failures.push(`切档后没按「稍后再看 + 不带 folderId」去问：${JSON.stringify(biliCalls)}`);
  if (biliCalls.filter((c) => c[0] === 'list').length !== 1) failures.push(`切一次档问了 ${biliCalls.filter((c) => c[0] === 'list').length} 趟，应只 1 趟`);
  const savedState = biliCalls.find((c) => c[0] === 'video.save')?.[1];
  if (!savedState) failures.push('切档没写 state.json：下次开机回到本地档，他会以为没记住');
  if (savedState && savedState.source !== 'bili') failures.push(`state.json 里的 source 是 ${JSON.stringify(savedState.source)}`);
  if (savedState && savedState.section !== 'toview') failures.push(`state.json 里没带上页签：${JSON.stringify(savedState.section)}`);
  if (JSON.stringify(biliCalls).includes(FAKE_SESS)) failures.push('IPC 参数里出现了 SESSDATA 值');

  // ---------- 3. 行的内容与几何 ----------
  if (bili.domBiliRows !== 4) failures.push(`稍后再看该 4 行，DOM 有 ${bili.domBiliRows} 行`);
  const [first, second, third, fourth] = bili.rows;
  console.log(`行几何：格子 ${bili.listBox?.w}px 宽 · 首行标题 [scroll, client, 字号]=${JSON.stringify(first?.titleFit)} · 清单滚 ${JSON.stringify(bili.listBoxScroll)} · host/section 高 ${bili.hostBox?.h}/${bili.secBox?.h} · 横向越出 ${JSON.stringify(bili.outOfCell)}`);
  if (!first?.title?.startsWith('探针稍后再看第一条')) failures.push(`第一行标题不对：${JSON.stringify(first?.title)}`);
  if (first?.titlePx < 12) failures.push(`标题只有 ${first?.titlePx}px，读起来费劲（应 ≥12）`);
  if (first?.titleClipped !== true) failures.push('那条超长标题没被省略号截断，会撑破整格');
  if (!/UP甲/.test(first?.meta || '') || !/1:13/.test(first?.meta || '')) failures.push(`meta 那行该是「UP · 时长」：${JSON.stringify(first?.meta)}`);
  if (!/看到 0:33/.test(first?.meta || '')) failures.push(`progress=33 的行没写「看到 0:33」：${JSON.stringify(first?.meta)}`);
  if (/看到/.test(second?.meta || '')) failures.push(`seenAt 为空的行硬编了一句「看到 x:xx」：${JSON.stringify(second?.meta)}`);
  if (!/1:01:40/.test(second?.meta || '')) failures.push(`3700 秒没写成 h:mm:ss：${JSON.stringify(second?.meta)}`);
  if (first?.imgOk !== true || first?.imgW !== 1) failures.push(`封面没真解码（imgW=${first?.imgW}）：data: 图源都进不去就是 CSP 或 src 拼错了`);
  if (second?.imgOk !== true || second?.imgW !== 1) failures.push(`第二行的 data: 封面也没解码（imgW=${second?.imgW}）`);
  // 封面地址一律原样交给 <img>：这一档不流媒体，没有把它拼成 track:// 的理由（CSP 的 img-src 已经放了 https:）
  if (!/^https:\/\//.test(String(bili.covers?.[2] || ''))) failures.push(`第三条的 cover 在组件内存里已不是 https：${JSON.stringify(bili.covers?.[2])}`);
  if (third?.imgOk && !/^https:\/\//.test(third.imgSrc || '')) failures.push(`挂着的那张封面不是 https 地址：${JSON.stringify(third.imgSrc)}`);
  if (fourth?.imgOk !== false) failures.push('封面挂了却没把 <img> 摘掉：破图标比空白更难读');
  if (fourth?.coverBox?.w !== first?.coverBox?.w || fourth?.coverBox?.h !== first?.coverBox?.h) failures.push('封面挂掉的那一行块子缩了，整列行高会跟着乱');
  if (new Set(bili.rows.map((r) => r.rowH)).size !== 1) failures.push(`${bili.rows.length} 行行高不一致：${JSON.stringify(bili.rows.map((r) => r.rowH))}`);
  if (bili.outOfCell.length) failures.push(`${bili.outOfCell.length} 个元素横向越出了格子：${JSON.stringify(bili.outOfCell)}`);
  // 清单放不下就该自己在滚，而不是把这一格顶高（顶高了会压到下面那一行格子）
  if (bili.hostBox && bili.secBox && bili.hostBox.h > bili.secBox.h + 1) {
    failures.push(`清单把格子顶高了：host ${bili.hostBox.h} > section ${bili.secBox.h}（滚动的应该是 .vd-list 自己）`);
  }
  if (bili.listBoxScroll && bili.listBoxScroll[0] > bili.listBoxScroll[1] + 1 && !/auto|scroll/.test(String(bili.listBoxScroll[2]))) {
    failures.push(`清单内容 ${bili.listBoxScroll[0]} 超出可视 ${bili.listBoxScroll[1]}，但 overflow-y 是 ${JSON.stringify(bili.listBoxScroll[2])}`);
  }

  // ---------- 4. 点一行：只把 id 递回主进程 ----------
  const clicked = JSON.parse(await evaluate(page, `(async () => {
    const calls = window.__biliDry.calls;
    const before = calls.length;
    document.getElementById('toast').innerHTML = '';
    document.querySelectorAll('#video .bl-item')[1].click();
    const until = Date.now() + 2500;
    while (Date.now() < until && !document.querySelectorAll('#toast .toast').length) await new Promise((resolve) => setTimeout(resolve, 60));
    return JSON.stringify({ newCalls: calls.slice(before), toasts: [...document.querySelectorAll('#toast .toast')].map((n) => n.textContent) });
  })()`));
  console.log(`点一行 => ${JSON.stringify(clicked.newCalls)}，toast ${JSON.stringify(clicked.toasts)}`);
  const openCall = clicked.newCalls.find((c) => c[0] === 'open');
  if (!openCall || openCall[1] !== 'v:BV1probe2') failures.push(`点一行没把行 id 递回去：${JSON.stringify(clicked.newCalls)}`);
  if (clicked.newCalls.filter((c) => c[0] === 'list').length) failures.push('点一行又去问了一遍列表');
  if (!/交给浏览器/.test(clicked.toasts.join(' '))) failures.push(`点完没告诉他交给了浏览器：${JSON.stringify(clicked.toasts)}`);

  // ---------- 5. 我的收藏：夹子下钻 + 页签行最右那个返回 ----------
  // 注：clickBili 会先把 rows 清空再等主进程，所以「等 .bl-back 出现」不等于「这一层画完了」——
  // 必须等它既有退路又有内容（行或那句空的提示），否则量到的是中间态。
  const drilled = JSON.parse(await evaluate(page, `(async () => {
    const calls = window.__biliDry.calls;
    const wait = async (cond, ms) => { const until = Date.now() + ms; while (Date.now() < until && !cond()) await new Promise((resolve) => setTimeout(resolve, 50)); return cond(); };
    const settled = () => document.querySelector('#video .bl-back') && (document.querySelectorAll('#video .bl-item').length || document.querySelector('#video .vd-none'));
    const before = calls.length;
    [...document.querySelectorAll('#video .bl-tab')].find((n) => n.textContent === '我的收藏').click();
    await wait(() => document.querySelectorAll('#video .bl-item.bl-folder').length >= 2, 3000);
    const firstFolder = document.querySelector('#video .bl-item.bl-folder');
    const folderMark = firstFolder?.querySelector('.bl-mark')?.textContent;
    firstFolder.click();
    await wait(settled, 3000);
    const back = document.querySelector('#video .bl-back');
    const backBox = back?.getBoundingClientRect();
    const tabsBox = document.querySelector('#video .bl-tabs').getBoundingClientRect();
    return JSON.stringify({
      stateNow: calls.slice(before),
      folderMark,
      folderTitle: firstFolder?.querySelector('.bl-title')?.textContent,
      folderMeta: firstFolder?.querySelector('.bl-meta')?.textContent,
      backText: back?.textContent,
      backRightAligned: backBox && Math.abs(backBox.right - tabsBox.right) < 3,
      backInVideo: Boolean(back?.closest('#video')),
      rows: [...document.querySelectorAll('#video .bl-item')].map((n) => n.querySelector('.bl-title')?.textContent),
      line: document.querySelector('#video .vd-line')?.textContent
    });
  })()`));
  console.log(`下钻 => 夹子行「${drilled.folderTitle} / ${drilled.folderMeta}」标记 ${JSON.stringify(drilled.folderMark)}，进去后 ${JSON.stringify(drilled.rows)}，返回钮「${drilled.backText}」`);
  if (drilled.folderMark !== '▸') failures.push(`夹子行末尾的标记是 ${JSON.stringify(drilled.folderMark)}，应为 ▸（和「↗ 交给浏览器」得看着就不一样）`);
  if (first?.mark && first.mark !== '↗') failures.push(`视频行末尾的标记是 ${JSON.stringify(first.mark)}，应为 ↗`);
  if (!/\d+ 个/.test(drilled.folderMeta || '')) failures.push(`夹子行没写多少个视频：${JSON.stringify(drilled.folderMeta)}`);
  if (drilled.stateNow.filter((c) => c[0] === 'list' && c[1] === 'fav' && c[2]?.folderId == null).length !== 1) failures.push(`点页签「我的收藏」没先列夹子：${JSON.stringify(drilled.stateNow)}`);
  if (drilled.stateNow.filter((c) => c[0] === 'list' && c[2]?.folderId === 901).length !== 1) failures.push(`点夹子没带 folderId=901：${JSON.stringify(drilled.stateNow)}`);
  if (drilled.rows.join() !== '夹子里的第一条') failures.push(`下钻后列的是 ${JSON.stringify(drilled.rows)}`);
  if (drilled.backText !== '← 收藏夹列表') failures.push(`返回钮写的是 ${JSON.stringify(drilled.backText)}`);
  if (!drilled.backRightAligned) failures.push('「← 收藏夹列表」没贴页签行右边缘：列表一滚动就找不到退路');
  if (!drilled.backInVideo) failures.push('返回钮不在这一格里（跑到别的格子里就点不着了）');

  const backAgain = JSON.parse(await evaluate(page, `(async () => {
    const calls = window.__biliDry.calls;
    const before = calls.length;
    const back = document.querySelector('#video .bl-back');
    if (!back) return JSON.stringify({ missing: '页签行里没有「← 收藏夹列表」那颗返回钮', newCalls: [], rows: [] });
    back.click();
    const until = Date.now() + 3000;
    while (Date.now() < until && document.querySelectorAll('#video .bl-item.bl-folder').length !== 2) await new Promise((resolve) => setTimeout(resolve, 50));
    return JSON.stringify({
      newCalls: calls.slice(before),
      backGone: !document.querySelector('#video .bl-back'),
      rows: [...document.querySelectorAll('#video .bl-item')].map((n) => n.querySelector('.bl-title')?.textContent)
    });
  })()`));
  if (backAgain.missing) failures.push(backAgain.missing);
  else {
    if (backAgain.newCalls.filter((c) => c[0] === 'list' && c[2]?.folderId == null).length !== 1) failures.push(`点返回没退回夹子列表：${JSON.stringify(backAgain.newCalls)}`);
    if (backAgain.rows.length !== 2) failures.push(`退回后夹子数量是 ${backAgain.rows.length}，应为 2`);
    if (!backAgain.backGone) failures.push('退回夹子列表后「← 收藏夹列表」还挂着（点了页签也退不掉那一层的话，页签会点成死键）');
  }

  // ---------- 6. 三种「看不到东西」分开说，没 cookie 那一条要能跳到设置 ----------
  const emptyState = JSON.parse(await evaluate(page, `(async () => {
    const before = window.__biliDry.calls.length;
    window.__biliDry.box.error = '还没填 B 站登录 cookie：设置 → Bilibili → SESSDATA（只加密存在本机 userData，不跟仓库走）';
    [...document.querySelectorAll('#video .bl-tab')].find((n) => n.textContent === '观看历史').click();
    const until = Date.now() + 3000;
    while (Date.now() < until && !document.querySelector('#video .vd-none button')) await new Promise((resolve) => setTimeout(resolve, 60));
    const out = {
      noneText: document.querySelector('#video .vd-none')?.textContent,
      noneBtn: document.querySelector('#video .vd-none button')?.textContent,
      line: document.querySelector('#video .vd-line')?.textContent,
      lineErr: document.querySelector('#video .vd-line')?.classList.contains('err'),
      count: document.querySelector('#video .vd-count')?.textContent,
      rows: document.querySelectorAll('#video .bl-item').length,
      newCalls: window.__biliDry.calls.slice(before)
    };
    document.getElementById('toast').innerHTML = '';
    document.querySelector('#video .vd-none button').click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    out.settingsOpen = document.getElementById('settings')?.classList.contains('open');
    out.biliCard = Boolean(document.querySelector('#settings [data-card="bili"]'));
    out.pwInputs = [...document.querySelectorAll('#settings [data-card="bili"] input')].map((n) => [n.type, n.value]);
    out.cardText = document.querySelector('#settings [data-card="bili"]')?.innerText || '';
    TB.settings.close();
    return JSON.stringify(out);
  })()`));
  console.log(`没 cookie => 计数牌「${emptyState.count}」· 提示「${String(emptyState.noneText).slice(0, 26)}…」· 按钮「${emptyState.noneBtn}」· 设置卡片在=${emptyState.biliCard}`);
  if (emptyState.rows) failures.push(`报错时还留着 ${emptyState.rows} 行上一次的数据`);
  if (!/SESSDATA/.test(emptyState.noneText || '')) failures.push(`没 cookie 那句没指出去哪儿填：${JSON.stringify(emptyState.noneText)}`);
  if (emptyState.noneBtn !== '去设置填 →') failures.push(`没 cookie 时没给跳设置的口子：${JSON.stringify(emptyState.noneBtn)}`);
  if (emptyState.count !== '没拿到') failures.push(`报错时计数牌是「${emptyState.count}」，应是「没拿到」`);
  if (!emptyState.lineErr || !/SESSDATA/.test(emptyState.line || '')) failures.push(`说明行没把那句错误用红字说出来：${JSON.stringify({ line: emptyState.line, err: emptyState.lineErr })}`);
  if (emptyState.settingsOpen !== true || emptyState.biliCard !== true) failures.push(`点「去设置填 →」没打开 Bilibili 那张卡片：${JSON.stringify({ open: emptyState.settingsOpen, card: emptyState.biliCard })}`);
  if (!emptyState.pwInputs.some((p) => p[0] === 'password')) failures.push(`设置里那张卡片的 cookie 框不是 password：${JSON.stringify(emptyState.pwInputs)}`);
  if (emptyState.pwInputs.some((p) => p[1])) failures.push('那张卡片把已存的 cookie 回填到输入框了（值不该出主进程）');
  if (!/bili-auth\.bin/.test(emptyState.cardText || '')) failures.push('卡片文案没写清 cookie 存在哪儿：' + JSON.stringify(String(emptyState.cardText).slice(0, 60)));
  if (/SESSDATA=|probeSESSDATA/.test(emptyState.cardText)) failures.push('卡片文案里带了 cookie 的值');

  // 空单子不该被报成错误
  const blank = JSON.parse(await evaluate(page, `(async () => {
    window.__biliDry.box.error = null;
    [...document.querySelectorAll('#video .bl-tab')].find((n) => n.textContent === '我的收藏').click();
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      if (document.querySelectorAll('#video .bl-item.bl-folder').length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    const folders = [...document.querySelectorAll('#video .bl-item.bl-folder')];
    const target = folders.find((n) => /空的收藏夹/.test(n.querySelector('.bl-title').textContent));
    if (!target) return JSON.stringify({ skipped: '夹子列表里没找到那个空的：' + JSON.stringify(folders.map((n) => n.querySelector('.bl-title')?.textContent)) });
    target.click();
    const until2 = Date.now() + 3000;
    while (Date.now() < until2 && !document.querySelector('#video .vd-none')) await new Promise((resolve) => setTimeout(resolve, 60));
    return JSON.stringify({
      none: document.querySelector('#video .vd-none')?.textContent,
      line: document.querySelector('#video .vd-line')?.textContent,
      lineErr: document.querySelector('#video .vd-line')?.classList.contains('err'),
      mark: document.querySelector('#video .bl-back')?.textContent
    });
  })()`));
  if (blank.skipped) failures.push(blank.skipped);
  else {
    if (!/这个收藏夹是空的/.test(blank.none || '')) failures.push(`空夹子的说法不对：${JSON.stringify(blank.none)}`);
    if (blank.lineErr) failures.push('空单子被当成了错误（红字）：空和失败是两件事');
    if (blank.mark !== '← 收藏夹列表') failures.push(`进了空夹子后退路没了：${JSON.stringify(blank.mark)}`);
  }

  // ---------- 7. 切回本地 + 切面板不重问 ----------
  const roundTrip = JSON.parse(await evaluate(page, `(async () => {
    const calls = window.__biliDry.calls;
    const before = calls.length;
    [...document.querySelectorAll('#video .seg-btn')].find((n) => n.textContent === '本地').click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const backLocal = {
      isBili: document.getElementById('video').classList.contains('is-bili'),
      stageDisplay: getComputedStyle(document.querySelector('#video .vd-stage')).display,
      tabsDisplay: getComputedStyle(document.querySelector('#video .bl-tabs')).display,
      localRows: document.querySelectorAll('#video .vd-item').length
    };
    TB.app.setPage('game');
    await new Promise((resolve) => setTimeout(resolve, 400));
    TB.app.setPage('${PAGE_ID}');
    const until = Date.now() + 4000;
    while (Date.now() < until && !document.getElementById('video')) await new Promise((resolve) => setTimeout(resolve, 80));
    await new Promise((resolve) => setTimeout(resolve, 300));
    return JSON.stringify({
      backLocal,
      newCalls: calls.slice(before).map((c) => c[0]),
      sourceAfter: TB.video.source,
      biliRowsAfter: TB.video.bili.rows.length,
      domAfter: document.querySelectorAll('#video .vd-item').length,
      stageAfter: getComputedStyle(document.querySelector('#video .vd-stage')).display
    });
  })()`));
  console.log(`切回本地 => ${JSON.stringify(roundTrip.backLocal)}；再切走切回 => 档位 ${roundTrip.sourceAfter}，IPC ${JSON.stringify(roundTrip.newCalls)}`);
  if (roundTrip.backLocal.isBili || roundTrip.backLocal.stageDisplay === 'none') failures.push('切回本地后排版没换回来');
  if (roundTrip.backLocal.tabsDisplay !== 'none') failures.push('切回本地后页签行还露着');
  if (roundTrip.newCalls.includes('list')) failures.push(`切档/切面板又去问了 B站 一趟：${JSON.stringify(roundTrip.newCalls)}`);
  if (roundTrip.sourceAfter !== 'local') failures.push(`切走再切回变成了 ${JSON.stringify(roundTrip.sourceAfter)} 档，档位该跟着他走`);
  if (roundTrip.stageAfter === 'none') failures.push('切面板回来后备画面格没打开（只有 B站 档才收它）');

  // ---------- 8. 凭据在渲染层搜不到 ----------
  // 替身故意在 status 里塞了一个 sess 字段（真主进程不会发）：整页 HTML 搜不到它，
  // 才说明渲染层只画自己认识的那几个字段，而不是把主进程给的东西整个贴出来。
  const leak = JSON.parse(await evaluate(page, `(async () => {
    // close() 会把 #settings 的 innerHTML 清空，所以这里自己开一次再扫，别拿上一次留下的空壳
    TB.settings.open('bili');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const out = {
      stateVideo: TB.app.state.video ?? null,
      biliObject: { section: TB.video.bili.section, account: TB.video.bili.account, rows: TB.video.bili.rows.length },
      body: document.body.innerHTML || '',
      settingsDom: document.getElementById('settings')?.innerHTML || ''
    };
    TB.settings.close();
    return JSON.stringify(out);
  })()`));
  const haystack = JSON.stringify(leak);
  if (haystack.includes(FAKE_SESS)) failures.push('SESSDATA 的值出现在渲染层（state / 组件内存 / 整页 DOM 之一）');
  if (/SESSDATA=/.test(haystack)) failures.push('渲染层某处带了 cookie 的形状：' + haystack.slice(haystack.search(/SESSDATA=/), 60));
  if (!/已登录：探针账号名/.test(leak.settingsDom || '')) failures.push('设置卡片没把账号名说出来（只该说这个，不说 cookie）：' + String(leak.settingsDom).slice(-160));

  if (SHOTS) {
    // 两张：一张「稍后再看」的列表，一张收藏下钻进夹子之后（带页签行最右那个返回钮）
    const shotStep1 = await evaluate(page, `(async () => {
      const find = (sel, text) => [...document.querySelectorAll(sel)].find((n) => n.textContent === text);
      const seg = find('#video .seg-btn', 'B站');
      if (!seg) return '这一格里没有「B站」那颗按钮：segs=' + JSON.stringify([...document.querySelectorAll('#video .seg-btn')].map((n) => n.textContent)) + '，格子在=' + Boolean(document.getElementById('video')) + '，面板=' + TB.app.state.page;
      if (TB.video.source !== 'bili') seg.click();
      // 上面几组把状态留在了「我的收藏」的某个夹子里，第一张要从头那一档截
      find('#video .bl-tab', '稍后再看')?.click();
      const until = Date.now() + 3000;
      while (Date.now() < until && document.querySelectorAll('#video .bl-item').length < 4) await new Promise((resolve) => setTimeout(resolve, 60));
      return 'rows=' + document.querySelectorAll('#video .bl-item').length + ' section=' + TB.video.bili.section;
    })()`);
    if (!/section=toview/.test(shotStep1)) failures.push(`截图第一步没回到「稍后再看」：${shotStep1}`);
    const one = await capture(page, path.join(APP_ROOT, 'samples', 'bili-panel.png'));
    const two = await evaluate(page, `(async () => {
      const diag = () => '格子在=' + Boolean(document.getElementById('video')) + ' · 面板=' + TB.app.state.page +
        ' · 档位=' + TB.video?.source + ' · tabs=' + JSON.stringify([...document.querySelectorAll('#video .bl-tab')].map((n) => n.textContent)) +
        ' · segs=' + JSON.stringify([...document.querySelectorAll('#video .seg-btn')].map((n) => n.textContent));
      const findTab = (text) => [...document.querySelectorAll('#video .bl-tab')].find((n) => n.textContent === text);
      let tab = findTab('我的收藏');
      if (!tab) {
        // 截图这一步和上面几组之间隔了一次真截图请求；万一格子被重建了，就按一次「B站」把界面摆回来再找
        const seg = [...document.querySelectorAll('#video .seg-btn')].find((n) => n.textContent === 'B站');
        seg?.click();
        await new Promise((resolve) => setTimeout(resolve, 600));
        tab = findTab('我的收藏');
        if (!tab) return '重试之后还是没有页签（' + diag() + '）';
      }
      tab.click();
      const until = Date.now() + 3000;
      while (Date.now() < until && !document.querySelector('#video .bl-item.bl-folder')) await new Promise((resolve) => setTimeout(resolve, 60));
      document.querySelector('#video .bl-item.bl-folder')?.click();
      await new Promise((resolve) => setTimeout(resolve, 600));
      return String(document.querySelectorAll('#video .bl-item').length);
    })()`);
    if (!/^\d+$/.test(two)) failures.push(`截图第二步没进得去夹子：${two}`);
    const three = await capture(page, path.join(APP_ROOT, 'samples', 'bili-fav.png'));
    console.log(`截图：${one}（稍后再看）、${three}（夹子里 ${two} 行）`);
  }

  // ---------- 9. 收尾：换成真 IPC、回到他原来那一档和原来的面板 ----------
  await restoreAll(page, orig);
  ORIG = null; // 收尾已经做过，崩在后面的话 catch 里不该再做一遍
  const after = JSON.parse(await evaluateReady(page, `JSON.stringify({ page: TB.app.state.page, source: TB.video?.source ?? null, module: document.querySelector('#shell > section[data-slot="${SLOT}"]')?.dataset.module ?? null })`));
  if (after.page !== orig.page) failures.push(`收尾停在面板 "${after.page}"，他原来在 "${orig.page}"`);
  if (after.source !== orig.source) failures.push(`收尾档位是 "${after.source}"，他原来选的是 "${orig.source}"`);

  if (failures.length) {
    for (const line of failures) console.log(`✗ ${line}`);
    console.log(`\nB站 那一格探针失败 ${failures.length} 项`);
    process.exitCode = 1;
    return;
  }
  console.log('✓ B站 那一格全绿：停在本地档时一次都不问 B站，切过去时画面格收起、清单吃掉整格、三个页签齐、本地播放停下、' +
    'state.json 记住档位与页签（不带 cookie），行是「封面块 + 标题（超长截断）+ UP · 时长 · 看到 m:ss」，空 seenAt 不硬编、' +
    'https 封面原样交给 <img>、封面挂了摘 <img> 留块子、各行等高，点一行只递 id 并 toast「交给浏览器」，收藏先列夹子（▸）再下钻、返回钮贴页签行右边缘，' +
    '没 cookie 那句带「去设置填 →」真跳到 Bilibili 卡片（密码框不回填、文案只提文件名），空夹子不报红且退路还在，' +
    '切回本地与切面板都不重问，SESSDATA 在 state/组件内存/DOM 里都搜不到');
}

main().catch(async (error) => {
  console.error(`[bili-appprobe] 失败：${error.message}`);
  if (TARGET && ORIG) {
    try {
      await restoreAll(TARGET, ORIG);
      console.log('（跑到一半崩了也做了收尾：拆掉页内替身、回到他原来那一档和原来的面板）');
    } catch (restoreError) {
      console.log(`收尾也没做成：${restoreError.message} —— 重载一次页面（Ctrl+R 或 --reload）就干净了`);
    }
  }
  process.exitCode = 1;
});
