// git 格子（工作面板中间那一整块 gitzone，和左列 projzone 上下通高）的真机验证：附着到真实运行的工具栏（需带 --remote-debugging-port 启动）。
//
// 这一格现在是「项目格的第二个视图」，所以量的是三件事：
//   1) 落位与新几何：gitzone 与 projzone 同顶同底同高（两块各合成一整块），宽度等于中间那一列（和 gauges 同列），
//      三种状态各自都不许被 .area 裁掉；
//   2) 联动：默认态（左边没点）一句提示 + 一条 IPC 都不发；点左边某一行，右边整块换成那个仓库，
//      点的还是项目格那一下（左键选中；双击才交给 IDE，这一趟不碰双击）；
//   3) 三态各自的证据：仓库态 = 分支行 + 清单 + 四个动作 + 说明框；非仓库态 = 项目信息卡 + 仓库根目录清单
//      （卡上的路径抄的是 TB.app.state.project，不是 git 的返回）。
//
// 写侧全部干跑，一个 git 写进程都不许起：
//   · TB.api.git 整个换成只记账的替身（status 那条继续走真的，它只读），
//     所以 prepare / confirm / cancel / openFile 四条真通道在这段里根本拿不到；
//   · 点「确认」只发生在替身身上；真通道那一次走 prepare → 看确认条那几句话 → 点「取消」（prepare 不发写命令，
//     这一点由 tools/git-check.js 钉着），永不点真「确认」；
//   · 跑前跑后各取一次每个仓库的 HEAD 与 reflog 顶端，逐字比一遍：多出一条就是真提交过。
//     「绝不真推」不需要旁证——替身不在线上，push 那一步连 nonce 都换不到。
//
// 真开 IDE 由人来点；解析、闸门、一次性 nonce 那些由 tools/git-check.js 验。
//
// 注意：工作面板绑了虚拟桌面 2，点这一页的 tab 会把桌面切过去；探针收尾会把面板和选中项都还回去。
//
// 用法（Git Bash）:
//   1) unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
//   2) node tools/git-appprobe.js [端口] [--shot]   # --shot 存 samples/git-*.png
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv.slice(2).find((arg) => /^\d+$/.test(arg)) || 9223);
const SHOTS = process.argv.includes('--shot');
const PAGE_ID = 'work';
const SLOT = 'gitzone';
const LEFT = 'projzone';

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

// --shot 时的四个镜头：默认态、仓库态、非仓库卡、确认条挂出来那一张。
// 后三张是这次排版的证据：几何问题（清单被压成一条线、卡长出格子外）光看断言的数字不够，得看图。
async function shot(page, name) {
  if (!SHOTS) return;
  try {
    const file = path.join(APP_ROOT, 'samples', name);
    await capture(page, file);
    console.log(`截图 ${file}`);
  } catch (error) {
    console.log(`截图 ${name} 失败（不影响功能判定）：${error.message}`);
  }
}

// 只读旁证：每个仓库的 HEAD 和 reflog 顶端。这两样只有真提交/真重置才会变。
function heads(dirs) {
  const read = (gitArgs) => {
    try {
      return execFileSync('git', gitArgs, { cwd: APP_ROOT, encoding: 'utf8', timeout: 8000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
    } catch (error) {
      return `读不到：${String(error.message).split(/\r?\n/)[0].slice(0, 60)}`;
    }
  };
  return Object.fromEntries(dirs.map((dir) => [path.basename(dir), [read(['-C', dir, 'rev-parse', 'HEAD']), read(['-C', dir, 'reflog', '-1', '--format=%H %gd'])]]));
}

// 量格子矩形 + 里外两层的内容高度：.area 是 overflow:hidden，内容超了不报错，只是看不见
const CELL = `(() => {
  if (!TB?.app?.state?.grid) throw new Error('渲染层 boot 未完成');
  const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const sec = (at) => document.querySelector('#shell > section[data-slot="' + at + '"]');
  const host = document.getElementById('git');
  const list = host?.querySelector('.gt-list');
  const font = (n) => (n ? Math.round(parseFloat(getComputedStyle(n).fontSize) * 10) / 10 : null);
  return JSON.stringify({
    cells: Object.fromEntries(['${SLOT}', '${LEFT}', 'gauges', 'slot2', 'workbench', 'topbar', 'clipboard', 'dock'].map((at) => [at, box(sec(at))])),
    modules: Object.fromEntries(['${SLOT}', '${LEFT}'].map((at) => [at, sec(at)?.dataset.module || null])),
    gitHostClip: host ? Math.round(host.scrollHeight - host.getBoundingClientRect().height) : null,
    secClip: (() => { const s = sec('${SLOT}'); return s ? Math.round(s.scrollHeight - s.getBoundingClientRect().height) : null; })(),
    listScroll: list ? { overflowY: getComputedStyle(list).overflowY, sh: list.scrollHeight, ch: list.clientHeight, sw: list.scrollWidth, cw: list.clientWidth, top: list.scrollTop } : null,
    listBox: box(host?.querySelector('.gt-files')),
    opsBox: box(host?.querySelector('.gt-ops')),
    promptBox: box(host?.querySelector('.gt-prompt')),
    promptFont: font(host?.querySelector('.gt-prompt')),
    repoBox: box(host?.querySelector('.gt-repo')),
    cardBox: box(host?.querySelector('.gt-card')),
    rootsBox: box(host?.querySelector('.gt-roots'))
  });
})()`;

async function main() {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((item) => item.type === 'page' && item.url.includes('renderer/index.html'));
  if (!page) throw new Error(`CDP 端口 ${PORT} 上找不到工具栏渲染层，先跑: ./node_modules/electron/dist/electron.exe . --remote-debugging-port=${PORT}`);

  const failures = [];
  if (JSON.parse(await evaluate(page, `JSON.stringify({ has: typeof TB.api?.git === 'object' })`)).has !== true)
    throw new Error('TB.api.git 不存在：跑着的是改动之前的旧主进程，重启应用再来（别在这儿验渲染层）');
  // 这一格的全部新意都在「id 跟着点走」，而参数个数问不出来：contextBridge 把每个 API 函数重新包一层，
  // 到了渲染层 Function.length 恒为 0（真机踩过：新主进程也被判成旧的）。改成拿一次真调用的回包当门——
  // 不传 id 那一次服务只回「先点左边一个项目」，一个 git 进程都不起，可以随便敲。
  const boot = JSON.parse(await evaluate(page, `TB.api.git.status(false).then(x => JSON.stringify({ keys: Object.keys(x || {}).sort().join(','), need: x?.need === undefined ? null : x.need }))`));
  if (!boot.keys.includes('focusId')) throw new Error(`git.status 的回包里没有 focusId（只有 ${boot.keys || '空'}）：跑着的是改动之前的旧主进程，重启应用再来`);

  // 给那条只读通道包一层账本：「默认态一条都不发」「点一次只读一个仓库」这两句话得有据可查
  await evaluate(page, `(() => {
    if (!TB.__origApi) {
      const original = {};
      for (const key of Object.keys(TB.api)) original[key] = TB.api[key];
      TB.__origApi = original;
      TB.__statusLog = [];
    }
    const copy = {};
    for (const key of Object.keys(TB.__origApi)) copy[key] = TB.__origApi[key];
    copy.git = Object.assign({}, TB.__origApi.git, { status: (force, id) => { TB.__statusLog.push({ force, id }); return TB.__origApi.git.status(force, id); } });
    TB.api = copy;
    return 'ok';
  })()`);
  const drain = async () => JSON.parse(await evaluate(page, `JSON.stringify((() => { const n = TB.__statusLog.slice(); TB.__statusLog.length = 0; return n; })())`));

  const originalPage = JSON.parse(await evaluateReady(page, `JSON.stringify({ page: TB.app.state.page })`)).page;
  await evaluate(page, `document.querySelector('.topbar .page-tab[data-page="${PAGE_ID}"]').click();'ok'`);
  // 起手把上一趟（或他自己）留下的状态收干净：挂着确认条、选中着某一行，后面每一步都会量到不该量到的东西。
  // 原来那一条选中项记在 TB.__savedSel，收尾还回去。
  const leftover = JSON.parse(await evaluate(page, `(() => {
    const before = { ask: document.querySelectorAll('#git .gt-ask').length, sel: TB.app.state.project ? TB.app.state.project.name : null };
    TB.git.stopAsk();
    TB.__savedSel = TB.app.state.project || null;
    TB.app.selectProject(null);
    return JSON.stringify(before);
  })()`));
  if (leftover.ask || leftover.sel) console.log(`起手收掉留下的状态：确认条 ${leftover.ask} 条、选中「${leftover.sel || '无'}」（收尾还回去）`);
  await drain();

  // ---------- 状态一：左边没点，这一格只该说一句话 ----------
  const idle = JSON.parse(await evaluateReady(page, CELL));
  const idleState = JSON.parse(await evaluate(page, `(() => {
    const host = document.getElementById('git');
    return JSON.stringify({
      activePage: TB.app.state.page,
      registered: TB.components.has('git'),
      module: document.querySelector('#shell > section[data-slot="${SLOT}"]')?.dataset.module || null,
      countLabel: host.querySelector('.gt-count')?.textContent || null,
      reloadLabel: host.querySelector('.gt-head .link-btn')?.textContent || null,
      prompt: host.querySelector('.gt-prompt')?.textContent || null,
      prompts: host.querySelectorAll('.gt-prompt').length,
      repo: host.querySelectorAll('.gt-repo').length,
      card: host.querySelectorAll('.gt-card').length,
      ops: host.querySelectorAll('.gt-op').length,
      state: TB.app.state.project ? TB.app.state.project.name : null,
      dataKeys: TB.git.data ? Object.keys(TB.git.data).sort().join(',') : null
    });
  })()`));
  // 空转 3 秒看账本：这一格没有自己的轮询，没选中更不该发任何东西
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const idleCalls = await drain();
  console.log(`默认态 => 计数牌「${idleState.countLabel}」，正文「${idleState.prompt}」，3 秒空转里 git.status 发了 ${idleCalls.length} 次`);
  if (idleState.activePage !== PAGE_ID) failures.push(`点 tab 没切到 "${PAGE_ID}"，还在 "${idleState.activePage}"`);
  if (idleState.module !== 'git') failures.push(`「${SLOT}」这格挂的是 "${idleState.module}"，layout.json 和 layout.js 里工作面板那一格没改成 git？（改完要重启应用）`);
  if (!idleState.registered) failures.push('组件注册表里没有 "git"（loader 没注入 src/renderer/js/components/git.js？）');
  if (idleState.state) failures.push(`起手没能清空选中态，还停在「${idleState.state}」：后面默认态那几条判据都不算数`);
  if (idleState.countLabel !== '未选项目') failures.push(`没选中时计数牌写的是「${idleState.countLabel}」，应为「未选项目」`);
  if (idleState.prompts !== 1 || !/点左边.{0,6}项目/.test(idleState.prompt || '')) failures.push(`没选中时正文不是那一句提示：${JSON.stringify(idleState.prompt)}（${idleState.prompts} 条）`);
  if (idleState.repo || idleState.card) failures.push(`没选中还长了仓库块/信息卡（${idleState.repo}/${idleState.card}）：默认态该只有一句话`);
  if (idleState.ops) failures.push(`没选中还挂着 ${idleState.ops} 个动作按钮：那是一张空表配四个必然失败的按钮`);
  if (idleState.dataKeys !== null) failures.push(`没选中时手上还留着数据（键 ${idleState.dataKeys}）：默认态该是空的，不是演上一次的数字`);
  if (idleCalls.length) failures.push(`没选中时发了 ${idleCalls.length} 次 git.status（${JSON.stringify(idleCalls)}）：他要的默认态是一条命令都不起`);
  if (idleState.reloadLabel !== '刷新') failures.push(`刷新按钮写着「${idleState.reloadLabel}」`);
  if (idle.promptFont !== null && idle.promptFont < 13) failures.push(`那一句提示 ${idle.promptFont}px，低于 13px 的可读下限`);
  if (idle.secClip > 1 || idle.gitHostClip > 1) failures.push(`默认态就超了格子：#git 内容高 ${idle.gitHostClip}px、格子 ${idle.secClip}px`);
  if (idle.promptBox && idle.cells?.[SLOT] && idle.promptBox.bottom > idle.cells[SLOT].bottom + 1) failures.push(`那一句提示落在格子外：${JSON.stringify([idle.promptBox, idle.cells[SLOT]])}`);
  await shot(page, 'git-idle.png');

  // ---------- 新几何：gitzone 是合成的一整块，不是原来那半格 ----------
  const geo = idle.cells || {};
  const here = geo[SLOT];
  const left = geo[LEFT];
  const gauge = geo.gauges;
  console.log(`格子 ${here?.w}x${here?.h} @(${here?.x},${here?.y})；左列 projzone ${left?.w}x${left?.h} @(${left?.x},${left?.y})；同列 gauges ${gauge?.w}x${gauge?.h}`);
  if (!here) failures.push(`DOM 上没有 data-slot="${SLOT}" 这一格（工作面板那份 grid 没落位？）`);
  else {
    if (here.h < 300) failures.push(`gitzone 只有 ${here.h}px 高：两块合成一整块以后该是第 2+3 行通高（旧尺寸 176px 会被这条咬住）`);
    if (here.w < 400) failures.push(`gitzone 只有 ${here.w}px 宽：该是中间那一整列（旧尺寸 330px 会被这条咬住）`);
    if (left && Math.abs(here.h - left.h) > 2) failures.push(`左右两块不同高：gitzone ${here.h} vs projzone ${left.h}（都是第 2+3 行通高，必须齐）`);
    if (left && (Math.abs(here.y - left.y) > 2 || Math.abs(here.bottom - left.bottom) > 2)) failures.push(`左右两块没对齐同一批行：${JSON.stringify([here, left])}`);
    if (left && here.x < left.right - 2) failures.push(`gitzone 不在 projzone 右边：${here.x} vs 左块右边 ${left.right}（联动靠他往右看一眼）`);
    if (gauge && Math.abs(here.w - gauge.w) > 2) failures.push(`gitzone 宽 ${here.w} 和同列的 gauges ${gauge.w} 不一样：第 2 列不该两种宽`);
    if (gauge && Math.abs(here.y - gauge.y) > 2) failures.push(`gitzone 顶边和同列的 gauges 不齐：${here.y} vs ${gauge.y}（两块都从第 2 行起）`);
    // 注意比的是 bottom：gauges 只占第 2 行（176px），gitzone 占第 2+3 行，正确几何下它的下沿必须越过 gauges 的下沿
    if (gauge && here.bottom <= gauge.bottom + 2) failures.push(`gitzone 到 gauges 那一行就停了（${here.bottom} vs 该行下沿 ${gauge.bottom}）：没跨过第 3 行，原 slot1 那块没合进来`);
  }
  for (const [at, rect] of Object.entries(geo)) {
    if (rect && /undefined|NaN/.test(JSON.stringify(rect))) failures.push(`格子 ${at} 的矩形读不出数字：${JSON.stringify(rect)}`);
  }

  // 其余格子不许跟着动
  const others = JSON.parse(await evaluate(page, `(() => {
    const at = (pageId, slot) => TB.app.pages().find((p) => p.id === pageId)?.slots.find((s) => s.at === slot)?.module || null;
    const secOf = (slot) => document.querySelector('#shell > section[data-slot="' + slot + '"]');
    return JSON.stringify({
      workSlots: TB.app.pages().find((p) => p.id === 'work')?.slots.map((s) => s.at).join(',') || null,
      workGit: at('work', 'gitzone'),
      workProjects: at('work', 'projzone'),
      homeClock: at('home', 'clock'),
      homePlayer: at('home', 'player'),
      lifeLeftzone: at('life', 'leftzone'),
      gameZone: at('game', 'gamezone'),
      shared: ['topbar', 'clipboard', 'dock'].map((slot) => secOf(slot)?.dataset.module || null)
    });
  })()`));
  console.log(`其余：work 格子=${others.workSlots}（${others.workProjects}+${others.workGit}）/ home clock=${others.homeClock} player=${others.homePlayer} / life leftzone=${others.lifeLeftzone} / game gamezone=${others.gameZone} / 常驻 ${others.shared.join(',')}`);
  if (others.workSlots !== 'projzone,gitzone,gauges,workbench,slot2') failures.push(`工作面板的格子清单是 "${others.workSlots}"，应为 projzone,gitzone,gauges,workbench,slot2（slot1/player/clock 都该被合掉了）`);
  if (others.homeClock !== 'clock') failures.push(`主界面的时钟被这一格顶掉了：${others.homeClock}`);
  if (others.homePlayer !== 'player') failures.push(`主界面的播放器被这一格顶掉了：${others.homePlayer}`);
  if (others.lifeLeftzone !== 'mail') failures.push(`生活面板的邮箱那格被动了：${others.lifeLeftzone}`);
  if (others.gameZone !== 'games') failures.push(`游戏面板的游戏列表那格被动了：${others.gameZone}`);
  if (others.shared.join(',') !== 'topbar,ai,dock') failures.push(`常驻三格跟着面板变了：${others.shared.join(',')}`);

  // ---------- 联动：点左边某一行 → 右边整块换成那个仓库 ----------
  const rows = JSON.parse(await evaluate(page, `JSON.stringify((TB.projects?.data?.items || []).map((item) => ({ id: item.id, name: item.name, path: item.path, git: Boolean(item.git), root: item.root })))`));
  if (!rows.length) throw new Error('项目格一行都没有：先看设置里的仓库根目录配的对不对，这一格的三态全靠点它');
  const repoRow = rows.find((item) => item.git);
  const plainRow = rows.find((item) => !item.git);
  const dirs = rows.filter((item) => item.git).map((item) => item.path);
  // 旁证在干跑之前取：这一趟之后每个仓库的 HEAD / reflog 顶端必须逐字没变
  const headsBefore = heads(dirs);
  console.log(`项目格 ${rows.length} 行、仓库 ${dirs.length} 条：仓库态用「${repoRow?.name || '（没有）'}」，非仓库态用「${plainRow ? plainRow.name : '（没有非仓库的行）'}」`);
  if (!repoRow) throw new Error('项目格里一条真仓库都没有（每行 git 都是 false）：仓库态没处验，先看 roots 配的是不是那批项目');

  // 点下去是同步的，数据要等一条只读 IPC 回来：轮它一等，别把「慢」读成「没换」
  const clickRow = async (item) => {
    await evaluate(page, `(() => { const n = document.querySelector('#projects .pj-item[data-id="${item.id}"]'); if (!n) throw new Error('项目格里没有 data-id=${item.id} 这一行'); n.click(); return 'ok'; })()`);
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const focused = JSON.parse(await evaluate(page, `JSON.stringify(TB.git.data?.focus?.id ?? null)`));
      if (focused === item.id) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    return drain();
  };

  const repoCalls = await clickRow(repoRow);
  const cell = JSON.parse(await evaluateReady(page, CELL));
  const repoState = JSON.parse(await evaluate(page, `(() => {
    const host = document.getElementById('git');
    const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
    const sec = document.querySelector('#shell > section[data-slot="${SLOT}"]');
    const secBox = box(sec);
    const inside = (n) => { const b = box(n); return Boolean(b && secBox) && b.x >= secBox.x - 1 && b.right <= secBox.right + 1 && b.bottom <= secBox.bottom + 1; };
    const glyph = (n) => { if (!n) return null; const range = document.createRange(); range.selectNodeContents(n); const t = range.getBoundingClientRect(); const p = n.getBoundingClientRect(); return { top: Math.round(t.top - p.top), h: Math.round(t.height * 10) / 10, rowH: Math.round(p.height), bottomGap: Math.round(p.bottom - t.bottom) }; };
    const data = TB.git.data || {};
    const row = (data.rows || [])[0] || null;
    const items = [...document.querySelectorAll('#projects .pj-item')];
    const ops = [...host.querySelectorAll('.gt-op')];
    const files = [...host.querySelectorAll('.gt-file')];
    const msg = host.querySelector('.gt-msg');
    return JSON.stringify({
      page: TB.app.state.page,
      selName: TB.app.state.project?.name ?? null,
      selId: TB.app.state.project?.id ?? null,
      selMarked: items.filter((n) => n.classList.contains('sel')).map((n) => n.querySelector('.pj-name')?.textContent),
      dataKeys: Object.keys(data).sort().join(','),
      focusKeys: data.focus ? Object.keys(data.focus).sort().join(',') : null,
      focus: data.focus || null,
      focusId: data.focusId ?? null,
      need: data.need ?? null,
      cached: data.cached ?? null,
      rows: (data.rows || []).length,
      rowKeys: row ? Object.keys(row).sort().join(',') : null,
      rowName: row?.name ?? null,
      rowRepo: row?.repo ?? null,
      rowError: row?.error ?? null,
      files: row?.files?.length ?? null,
      truncated: row?.truncated ?? false,
      upstream: row?.upstream ?? null,
      gitFound: data.git?.found ?? null,
      gitVersion: data.git?.version ?? null,
      dataError: data.error ?? null,
      countLabel: host.querySelector('.gt-count')?.textContent || null,
      repoShown: Boolean(host.querySelector('.gt-repo')),
      promptShown: Boolean(host.querySelector('.gt-prompt')),
      cardShown: Boolean(host.querySelector('.gt-card')),
      nameText: host.querySelector('.gt-name')?.textContent ?? null,
      nameTip: host.querySelector('.gt-name')?.title ?? null,
      chip: host.querySelector('.gt-repo .gt-chip')?.textContent ?? null,
      blockTip: String(host.querySelector('.gt-repo')?.title ?? '').split('\\n').join(' / '),
      opLabels: ops.map((n) => n.textContent),
      opTips: ops.map((n) => n.title),
      msgBox: Boolean(msg),
      msgPlaceholder: msg?.placeholder || null,
      fileCount: files.length,
      fileTips: files.slice(0, 3).map((n) => n.title),
      fileFontSize: files.length ? Math.round(parseFloat(getComputedStyle(files[0]).fontSize) * 10) / 10 : null,
      fileRowHeights: files.slice(0, 4).map((n) => Math.round(n.getBoundingClientRect().height)),
      fileGlyph: glyph(files[0]),
      moreNote: host.querySelector('.gt-more')?.textContent || null,
      cleanNote: host.querySelector('.gt-files .muted')?.textContent || null,
      // 跨 IPC：这一趟除 root（他自己配的根）以外不许有盘符路径，也不许有 git.exe / IDE 启动器
      absInPayload: JSON.stringify((data.rows || []).map((r) => ({ ...r, root: undefined }))).match(/[A-Za-z]:[\\\\/][^"]{0,40}/g) || [],
      exeLeak: JSON.stringify(data).includes('git.exe') || JSON.stringify(data).includes('JetBrains'),
      repoInside: inside(host.querySelector('.gt-repo')),
      opsInside: inside(host.querySelector('.gt-ops')),
      msgInside: inside(msg),
      hostClip: Math.round(host.scrollHeight - host.getBoundingClientRect().height),
      secClip: Math.round(sec.scrollHeight - sec.getBoundingClientRect().height)
    });
  })()`));
  console.log(`点「${repoRow.name}」=> 计数牌「${repoState.countLabel}」，块顶「${repoState.nameText} ${repoState.chip}」，清单 ${repoState.fileCount} 条，动作 ${repoState.opLabels.join('/')}，status ${repoCalls.length} 次 ${JSON.stringify(repoCalls)}`);
  console.log(`  data 键=${repoState.dataKeys}；focus 键=${repoState.focusKeys}；行键=${repoState.rowKeys}；cached=${repoState.cached} need=${JSON.stringify(repoState.need)}`);
  console.log(`  列表 ${JSON.stringify(cell.listScroll)}；清单框 ${JSON.stringify(cell.listBox)}；格子超 ${cell.secClip}px / #git 超 ${cell.gitHostClip}px`);

  if (repoState.page !== PAGE_ID) failures.push(`点项目行把面板切走了：现在在 "${repoState.page}"`);
  if (repoState.selId !== repoRow.id || repoState.selName !== repoRow.name) failures.push(`点了「${repoRow.name}」但选中态是 ${JSON.stringify([repoState.selId, repoState.selName])}`);
  if (repoState.selMarked.length !== 1 || repoState.selMarked[0] !== repoRow.name) failures.push(`左边那一行的选中标记不对：标了 ${JSON.stringify(repoState.selMarked)}，应恰好「${repoRow.name}」`);
  if (repoState.focusId !== repoRow.id || repoState.focus?.id !== repoRow.id) failures.push(`git 那一份看的不是点的这一条：focus=${JSON.stringify(repoState.focus)} focusId=${repoState.focusId}`);
  if (repoState.rows !== 1) failures.push(`一格只看一个仓库，rows 却有 ${repoState.rows} 条`);
  if (repoState.need) failures.push(`点了真仓库还说 ${JSON.stringify(repoState.need)}：这一格该直接给出那个仓库`);
  if (!repoState.repoShown || repoState.promptShown || repoState.cardShown) failures.push(`仓库态的块不对：repo=${repoState.repoShown} prompt=${repoState.promptShown} card=${repoState.cardShown}`);
  if (repoState.nameText !== repoRow.name) failures.push(`右边块顶上的名字是「${repoState.nameText}」，点的是「${repoRow.name}」：切项目没切过来`);
  if (repoState.rowName !== repoRow.name) failures.push(`数据里的行是「${repoState.rowName}」，点的却是「${repoRow.name}」`);
  if (repoState.rowRepo !== true) failures.push(`git 说这一条 repo=${JSON.stringify(repoState.rowRepo)}，项目格却认它是仓库：两格判的不是同一件事`);
  if (repoState.rowError) failures.push(`这一格这个仓库读不到：${repoState.rowError}`);
  if (repoState.dataError) failures.push(`主进程整格级别的报错：${repoState.dataError}`);
  if (!repoState.gitFound) failures.push(`这一格说本机没有 git（version=${JSON.stringify(repoState.gitVersion)}）：先确认应用真重启过`);
  if (repoState.dataKeys !== 'cached,focus,focusId,git,need,rows,scannedAt') failures.push(`git 那份返回的键集合变了：${repoState.dataKeys}`);
  if (repoState.focusKeys !== 'id,name,repo,root') failures.push(`focus 里带了别的东西：${repoState.focusKeys}`);
  if (repoState.absInPayload.length) failures.push(`除 root 以外的绝对路径过了 IPC：${JSON.stringify(repoState.absInPayload.slice(0, 2))}`);
  if (repoState.exeLeak) failures.push('跨 IPC 的数据里出现了 git.exe 或 JetBrains 路径');
  if (repoCalls.length > 1) failures.push(`点一次发了 ${repoCalls.length} 次 git.status（${JSON.stringify(repoCalls)}）：换项目只该读那一个仓库一次`);
  if (repoCalls.some((c) => c.id !== repoRow.id)) failures.push(`status 递的 id 不是点的那一行：${JSON.stringify(repoCalls)}`);
  if (repoState.countLabel === '未选项目') failures.push('已经点了项目，计数牌还写着「未选项目」');
  if (repoState.opLabels.join(',') !== '抓取,拉取,提交,推送') failures.push(`动作行不是那四个：${repoState.opLabels.join('/')}`);
  if (!repoState.msgBox) failures.push('没有那句提交说明的输入框（不该点「提交」才长出来）');
  if (!/不 add|不替你编/.test(repoState.msgPlaceholder || '')) failures.push(`说明框的提示没交代这一格不做什么：${JSON.stringify(repoState.msgPlaceholder)}`);
  if (!/[A-Za-z]:[\\/]/.test(String(repoState.nameTip || ''))) failures.push(`名字上的 tooltip 该是它来自哪个根目录（root），实际是 ${JSON.stringify(repoState.nameTip)}`);
  if (!/已跟踪的改动 \d+ 个（提交会带走这些）· 未跟踪 \d+ 个（提交不带）/.test(repoState.blockTip || '')) {
    failures.push(`块上的悬浮说明没把「已跟踪 / 未跟踪」分开说：${JSON.stringify(repoState.blockTip)}`);
  }
  if (repoState.opLabels.length === 4) {
    const push = repoState.opTips[3] || '';
    if (repoState.upstream ? !/别人看得见/.test(push) : !/第一次推送/.test(push)) failures.push(`推送那一句要么没说「别人看得见」要么没指路去命令行：${JSON.stringify(push)}`);
    if (!/未跟踪的 \d+ 个不会被带上/.test(repoState.opTips[2] || '')) failures.push(`提交那一句没单独说未跟踪的不会带上：${JSON.stringify(repoState.opTips[2])}`);
  }
  if (repoState.fileCount && !/IDE 打开/.test(String(repoState.fileTips[0] || ''))) failures.push(`文件条目上的提示没说点开是交给 IDE：${JSON.stringify(repoState.fileTips[0])}`);
  if (repoState.fileCount && /[A-Za-z]:[\\\\/]/.test(String(repoState.fileTips[0] || ''))) failures.push(`文件条目的提示里漏了绝对路径：${JSON.stringify(repoState.fileTips[0])}`);
  if (repoState.files && repoState.fileCount === 0 && !repoState.cleanNote) failures.push(`有 ${repoState.files} 条改动却一条都没列出来，也没说为什么`);
  if (repoState.truncated && !repoState.moreNote) failures.push('清单被截了但没写「只显示前面一部分」');
  // 几何：整块都在格子里；清单是这一格唯一该被压缩、该自己滚的部分
  if (!repoState.repoInside) failures.push('仓库块超出格子矩形，会被 .area 裁掉');
  if (!repoState.opsInside) failures.push('动作行够不着：被裁在格子外');
  if (!repoState.msgInside) failures.push('说明框被裁在格子外');
  if (repoState.hostClip > 1 || repoState.secClip > 1) failures.push(`仓库态内容超了格子：#git ${repoState.hostClip}px、格子 ${repoState.secClip}px（这一格放大以后不该还需要裁）`);
  if (repoState.fileGlyph && (repoState.fileGlyph.top < 0 || repoState.fileGlyph.bottomGap < 1)) failures.push(`清单行把字裁了：行 ${repoState.fileGlyph.rowH}px，字 ${repoState.fileGlyph.h}px，上溢 ${repoState.fileGlyph.top}px、下留 ${repoState.fileGlyph.bottomGap}px`);
  if (repoState.fileFontSize !== null && repoState.fileFontSize < 13) failures.push(`改动文件名 ${repoState.fileFontSize}px，低于 13px 的可读下限（要点开的就是这一行）`);
  if (repoState.fileRowHeights.length && Math.min(...repoState.fileRowHeights) < 15) failures.push(`清单里的行被压成 ${JSON.stringify(repoState.fileRowHeights)}px：框子有高度但每条文件名只剩一条线，等于没列出来`);
  if (repoState.files && cell.listBox && cell.listBox.h < 18) failures.push(`有 ${repoState.files} 条改动，清单那一块只有 ${cell.listBox.h}px：一条文件名都看不见`);
  if (cell.opsBox && here && cell.opsBox.bottom > here.bottom + 1) failures.push(`动作行落在格子底边以外：${JSON.stringify([cell.opsBox, here])}`);
  // 竖向不许留大片空白：这一格 402px 高，详情块（含清单）必须把它吃满，
  // 只写 flex: 0 1 auto 时改动少的那几行会整块缩在上半截，下面空 250px、清单只剩两行（放大截图看到的）。
  if (cell.repoBox && here && here.bottom - cell.repoBox.bottom > 20)
    failures.push(`详情块只到 ${cell.repoBox.bottom}，格子底边 ${here.bottom}：下面空了 ${here.bottom - cell.repoBox.bottom}px，清单没吃到竖向空间`);
  if (cell.listScroll && cell.listScroll.sw > cell.listScroll.cw + 1) failures.push(`清单横向溢出 ${cell.listScroll.sw - cell.listScroll.cw}px：文件名不许把这一格撑宽`);
  await shot(page, 'git-repo.png');

  // ---------- 状态三：点一条非仓库的行 → 信息卡 + 仓库根目录清单 ----------
  if (plainRow) {
    const plainCalls = await clickRow(plainRow);
    const cardCell = JSON.parse(await evaluate(page, CELL));
    const card = JSON.parse(await evaluate(page, `(() => {
      const host = document.getElementById('git');
      const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
      const sec = document.querySelector('#shell > section[data-slot="${SLOT}"]');
      const secBox = box(sec);
      const inside = (n) => { const b = box(n); return Boolean(b && secBox) && b.x >= secBox.x - 1 && b.right <= secBox.right + 1 && b.bottom <= secBox.bottom + 1; };
      const sel = TB.app.state.project || {};
      const data = TB.git.data || {};
      const row = (data.rows || [])[0] || null;
      return JSON.stringify({
        focus: data.focus?.name ?? null,
        rows: (data.rows || []).length,
        rowRepo: row?.repo ?? null,
        rowHasPath: row ? 'path' in row : null,
        countLabel: host.querySelector('.gt-count')?.textContent || null,
        cardShown: Boolean(host.querySelector('.gt-card')),
        repoShown: Boolean(host.querySelector('.gt-repo')),
        why: host.querySelector('.gt-card-why')?.textContent || null,
        name: host.querySelector('.gt-card .gt-name')?.textContent || null,
        chip: host.querySelector('.gt-card .gt-chip')?.textContent || null,
        lines: [...host.querySelectorAll('.gt-card-line')].map((n) => [n.querySelector('.gt-card-label')?.textContent, n.querySelector('.gt-card-value')?.textContent]),
        emptyNote: host.querySelector('.gt-card .gt-note')?.textContent || null,
        rootsTitle: host.querySelector('.gt-roots-title')?.textContent || null,
        roots: [...host.querySelectorAll('.gt-root')].map((n) => n.textContent),
        rootsEmpty: host.querySelector('.gt-roots-empty')?.textContent || null,
        ops: host.querySelectorAll('.gt-op').length,
        files: host.querySelectorAll('.gt-file').length,
        selIde: sel.ideLabel || sel.ide || null,
        selWhy: sel.why || null,
        selPath: sel.path || null,
        selRoot: sel.root || null,
        projRoots: (TB.projects?.data?.roots || []).slice(),
        cardInside: inside(host.querySelector('.gt-card')),
        rootsInside: inside(host.querySelector('.gt-roots')),
        secClip: Math.round(sec.scrollHeight - sec.getBoundingClientRect().height),
        hostClip: Math.round(host.scrollHeight - host.getBoundingClientRect().height),
        cardFont: (() => { const n = host.querySelector('.gt-card-value'); return n ? Math.round(parseFloat(getComputedStyle(n).fontSize) * 10) / 10 : null; })()
      });
    })()`));
    console.log(`点非仓库「${plainRow.name}」=> 计数牌「${card.countLabel}」，卡上 ${card.lines.length} 行 ${JSON.stringify(card.lines.map((l) => l[0]))}，根目录 ${card.roots.length} 处「${card.rootsTitle}」，动作 ${card.ops} 个，status ${plainCalls.length} 次`);
    console.log(`  卡 ${JSON.stringify(cardCell.cardBox)} / 根目录栏 ${JSON.stringify(cardCell.rootsBox)} / 格子 ${JSON.stringify(cardCell.cells?.[SLOT])}`);
    if (!card.cardShown || card.repoShown) failures.push(`非仓库那一条没换成信息卡（card=${card.cardShown} repo=${card.repoShown}）`);
    if (card.countLabel !== '非仓库') failures.push(`非仓库时计数牌写的是「${card.countLabel}」，应为「非仓库」`);
    if (card.name !== plainRow.name) failures.push(`卡顶上是「${card.name}」，点的是「${plainRow.name}」`);
    if (card.chip !== '非仓库') failures.push(`卡上的徽章写的是「${card.chip}」`);
    if (card.focus !== plainRow.name) failures.push(`git 那份 focus 是「${card.focus}」，点的是「${plainRow.name}」`);
    if (card.rowRepo !== false) failures.push(`git 那份说这一条 repo=${JSON.stringify(card.rowRepo)}：项目格认它是非仓库，git 却去问了`);
    if (card.rows !== 1) failures.push(`非仓库那一态 rows=${card.rows}`);
    if (card.rowHasPath) failures.push('git 那份行数据里出现了 path：卡上的路径只能抄 TB.app.state.project');
    if (plainCalls.length > 1) failures.push(`点一条非仓库发了 ${plainCalls.length} 次 status：一次点一下只问一个项目`);
    if (card.ops) failures.push(`非仓库还挂着 ${card.ops} 个动作按钮：这一格对它没有可做的 git 操作`);
    if (card.files) failures.push(`非仓库还列了 ${card.files} 条改动文件：没有 .git 就没有「什么还没交出去」`);
    if (!/\.git/.test(card.why || '')) failures.push(`卡上没说清为什么没有仓库信息：${JSON.stringify(card.why)}`);
    // 五句话：该用哪个 IDE / 按哪条判的 / 上次动过 / 这个文件夹 / 来自根目录——都是项目格那行本来就有的话
    const labels = card.lines.map((l) => l[0]).join(',');
    if (labels !== '该用的 IDE,按哪条判的,上次动过,这个文件夹,来自根目录') failures.push(`卡上那五行不对：${labels}`);
    const value = (label) => (card.lines.find((l) => l[0] === label) || [])[1];
    if (!card.selIde || !String(value('该用的 IDE')).startsWith(card.selIde)) failures.push(`「该用的 IDE」和项目格判出来的不一致：卡上「${value('该用的 IDE')}」，项目行「${card.selIde}」`);
    if (value('按哪条判的') !== card.selWhy) failures.push(`「按哪条判的」不是项目行那句 why：卡上「${value('按哪条判的')}」，项目行「${card.selWhy}」`);
    if (value('这个文件夹') !== card.selPath) failures.push(`「这个文件夹」不是项目行那个目录：卡上「${value('这个文件夹')}」，项目行「${card.selPath}」`);
    if (value('来自根目录') !== card.selRoot) failures.push(`「来自根目录」和项目行的 root 不一致：卡上「${value('来自根目录')}」，项目行「${card.selRoot}」`);
    // 根目录清单：数一下有几处、逐字和 projects 那一份比
    if (!card.roots.length && !card.rootsEmpty) failures.push('一处根目录都没配，却没说去哪儿加');
    if (card.roots.length && JSON.stringify(card.roots) !== JSON.stringify(card.projRoots)) failures.push(`卡上列的根目录和 projects 那份不是一份：${JSON.stringify([card.roots, card.projRoots])}`);
    if (card.rootsTitle && !/仓库根目录/.test(card.rootsTitle)) failures.push(`根目录那一栏的标题不是这句话：${JSON.stringify(card.rootsTitle)}`);
    if (card.emptyNote && !/空文件夹/.test(card.emptyNote)) failures.push(`空文件夹那句话写歪了：${JSON.stringify(card.emptyNote)}`);
    if (!card.cardInside) failures.push('信息卡超出格子（这一整块的上半部分装不下它）');
    if (!card.rootsInside) failures.push('根目录那一栏被裁到格子外面：这一整块下半部分本来是空的，装得下');
    if (card.hostClip > 1 || card.secClip > 1) failures.push(`信息卡那态内容超了格子：#git ${card.hostClip}px、格子 ${card.secClip}px`);
    if (card.cardFont !== null && card.cardFont < 13) failures.push(`卡上的值 ${card.cardFont}px，低于 13px：这些字是给人对着看的`);
    await shot(page, 'git-card.png');
  } else {
    console.log('（这批项目里没有非仓库的目录，信息卡那一态没处验——离线自检 tools/git-check.js 里那条仍然钉着）');
  }

  // ---------- 再点回仓库：视图跟着换回去，且不因为「刚看过」而停在旧数字上 ----------
  const backCalls = await clickRow(repoRow);
  const back = JSON.parse(await evaluate(page, `JSON.stringify({ name: document.querySelector('#git .gt-repo .gt-name')?.textContent ?? null, focus: TB.git.data?.focus?.name ?? null, cached: TB.git.data?.cached ?? null, card: Boolean(document.querySelector('#git .gt-card')), repo: Boolean(document.querySelector('#git .gt-repo')) })`));
  console.log(`点回「${repoRow.name}」=> 块顶「${back.name}」/ focus「${back.focus}」cached=${back.cached}，卡 ${back.card ? '还在' : '没了'}，status ${backCalls.length} 次`);
  if (back.name !== repoRow.name || back.focus !== repoRow.name) failures.push(`点回去以后这一格还停在「${back.focus || back.name}」：视图没跟着选中走`);
  if (back.card) failures.push('切回仓库了，信息卡还挂着');
  if (!back.repo) failures.push('切回仓库却没有仓库块');
  if (backCalls.length > 1) failures.push(`点回去发了 ${backCalls.length} 次 status：一次点一下只读一个仓库`);
  // 空转 3 秒：这一格不许自己起进程（20 秒那条缓存只在选中项变了和点刷新时才作废）
  await drain();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const idleAfter = await drain();
  if (idleAfter.length) failures.push(`选中不动的这 3 秒里发了 ${idleAfter.length} 次 git.status：这一格没有自己的轮询，也不该有`);
  console.log(`空转 3 秒（选中不变）=> git.status ${idleAfter.length} 次`);

  // ---------- 干跑：真点 DOM，TB.api.git 整个换成只记账的替身 ----------
  const dry = JSON.parse(await evaluate(page, `(async () => {
    const original = TB.__origApi;
    const current = TB.api;
    const calls = [];
    // deskToolbar 是 contextBridge 造的，属性只读且不可配置，Proxy 拦不住（会直接抛）。
    // 所以把键浅拷成一份普通对象，只换掉 git 这一层；status 继续走真的（只读，不动任何东西）。
    const wrap = (git) => { const copy = {}; for (const key of Object.keys(original)) copy[key] = original[key]; copy.git = git; return copy; };
    const LABEL = { fetch: '抓取', pull: '拉取', commit: '提交', push: '推送' };
    let nonceSeq = 0;
    const stub = (expiresMs) => ({
      status: (force, id) => original.git.status(force, id),
      prepare: (id, op, extra) => {
        calls.push({ m: 'prepare', id, op, extra });
        nonceSeq += 1;
        return Promise.resolve({
          ok: true,
          op,
          label: LABEL[op] || op,
          name: '干跑仓库',
          nonce: 'dryrun' + nonceSeq + 'abcdefghij',
          expiresMs,
          lines: ['这一步会动到什么（干跑编的两句）', '已跟踪 1 个（提交会带走）· 未跟踪 0 个（提交不带）']
        });
      },
      confirm: (nonce) => { calls.push({ m: 'confirm', nonce }); return Promise.resolve({ ok: true, op: 'commit', name: '干跑仓库', output: '干跑：什么都没跑' }); },
      cancel: (nonce) => { calls.push({ m: 'cancel', nonce }); return Promise.resolve({ ok: true, canceled: true }); },
      openFile: (id, index) => { calls.push({ m: 'openFile', id, index }); return Promise.resolve({ ok: true, file: 'src/干跑.js', ideLabel: 'WebStorm' }); }
    });
    TB.api = wrap(stub(5000));

    const host = document.getElementById('git');
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const read = () => ({
      ask: host.querySelectorAll('.gt-ask').length,
      yes: host.querySelector('.gt-ask .gt-yes')?.textContent || null,
      who: host.querySelector('.gt-ask-who')?.textContent || null,
      lines: [...host.querySelectorAll('.gt-ask-line')].map((n) => n.textContent),
      // 确认条上那几句话是全格这 5 秒最该看清的字，字号单独钉一条下限
      lineFont: ((n) => (n ? Math.round(parseFloat(getComputedStyle(n).fontSize) * 10) / 10 : null))(host.querySelector('.gt-ask-line')),
      yesFont: ((n) => (n ? Math.round(parseFloat(getComputedStyle(n).fontSize) * 10) / 10 : null))(host.querySelector('.gt-ask .gt-yes')),
      files: host.querySelectorAll('.gt-file').length,
      ops: host.querySelectorAll('.gt-op').length,
      toast: [...document.querySelectorAll('#toast .toast')].map((n) => n.textContent).slice(-1)[0] || null
    });
    // 每一步都重新查节点：组件每次 renderList 都整段重建，握着旧引用点下去点到的是幽灵
    const opBtn = (which) => {
      const btn = [...host.querySelectorAll('.gt-op')][which];
      if (!btn) throw new Error('动作按钮没长出来（当前这一条不是仓库？这一段的前提是选中停在一条仓库上）');
      return { btn, rowId: TB.git.data.rows[0].id };
    };
    const msgBox = () => {
      const n = host.querySelector('.gt-msg');
      if (!n) throw new Error('说明框没长出来');
      return n;
    };

    const before = read();

    // 1) 空说明点「提交」：该被渲染层自己拦下，一次 IPC 都不发
    const first = opBtn(2);
    msgBox().value = '';
    TB.git.message = '';
    const callsAtEmpty = calls.length;
    first.btn.click();
    await sleep(250);
    const emptyToast = read();
    const callsAfterEmpty = calls.length;

    // 2) 写一句说明点「提交」：只发 prepare，确认条挂出来（整格只剩这一步）
    const second = opBtn(2);
    const input = msgBox();
    input.value = '探针写的说明';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    second.btn.click();
    await sleep(250);
    const bar = read();
    const barNode = host.querySelector('.gt-ask');
    const secBox = document.querySelector('#shell > section[data-slot="${SLOT}"]').getBoundingClientRect();
    const barRect = barNode ? barNode.getBoundingClientRect() : null;
    const barTop = barRect ? {
      x: Math.round(barRect.left), right: Math.round(barRect.right), y: Math.round(barRect.top), bottom: Math.round(barRect.bottom),
      cellX: Math.round(secBox.left), cellRight: Math.round(secBox.right), cellBottom: Math.round(secBox.bottom)
    } : null;

    // 3) 倒计时自己走
    await sleep(1300);
    const ticked = read();

    // 4) 点「确认」：只递 nonce，一个参数
    host.querySelector('.gt-ask .gt-yes').click();
    await sleep(600);
    const afterConfirm = read();

    // 5) 再来一条，点「取消」
    opBtn(0).btn.click();
    await sleep(250);
    host.querySelector('.gt-ask .gt-no').click();
    await sleep(200);
    const afterCancel = read();

    // 6) 过期：把 expiresMs 换成 1.2 秒，等它自己作废
    TB.api = wrap(stub(1200));
    opBtn(0).btn.click();
    await sleep(400);
    const expEarly = read();
    await sleep(1800);
    const expLate = read();

    // 7) 点一个改动文件：只递 (id, 序号)
    TB.api = wrap(stub(5000));
    const fileNode = host.querySelector('.gt-file');
    fileNode?.click();
    await sleep(250);
    const fileToast = read();

    // 8) 确认条挂着的时候换项目：那一步该连同主进程的 nonce 一起作废，不许留「看不见但还能跑」
    opBtn(0).btn.click();
    await sleep(250);
    const askBeforeSwitch = read();
    const other = [...document.querySelectorAll('#projects .pj-item')].find((n) => Number(n.dataset.id) !== Number(TB.app.state.project?.id));
    other?.click();
    await sleep(500);
    const afterSwitch = read();
    const switchedTo = TB.app.state.project?.name || null;

    TB.api = current;
    return JSON.stringify({
      calls,
      callsAtEmpty,
      callsAfterEmpty,
      before,
      emptyToast,
      bar,
      barTop,
      ticked,
      afterConfirm,
      afterCancel,
      expEarly,
      expLate,
      fileToast,
      hadFile: Boolean(fileNode),
      wantId: second.rowId,
      askBeforeSwitch,
      afterSwitch,
      switchedTo,
      switchFound: Boolean(other)
    });
  })()`, 120000));
  console.log(`干跑记账 => ${JSON.stringify(dry.calls.map((c) => ({ ...c, nonce: c.nonce ? `${c.nonce.slice(0, 6)}…` : undefined })))}`);
  console.log(`空说明点提交 => 提示「${dry.emptyToast.toast}」，IPC ${dry.callsAfterEmpty > dry.callsAtEmpty ? '发了' : '没发'}`);
  console.log(`确认条 => 「${dry.bar.who}」 ${JSON.stringify(dry.bar.lines)}，按钮「${dry.bar.yes}」→「${dry.ticked.yes}」`);
  console.log(`过期 => 0.4s 时 ${dry.expEarly.ask} 条 / 2.0s 时 ${dry.expLate.ask} 条，提示「${dry.expLate.toast}」`);
  console.log(`确认条挂着时换项目 => 之前 ${dry.askBeforeSwitch.ask} 条，之后 ${dry.afterSwitch.ask} 条（切到「${dry.switchedTo}」）`);

  const prepareCalls = dry.calls.filter((c) => c.m === 'prepare');
  const confirmCalls = dry.calls.filter((c) => c.m === 'confirm');
  const cancelCalls = dry.calls.filter((c) => c.m === 'cancel');
  const openCalls = dry.calls.filter((c) => c.m === 'openFile');

  if (dry.before.ask) failures.push('一点开就挂着确认条');
  if (dry.before.ops !== 4) failures.push(`当前这一条的动作行是 ${dry.before.ops} 个：干跑这一段的前提是选中停在一条仓库上`);
  if (dry.emptyToast.ask) failures.push('空说明那次也长出了确认条');
  if (!/提交说明/.test(dry.emptyToast.toast || '')) failures.push(`空说明点提交没拦住并说明原因：${JSON.stringify(dry.emptyToast.toast)}`);
  if (dry.callsAfterEmpty !== dry.callsAtEmpty) failures.push('空说明那次也发了 IPC');
  if (!prepareCalls.length) failures.push('点「提交」没发 prepare（写侧两步的第一步根本没走）');
  const commitCall = prepareCalls.find((c) => c.op === 'commit');
  if (!commitCall || commitCall.id !== dry.wantId) failures.push(`prepare 的行 id 不是当前这一条：${JSON.stringify(commitCall)} vs ${dry.wantId}`);
  if (commitCall?.extra?.message !== '探针写的说明') failures.push(`说明没原样递过去：${JSON.stringify(commitCall?.extra)}`);
  if (commitCall && JSON.stringify(commitCall).match(/[A-Za-z]:[\\\\/]/)) failures.push(`prepare 的参数里有绝对路径：${JSON.stringify(commitCall)}`);
  if (dry.bar.ask !== 1) failures.push(`点完提交确认条是 ${dry.bar.ask} 条（该恰好一条）`);
  // 这一格的新规矩：确认条挂出来的那 5 秒整格只渲染它——清单、动作行、说明框都得让位
  if (dry.bar.ops) failures.push(`确认条挂出来时还留着 ${dry.bar.ops} 个动作按钮：那一格应当只剩这一步`);
  if (dry.bar.files) failures.push(`确认条挂出来时清单里还留着 ${dry.bar.files} 条：那一格应当只剩这一步`);
  if (!/干跑仓库/.test(dry.bar.who || '') || !dry.bar.lines.length) failures.push(`确认条上没说清这一步动哪个仓库：${JSON.stringify(dry.bar)}`);
  if (dry.bar.lineFont !== null && dry.bar.lineFont < 13) failures.push(`确认条上「会动到什么」那句话 ${dry.bar.lineFont}px，低于 13px：这是决定按不按确认的字`);
  if (dry.bar.yesFont !== null && dry.bar.yesFont < 13) failures.push(`「确认」按钮 ${dry.bar.yesFont}px，低于 13px`);
  if (!/^确认 5s$/.test(dry.bar.yes || '')) failures.push(`确认按钮写的是「${dry.bar.yes}」，该从 5 秒起`);
  if (dry.ticked.yes === dry.bar.yes) failures.push(`等了一秒多，确认按钮还是「${dry.ticked.yes}」（倒计时没走，5 秒到点也不会自己作废）`);
  if (dry.barTop && (dry.barTop.bottom > dry.barTop.cellBottom + 1 || dry.barTop.right > dry.barTop.cellRight + 1)) {
    failures.push(`确认条被裁在格子外：${JSON.stringify(dry.barTop)}`);
  }
  if (confirmCalls.length !== 1) failures.push(`点一次确认发了 ${confirmCalls.length} 次 confirm`);
  if (confirmCalls.some((c) => Object.keys(c).filter((k) => k !== 'm' && k !== 'nonce').length)) failures.push('confirm 除了 nonce 还递了别的东西');
  if (confirmCalls.some((c) => !/^dryrun\d+abcdefghij$/.test(c.nonce || ''))) failures.push(`confirm 递的不是 prepare 回来的那条 nonce：${JSON.stringify(confirmCalls)}`);
  if (dry.afterConfirm.ask) failures.push('确认以后确认条还挂着');
  if (dry.afterConfirm.ops !== 4) failures.push(`确认以后动作行是 ${dry.afterConfirm.ops} 个（该回到那四个，不能停在那一句话上）`);
  if (!/干跑：什么都没跑/.test(dry.afterConfirm.toast || '')) failures.push(`确认以后没把结果说回来（toast）：${JSON.stringify(dry.afterConfirm.toast)}`);
  if (!cancelCalls.length) failures.push('点「取消」没发 cancel');
  if (dry.afterCancel.ask) failures.push('点了取消确认条还在');
  if (!dry.expEarly.ask) failures.push('过期那条根本没挂出确认条');
  if (dry.expLate.ask) failures.push('过期以后确认条还挂着（那一步随时还能被点到）');
  if (!/超时|重新点/.test(dry.expLate.toast || '')) failures.push(`过期没说一句：${JSON.stringify(dry.expLate.toast)}`);
  if (dry.hadFile && !openCalls.length) failures.push('点改动文件没发 openFile');
  if (openCalls.some((c) => typeof c.id !== 'number' || typeof c.index !== 'number')) failures.push(`openFile 递的不是 (id, 序号)：${JSON.stringify(openCalls)}`);
  if (openCalls.some((c) => /[A-Za-z]:[\\\\/]/.test(JSON.stringify(c)))) failures.push('openFile 递了路径');
  if (dry.askBeforeSwitch.ask !== 1) failures.push(`换项目前确认条该挂着，实测 ${dry.askBeforeSwitch.ask} 条：这一段前置没成立，后面两条判据都不算数`);
  if (dry.switchFound && dry.afterSwitch.ask) failures.push('换了项目确认条还挂着：那一步看不见却还能被点到');
  if (dry.switchFound && !cancelCalls.length) failures.push('换项目没把那条待确认的操作在主进程一起取消（没有 cancel 的记账）');

  // ---------- 真通道走一遍 prepare → 看确认条那几句话 → 取消 ----------
  // prepare 只读（一个写进程都不起，这一点由 tools/git-check.js 钉着），所以这一段走真 IPC 是安全的；
  // 「确认」那一下永远不点——看到确认条挂出来就点「取消」。
  const realRound = JSON.parse(await evaluate(page, `(async () => {
    const host = document.getElementById('git');
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // 上一段最后换了项目：先点回一条真仓库，再挑一条推得动的（有上游、不游离、有领先），确认条那句话才有内容可读
    const repoItem = (TB.projects?.data?.items || []).find((item) => item.git);
    const rowNode = document.querySelector('#projects .pj-item[data-id="' + (repoItem?.id ?? -1) + '"]');
    if (!repoItem || !rowNode) return JSON.stringify({ skipped: '项目格里没有一条真仓库' });
    rowNode.click();
    let row = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(200);
      row = TB.git.data?.rows?.[0] || null;
      if (TB.git.data?.focus?.id === repoItem.id && row?.repo && !row.error) break;
    }
    if (!row) return JSON.stringify({ skipped: '这一条没数据回来' });
    if (row.error) return JSON.stringify({ skipped: '这一条读不到：' + row.error });
    if (row.detached) return JSON.stringify({ skipped: '游离 HEAD：这一格不做切分支' });
    const which = row.upstream && row.ahead ? 3 : 0;
    const opName = which === 3 ? '推送' : '抓取';
    const toastBefore = document.querySelectorAll('#toast .toast').length;
    [...host.querySelectorAll('.gt-op')][which].click();
    await sleep(800);
    const bar = {
      ask: host.querySelectorAll('.gt-ask').length,
      who: host.querySelector('.gt-ask-who')?.textContent || null,
      lines: [...host.querySelectorAll('.gt-ask-line')].map((n) => n.textContent),
      yes: host.querySelector('.gt-ask .gt-yes')?.textContent || null
    };
    const toasts = [...document.querySelectorAll('#toast .toast')].slice(toastBefore).map((n) => n.textContent);
    const shown = host.querySelector('.gt-ask');
    let insideCell = null;
    if (shown) {
      const cellBox = document.querySelector('#shell > section[data-slot="${SLOT}"]').getBoundingClientRect();
      const b = shown.getBoundingClientRect();
      insideCell = b.bottom <= cellBox.bottom + 1 && b.top >= cellBox.top - 1;
    }
    host.querySelector('.gt-ask .gt-no')?.click();
    await sleep(300);
    return JSON.stringify({ opName, row: row.name, bar, toasts, insideCell, gone: host.querySelectorAll('.gt-ask').length, ops: host.querySelectorAll('.gt-op').length });
  })()`, 90000));
  console.log(`真通道 prepare「${realRound.opName}」于「${realRound.row}」=> ${JSON.stringify(realRound.bar?.lines)}（${realRound.bar?.yes}）/ 提示 ${JSON.stringify(realRound.toasts)}${realRound.skipped ? ` / 跳过：${realRound.skipped}` : ''}`);
  if (!realRound.skipped) {
    if (realRound.bar.ask !== 1 && !realRound.toasts.length) failures.push('点动作按钮既没挂出确认条，也没给一句为什么');
    if (realRound.bar.ask) {
      const joined = realRound.bar.lines.join(' ');
      if (/[A-Za-z]:[\\/]/.test(joined)) failures.push(`确认条那几句话里漏了绝对路径：${joined}`);
      if (/^(fatal|error|warning):/i.test(joined)) failures.push(`确认条上是 git 的英文原话：${joined}`);
      if (realRound.opName === '推送' && !/别人看得见/.test(joined)) failures.push(`推送那条确认没写「别人看得见」：${joined}`);
      if (!/^确认 \d+s$/.test(realRound.bar.yes || '')) failures.push(`真确认条的按钮写的是「${realRound.bar.yes}」`);
      if (!realRound.insideCell) failures.push('真确认条挂到格子外面');
    }
    for (const text of realRound.toasts) {
      if (/[A-Za-z]:[\\/]/.test(text)) failures.push(`提示里漏了绝对路径：${text}`);
      if (/^(fatal|error|warning):/i.test(text)) failures.push(`提示是 git 的英文原话：${text}`);
    }
    if (realRound.gone) failures.push('点了「取消」确认条还挂着');
    if (realRound.ops !== 4) failures.push(`取消以后动作行是 ${realRound.ops} 个（该回到那四个）`);
  }

  // 确认条挂出来那一张：再走一次真 prepare（同样只读、同样不点「确认」），截完立刻取消。
  // 这一段专门给「确认条整格替换清单」那条形变留证据——它长什么样、两个按钮在不在格子内，看图最快。
  const barShot = JSON.parse(await evaluate(page, `(async () => {
    const host = document.getElementById('git');
    const row = TB.git.data?.rows?.[0];
    if (!row?.repo || row.error || row.detached) return JSON.stringify({ skipped: '当前这条不是可动的仓库' });
    [...host.querySelectorAll('.gt-op')][0].click();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const cellBox = document.querySelector('#shell > section[data-slot="${SLOT}"]').getBoundingClientRect();
    const bar = host.querySelector('.gt-ask');
    const got = { shown: Boolean(bar), filesLeft: host.querySelectorAll('.gt-file').length, opsLeft: host.querySelectorAll('.gt-op').length, repoLeft: host.querySelectorAll('.gt-repo').length };
    if (bar) {
      const b = bar.getBoundingClientRect();
      // 居中与否只跟清单那一段比（格子矩形还含头上那行「GIT / 刷新」，比它会差出一个行高）
      const lb = host.querySelector('.gt-list').getBoundingClientRect();
      got.box = { y: Math.round(b.top), h: Math.round(b.height), bottom: Math.round(b.bottom) };
      got.topGap = Math.round(b.top - lb.top);
      got.bottomGap = Math.round(lb.bottom - b.bottom);
      got.insideCell = b.bottom <= cellBox.bottom + 1 && b.top >= cellBox.top - 1;
    }
    return JSON.stringify(got);
  })()`, 60000));
  await shot(page, 'git-confirm.png');
  const barGone = JSON.parse(await evaluate(page, `(async () => {
    const host = document.getElementById('git');
    host.querySelector('.gt-ask .gt-no')?.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return JSON.stringify({ ask: host.querySelectorAll('.gt-ask').length, files: host.querySelectorAll('.gt-file').length, ops: host.querySelectorAll('.gt-op').length });
  })()`, 60000));
  console.log(`确认条镜头 => ${JSON.stringify(barShot)}，取消以后 ${JSON.stringify(barGone)}`);
  if (barShot.shown && !barShot.insideCell) failures.push(`确认条挂到格子外面：${JSON.stringify(barShot.box)}`);
  if (barShot.shown && (barShot.repoLeft || barShot.filesLeft || barShot.opsLeft))
    failures.push(`确认条挂出来时那一格不止这一步：还剩 ${barShot.repoLeft} 块详情 / ${barShot.filesLeft} 行清单 / ${barShot.opsLeft} 个动作按钮（设计是整格只渲染确认条）`);
  // 整格只剩这一条时它得站在中线上：贴顶挂会在下面留一大截空，看着像读到了但没东西（放大截图看到的）
  if (barShot.shown && Math.abs(barShot.topGap - barShot.bottomGap) > 12)
    failures.push(`确认条没站在这块的中间：上留 ${barShot.topGap}px、下留 ${barShot.bottomGap}px`);
  if (barGone.ask) failures.push('截图那一步点了「取消」确认条还挂着');
  if (barGone.ops !== 4) failures.push(`取消以后动作按钮是 ${barGone.ops} 个（该回到那四个）`);

  // ---------- 刷新按钮：真发 IPC（只读），且带着当前这一条的 id ----------
  await drain();
  const refresh = JSON.parse(await evaluate(page, `(async () => {
    const host = document.getElementById('git');
    const wantId = TB.app.state.project?.id ?? null;
    document.querySelector('#git .gt-head .link-btn').click();
    const during = host.querySelector('.gt-count')?.textContent;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return JSON.stringify({
      during,
      after: host.querySelector('.gt-count')?.textContent,
      name: host.querySelector('.gt-name')?.textContent || null,
      wantId,
      focus: TB.git.data?.focus?.id ?? null,
      rows: (TB.git.data?.rows || []).length,
      log: TB.__statusLog.slice()
    });
  })()`, 60000));
  console.log(`点「刷新」=> 过程中「${refresh.during}」，之后「${refresh.after}」/「${refresh.name}」，账本 ${JSON.stringify(refresh.log)}`);
  if (refresh.during !== '刷新中…') failures.push(`刷新过程中没有「刷新中…」反馈，而是「${refresh.during}」`);
  if (!refresh.rows) failures.push('刷新以后这一格没有行了（当前是仓库态，该还有一个仓库的一条行）');
  if (!refresh.log.length) failures.push('点「刷新」没发 git.status');
  if (refresh.log.some((c) => c.force !== true)) failures.push(`点刷新却没带 force：${JSON.stringify(refresh.log)}`);
  if (refresh.log.some((c) => c.id !== refresh.wantId)) failures.push(`刷新递的 id 不是当前选中那条：${JSON.stringify(refresh.log)} vs ${refresh.wantId}`);

  // ---------- 旁证：每个仓库的 HEAD 与 reflog 顶端一格没变 ----------
  const headsAfter = heads(dirs);
  const moved = Object.keys(headsAfter).filter((name) => JSON.stringify(headsAfter[name]) !== JSON.stringify(headsBefore[name]));
  if (moved.length) {
    for (const name of moved) console.log(`  ${name}：${JSON.stringify(headsBefore[name])} → ${JSON.stringify(headsAfter[name])}`);
    failures.push(`${moved.length} 个仓库的 HEAD/reflog 在这趟探针里变了（${moved.join('、')}）——写侧漏出去了，或者是他这期间真提交过，请手工确认`);
  } else {
    console.log(`旁证：${dirs.length} 个仓库的 HEAD 与 reflog 顶端逐字没变（干跑那一段 confirm 只拿到替身的 nonce，真通道只走到 prepare）`);
  }

  // ---------- 收尾：把自己动过的状态还回去 ----------
  const restored = JSON.parse(await evaluate(page, `(() => {
    const host = document.getElementById('git');
    TB.git.stopAsk();
    TB.app.selectProject(TB.__savedSel || null);
    const apiBack = Boolean(TB.api && TB.__origApi && Object.keys(TB.__origApi).join(',') === Object.keys(TB.api).join(','));
    return JSON.stringify({ ask: host.querySelectorAll('.gt-ask').length, sel: TB.app.state.project?.name || null, apiBack });
  })()`));
  console.log(`收尾：确认条 ${restored.ask} 条，选中还回「${restored.sel || '（跑之前本来就没选）'}」，TB.api 键集合还原 ${restored.apiBack}`);
  if (restored.ask) failures.push('收尾以后还挂着确认条');
  if (!restored.apiBack) failures.push('TB.api 没还原成原来那份（替身还挂着，下一趟探针量的是假通道）');
  await shot(page, 'git-panel.png');

  try {
    await evaluate(page, `TB.app.setPage(${JSON.stringify(originalPage)});'ok'`);
    const back2 = JSON.parse(await evaluateReady(page, `JSON.stringify({ page: TB.app.state.page })`)).page;
    if (back2 !== originalPage) failures.push(`收尾没切回 "${originalPage}"，还留在 "${back2}"（桌面也一并留在第 2 个）`);
    console.log(`收尾：从 "${PAGE_ID}" 切回面板 "${back2}"（跑之前他在 "${originalPage}"）`);
  } catch (error) {
    failures.push(`切回 "${originalPage}" 失败：${error.message}`);
  }

  if (failures.length) {
    for (const line of failures) console.log(`✗ ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ git 格子全绿：${SLOT} ${here?.w}x${here?.h}，和左列 projzone 同顶同底同高，宽度等于中间那一列；三态各就各位且都在格子内；`);
  console.log(`  默认态一句话 + 3 秒空转一条 IPC 都不发；点「${repoRow.name}」右边就换到那个仓库，点过去点回来都跟着换；`);
  console.log('  非仓库那条换成项目信息卡 + 仓库根目录清单，卡上五句话逐字抄自项目格那行；跨 IPC 除 root 没有盘符路径；');
  console.log('  写侧全程干跑（confirm 只拿 nonce、openFile 只拿序号、换项目把待确认那条一起取消），真通道只走到 prepare 就取消；');
  console.log(`  ${dirs.length} 个仓库的 HEAD 与 reflog 一格没动。`);
}

main().catch((error) => {
  console.error(`[git-appprobe] 失败：${error.message}`);
  process.exitCode = 1;
});
