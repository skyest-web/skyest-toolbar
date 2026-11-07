// 布局的真机验证：附着到真实运行的工具栏（需带 --remote-debugging-port 启动），
// 量「音乐在时钟下方、原音乐位拆两格、系统指标不被拉伸、搜索是常驻栏」，
// 再逐个点顶栏面板 tab：常驻那几格切页不许动、每格配置要和 DOM 对上、内容不许被裁。
// 游戏面板自带一份 grid，所以还要拿主界面量到的三个中格去对：合成那一大格的矩形
// 必须正好等于它们拼起来的矩形。
// 用法（Git Bash）:
//   1) ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
//   2) node tools/layout-appprobe.js [端口] [--shot]   # --shot 存 samples/layout-after.png 和每页一张 layout-page-<id>.png
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || 9223);
const SHOTS = process.argv.includes('--shot');

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

// 工具栏刚起来那几秒渲染层还没 boot 完，量不到就别当失败，等它一等
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

// 点一个面板 tab，并确认真的切过去了。
// 上一趟切换留下的外壳重建可能正好把这一秒查到的 tab 节点换掉——点在已经脱离文档的旧节点上不报错但没作用，
// 量到的 activePage 还是上一页（真机踩过：切到 game 却读到 life）。所以没切成就再点一次。
async function clickTab(page, id, tries = 8) {
  for (let i = 0; i < tries; i += 1) {
    await evaluate(page, `document.querySelector('.topbar .page-tab[data-page="${id}"]')?.click();'ok'`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const now = JSON.parse(await evaluate(page, `JSON.stringify({ page: TB.app.state.page })`)).page;
    if (now === id) return now;
  }
  return JSON.parse(await evaluate(page, `JSON.stringify({ page: TB.app.state.page })`)).page;
}

const EXPRESSION = `(() => {
  if (!TB?.app?.state?.grid) throw new Error('渲染层 boot 未完成');
  const area = (at) => document.querySelector('#shell > section[data-slot="' + at + '"]');
  const box = (at) => {
    const sec = area(at);
    if (!sec) return null;
    const r = sec.getBoundingClientRect();
    const own = sec.firstElementChild;
    return {
      module: sec.dataset.module,
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      content: own ? Math.round(own.scrollHeight) : 0,
      overflowY: Math.round(own ? own.scrollHeight - own.getBoundingClientRect().height : 0)
    };
  };
  const shell = document.getElementById('shell');
  const shellRect = shell.getBoundingClientRect();
  const gaugeRow = document.querySelector('.gauge-row');
  return JSON.stringify({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    layout: TB.app.state.grid,
    activePage: TB.app.state.page,
    // 外壳上真的生效的那份 grid：面板自带 grid 时这里必须是它自己那份
    shellAreas: getComputedStyle(shell).gridTemplateAreas,
    shellCols: getComputedStyle(shell).gridTemplateColumns.split(' ').length,
    // 逐格从真实 DOM 取，别写死格子名：面板一多，写死的清单会漏掉新页里挂上来的组件
    areas: Object.fromEntries([...document.querySelectorAll('#shell > section[data-slot]')].map((sec) => [sec.dataset.slot, box(sec.dataset.slot)])),
    tabs: [...document.querySelectorAll('.topbar .page-tab')].map((b) => ({ page: b.dataset.page, text: b.textContent.trim(), active: b.classList.contains('active') })),
    shellOverflow: Math.round(shell.scrollHeight - shellRect.height),
    bodyOverflow: Math.round(document.documentElement.scrollHeight - window.innerHeight),
    gaugeRowHeight: gaugeRow ? Math.round(gaugeRow.getBoundingClientRect().height) : null,
    gaugeCardHeight: (() => { const g = document.querySelector('.gauge'); return g ? Math.round(g.getBoundingClientRect().height) : null; })(),
    playerContainer: (() => { const p = document.querySelector('.player-area'); return p ? getComputedStyle(p).containerName : null; })(),
    playerBodyDir: (() => { const b = document.querySelector('.pl-body'); return b ? getComputedStyle(b).flexDirection : null; })(),
    searchInBar: Boolean(document.querySelector('.topbar .search-bar #search-input')),
    chipsPerRow: (() => { const c = document.querySelector('.clock-chips'); return c ? getComputedStyle(c).gridTemplateColumns.split(' ').length : null; })()
  });
})()`;

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

async function main() {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((item) => item.type === 'page' && item.url.includes('renderer/index.html'));
  if (!page) throw new Error(`CDP 端口 ${PORT} 上找不到工具栏渲染层，先跑: ./node_modules/electron/dist/electron.exe . --remote-debugging-port=${PORT}`);
  // 开头这一轮量的是「全局那份骨架」的形状（拆两格的音乐位、固定高度的指标），
  // 必须站在没自带 grid 的主界面上量——停在游戏面板会把这些当成回归。
  const startPage = JSON.parse(await evaluateReady(page, EXPRESSION)).activePage;
  if (startPage !== 'home') {
    await evaluate(page, `document.querySelector('.topbar .page-tab[data-page="home"]').click();'ok'`);
  }
  const out = JSON.parse(await evaluateReady(page, EXPRESSION));
  const a = out.areas;
  console.log(`窗口 ${out.viewport.width}x${out.viewport.height} / 行 ${out.layout.grid.rows.join(' ')} / 列 ${out.layout.grid.columns.join(' ')}`);
  for (const [at, box] of Object.entries(a)) console.log(`${at.padEnd(10)} ${box ? `${box.module.padEnd(11)} ${box.w}x${box.h} @(${box.x},${box.y}) 内容${box.content} 溢出${box.overflowY}` : '缺失'}`);

  const failures = [];
  if (out.activePage !== 'home') failures.push(`切不回主界面，量不了全局骨架（当前停在 "${out.activePage}"）`);
  // 逐格量「内容高度 vs 位置高度」——.area 是 overflow:hidden，超了不报错、只是看不见
  const overflowOf = (areas, tag) => {
    for (const [at, box] of Object.entries(areas)) {
      if (box && box.content > box.h + 1) failures.push(`「${at}」(${tag}) 内容比位置高 ${box.content - box.h}px，会被裁掉`);
      if (box && box.overflowY > 1) failures.push(`「${at}」(${tag}) 内容比自己的可视区高 ${box.overflowY}px，底部被裁掉了`);
    }
  };
  // 配置里 enabled 的位置，DOM 上必须挂着同一个组件；DOM 也不许多挂
  const slotsMatchDom = (measured, tag) => {
    const page = measured.layout.pages.find((item) => item.id === measured.activePage);
    const want = [...measured.layout.shared, ...(page?.slots || [])].filter((slot) => slot.enabled && slot.module);
    for (const slot of want) {
      const box = measured.areas[slot.at];
      if (!box) failures.push(`${tag}：配置里「${slot.at}」要放 "${slot.module}"，DOM 上没有这一格`);
      else if (box.module !== slot.module) failures.push(`${tag}：「${slot.at}」DOM 上挂的是 "${box.module}"，配置写的是 "${slot.module}"`);
    }
    const extra = Object.keys(measured.areas).filter((at) => !want.some((slot) => slot.at === at));
    if (extra.length) failures.push(`${tag}：DOM 上多挂了 ${extra.join('、')}，layout.json 里没有`);
  };

  if (out.shellOverflow > 1 || out.bodyOverflow > 1) failures.push(`网格整体超出窗口：shell+${out.shellOverflow} body+${out.bodyOverflow}`);
  if (!a.clock || !a.player) failures.push('左列没有时钟或播放器');
  else {
    if (a.clock.x !== a.player.x) failures.push(`播放器没和时钟对齐同一列：${a.clock.x} vs ${a.player.x}`);
    if (a.player.y < a.clock.y + a.clock.h) failures.push('播放器没在时钟下方');
  }
  if (!a.slot1 || !a.slot2) failures.push('原音乐位没拆成两格');
  else {
    if (a.slot1.y !== a.slot2.y || Math.abs(a.slot1.x + a.slot1.w - a.slot2.x) > 12) failures.push(`两格不是左右并排：${JSON.stringify([a.slot1, a.slot2])}`);
    // 两格挂什么由 layout.json 说当下算（他随时能在「组件与位置」里换成待办/剪贴板），
    // 所以这里只要求「有组件、不重复」——原来那句「必须是 placeholder」一换布局就假报警。
    for (const key of ['slot1', 'slot2']) {
      if (!a[key].module) failures.push(`${key} 没挂组件（data-module 是空的）`);
    }
    if (a.slot1.module === a.slot2.module && a.slot1.module !== 'placeholder') {
      failures.push(`两格挂了同一个「${a.slot1.module}」：一个组件两个位置时只有最后一个拿得到刷新`);
    }
  }
  overflowOf(a, out.activePage);
  slotsMatchDom(out, `面板 "${out.activePage}"`);
  if (a.gauges && out.gaugeRowHeight > a.gauges.h) failures.push(`系统指标被拉伸：行 ${a.gauges.h} 里内容 ${out.gaugeRowHeight}`);
  // 这三条量的是「真播放器/真时钟」的行为。停在游戏面板时那两格是占位组件，
  // 查不到 .player-area / .clock-chips 不是回归，是那一格本来就没挂它们——所以按挂载的组件判断。
  if (a.player?.module === 'player' && out.playerContainer !== 'player') failures.push('播放器区域没建立容器查询上下文');
  if (a.player && a.player.w <= 420 && a.player.module === 'player' && out.playerBodyDir !== 'column') failures.push(`窄列里播放器没切到竖排：${out.playerBodyDir}`);
  if (a.clock?.module === 'clock' && out.chipsPerRow !== 2) failures.push(`窄列里主机信息不是两列：${out.chipsPerRow}`);
  if (!out.searchInBar) failures.push('搜索栏不在顶栏里');

  // ---------- 面板 tab 与逐面板切换 ----------
  const pages = out.layout.pages || [];
  const sharedAts = (out.layout.shared || []).map((slot) => slot.at);
  if (!pages.length) failures.push('layout.json 里没有 pages（面板）');
  if (!sharedAts.length) failures.push('layout.json 里没有 shared（常驻位置）');
  if (out.tabs.length !== pages.length) failures.push(`顶栏只有 ${out.tabs.length} 个面板 tab，layout.json 里有 ${pages.length} 个面板`);
  for (const [index, item] of pages.entries()) {
    const tab = out.tabs[index];
    if (!tab) break;
    if (tab.page !== item.id) failures.push(`第 ${index + 1} 个 tab 指向 "${tab.page}"，配置里是 "${item.id}"`);
    if (tab.text !== item.name) failures.push(`第 ${index + 1} 个 tab 写着 "${tab.text}"，配置里叫 "${item.name}"`);
  }
  const litTab = out.tabs.find((tab) => tab.active);
  if (!litTab) failures.push('没有一个面板 tab 是高亮的');
  else if (litTab.page !== out.activePage) failures.push(`高亮的 tab 是 "${litTab.page}"，当前面板却是 "${out.activePage}"`);

  // 走真实点击（不是直接调 setPage）：tab 接线、外壳重建、常驻格不动，都在这一趟里验。
  // out 量的是「基准那页」（上面为了全局骨架强制切过去的 home），它已经在手里了，不必再点一遍；
  // 但要还原的是你原本站着的那页，不是 home。
  const original = startPage;
  for (const item of pages) {
    if (item.id === out.activePage) continue;
    try {
      const landed = await clickTab(page, item.id);
      const shot = JSON.parse(await evaluateReady(page, EXPRESSION));
      if (shot.activePage !== item.id) failures.push(`点 tab 切到 "${item.id}" 没生效，还停在 "${shot.activePage}"（最后一次点完读到 "${landed}"）`);
      for (const at of sharedAts) {
        const before = out.areas[at];
        const after = shot.areas[at];
        if (!after) failures.push(`面板 "${item.id}" 里常驻位置 "${at}" 消失了`);
        else if (before && after.module !== before.module) failures.push(`常驻位置 "${at}" 在面板 "${item.id}" 里换成了 "${after.module}"（切页不该动它）`);
      }
      overflowOf(shot.areas, item.id);
      slotsMatchDom(shot, `面板 "${item.id}"`);
      // 自带 grid 的面板：那份 grid 必须真的挂到外壳上，而且常驻那几块的名字还得在
      const own = item.grid;
      if (own) {
        const wantAreas = own.areas.map((row) => `"${row.join(' ')}"`).join(' ');
        if (shot.shellAreas.replace(/"/g, '') !== wantAreas.replace(/"/g, '')) {
          failures.push(`面板 "${item.id}" 自带 grid，但外壳上的 areas 是 ${shot.shellAreas}`);
        }
        if (shot.shellCols !== own.columns.length) failures.push(`面板 "${item.id}" 外壳列数 ${shot.shellCols}，自带 grid 写了 ${own.columns.length} 列`);
        for (const at of sharedAts) if (!wantAreas.includes(at)) failures.push(`面板 "${item.id}" 自带的 grid 里没有常驻位置 "${at}"`);
      }
      // 游戏面板那一大格：必须正好等于主界面中间三格拼起来的矩形（这就是「合成一个」的几何含义）。
      // 间距从主界面那次测量里现算，别把 .shell 的 gap 写死进探针。
      if (item.id === 'game' && a.gauges && a.slot1 && a.slot2) {
        const g = shot.areas.gamezone;
        const gapX = a.slot2.x - (a.slot1.x + a.slot1.w);
        const gapY = a.slot1.y - (a.gauges.y + a.gauges.h);
        const wantW = a.slot1.w + gapX + a.slot2.w;
        const wantH = a.gauges.h + gapY + a.slot1.h;
        if (!g) failures.push('游戏面板没有 gamezone 这一格');
        else {
          const near = (x, y) => Math.abs(x - y) <= 2;
          if (!near(g.x, a.gauges.x) || !near(g.y, a.gauges.y)) failures.push(`gamezone 没从 gauges 的左上角起笔：(${g.x},${g.y}) vs (${a.gauges.x},${a.gauges.y})`);
          if (!near(g.w, wantW)) failures.push(`gamezone 宽 ${g.w}，应是中间两列 + 列间距 = ${wantW}`);
          if (!near(g.h, wantH)) failures.push(`gamezone 高 ${g.h}，应是中间两行 + 行间距 = ${wantH}`);
          if (g.module !== 'games') failures.push(`gamezone 挂的是 "${g.module}"，游戏面板该放游戏列表`);
        }
        for (const at of ['gauges', 'slot1', 'slot2']) {
          if (shot.areas[at]) failures.push(`游戏面板还留着 "${at}" 这一格：三格本该合成 gamezone`);
        }
      }
      // 生活面板：左列两格（时钟 + 播放器）合成一整块 leftzone 挂邮箱；
      // 「中间不要变动」在这里是可量的——gauges / slot1 / slot2 的矩形要和主界面量到的逐字相同。
      if (item.id === 'life' && a.clock && a.player) {
        const near = (x, y) => Math.abs(x - y) <= 2;
        const g = shot.areas.leftzone;
        const gapY = a.player.y - (a.clock.y + a.clock.h);
        const wantH = a.clock.h + gapY + a.player.h;
        if (!g) failures.push('生活面板没有 leftzone 这一格');
        else {
          if (!near(g.x, a.clock.x) || !near(g.y, a.clock.y)) failures.push(`leftzone 没从时钟的左上角起笔：(${g.x},${g.y}) vs (${a.clock.x},${a.clock.y})`);
          if (!near(g.w, a.clock.w)) failures.push(`leftzone 宽 ${g.w}，应与左列同宽 = ${a.clock.w}`);
          if (!near(g.h, wantH)) failures.push(`leftzone 高 ${g.h}，应是两行 + 行间距 = ${wantH}`);
          if (g.module !== 'mail') failures.push(`leftzone 挂的是 "${g.module}"，生活面板那格该放邮箱`);
        }
        for (const at of ['clock', 'player']) {
          if (shot.areas[at]) failures.push(`生活面板还留着 "${at}" 这一格：左列两格本该合成 leftzone`);
        }
        for (const at of ['gauges', 'slot1', 'slot2']) {
          const before = a[at];
          const after = shot.areas[at];
          if (!after) failures.push(`生活面板中间少了 "${at}" 这一格（中间不许变动）`);
          else if (before && !(near(before.x, after.x) && near(before.y, after.y) && near(before.w, after.w) && near(before.h, after.h))) {
            failures.push(`生活面板的「${at}」动了：主界面 ${before.x},${before.y} ${before.w}x${before.h} → 这里 ${after.x},${after.y} ${after.w}x${after.h}`);
          }
        }
      }
      // 工作面板：左列两格合成 projzone 挂项目，中间第 2 列的两行（gauges 的左半 + 原 slot1）合成 gitzone 挂 git。
      // 同样拿主界面那次测量当尺子：列宽、行高、行间距都是现量出来的，探针里不写死像素。
      if (item.id === 'work' && a.clock && a.player && a.gauges && a.slot1) {
        const near = (x, y) => Math.abs(x - y) <= 2;
        const gapY = a.player.y - (a.clock.y + a.clock.h);
        const wantH = a.clock.h + gapY + a.player.h;
        const p = shot.areas.projzone;
        const g = shot.areas.gitzone;
        if (!p) failures.push('工作面板没有 projzone 这一格');
        else {
          if (!near(p.x, a.clock.x) || !near(p.y, a.clock.y)) failures.push(`projzone 没从左列的左上角起笔：(${p.x},${p.y}) vs (${a.clock.x},${a.clock.y})`);
          if (!near(p.w, a.clock.w)) failures.push(`projzone 宽 ${p.w}，应与左列同宽 = ${a.clock.w}`);
          if (!near(p.h, wantH)) failures.push(`projzone 高 ${p.h}，应是两行 + 行间距 = ${wantH}`);
          if (p.module !== 'projects') failures.push(`projzone 挂的是 "${p.module}"，工作面板左列该放项目`);
        }
        if (!g) failures.push('工作面板没有 gitzone 这一格');
        else {
          // gitzone 只吃中间那一列（gauges 在主界面横跨两列，所以取它的左边缘而不是宽度），高度和左列一样通到第 3 行底
          if (!near(g.x, a.gauges.x) || !near(g.y, a.gauges.y)) failures.push(`gitzone 没从第 2 列的左上角起笔：(${g.x},${g.y}) vs (${a.gauges.x},${a.gauges.y})`);
          if (!near(g.w, a.slot1.w)) failures.push(`gitzone 宽 ${g.w}，应是中间那一列 = ${a.slot1.w}（gauges 的左半，不含第 3 列）`);
          if (!near(g.h, wantH)) failures.push(`gitzone 高 ${g.h}，应是两行 + 行间距 = ${wantH}`);
          if (g.module !== 'git') failures.push(`gitzone 挂的是 "${g.module}"，工作面板中间该放 git`);
          // box() 只给 x/y/w/h，底边和右边现算
          if (p && !(near(p.h, g.h) && near(p.y, g.y) && near(p.y + p.h, g.y + g.h))) failures.push(`左右两块不齐：projzone ${JSON.stringify([p.y, p.h])} vs gitzone ${JSON.stringify([g.y, g.h])}`);
          if (p && g.x < p.x + p.w - 2) failures.push(`gitzone 不在 projzone 右边：${g.x} vs 左列右边 ${p.x + p.w}`);
        }
        if (shot.areas.slot1) failures.push('工作面板还留着 slot1 这一格：它本该合进 gitzone');
      }
      const lit = shot.tabs.find((tab) => tab.active);
      if (!lit || lit.page !== item.id) failures.push(`切到面板 "${item.id}" 后高亮停在 "${lit?.page}"`);
      console.log(`面板 ${item.id.padEnd(6)} ${Object.entries(shot.areas).map(([at, box]) => `${at}:${box?.module || '空'}`).join(' ')}`);
      if (SHOTS) {
        const file = path.join(APP_ROOT, 'samples', `layout-page-${item.id}.png`);
        await capture(page, file);
        console.log(`  截图 ${file}`);
      }
    } catch (error) {
      failures.push(`切到面板 "${item.id}" 失败：${error.message}`);
    }
  }
  // 验完切回去：当前面板会写进 state.json，别把界面留在别的面板上
  try {
    await evaluate(page, `TB.app.setPage(${JSON.stringify(original)});'ok'`);
  } catch (error) {
    failures.push(`切回原面板 "${original}" 失败：${error.message}`);
  }

  if (SHOTS) {
    try {
      await evaluate(page, "TB.search.close();TB.search.input?.blur();'closed'");
      const file = path.join(APP_ROOT, 'samples', 'layout-after.png');
      await capture(page, file);
      console.log(`[layout-appprobe] 截图 ${file}`);
    } catch (error) {
      console.log(`[layout-appprobe] 截图失败（不影响功能判定）：${error.message}`);
    }
  }

  // 「组件与位置」面板：要能选面板，位置数 = 常驻 + 本面板
  try {
    const editor = JSON.parse(
      await evaluate(
        page,
        `(() => {
          TB.layoutEditor.open();
          const host = document.getElementById('layout-editor');
          const rows = [...host.querySelectorAll('.slot-row')];
          const out = { rows: rows.length, slots: rows.filter((r) => r.querySelector('.slot-select')).length, areas: rows.map((r) => r.querySelector('.slot-area')?.textContent).filter(Boolean).join(','), options: rows[0]?.querySelectorAll('option').length || 0, tabs: [...host.querySelectorAll('.page-tab')].map((b) => b.textContent.trim()).join(',') };
          TB.layoutEditor.close();
          return JSON.stringify(out);
        })()`
      )
    );
    console.log(`组件与位置面板：${editor.slots} 个可选位置（${editor.areas}）/ 面板页签「${editor.tabs}」/ 每个下拉 ${editor.options} 项`);
    const current = pages.find((item) => item.id === original) || pages[0];
    const expected = sharedAts.length + (current?.slots.length || 0);
    if (editor.slots !== expected) failures.push(`面板里的位置数 ${editor.slots} 和「常驻 ${sharedAts.length} + 本面板 ${current?.slots.length}」对不上`);
    if (editor.tabs.split(',').length !== pages.length) failures.push(`「组件与位置」里只有 ${editor.tabs.split(',').filter(Boolean).length} 个面板页签，配置里有 ${pages.length} 个`);
    if (editor.options < 8) failures.push(`下拉里只有 ${editor.options} 个组件，占位组件没注册上？`);
  } catch (error) {
    failures.push(`打不开「组件与位置」面板：${error.message}`);
  }

  if (failures.length) {
    for (const line of failures) console.log(`✗ ${line}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ 布局全绿：${pages.length} 个面板逐个切过（音乐在时钟下方 ${a.player.w}x${a.player.h}、指标固定 ${out.gaugeRowHeight}px、搜索栏常驻、常驻位置切页不动）`);
  }
}

main().catch((error) => {
  console.error(`[layout-appprobe] 失败：${error.message}`);
  process.exitCode = 1;
});
