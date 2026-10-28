// 顶栏搜索栏的真机验证：附着到真实运行的工具栏（需带 --remote-debugging-port 启动），
// 用 CDP 走一遍 常驻输入框→聚焦展开下拉→查询→渲染→键盘选择→打开守门→Ctrl+F→Esc→点外面，
// 最后再验一遍 config.search.enabled 这个开关（关掉→搜索栏消失、Ctrl+F 失效→恢复原值）。
// 全程只发查询、不调 choose()：真打开文件会拉起源程序，这里只要验到"路径能取到、守门有效"。
// 用法（Git Bash）:
//   1) ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
//   2) node tools/search-appprobe.js [端口] [--shot]
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
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true }
      }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result?.result?.value);
    });
    ws.on('error', reject);
  });
}

async function capture(target, file) {
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

// config.search.enabled 这个开关是不是真的管用：关掉 → 顶栏整条搜索栏不渲染、
// TB.search 交出输入框、Ctrl+F 与 focus() 都成空操作 → 再把原值写回去。
// 走的是用户路径（config.save → applyConfigResult → buildShell），会重建整个界面，所以放在最后跑。
// 中间那步会真的改 toolbar.config.json；万一进程被杀在这里，把 search.enabled 手动改回 true 即可。
async function verifyGate(page) {
  const snapshot = JSON.parse(
    await evaluate(page, 'JSON.stringify({ enabled: TB.app.state.config?.search?.enabled !== false })', 30000)
  );
  if (!snapshot.enabled) {
    console.log('gate: 跳过——配置里 search.enabled 本来就是关的');
    return null;
  }
  const expression = `(async () => {
  const out = {};
  const panel = document.getElementById('search-panel');
  const apply = async (enabled) => {
    const result = await TB.api.config.save({ search: { enabled } });
    TB.app.applyConfigResult(result);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  };
  try {
    await apply(false);
    out.disabled = TB.app.state.config?.search?.enabled === false;
    out.barGone = !document.querySelector('.topbar .search-bar');
    out.badgeGone = !document.querySelector('#search-badge');
    out.detached = !TB.search.input;
    TB.search.close();
    document.body.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    out.ctrlFNoop = panel.classList.contains('hidden') && !TB.search.opened;
    TB.search.focus();
    out.focusNoop = !TB.search.opened;
  } finally {
    await apply(true);
  }
  out.restored = TB.app.state.config?.search?.enabled !== false;
  out.barBack = Boolean(document.querySelector('.search-bar #search-input'));
  out.badgeBack = Boolean(document.querySelector('.search-bar #search-badge'));
  out.reattached = TB.search.input === document.getElementById('search-input');
  return JSON.stringify(out);
})()`;
  return JSON.parse(await evaluate(page, expression, 60000));
}

function buildExpression() {
  return `(async () => {
  const out = {};
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const panel = document.getElementById('search-panel');

  // 常驻搜索栏：输入框在顶栏里，不再有「搜索」按钮
  out.hasBar = Boolean(document.querySelector('.topbar .search-bar'));
  out.hasInput = Boolean(document.getElementById('search-input'));
  out.badgeInBar = Boolean(document.querySelector('.search-bar #search-badge'));
  out.buttonGone = !document.getElementById('btn-search');
  out.placeholder = document.getElementById('search-input')?.placeholder || null;
  out.attached = TB.search.input === document.getElementById('search-input');

  // 归零：上一轮跑挂可能把面板、待发查询和结果列表留在脏状态
  // （直连内部字段是有意的——这里要的是"从零开始"，不是走用户路径）
  TB.search.close();
  TB.search.inflight = false;
  TB.search.trailing = null;
  TB.search.items = [];
  TB.search.listId = null;
  TB.search.query = '';
  out.closedAtStart = panel.classList.contains('hidden');

  // 状态桥：focus() 才是用户路径（聚焦输入框 → 下拉展开 → 探测状态）
  out.status0 = await TB.api.search.status();
  TB.search.close();
  TB.search.focus();
  out.openedAfterFocus = !panel.classList.contains('hidden');
  out.focusIsInput = document.activeElement === TB.search.input;
  for (let i = 0; i < 20 && !/已连接|未运行|连不上|索引中|未安装/.test(TB.search.badge.textContent); i++) await wait(200);
  out.probedStatus = TB.search.status;
  out.badge = TB.search.badge.textContent;

  // 下拉要贴在搜索栏正下方，且不能跑出窗口
  const inputRect = TB.search.input.getBoundingClientRect();
  const rect = panel.getBoundingClientRect();
  out.rect = { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) };
  out.inputRect = { top: Math.round(inputRect.top), bottom: Math.round(inputRect.bottom), left: Math.round(inputRect.left), right: Math.round(inputRect.right) };
  out.viewport = { width: window.innerWidth, height: window.innerHeight };
  out.fitsViewport = rect.top >= 0 && rect.left >= 0 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1;
  out.anchoredUnderBar = rect.top >= inputRect.bottom && rect.top - inputRect.bottom <= 12 && rect.left <= inputRect.left + 4 && rect.right >= inputRect.right - 4;

  // 字数下限：单字符不发查询
  TB.search.input.value = 'a';
  TB.search.query = 'a';
  await TB.search.run('a');
  out.tooShortNote = TB.search.note.textContent;
  out.tooShortItems = TB.search.items.length;

  // 数值字段：size 是 int64* 出参、modified 是 FILETIME，走完整条 IPC 链后最容易静默归零
  const sized = await TB.api.search.query('explorer.exe');
  out.sizedTop = Math.max(0, ...(sized.items || []).map((item) => item.size || 0));
  out.sizedDated = (sized.items || []).filter((item) => item.modified > 0).length;

  // 真查询
  const t0 = Date.now();
  TB.search.input.value = 'Everything';
  TB.search.query = 'Everything';
  const raw = await TB.api.search.query('Everything');
  out.raw = { ...raw, items: (raw.items || []).slice(0, 2).map((it) => it.name) };
  await TB.search.run('Everything');
  out.queryMs = Date.now() - t0;
  out.items = TB.search.items.length;
  out.total = TB.search.total;
  out.rows = [...TB.search.list.querySelectorAll('.search-row')].length;
  out.first = TB.search.items[0] ? { name: TB.search.items[0].name, folder: TB.search.items[0].folder, hasPath: Boolean(TB.search.items[0].path) } : null;
  // 只报路径的样子，不报内容：绝对路径本来就要显示给用户
  out.firstPathShape = TB.search.items[0] ? /^[a-zA-Z]:\\\\/.test(TB.search.items[0].path) : false;
  out.activeIndex = TB.search.active;
  out.listIdShape = /^l\\d+$/.test(String(TB.search.listId));
  out.listScrolls = TB.search.list.getBoundingClientRect().height <= panel.getBoundingClientRect().height;

  // 键盘选择
  TB.search.onKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
  out.afterDown = TB.search.active;
  out.activeRowClass = TB.search.list.children[TB.search.active]?.className || '';
  TB.search.onKey(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
  out.afterUp = TB.search.active;

  // 「打开」守门：拿一个不存在的列表 id，主进程必须拒绝而不是去 openPath
  out.guardExpired = await TB.api.search.open('l999999', 0);
  out.guardBadIndex = TB.search.listId ? await TB.api.search.open(TB.search.listId, 9999) : { ok: false };

  // 连打两次：只有最后一次的输入该留下结果。
  // 第二条是被防抖挤进 trailing 的，p1 之后才补发，所以要等 inflight 落下来再判
  const p1 = TB.search.run('toolbar');
  const p2 = TB.search.run('config.js');
  await Promise.all([p1, p2]);
  for (let i = 0; i < 40 && TB.search.inflight; i++) await wait(200);
  out.settledAfter = TB.search.inflight ? 'still-inflight' : 'settled';
  out.serialized = TB.search.items.length > 0 && TB.search.items.every((item) => (item.name + ' ' + item.path).toLowerCase().includes('config.js'));
  out.serializedCount = TB.search.items.length;

  // Ctrl+F 快捷键（焦点在 body 才走全局键）→ 聚焦搜索栏并展开下拉
  TB.search.close();
  document.body.focus();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
  out.ctrlFOpened = !panel.classList.contains('hidden');
  out.ctrlFFocusIsInput = document.activeElement === TB.search.input;
  // 输入框里按 Esc：收起下拉并把焦点交还
  TB.search.onKey(new KeyboardEvent('keydown', { key: 'Escape' }));
  out.escClosed = panel.classList.contains('hidden');
  out.escBlurred = document.activeElement !== TB.search.input;

  // 点下拉外面收起；点搜索栏本身不算"外面"
  TB.search.open();
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  out.outsideClosed = panel.classList.contains('hidden');
  TB.search.open();
  TB.search.input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  out.barStaysOpen = TB.search.opened && !panel.classList.contains('hidden');

  // 面板开着截一张：把结果留在屏上再抓
  TB.search.input.value = 'txt';
  TB.search.query = 'txt';
  TB.search.open();
  await TB.search.run('txt');
  out.shotItems = TB.search.items.length;

  // 设置面板的 search 段：只验界面在不在，不点保存（保存会走整条 applyConfig）
  TB.settings.open('search');
  const card = document.querySelector('[data-card="search"]');
  out.settingsFields = card ? [...card.querySelectorAll('.field-label')].map((n) => n.textContent) : null;
  out.settingsScrolled = Boolean(card);
  TB.settings.close();
  return JSON.stringify(out);
})()`;
}

async function main() {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((item) => item.type === 'page' && item.url.includes('renderer/index.html'));
  if (!page) throw new Error(`CDP 端口 ${PORT} 上找不到工具栏渲染层，先跑: ./node_modules/electron/dist/electron.exe . --remote-debugging-port=${PORT}`);
  console.log(`[appprobe] 附着 ${page.title || page.url}`);

  const raw = await evaluate(page, buildExpression(), 180000);
  const out = JSON.parse(raw);
  for (const [key, value] of Object.entries(out)) console.log(`${key}: ${typeof value === 'object' && value ? JSON.stringify(value) : value}`);

  const failures = [];
  if (!out.hasBar || !out.hasInput || !out.badgeInBar) failures.push('顶栏没有常驻搜索栏（.search-bar / #search-input / #search-badge 缺件）');
  if (!out.buttonGone) failures.push('旧的「搜索」按钮还在顶栏');
  if (!out.attached) failures.push('TB.search 没认领顶栏那个输入框（attachBar 没跑或节点变了）');
  if (!out.closedAtStart) failures.push('下拉初始不是收起状态');
  if (!out.openedAfterFocus || !out.focusIsInput) failures.push('focus() 没展开下拉或没把焦点给输入框');
  if (!out.status0.supported) failures.push(`这台机器不支持：${JSON.stringify(out.status0)}`);
  if (!out.status0.installed) failures.push('主进程没认出 vendor/everything 里的东西');
  if (!out.probedStatus?.running) failures.push(`探测后仍连不上 Everything：${out.probedStatus?.lastError}`);
  if (!/已连接/.test(out.badge)) failures.push(`徽标不对：${out.badge}`);
  if (!out.anchoredUnderBar) failures.push(`下拉没贴在搜索栏下方：${JSON.stringify(out.rect)} vs ${JSON.stringify(out.inputRect)}`);
  if (!out.fitsViewport) failures.push(`下拉超出窗口：${JSON.stringify(out.rect)} / ${JSON.stringify(out.viewport)}`);
  if (out.tooShortItems !== 0) failures.push('少于 minChars 也发了查询');
  if (!out.settingsFields || out.settingsFields.length < 8) failures.push(`设置面板的 search 卡片不全：${JSON.stringify(out.settingsFields)}`);
  if (!out.raw.ok) failures.push(`搜索栏刚聚焦就发查询被吞了：${JSON.stringify(out.raw)}`);
  if (out.settledAfter !== 'settled') failures.push('连打两次后 inflight 没落下来');
  if (!(out.sizedTop > 100000)) failures.push(`结果里的 size 没读回来（最大 ${out.sizedTop} 字节）`);
  if (!out.sizedDated) failures.push('结果里的修改时间没读回来（FILETIME 全空）');
  if (!out.items) failures.push('「Everything」这个关键字一条都没查到（索引可能没建好）');
  if (!out.firstPathShape || !out.listIdShape) failures.push(`结果形状不对：${JSON.stringify(out.first)}`);
  if (!out.listScrolls) failures.push('结果列表比下拉面板还高，滚不起来');
  if (out.activeIndex !== 0 || out.afterDown !== 1 || out.afterUp !== 0) failures.push(`↑↓ 选择不对：${out.activeIndex}/${out.afterDown}/${out.afterUp}`);
  if (out.guardExpired.ok || out.guardBadIndex.ok) failures.push('「打开」守门失效：过期列表或越界序号被放行了');
  if (!out.serialized) failures.push('连打两次留下了旧输入的结果');
  if (!out.ctrlFOpened || !out.ctrlFFocusIsInput) failures.push('Ctrl+F 没聚焦搜索栏并展开下拉');
  if (!out.escClosed || !out.escBlurred) failures.push('Esc 没收起下拉或没交出焦点');
  if (!out.outsideClosed || !out.barStaysOpen) failures.push('点外面收起 / 点搜索栏不收起没生效');

  if (SHOTS) {
    try {
      const file = path.join(APP_ROOT, 'samples', 'search-panel.png');
      await capture(page, file);
      console.log(`[appprobe] 截图 ${file}`);
    } catch (error) {
      console.log(`[appprobe] 截图失败（不影响功能判定）：${error.message}`);
    }
  }

  // 收尾：收起下拉、清掉探针输入的关键词，别把脏状态留在屏上
  await evaluate(page, "TB.search.close();TB.search.query='';if(TB.search.input){TB.search.input.value='';TB.search.input.blur();}'closed'").catch(() => {});

  const gate = await verifyGate(page);
  if (gate) {
    for (const [key, value] of Object.entries(gate)) console.log(`gate.${key}: ${JSON.stringify(value)}`);
    if (!gate.disabled) failures.push('search.enabled 写不成 false');
    if (!gate.barGone || !gate.badgeGone) failures.push('关掉开关后顶栏还留着搜索栏或徽标');
    if (!gate.detached) failures.push('关掉开关后 TB.search 还认领着已被销毁的输入框');
    if (!gate.ctrlFNoop || !gate.focusNoop) failures.push('开关关掉后 Ctrl+F / focus() 仍能展开下拉');
    if (!gate.restored || !gate.barBack || !gate.badgeBack || !gate.reattached) failures.push(`恢复后搜索栏没回来：${JSON.stringify(gate)}`);
  }

  if (failures.length) {
    for (const line of failures) console.log(`✗ ${line}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ 顶栏搜索栏全绿：查到 ${out.total} 条 / 显示 ${out.rows} 行 / 单次查询 ${out.queryMs}ms${gate ? ' / enabled 开关关得掉也恢复得了' : ''}`);
  }
}

main().catch((error) => {
  console.error(`[appprobe] 失败：${error.message}`);
  process.exitCode = 1;
});
