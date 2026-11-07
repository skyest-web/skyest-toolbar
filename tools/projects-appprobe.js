// 项目格子（工作面板左列那一整块 projzone，第 2+3 行通高）的真机验证：附着到真实运行的工具栏（需带 --remote-debugging-port 启动）。
//
// 量的是「这一格挂的是 projects、repos.roots 里那批真项目渲染出来了、每行是 名字 / IDE / 多久之前 三段且
// 都不越出格子、列表要滚就自己滚而不是被 .area 裁掉」，再验重扫、三种兜底文案、以及跨 IPC 的行里没有 exe 路径。
//
// 根目录那一段是真往返：打开设置 → 改那张卡片 → 点「保存并应用」→ 这一格换成临时根里的 ProbePkg
// → 再换回来。所以这一步会真写 toolbar.config.json 两次，收尾逐字比一遍，repos 之外动了别的段就报失败。
//
// 启动链路只走"劫持 IPC"的干跑：DOM 上真点、组件真处理，但 TB.api.projects 换成只记账的替身，
// 所以一个 IDE 都不会被真拉起来（跑前跑后各数一遍 JetBrains 的进程做旁证）。
// 三个手势各验各的：左键只选中（一条 projects IPC 都不许发）、Ctrl+左键 = reveal、双击 = launch。
// 真开 IDE 由人来点；判序、只认 id、防抖那些由 tools/projects-check.js 验。
//
// 注意：工作面板绑了虚拟桌面 2，点这一页的 tab 会把桌面切过去，探针收尾会切回他原来那一页。
//
// 用法（Git Bash）:
//   1) unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
//   2) node tools/projects-appprobe.js [端口] [--shot]   # --shot 存 samples/projects-panel.png
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execSync } = require('node:child_process');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..');
// 端口从参数里挑数字，别把 "--shot" 当成端口号（那会拼出 http://127.0.0.1:NaN/ 这种地址）
const PORT = Number(process.argv.slice(2).find((arg) => /^\d+$/.test(arg)) || 9223);
const SHOTS = process.argv.includes('--shot');
const PAGE_ID = 'work';
const SLOT = 'projzone';
const IDE_EXES = ['webstorm64.exe', 'pycharm64.exe', 'datagrip64.exe'];

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

// 只数进程条数，不当判据用（真判据是干跑那份记账）；IDE 数变多说明有东西绕过替身真被拉起来了
function ideProcesses() {
  try {
    const out = execSync('tasklist /NH /FO CSV', { encoding: 'utf8', timeout: 15000 });
    const lines = out.split('\r\n').filter((line) => line.trim());
    return IDE_EXES.reduce((acc, exe) => {
      acc[exe] = lines.filter((line) => line.toLowerCase().includes(exe)).length;
      return acc;
    }, {});
  } catch (err) {
    return { error: err.message };
  }
}

const MEASURE = `(() => {
  if (!TB?.app?.state?.grid) throw new Error('渲染层 boot 未完成');
  const sec = document.querySelector('#shell > section[data-slot="${SLOT}"]');
  const host = document.getElementById('projects');
  const list = host?.querySelector('.pj-list');
  const items = [...(list?.querySelectorAll('.pj-item') || [])];
  const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const rectInside = (a, b) => Boolean(a && b) && a.x >= b.x - 1 && a.right <= b.right + 1 && a.y >= b.y - 1 && a.bottom <= b.bottom + 1;
  // 量字形自己的矩形，不量容器：button/div 上写 overflow:hidden 会在 flex 行里把内容盒塌成 0，
  // DOM 全在、探针全绿，人却看不清（修改器那格踩过一次）。
  let glyph = null;
  let ellipsis = 0;
  let sideOut = 0;
  if (items.length) {
    const range = document.createRange();
    range.selectNodeContents(items[0].querySelector('.pj-name') || items[0]);
    const t = range.getBoundingClientRect();
    const p = items[0].getBoundingClientRect();
    glyph = { top: Math.round(t.top - p.top), h: Math.round(t.height * 10) / 10, rowH: Math.round(p.height), bottomGap: Math.round(p.bottom - t.bottom) };
    ellipsis = items.filter((n) => { const e = n.querySelector('.pj-name'); return e && e.scrollWidth > e.clientWidth + 1; }).length;
    // 名字省略号之外，右侧两段（IDE 标签、多久之前）不许挤出行
    // 拿每一行自己的矩形比：跟首行比会把后面每一行都误报成「挤出行外」（探针自己踩过，纵向必然越界）
    sideOut = items.filter((n) => {
      const own = box(n);
      return !rectInside(box(n.querySelector('.pj-ide')), own)
          || !rectInside(box(n.querySelector('.pj-ago')), own);
    }).length;
  }
  const items0 = TB.projects?.data?.items || [];
  const rowBoxes = items.map(box);
  const last = rowBoxes[rowBoxes.length - 1];
  return JSON.stringify({
    glyph,
    ellipsis,
    sideOut,
    itemFontSize: items.length ? Math.round(parseFloat(getComputedStyle(items[0]).fontSize) * 10) / 10 : null,
    chipFontSize: items.length ? Math.round(parseFloat(getComputedStyle(items[0].querySelector('.pj-ide')).fontSize) * 10) / 10 : null,
    activePage: TB.app.state.page,
    registered: TB.components.has('projects'),
    module: sec?.dataset.module || null,
    // 根目录现在从配置来（repos.roots）：渲染层拿到的该是数组，且和主进程那份配置逐字一样
    dataRoots: TB.projects?.data?.roots ?? null,
    // 设置里存的那一份（TB.app.state.config）和这一格实际扫的那一份要对得上，
    // 对不上就是「保存并应用」没把新 roots 送到服务那边
    configRoots: (TB.app.state.config?.repos?.roots || []).slice(),
    dataWarnings: (TB.projects?.data?.warnings || []).length,
    warnNodes: document.querySelectorAll('#projects .pj-warn').length,
    dataError: TB.projects?.data?.error ?? null,
    itemCount: items0.length,
    domItems: items.length,
    leakedExe: JSON.stringify(items0).includes('.exe') || JSON.stringify(items0).includes('JetBrains'),
    keysMissing: ['id', 'name', 'path', 'root', 'ide', 'ideLabel', 'ideReady', 'why', 'touched', 'touchedBy'].filter((key) => items0.length && !(key in items0[0])),
    idesFound: (TB.projects?.data?.ides || []).filter((ide) => ide.found).map((ide) => ide.label),
    idesMissing: (TB.projects?.data?.ides || []).filter((ide) => !ide.found).map((ide) => ide.label),
    allReady: items0.every((item) => item.ideReady === true),
    countLabel: host?.querySelector('.pj-count')?.textContent ?? null,
    rescanLabel: host?.querySelector('.pj-head .link-btn')?.textContent ?? null,
    domNames: items.map((n) => n.querySelector('.pj-name')?.textContent),
    dataNames: items0.map((item) => item.name),
    domFirstIde: items[0]?.querySelector('.pj-ide')?.textContent ?? null,
    dataFirstIde: items0[0]?.ideLabel ?? null,
    domFirstAgo: items[0]?.querySelector('.pj-ago')?.textContent ?? null,
    titleTip: items[0]?.title ?? null,
    secBox: box(sec),
    hostBox: box(host),
    listBox: box(list),
    firstBox: box(items[0]),
    lastBox: last,
    rowsTopDown: rowBoxes.every((b, i) => i === 0 || (b && rowBoxes[i - 1] && b.y >= rowBoxes[i - 1].y)),
    listStyle: list ? { overflowY: getComputedStyle(list).overflowY, sh: list.scrollHeight, ch: list.clientHeight } : null,
    hostClip: host ? Math.round(host.scrollHeight - host.getBoundingClientRect().height) : null,
    secClip: sec ? Math.round(sec.scrollHeight - sec.getBoundingClientRect().height) : null,
    listClip: list ? Math.round(list.scrollWidth - list.clientWidth) : null
  });
})()`;

async function main() {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((item) => item.type === 'page' && item.url.includes('renderer/index.html'));
  if (!page) throw new Error(`CDP 端口 ${PORT} 上找不到工具栏渲染层，先跑: ./node_modules/electron/dist/electron.exe . --remote-debugging-port=${PORT}`);

  const failures = [];
  const before = await evaluate(page, `typeof TB.api.projects === 'object' ? 'yes' : 'no'`);
  if (before !== 'yes') throw new Error('TB.api.projects 不存在：跑着的是改动之前的旧主进程，重启应用再来（别在这儿验渲染层）');

  // 切到工作面板：会顺带把虚拟桌面跳到第 2 个，收尾再切回他原来那一页
  // 原来那一页要在点 tab 之前问，事后再问只能问出 "work"
  const originalPage = JSON.parse(await evaluateReady(page, `JSON.stringify({ page: TB.app.state.page })`)).page;
  // 干跑那三下手势会真把某一行的选中态写进 TB.app.state；跑之前他选着谁，收尾就还回谁
  const originalSel = JSON.parse(await evaluate(page, `JSON.stringify(TB.app.state.project || null)`));
  await evaluate(page, `document.querySelector('.topbar .page-tab[data-page="${PAGE_ID}"]').click();'ok'`);
  const out = JSON.parse(await evaluateReady(page, MEASURE));
  // roots 是这次才有的字段：老主进程回的是单数 root，后面的往返一步都别跑
  if (!Array.isArray(out.dataRoots)) throw new Error('主进程返回的列表里没有 roots 数组：跑着的是改动之前的旧主进程，重启应用再来（这一步要真换配置，旧代码会把 roots 段丢掉）');

  console.log(`面板 ${out.activePage} / ${SLOT} => ${out.module} / 根目录 ${(out.dataRoots || []).join('、') || '（一个都没有）'}`);
  console.log(`列表 ${out.domItems} 行（主进程给 ${out.itemCount} 条），计数牌「${out.countLabel}」，首行「${out.domNames?.[0]} · ${out.domFirstIde} · ${out.domFirstAgo}」`);
  console.log(`认到的 IDE：${out.idesFound.join('、') || '（一个都没认到）'}${out.idesMissing.length ? ` / 没认到：${out.idesMissing.join('、')}` : ''}`);
  console.log(`格子 ${out.secBox?.w}x${out.secBox?.h} @(${out.secBox?.x},${out.secBox?.y})，列表 ${out.listStyle?.ch}px 可视 / ${out.listStyle?.sh}px 内容，overflow-y=${out.listStyle?.overflowY}`);
  console.log(`字号 ${out.itemFontSize}px / 行高 ${out.glyph?.rowH}px（字形 ${out.glyph?.h}px，上留 ${out.glyph?.top}px、下留 ${out.glyph?.bottomGap}px），名字带省略号 ${out.ellipsis} 行，右侧两段挤出行的 ${out.sideOut} 行`);

  if (out.activePage !== PAGE_ID) failures.push(`点 tab 没切到 "${PAGE_ID}"，还在 "${out.activePage}"`);
  if (out.module !== 'projects') failures.push(`「${SLOT}」这格挂的是 "${out.module}"，layout.json 里工作面板那一格没改成 projects？（改完要重启应用）`);
  if (!out.registered) failures.push('组件注册表里没有 "projects"（loader 没注入 src/renderer/js/components/projects.js？）');
  if (out.dataError) failures.push(`主进程报的错直接显示在格子里：${out.dataError}`);
  if (!out.itemCount) failures.push(`列表是空的：${out.dataRoot} 下没有顶层文件夹？`);
  if (out.domItems !== out.itemCount) failures.push(`DOM 渲染 ${out.domItems} 行，主进程给了 ${out.itemCount} 条，对不上`);
  if (out.keysMissing.length) failures.push(`行数据缺字段：${out.keysMissing.join('、')}`);
  if (out.countLabel !== `${out.itemCount} 个`) failures.push(`计数牌写着「${out.countLabel}」，应是「${out.itemCount} 个」`);
  if (out.rescanLabel !== '重扫') failures.push(`重扫按钮写着「${out.rescanLabel}」`);
  if (JSON.stringify(out.domNames) !== JSON.stringify(out.dataNames)) failures.push(`DOM 行序和数据不一致：${JSON.stringify(out.domNames)} vs ${JSON.stringify(out.dataNames)}`);
  if (!/^(今天|昨天|\d+ 天前|\d+ 个月前|\d+ 年前|没记录)$/.test(out.domFirstAgo || '')) failures.push(`右侧「多久之前」不是人话：${JSON.stringify(out.domFirstAgo)}`);
  if (!['DataGrip', 'PyCharm', 'WebStorm'].includes(out.domFirstIde)) failures.push(`IDE 标签写的不是三个产品名之一：${JSON.stringify(out.domFirstIde)}`);
  if (out.domFirstIde !== out.dataFirstIde) failures.push(`行上的 IDE 标签「${out.domFirstIde}」和数据里的「${out.dataFirstIde}」不是一回事`);
  if (out.leakedExe) failures.push('跨 IPC 的行里出现了 exe 或 JetBrains 路径——启动器位置只能留在主进程');
  if (!out.allReady) failures.push(`有行的 ideReady 是 false（本机认不到判出来的那个 IDE）：认到的是 ${out.idesFound.join('、')}`);
  if (!out.titleTip?.includes('左键') || !out.titleTip.includes('Ctrl+左键') || !out.titleTip.includes('按这条判的')) {
    failures.push(`悬停提示没写清手势或判据：${JSON.stringify(out.titleTip)}`);
  }

  // .area 是 overflow:hidden：内容比格子高不报错，只是看不见。列表要自己滚。
  if (out.hostClip > 1) failures.push(`#projects 内容比格子高 ${out.hostClip}px，底部会被裁掉`);
  if (out.secClip > 1) failures.push(`「${SLOT}」格里内容超了 ${out.secClip}px`);
  if (out.listStyle?.overflowY !== 'auto') failures.push(`列表不是自己滚的：overflow-y=${out.listStyle?.overflowY}`);
  if (out.listClip > 1) failures.push(`列表横向溢出 ${out.listClip}px（名字该自己省略，右边两段不许把行撑宽）`);
  if (out.glyph && (out.glyph.top < 0 || out.glyph.bottomGap < 1)) failures.push(`文字被行高裁掉了：行 ${out.glyph.rowH}px，字 ${out.glyph.h}px，上溢 ${out.glyph.top}px、下溢 ${out.glyph.bottomGap}px`);
  if (out.glyph && out.glyph.rowH < 22) failures.push(`每行只有 ${out.glyph.rowH}px，挤得看不清`);
  if (out.itemFontSize < 13) failures.push(`行字号 ${out.itemFontSize}px，低于 13px 的可读下限`);
  if (out.chipFontSize < 13) failures.push(`IDE 标签字号 ${out.chipFontSize}px：它就是「点下去会发生什么」，不该低于 13px`);
  if (out.sideOut) failures.push(`${out.sideOut} 行的 IDE 标签或「多久之前」挤出了行外，会被格子裁掉`);
  if (!out.rowsTopDown) failures.push('行不是从上往下一条一条排的（读序乱了）');
  if (out.firstBox && out.listBox && (out.firstBox.y < out.listBox.y - 1 || out.firstBox.bottom > out.listBox.bottom + 1)) {
    failures.push(`第一行本身就在列表可视区外面：${out.firstBox.y}~${out.firstBox.bottom} vs ${out.listBox.y}~${out.listBox.bottom}`);
  }
  // 最后一行要不要滚，只看一眼：项目数一多它会滚出可视区，那是列表自己的事，不算裁切
  console.log(`最后一行 ${out.lastBox?.y}~${out.lastBox?.bottom}，列表底 ${out.listBox?.bottom}${out.lastBox && out.lastBox.bottom > out.listBox.bottom + 1 ? '（要滚动才看到，列表自己滚）' : '（一屏看完）'}`);

  // 常驻三格不许跟着动，别的面板也不许被顺手改
  const others = JSON.parse(await evaluate(page, `(() => {
    const at = (pageId, slot) => TB.app.pages().find((p) => p.id === pageId)?.slots.find((s) => s.at === slot)?.module || null;
    const secOf = (slot) => document.querySelector('#shell > section[data-slot="' + slot + '"]');
    return JSON.stringify({
      workProjects: at('work', 'projzone'),
      // 左列合成一整块以后，工作面板剩下的位置是 gitzone / gauges / workbench / slot2；slot1 和 player 都被合掉了
      workOthers: ['gitzone', 'gauges', 'workbench', 'slot2'].map((slot) => at('work', slot)),
      workSlots: TB.app.pages().find((p) => p.id === 'work')?.slots.map((s) => s.at).join(',') || null,
      homePlayer: at('home', 'player'),
      lifeSlot1: at('life', 'slot1'),
      gameZone: at('game', 'gamezone'),
      shared: ['topbar', 'clipboard', 'dock'].map((slot) => secOf(slot)?.dataset.module || null),
      pages: TB.app.pages().map((p) => p.id)
    });
  })()`));
  console.log(`其余面板：work 那四格 ${others.workOthers.join(',')} / home player=${others.homePlayer} / life slot1=${others.lifeSlot1} / game gamezone=${others.gameZone} / 常驻 ${others.shared.join(',')}`);
  if (others.workProjects !== 'projects') failures.push(`内存里工作面板 projzone 是 "${others.workProjects}"`);
  if (others.workSlots !== 'projzone,gitzone,gauges,workbench,slot2') failures.push(`工作面板的格子清单是 "${others.workSlots}"，应为 projzone,gitzone,gauges,workbench,slot2`);
  if (others.workOthers.join(',') !== 'git,placeholder,placeholder,placeholder') failures.push(`工作面板别的位置被顺手改了：${others.workOthers.join(',')}`);
  if (others.homePlayer !== 'player') failures.push(`主界面的音乐播放器那格被动了：${others.homePlayer}`);
  if (others.lifeSlot1 !== 'player') failures.push(`生活面板的音乐那格被动了：${others.lifeSlot1}`);
  if (others.gameZone !== 'games') failures.push(`游戏面板的游戏列表那格被动了：${others.gameZone}`);
  if (others.shared.join(',') !== 'topbar,ai,dock') failures.push(`常驻三格跟着面板变了：${others.shared.join(',')}`);

  // ---------- 干跑：真点 DOM，只把 IPC 那一层换成记账替身 ----------
  const beforeProcs = ideProcesses();
  const dry = await evaluate(page, `(async () => {
    const real = TB.api;
    const calls = [];
    // deskToolbar 是 contextBridge 造的，属性只读且不可配置，Proxy 拦不住（会直接抛）。
    // 所以把键浅拷成一份普通对象，只换掉 projects 这一层。
    const wrap = (projects) => { const copy = {}; for (const key of Object.keys(real)) copy[key] = real[key]; copy.projects = projects; return copy; };
    TB.api = wrap({
      list: (force) => real.projects.list(force),
      launch: (id) => { calls.push({ m: 'launch', id }); return Promise.resolve({ ok: true, name: '干跑', ideLabel: 'WebStorm' }); },
      reveal: (id) => { calls.push({ m: 'reveal', id }); return Promise.resolve({ ok: true }); }
    });
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const rows = [...document.querySelectorAll('#projects .pj-item')];
    const items = TB.projects.data.items;
    const marked = () => [...document.querySelectorAll('#projects .pj-item.sel')].map((n) => n.querySelector('.pj-name')?.textContent);
    // 左键：只把这一行选上，一条 projects IPC 都不许发（选中态存在 TB.app.state，git 那一格自己去读）
    rows[0].click();
    await wait(250);
    const afterLeft = { calls: calls.slice(), selId: TB.app.state.project?.id ?? null, marked: marked() };
    // Ctrl+左键：打开文件夹
    if (rows[1]) rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await wait(250);
    const afterCtrl = { calls: calls.slice(), selId: TB.app.state.project?.id ?? null };
    // 双击：交给 IDE。浏览器在 dblclick 之前一定先送两次 click，所以那两次左键也不该多发 IPC、
    // 更不该把刚选上的行洗掉（app.selectProject 里「同一个项目不重渲染」那条就是为这一下留的）
    rows[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await wait(250);
    const stack = [...document.querySelectorAll('#toast .toast')].map((n) => n.textContent);
    const afterDbl = { calls: calls.slice(), selId: TB.app.state.project?.id ?? null, marked: marked() };
    TB.api = real;
    return JSON.stringify({
      afterLeft,
      afterCtrl,
      afterDbl,
      toast: stack[stack.length - 1] || null,
      wantLaunch: items[0].id,
      wantReveal: items[1]?.id ?? null,
      wantName: items[0].name
    });
  })()`);
  const dryOut = JSON.parse(dry);
  console.log(`干跑手势 => 左键后 IPC ${JSON.stringify(dryOut.afterLeft.calls)}、选中「${dryOut.afterLeft.marked.join('/')}」；Ctrl+左键 ${JSON.stringify(dryOut.afterCtrl.calls)}；双击 ${JSON.stringify(dryOut.afterDbl.calls)} / 提示条「${dryOut.toast}」`);
  if (dryOut.afterLeft.calls.length !== 0) {
    failures.push(`左键第一条发了 ${JSON.stringify(dryOut.afterLeft.calls)}：左键只该选中，不该 launch 也不该 reveal`);
  }
  if (dryOut.afterLeft.selId !== dryOut.wantLaunch) failures.push(`左键点完选中态是 ${dryOut.afterLeft.selId}，点的却是 ${dryOut.wantLaunch}：git 那格没法跟着换`);
  if (dryOut.afterLeft.marked.length !== 1 || dryOut.afterLeft.marked[0] !== dryOut.wantName) failures.push(`左边那一行的选中标记不对：${JSON.stringify(dryOut.afterLeft.marked)}，应恰好「${dryOut.wantName}」`);
  if (dryOut.afterCtrl.calls.length !== 1 || dryOut.afterCtrl.calls[0]?.m !== 'reveal' || dryOut.afterCtrl.calls[0]?.id !== dryOut.wantReveal) {
    failures.push(`Ctrl+左键第二条没走 reveal(${dryOut.wantReveal})，实际 ${JSON.stringify(dryOut.afterCtrl.calls)}`);
  }
  if (dryOut.afterDbl.calls.length !== 2 || dryOut.afterDbl.calls[1]?.m !== 'launch' || dryOut.afterDbl.calls[1]?.id !== dryOut.wantLaunch) {
    failures.push(`双击没走 launch(${dryOut.wantLaunch})，两次点完的账是 ${JSON.stringify(dryOut.afterDbl.calls)}`);
  }
  if (dryOut.afterDbl.selId !== dryOut.wantLaunch) failures.push(`双击那两下 click 把选中态洗成了 ${dryOut.afterDbl.selId}：同一行重复选中不该改状态`);
  if (!/已交给/.test(String(dryOut.toast || ''))) failures.push(`双击以后没有「已交给 IDE」的提示条：${JSON.stringify(dryOut.toast)}`);
  const afterProcs = ideProcesses();
  console.log(`JetBrains 进程数 前 ${JSON.stringify(beforeProcs)} → 后 ${JSON.stringify(afterProcs)}`);
  for (const exe of IDE_EXES) {
    if (afterProcs.error || beforeProcs.error) continue;
    if (afterProcs[exe] > beforeProcs[exe]) failures.push(`干跑期间多出一个 ${exe}：启动链路的替身没兜住，真开 IDE 了（若是他自己点的请忽略这条）`);
  }

  // ---------- 两种「看不到东西」的文案 ----------
  const states = JSON.parse(await evaluate(page, `(async () => {
    const real = TB.api;
    const wrap = (projects) => { const copy = {}; for (const key of Object.keys(real)) copy[key] = real[key]; copy.projects = projects; return copy; };
    const mk = (payload) => ({ list: () => Promise.resolve(payload), launch: () => Promise.resolve({ ok: false }), reveal: () => Promise.resolve({ ok: false }) });
    const read = () => ({
      count: document.querySelector('#projects .pj-count')?.textContent,
      muted: document.querySelector('#projects .pj-list .muted')?.textContent || null,
      dom: document.querySelectorAll('#projects .pj-item').length
    });
    TB.api = wrap(mk({ roots: ['Z:\\\\这个根不存在'], items: [], ides: [], warnings: [], error: '找不到仓库根目录（ENOENT）：Z:\\\\这个根不存在' }));
    await TB.projects.load(true);
    const errored = read();
    TB.api = wrap(mk({ roots: ['D:\\\\空项目根'], items: [], ides: [{ id: 'webstorm', label: 'WebStorm', found: true }], warnings: [] }));
    await TB.projects.load(true);
    const empty = read();
    // 一个坏根 + 一个好根：行照出，坏的那条单独占一行提示，不能把整张表掀了
    TB.api = wrap(mk({
      roots: ['D:\\\\坏根', 'D:\\\\GitProject'],
      items: [{ id: 0, name: 'toolbar', root: 'D:\\\\GitProject', path: 'D:\\\\GitProject\\\\toolbar', ide: 'webstorm', ideLabel: 'WebStorm', ideReady: true, why: '前端 / Node 工程', touched: Math.floor(Date.now() / 1000), touchedBy: 'git' }],
      ides: [{ id: 'webstorm', label: 'WebStorm', found: true }],
      warnings: ['找不到仓库根目录（ENOENT）：D:\\\\坏根']
    }));
    await TB.projects.load(true);
    const partial = { ...read(), warn: document.querySelector('#projects .pj-warn')?.textContent || null };
    TB.api = real;
    await TB.projects.load(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return JSON.stringify({ errored, empty, partial, restored: read() });
  })()`, 90000));
  console.log(`异常态 => 报错「${states.errored.muted}」/ 空根「${states.empty.muted}」/ 一个坏根「${states.partial.warn}」+ ${states.partial.dom} 行 / 复原 ${states.restored.count} + ${states.restored.dom} 行`);
  if (states.errored.count !== '未就绪') failures.push(`主进程报错时计数牌是「${states.errored.count}」，应是「未就绪」`);
  if (!states.errored.muted?.includes('找不到仓库根目录')) failures.push(`根目录不存在时没给出原因：${JSON.stringify(states.errored.muted)}`);
  if (!states.empty.muted?.includes('下没有项目文件夹') || !states.empty.muted.includes('D:\\空项目根')) {
    failures.push(`根目录是空的时提示不对（要把根路径说给他看）：${JSON.stringify(states.empty.muted)}`);
  }
  if (states.empty.dom !== 0) failures.push(`空根还渲染了 ${states.empty.dom} 行`);
  if (states.partial.dom !== 1) failures.push(`一个根读不到时把行也掀了：渲染了 ${states.partial.dom} 行，应还有那 1 个好根的行`);
  if (!states.partial.warn?.includes('D:\\坏根')) failures.push(`坏根那句提示没说是哪一个：${JSON.stringify(states.partial.warn)}`);
  if (states.restored.dom !== out.domItems || states.restored.count !== out.countLabel) {
    failures.push(`验完没恢复到真实列表：${JSON.stringify(states.restored)}`);
  }

  // ---------- 重扫按钮：真发 IPC（只读目录，安全） ----------
  const rescan = JSON.parse(await evaluate(page, `(async () => {
    document.querySelector('#projects .pj-head .link-btn').click();
    const during = document.querySelector('#projects .pj-count').textContent;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return JSON.stringify({ during, after: document.querySelector('#projects .pj-count').textContent, dom: document.querySelectorAll('#projects .pj-item').length });
  })()`));
  console.log(`点「重扫」=> 过程中「${rescan.during}」，之后「${rescan.after}」/ ${rescan.dom} 行`);
  if (rescan.during !== '重扫中…') failures.push(`重扫过程中没有「重扫中…」反馈，而是「${rescan.during}」`);
  if (rescan.after !== `${out.itemCount} 个`) failures.push(`重扫后计数牌是「${rescan.after}」，应回到「${out.itemCount} 个」`);
  if (rescan.dom !== out.domItems) failures.push(`重扫后渲染 ${rescan.dom} 行，之前是 ${out.domItems} 行（他这期间新建/删了项目的话，重启探针再比一次）`);

  // ---------- 根目录往返：走设置面板那张真卡片，换一次 roots 既不用重启也不用点「重扫」 ----------
  // 这一段会真写两次 toolbar.config.json（换过去、换回来），收尾逐字比一遍再原样还原：
  // 除了 repos.roots 之外的键动了，说明「保存并应用」顺手改了别的手段。
  // 中途抛了也要还原，所以 cleanupRoots 同时挂在 process 'exit' 上（main().catch 之后就是退出）。
  const cfgFile = path.join(APP_ROOT, 'toolbar.config.json');
  const cfgBefore = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
  const probeRoot = path.join(os.tmpdir(), 'toolbar-roots-probe');
  const cleanupRoots = () => {
    try {
      if (cfgBefore !== null && fs.readFileSync(cfgFile, 'utf8') !== cfgBefore) {
        fs.writeFileSync(cfgFile, cfgBefore, 'utf8');
        console.log('已把 toolbar.config.json 逐字还原成跑之前那份（内存里的应用还拿着探针写过的那一份，它下次自己保存会再写一遍）');
      }
      fs.rmSync(probeRoot, { recursive: true, force: true });
    } catch (error) {
      console.log(`还原配置文件失败（要手工看一眼 ${cfgFile}）：${error.message}`);
    }
  };
  process.on('exit', cleanupRoots);
  fs.mkdirSync(path.join(probeRoot, 'ProbePkg'), { recursive: true });
  fs.writeFileSync(path.join(probeRoot, 'ProbePkg', 'package.json'), '{"name":"toolbar-roots-probe"}', 'utf8');
  const wantRoots = out.configRoots || [];

  const form = JSON.parse(await evaluate(page, `(() => {
    TB.settings.open();
    const box = document.querySelector('.repos-roots');
    const titles = [...document.querySelectorAll('.settings-modal .card h3')].map((h) => h.textContent);
    return JSON.stringify({
      card: titles.includes('仓库根目录'),
      hasBox: Boolean(box),
      prefilled: box ? box.value.split('\\n').map((line) => line.trim()).filter(Boolean) : null,
      browse: [...document.querySelectorAll('.settings-modal button')].some((btn) => /浏览/.test(btn.textContent)),
      save: [...document.querySelectorAll('.settings-footer button')].some((btn) => btn.textContent === '保存并应用')
    });
  })()`));
  console.log(`设置卡片：「仓库根目录」${form.card ? '在' : '没有'}，textarea ${form.hasBox ? '在' : '没有'}，预填 ${JSON.stringify(form.prefilled)}，浏览按钮 ${form.browse}，保存按钮 ${form.save}`);
  if (!form.card || !form.hasBox || !form.browse || !form.save) failures.push('设置面板里那张卡片摆不齐（卡片标题 / textarea / 浏览按钮 / 保存并应用 四样都要在）');
  if (JSON.stringify(form.prefilled) !== JSON.stringify(wantRoots)) {
    failures.push(`卡片预填的和配置里存的不是一回事：${JSON.stringify(form.prefilled)} vs ${JSON.stringify(wantRoots)}`);
  }

  const swapRoots = async (lines) => JSON.parse(await evaluate(page, `(async () => {
    TB.settings.open();
    const box = document.querySelector('.repos-roots');
    box.value = ${JSON.stringify(lines.join('\n'))};
    [...document.querySelectorAll('.settings-footer button')].find((btn) => btn.textContent === '保存并应用').click();
    // 保存会重建整壳：等这一格重新把列表填回来
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (TB.projects?.data?.items?.length && !TB.projects.data.error) break;
    }
    return JSON.stringify({
      dataRoots: TB.projects?.data?.roots || [],
      configRoots: (TB.app.state.config?.repos?.roots || []).slice(),
      names: [...document.querySelectorAll('#projects .pj-name')].map((n) => n.textContent),
      error: TB.projects?.data?.error || null,
      open: document.querySelector('#settings')?.classList.contains('open')
    });
  })()`, 120000));
  // 先把根目录换成临时那一个：这一格该只剩 ProbePkg 一行
  const swapped = await swapRoots([probeRoot]);
  console.log(`换根 => data ${JSON.stringify(swapped.dataRoots)} / 卡片存回 ${JSON.stringify(swapped.configRoots)} / 行 ${JSON.stringify(swapped.names)}`);
  if (swapped.error) failures.push(`换新根目录时报错了：${swapped.error}`);
  if (JSON.stringify(swapped.dataRoots) !== JSON.stringify([probeRoot])) {
    failures.push(`「保存并应用」换了 roots，这一格扫的还是旧根（现读配置那条没生效，得重启才见效）：${JSON.stringify(swapped.dataRoots)}`);
  }
  if (JSON.stringify(swapped.names) !== JSON.stringify(['ProbePkg'])) {
    failures.push(`新根下只该有 ProbePkg 一行，实际 ${JSON.stringify(swapped.names)}`);
  }
  if (swapped.open) failures.push('点了「保存并应用」设置面板没关掉');

  // 再换回来：roots 一路走的是「textarea → config.save → 主进程现读 → 这一格重扫」，两头都得对上
  const restored = await swapRoots(wantRoots);
  const sameRoots = (a, b) => JSON.stringify((a || []).map((x) => x.toLowerCase())) === JSON.stringify((b || []).map((x) => x.toLowerCase()));
  console.log(`换回 => data ${JSON.stringify(restored.dataRoots)} / 行 ${restored.names.length} 条（之前 ${out.domItems} 条）`);
  if (!sameRoots(restored.dataRoots, wantRoots)) failures.push(`roots 没换回来：${JSON.stringify(restored.dataRoots)}，应为 ${JSON.stringify(wantRoots)}`);
  if (restored.names.length !== out.domItems) failures.push(`换回来后渲染 ${restored.names.length} 行，跑之前是 ${out.domItems} 行`);
  if (cfgBefore !== null) {
    const before = JSON.parse(cfgBefore);
    const after = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => key !== 'repos' && JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    console.log(`配置文件：${changed.length ? `除 repos 之外还动了这些段（本来不该动）：${changed.join('、')}` : '除 repos 之外没有一段被动过'}`);
    if (changed.length) failures.push(`「保存并应用」顺手改了 repos 以外的段：${changed.join('、')}`);
  }
  cleanupRoots();

  if (SHOTS) {
    try {
      const file = path.join(APP_ROOT, 'samples', 'projects-panel.png');
      await capture(page, file);
      console.log(`截图 ${file}`);
    } catch (error) {
      console.log(`截图失败（不影响功能判定）：${error.message}`);
    }
  }

  // 切回他原来那一页（工作面板绑了桌面 2，别把桌面留在第二个虚拟桌面上）
  try {
    await evaluate(page, `TB.app.selectProject(${JSON.stringify(originalSel)});'ok'`);
    await evaluate(page, `TB.app.setPage(${JSON.stringify(originalPage)});'ok'`);
    const left = JSON.parse(await evaluateReady(page, `JSON.stringify({ page: TB.app.state.page })`)).page;
    if (left !== originalPage) failures.push(`收尾没切回 "${originalPage}"，还留在 "${left}"（桌面也一并留在第 2 个）`);
    console.log(`收尾：从 "${PAGE_ID}" 切回面板 "${left}"（跑之前他在 "${originalPage}"）`);
  } catch (error) {
    failures.push(`切回 "${originalPage}" 失败：${error.message}`);
  }

  if (failures.length) {
    for (const line of failures) console.log(`✗ ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ 项目格子全绿：真根目录 ${out.itemCount} 个项目进「${PAGE_ID}/${SLOT}」，每行「名字 / ${out.domFirstIde} / ${out.domFirstAgo}」都在格子内且横向不溢出，`);
  console.log('  判据与手势写在悬浮提示里、行里没有 exe 路径、重扫与三种兜底文案都对得上、设置卡片真换了一次根目录又换回来；启动链路是干跑，一个 IDE 都没被真拉起来');
}

main().catch((error) => {
  console.error(`[projects-appprobe] 失败：${error.message}`);
  process.exitCode = 1;
});
