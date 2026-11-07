// 面板 ↔ 虚拟桌面的真机验证：附着到真实运行的工具栏（需带 --remote-debugging-port 启动），
// 一边点顶栏页签、一边读「看护此刻看到的真实桌面」，两边对得上才算通。
//
// 它盯的是这几条：
// 1) 顶栏页签顺序是他点名的 主界面 / 生活 / 工作 / 游戏，且后三个在 layout 里绑了桌面 1/2/3；
// 2) 点绑了桌面的页签 → 真实活动桌面跟着跳过去；
// 3) 点「主界面」（没绑）→ 桌面原地不动，不许被切回第 1 个；
// 4) 反过来：外部切桌面（模拟他自己按 Win+Ctrl+←/→）→ 面板跟着换成绑在那个桌面上的；
// 5) 换完不反弹：桌面和面板都停在原位，不许出现「面板把桌面又切回去」的乒乓；
// 6) 全程只在已有桌面里跳，绝不创建；结束时把你原来待的那个桌面还给你。
//
// 为什么轮询只读应用自己的 vdesk:status，而不是每次都起一个 powershell 去读桌面：
// 命令行进程属于它自己那个桌面，每 200ms 起一个会把前台拽回去，等于探针自己把要测的
// 东西改掉了。独立校验只在每步结束时做一次（一次进程、一次读）。
//
// 用法（Git Bash）:
//   1) ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
//   2) node tools/desktop-appprobe.js [端口]
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || 9223);
// 助手 800ms 一轮，切桌面是一次性子进程（powershell 冷启动几百 ms）：
// 200ms 一跳、最多 10 秒，真没动才算失败
const SETTLE_MS = 10000;

const failures = [];
const expect = (label, cond) => {
  if (!cond) failures.push(label);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

function runPs(script, args) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(APP_ROOT, 'tools', script), ...args], { windowsHide: true }, (err, stdout) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout).trim().split(/\r?\n/)[0] || '' });
    });
  });
}

// 独立的一次读桌面（0-based index + 总数）
async function realDesktop() {
  const { out } = await runPs('vdesktop-check.ps1', ['-Current']);
  const index = Number.parseInt(/index=(-?\d+)/.exec(out)?.[1] ?? '', 10);
  const count = Number.parseInt(/count=(\d+)/.exec(out)?.[1] ?? '', 10);
  return { index: Number.isInteger(index) ? index : null, count: Number.isInteger(count) ? count : null, raw: out };
}

const realSwitch = (index) => runPs('vdesktop-switch.ps1', ['-Index', String(index)]);

function evaluate(target, expression, timeoutMs = 20000) {
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('CDP 超时'));
    }, timeoutMs);
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

// 重建窗口会让 CDP target 换人，所以每次都重新列一遍
async function app(expression, tries = 25) {
  let last = '没有可用的工具栏页面';
  for (let i = 0; i < tries; i += 1) {
    try {
      const targets = (await getJson(`http://127.0.0.1:${PORT}/json`)).filter((t) => t.type === 'page' && /renderer\/index\.html/.test(t.url));
      if (!targets.length) throw new Error('工具栏页面还没起来');
      const value = await evaluate(targets[0], expression);
      if (value !== undefined && value !== null) return value;
      last = '渲染层返回为空（还没 boot 完）';
    } catch (error) {
      last = error.message;
    }
    await sleep(400);
  }
  throw new Error(`连着 ${tries} 轮拿不到结果：${last}`);
}

const STATE = `(async () => JSON.stringify({
  active: TB.app.state.page,
  tabs: [...document.querySelectorAll('.page-tabs .page-tab')].map((node) => node.textContent),
  bindings: TB.app.state.grid.pages.map((item) => ({ id: item.id, desktop: item.desktop ?? null })),
  vdesk: await TB.api.vdesk.status()
}))()`;

const read = async () => JSON.parse(await app(STATE));

// 等「渲染层面板 === wantPage（传 null 表示不看）且看护读到的桌面 === wantDesk」
async function settle(wantPage, wantDesk) {
  const deadline = Date.now() + SETTLE_MS;
  let seen = null;
  while (Date.now() < deadline) {
    seen = await read();
    const desk = seen.vdesk?.desktopIndex;
    if ((wantPage === null || seen.active === wantPage) && desk === wantDesk) return seen;
    await sleep(200);
  }
  return seen;
}

async function main() {
  const before = await realDesktop();
  expect(`读不到真实桌面（${before.raw || '无输出'}），后面的断言都无从比对`, before.index !== null);
  if (before.index === null) return report();

  const snap0 = await read();
  console.log(`· 起始：真实桌面=第 ${before.index + 1} 个 / 共 ${before.count} 个，看护=第 ${(snap0.vdesk?.desktopIndex ?? -1) + 1} 个`);
  expect(`看护还没读到桌面（status=${JSON.stringify(snap0.vdesk)}）`, Number.isInteger(snap0.vdesk?.desktopIndex));

  // ---------- 1. 页签顺序与绑定 ----------
  expect(`顶栏页签顺序是 ${JSON.stringify(snap0.tabs)}，该是 ["主界面","生活面板","工作面板","游戏面板"]`,
    JSON.stringify(snap0.tabs) === JSON.stringify(['主界面', '生活面板', '工作面板', '游戏面板']));
  expect(`渲染层看到的绑定是 ${JSON.stringify(snap0.bindings)}，该是 home 不绑 + life1/work2/game3`,
    JSON.stringify(snap0.bindings) === JSON.stringify([
      { id: 'home', desktop: null },
      { id: 'life', desktop: 1 },
      { id: 'work', desktop: 2 },
      { id: 'game', desktop: 3 }
    ]));
  expect(`主进程给的绑定和渲染层不一致：${JSON.stringify(snap0.vdesk?.bindings)}`, JSON.stringify(snap0.vdesk?.bindings) === JSON.stringify(snap0.bindings));

  // 桌面上数不够时后面几步没法比，直接说明而不是误报
  const needed = Math.max(...snap0.bindings.map((p) => p.desktop || 0)) - 1;
  expect(`这台机器只有 ${before.count} 个桌面，验证需要至少 ${needed + 1} 个（先手动多开一个再跑）`, before.count > needed);
  if (before.count <= needed) return report();

  // ---------- 2. 点「游戏面板」→ 真实跳到第 3 个桌面 ----------
  await app(`document.querySelector('.page-tab[data-page="game"]').click(); 'ok'`);
  const afterGame = await settle('game', 2);
  expect(`点「游戏面板」后渲染层停在 "${afterGame.active}"（该是 game）`, afterGame.active === 'game');
  expect(`点「游戏面板」后看护读到第 ${(afterGame.vdesk?.desktopIndex ?? -1) + 1} 个桌面（该是第 3 个）`, afterGame.vdesk?.desktopIndex === 2);
  const truth1 = await realDesktop();
  expect(`独立复核：真实桌面是第 ${(truth1.index ?? -1) + 1} 个（该是第 3 个），和看护不一致`, truth1.index === 2);

  // ---------- 3. 点「主界面」→ 桌面原地不动 ----------
  await app(`document.querySelector('.page-tab[data-page="home"]').click(); 'ok'`);
  const afterHome = await settle('home', 2);
  expect(`点「主界面」后渲染层停在 "${afterHome.active}"（该是 home）`, afterHome.active === 'home');
  expect(`「主界面」没绑桌面，看护却读到第 ${(afterHome.vdesk?.desktopIndex ?? -1) + 1} 个（该原地停在第 3 个）`, afterHome.vdesk?.desktopIndex === 2);

  // ---------- 4. 外部切桌面 → 面板反过来跟着换 ----------
  const external = await realSwitch(1);
  expect(`外部切到第 2 个桌面失败：${external.out || `exit=${external.code}`}`, external.code === 0);
  const afterDesk = await settle('work', 1);
  expect(`外部把桌面切到第 2 个后，面板停在 "${afterDesk.active}"（该是绑在这个桌面上的 work）`, afterDesk.active === 'work');
  expect(`外部切桌面后看护读到第 ${(afterDesk.vdesk?.desktopIndex ?? -1) + 1} 个（该是第 2 个）`, afterDesk.vdesk?.desktopIndex === 1);

  // ---------- 5. 反弹检查：面板跟过去之后不许再把桌面切走 ----------
  await sleep(2500);
  const quiet = await read();
  expect(`跟过去 2.5 秒后面板变成了 "${quiet.active}"，说明两边在打乒乓`, quiet.active === 'work');
  expect(`跟过去 2.5 秒后看护读到第 ${(quiet.vdesk?.desktopIndex ?? -1) + 1} 个桌面，说明面板把桌面又切回去了`, quiet.vdesk?.desktopIndex === 1);
  expect(`反弹检查时主进程还挂着待确认的桌面记号（pendingDesktop=${JSON.stringify(quiet.vdesk?.pendingDesktop)}）`, quiet.vdesk?.pendingDesktop === null);

  // ---------- 6. 还给他 ----------
  await realSwitch(before.index);
  await settle(null, before.index);
  const back = await realDesktop();
  expect(`结束时没回到你原来那个桌面（现在第 ${(back.index ?? -1) + 1} 个，原本第 ${before.index + 1} 个）`, back.index === before.index);
  report();
}

function report() {
  if (failures.length) {
    for (const line of failures) console.log(`✗ ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log('✓ 面板↔桌面真机全绿：页签顺序与 1/2/3 绑定、点页签跳桌面、点主界面不动桌面、外部切桌面面板跟着换、跟过去不反弹、结束还原原桌面');
}

main().catch((error) => {
  console.log(`✗ 探针跑不动：${error.message}`);
  process.exitCode = 1;
});
