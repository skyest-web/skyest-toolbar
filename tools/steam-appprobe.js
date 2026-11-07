// Steam 格子（独立那份纯游戏列表组件）的真机验证：附着到真实运行的工具栏（需带 --remote-debugging-port 启动）。
// 量「这一格挂的是 steam、真库里的游戏渲染出来了、列表自滚不被格子裁掉、文字看得清」，
// 再验过滤、重扫、报错/空库兜底文案、设置里的 Steam 卡片。
//
// 版式说明：游戏面板中间三格已经合成一整块「游戏列表」（tools/games-appprobe.js 验那个），
// layout.json 里不再有纯 Steam 格子；这个组件还在「组件与位置」的可选清单里，所以本探针临时把它
// 挂到主界面的一个空位上验——只改渲染层内存里那份 layout，不调 layout:save，验完原样还回去。
//
// 启动链路在这里只走"劫持 IPC"的干跑：DOM 上真点、组件真处理，但 TB.api.steam 换成只记账的替身，
// 所以一个游戏都不会真的交给 Steam。真要启动由人来点，或跑 tools/steam-check.js（那里注入 openExternal，只看拼出来的地址）。
//
// 用法（Git Bash）:
//   1) unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
//   2) node tools/steam-appprobe.js [端口] [--shot]   # --shot 存 samples/steam-game.png
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..');
// 端口从参数里挑数字，别把 "--shot" 当成端口号（那会拼出 http://127.0.0.1:NaN/ 这种地址）
const PORT = Number(process.argv.slice(2).find((arg) => /^\d+$/.test(arg)) || 9223);
const SHOTS = process.argv.includes('--shot');
const PAGE_ID = 'home';
const SLOT = 'slot2';

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
  if (!TB?.app?.state?.grid) throw new Error('渲染层 boot 未完成');
  const sec = document.querySelector('#shell > section[data-slot="${SLOT}"]');
  const host = document.getElementById('steam');
  const list = host?.querySelector('.st-list');
  const filter = host?.querySelector('.st-filter');
  const items = [...(list?.querySelectorAll('.st-item') || [])];
  const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; };
  // 量字形自己的矩形，不量容器：button 上写 overflow:hidden 会在 grid 的 auto 行里把内容盒塌成 0，
  // DOM 全在、探针全绿，人却看不清（修改器那格踩过一次）。
  let glyph = null;
  let ellipsis = 0;
  if (items.length) {
    const range = document.createRange();
    range.selectNodeContents(items[0].querySelector('.st-name') || items[0]);
    const t = range.getBoundingClientRect();
    const p = items[0].getBoundingClientRect();
    glyph = { top: Math.round(t.top - p.top), h: Math.round(t.height * 10) / 10, rowH: Math.round(p.height), bottomGap: Math.round(p.bottom - t.bottom) };
    ellipsis = [...list.querySelectorAll('.st-name')].filter((n) => n.scrollWidth > n.clientWidth + 1).length;
  }
  const ago = items.length ? items[0].querySelector('.st-ago') : null;
  let agoGlyph = null;
  if (ago) {
    const r = document.createRange();
    r.selectNodeContents(ago);
    const t = r.getBoundingClientRect();
    const p = items[0].getBoundingClientRect();
    agoGlyph = { h: Math.round(t.height * 10) / 10, inside: t.left >= p.left - 1 && t.right <= p.right + 1 && t.bottom <= p.bottom + 1 };
  }
  return JSON.stringify({
    glyph,
    agoGlyph,
    ellipsis,
    itemFontSize: items.length ? Math.round(parseFloat(getComputedStyle(items[0]).fontSize) * 10) / 10 : null,
    activePage: TB.app.state.page,
    registered: TB.components.has('steam'),
    module: sec?.dataset.module || null,
    configFolder: TB.app.state.config.steam?.folder ?? null,
    dataFolder: TB.steam?.data?.folder ?? null,
    dataError: TB.steam?.data?.error ?? null,
    itemCount: (TB.steam?.data?.items || []).length,
    domItems: items.length,
    leakedPaths: (TB.steam?.data?.items || []).some((item) => 'dir' in item || 'clientRoot' in item || 'path' in item),
    appidType: (TB.steam?.data?.items || [])[0]?.appid,
    countLabel: host?.querySelector('.st-count')?.textContent ?? null,
    rescanLabel: host?.querySelector('.st-head .link-btn')?.textContent ?? null,
    firstNames: (TB.steam?.data?.items || []).slice(0, 3).map((item) => item.name),
    // 行里除了名字还有右侧那块「多久之前」，所以取 .st-name 自己的文本，不能拿整行的 textContent
    domFirst: items[0]?.querySelector('.st-name')?.textContent ?? null,
    domFirstAgo: items[0]?.querySelector('.st-ago')?.textContent ?? null,
    titleTip: items[0]?.title ?? null,
    secBox: box(sec),
    hostBox: box(host),
    filterBox: box(filter),
    itemBox: box(items[0]),
    listStyle: list ? { overflowY: getComputedStyle(list).overflowY, sh: list.scrollHeight, ch: list.clientHeight, cols: getComputedStyle(list).gridTemplateColumns.split(' ').length } : null,
    hostClip: host ? Math.round(host.scrollHeight - host.getBoundingClientRect().height) : null,
    secClip: sec ? Math.round(sec.scrollHeight - sec.getBoundingClientRect().height) : null
  });
})()`;

async function main() {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((item) => item.type === 'page' && item.url.includes('renderer/index.html'));
  if (!page) throw new Error(`CDP 端口 ${PORT} 上找不到工具栏渲染层，先跑: ./node_modules/electron/dist/electron.exe . --remote-debugging-port=${PORT}`);

  const failures = [];
  const original = JSON.parse(await evaluateReady(page, MEASURE));
  if (!original.registered) failures.push('组件注册表里没有 "steam"（loader 没注入 src/renderer/js/components/steam.js？）');

  // 先切到主界面（那页用的是全局骨架，有 slot2 这个空位），再把纯 Steam 格子临时挂上去
  await evaluate(page, `document.querySelector('.topbar .page-tab[data-page="${PAGE_ID}"]').click();'ok'`);
  const mounted = await evaluate(page, `(() => {
    window.__probeGrid = JSON.parse(JSON.stringify(TB.app.state.grid));
    const page = TB.app.pages().find((p) => p.id === "${PAGE_ID}");
    const slot = page.slots.find((s) => s.at === "${SLOT}") || page.slots[0];
    slot.at = "${SLOT}";
    slot.module = "steam";
    slot.enabled = true;
    TB.app.buildShell();
    return 'ok';
  })()`);
  if (mounted !== 'ok') failures.push(`临时挂载 steam 组件失败：${JSON.stringify(mounted)}`);
  const out = JSON.parse(await evaluateReady(page, MEASURE));

  console.log(`面板 ${out.activePage} / ${SLOT} => ${out.module} / 配置的库 ${out.configFolder}`);
  console.log(`列表 ${out.domItems} 格（主进程给 ${out.itemCount} 款，${out.listStyle?.cols} 列），计数牌「${out.countLabel}」，首格「${out.domFirst} · ${out.domFirstAgo}」`);
  console.log(`格子 ${out.secBox?.w}x${out.secBox?.h} @(${out.secBox?.x},${out.secBox?.y})，列表 ${out.listStyle?.ch}px 可视 / ${out.listStyle?.sh}px 内容，overflow-y=${out.listStyle?.overflowY}`);
  console.log(`字号 ${out.itemFontSize}px / 行高 ${out.glyph?.rowH}px（字形 ${out.glyph?.h}px，上留 ${out.glyph?.top}px、下留 ${out.glyph?.bottomGap}px），右侧「多久之前」${out.agoGlyph?.h}px，名字带省略号 ${out.ellipsis} 条`);

  if (out.activePage !== PAGE_ID) failures.push(`点 tab 没切到 "${PAGE_ID}"，还在 "${out.activePage}"`);
  if (out.module !== 'steam') failures.push(`「${SLOT}」这格挂的是 "${out.module}"，探针没能把 steam 组件挂上去（layout.json 里那个位置本来就有别的组件？内存里覆盖失败）`);
  if (out.dataError) failures.push(`主进程报的错直接显示在格子里：${out.dataError}`);
  if (!out.itemCount) failures.push('列表是空的：检查设置 → Steam → 库文件夹，以及 H 盘有没有挂载');
  if (out.domItems !== out.itemCount) failures.push(`DOM 渲染 ${out.domItems} 格，主进程给了 ${out.itemCount} 条，对不上`);
  if (out.countLabel !== `共 ${out.itemCount} 款`) failures.push(`计数牌写着「${out.countLabel}」，应是「共 ${out.itemCount} 款」`);
  if (out.rescanLabel !== '重扫') failures.push(`重扫按钮写着「${out.rescanLabel}」`);
  if (!out.configFolder || out.dataFolder !== out.configFolder) failures.push(`主进程扫的库「${out.dataFolder}」和配置里的「${out.configFolder}」不一致`);
  if (out.domFirst !== out.firstNames[0]) failures.push(`DOM 第一格「${out.domFirst}」不是数据里的第一条「${out.firstNames[0]}」（顺序乱了）`);
  if (!/^(今天|昨天|\d+ 天前|\d+ 个月前|\d+ 年前|没玩过)$/.test(out.domFirstAgo || '')) failures.push(`右侧「多久之前」不是人话：${JSON.stringify(out.domFirstAgo)}`);
  if (out.leakedPaths) failures.push('主进程给渲染层的条目里带了 dir/path——路径只能留在主进程缓存里');
  if (typeof out.appidType !== 'number') failures.push(`appid 不是数字：${JSON.stringify(out.appidType)}`);
  if (!out.titleTip?.includes('appid') || !out.titleTip.includes('Steam 启动')) failures.push(`悬停提示没写清 appid 或手势：${JSON.stringify(out.titleTip)}`);

  // .area 是 overflow:hidden：内容比格子高不报错，只是看不见。列表要自己滚。
  if (out.hostClip > 1) failures.push(`#steam 内容比格子高 ${out.hostClip}px，底部会被裁掉`);
  if (out.secClip > 1) failures.push(`「${SLOT}」格里内容超了 ${out.secClip}px`);
  if (out.listStyle?.overflowY !== 'auto') failures.push(`列表不是自己滚的：overflow-y=${out.listStyle?.overflowY}`);
  if (out.glyph && (out.glyph.top < 0 || out.glyph.bottomGap < 1)) failures.push(`文字被行高裁掉了：行 ${out.glyph.rowH}px，字 ${out.glyph.h}px，上溢 ${out.glyph.top}px、下溢 ${out.glyph.bottomGap}px`);
  if (out.glyph && out.glyph.rowH < 22) failures.push(`每行只有 ${out.glyph.rowH}px，挤得看不清`);
  if (out.itemFontSize < 13) failures.push(`列表字号 ${out.itemFontSize}px，低于 13px 的可读下限`);
  if (out.agoGlyph && !out.agoGlyph.inside) failures.push(`右侧「多久之前」溢出到行外面了，会被裁掉`);
  if (out.filterBox && out.secBox && out.filterBox.bottom > out.secBox.bottom) failures.push('过滤输入框掉到格子外面了');
  if (out.itemBox && out.secBox && out.itemBox.bottom > out.secBox.bottom + 1) failures.push(`第一格游戏本身就在格子外面：${out.itemBox.bottom} > ${out.secBox.bottom}`);

  // ---------- 跨 IPC 的条目形状：扫描那条和缓存命中那条都要验 ----------
  // steam.scan 有 60 秒缓存，命中走的是另一条 return。缓存那条以前直接回 this.items，
  // 于是 dir/clientRoot 跟着跨过了 IPC——只在 60 秒内第二次点「重扫」才犯，所以必须连着调两次才验得到。
  const ipc = JSON.parse(await evaluate(page, `(async () => {
    const fresh = await TB.api.steam.list(true);
    const cached = await TB.api.steam.list(false);
    const leaked = (items) => (items || []).filter((it) => 'dir' in it || 'clientRoot' in it || 'path' in it).length;
    return JSON.stringify({
      freshCount: (fresh?.items || []).length,
      freshLeaked: leaked(fresh?.items),
      cachedCount: (cached?.items || []).length,
      cachedLeaked: leaked(cached?.items),
      cacheBranch: cached?.cached === true,
      keys: Object.keys((cached?.items || [])[0] || {}).sort().join(','),
      same: JSON.stringify(fresh?.items) === JSON.stringify(cached?.items)
    });
  })()`, 90000));
  console.log(`IPC 两条路 => 新扫 ${ipc.freshCount} 条 / 缓存 ${ipc.cachedCount} 条（走没走缓存分支：${ipc.cacheBranch}），字段 ${ipc.keys}`);
  if (!ipc.cacheBranch) failures.push('第二次 list(false) 没走缓存命中那条 return——60 秒 TTL 判断失效或路径比对不上，探针没验到它');
  if (ipc.freshLeaked || ipc.cachedLeaked) failures.push(`主进程给渲染层的条目里带了 dir/clientRoot/path：新扫漏 ${ipc.freshLeaked} 条、缓存漏 ${ipc.cachedLeaked} 条——每条返回路都得过 publicItems()`);
  if (!ipc.same) failures.push('新扫和缓存命中给渲染层的两份数据不一样（剥字段只剥了一条路）');
  if (ipc.cachedCount !== out.itemCount) failures.push(`缓存那条给了 ${ipc.cachedCount} 款，挂载时给的 ${out.itemCount} 款对不上`);

  // ---------- 过滤 ----------
  const needle = out.firstNames[0].slice(0, 2);
  const filtered = JSON.parse(await evaluate(page, `(() => {
    const input = document.querySelector('#steam .st-filter');
    input.value = ${JSON.stringify(needle)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const vis = TB.steam.visible();
    return JSON.stringify({
      dom: document.querySelectorAll('#steam .st-item').length,
      vis: vis.length,
      allMatch: vis.every((item) => item.name.toLowerCase().includes(${JSON.stringify(needle.toLowerCase())})),
      label: document.querySelector('#steam .st-count').textContent
    });
  })()`));
  console.log(`过滤「${needle}」=> ${filtered.dom} 格（计数牌仍写「${filtered.label}」= 总数，不是过滤后的数）`);
  if (!filtered.dom || filtered.dom > out.domItems) failures.push(`过滤「${needle}」后 DOM 有 ${filtered.dom} 格，不合理`);
  if (filtered.dom !== filtered.vis) failures.push(`过滤后 DOM ${filtered.dom} 格 vs visible() ${filtered.vis} 条，对不上`);
  if (!filtered.allMatch) failures.push(`过滤「${needle}」出现了不匹配的名字`);
  if (filtered.label !== `共 ${out.itemCount} 款`) failures.push(`过滤后计数牌变成「${filtered.label}」，应仍写总数`);

  const nomatch = JSON.parse(await evaluate(page, `(() => {
    const input = document.querySelector('#steam .st-filter');
    input.value = '这个肯定没有';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return JSON.stringify({ dom: document.querySelectorAll('#steam .st-item').length, hint: document.querySelector('#steam .st-list .muted')?.textContent || null });
  })()`));
  if (nomatch.dom !== 0 || !nomatch.hint) failures.push(`过滤不存在的词后还有 ${nomatch.dom} 格或没有提示语`);
  else console.log(`无匹配时提示：${nomatch.hint}`);

  await evaluate(page, `(() => { const i = document.querySelector('#steam .st-filter'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); return 'cleared'; })()`);

  // ---------- 干跑启动链路：真点 DOM，只把 IPC 那一层换成记账替身 ----------
  const dry = await evaluate(page, `(async () => {
    const real = TB.api;
    const calls = [];
    // deskToolbar 是 contextBridge 造的，属性只读且不可配置，Proxy 拦不住（会直接抛）。
    // 所以把键浅拷成一份普通对象，只换掉 steam 这一层。
    const wrap = (steam) => { const copy = {}; for (const key of Object.keys(real)) copy[key] = real[key]; copy.steam = steam; return copy; };
    TB.api = wrap({
      list: (force) => real.steam.list(force),
      launch: (id) => { calls.push({ m: 'launch', id }); return Promise.resolve({ ok: true, name: '干跑' }); },
      reveal: (id) => { calls.push({ m: 'reveal', id }); return Promise.resolve({ ok: true }); },
      pickFolder: () => Promise.resolve(null)
    });
    const vis = TB.steam.visible();
    const items = [...document.querySelectorAll('#steam .st-item')];
    items[0].click();
    items[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    document.querySelector('#steam .st-filter').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    // #toast 是堆叠的（活 3.1 秒），要最后一次点击那条，不是最早残留的
    const stack = [...document.querySelectorAll('#toast .toast')].map((n) => n.textContent);
    const toast = stack[stack.length - 1] || null;
    TB.api = real;
    return JSON.stringify({
      calls,
      toast,
      expect: [
        { m: 'launch', id: vis[0].id },
        { m: 'reveal', id: vis[1].id },
        { m: 'launch', id: vis[0].id }
      ]
    });
  })()`);
  const dryOut = JSON.parse(dry);
  console.log(`干跑点击 => ${JSON.stringify(dryOut.calls)}`);
  if (dryOut.calls.length !== 3) failures.push(`三次点击只发出 ${dryOut.calls.length} 次 IPC 调用`);
  dryOut.expect.forEach((want, i) => {
    const got = dryOut.calls[i];
    if (got && (got.m !== want.m || got.id !== want.id)) failures.push(`第 ${i + 1} 次点击期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
  });
  if (!/交给 Steam|定位失败/.test(dryOut.toast || '')) failures.push(`点完没有任何反馈提示（toast）：${JSON.stringify(dryOut.toast)}`);

  // ---------- 主进程出错/空库时的兜底文案 ----------
  const states = await evaluate(page, `(async () => {
    const real = TB.api;
    const wrap = (steam) => { const copy = {}; for (const key of Object.keys(real)) copy[key] = real[key]; copy.steam = steam; return copy; };
    const mk = (payload) => ({ list: () => Promise.resolve(payload), launch: () => Promise.resolve({ ok: false }), reveal: () => Promise.resolve({ ok: false }), pickFolder: () => Promise.resolve(null) });
    const read = () => ({
      label: document.querySelector('#steam .st-count')?.textContent,
      muted: document.querySelector('#steam .st-list .muted')?.textContent || null,
      dom: document.querySelectorAll('#steam .st-item').length
    });
    TB.api = wrap(mk({ folder: 'X:\\\\没这个库', items: [], error: '找不到 steamapps 目录（ENOENT）：X:\\\\没这个库\\\\steamapps' }));
    await TB.steam.load(true);
    const errored = read();
    TB.api = wrap(mk({ folder: 'X:\\\\空库', items: [] }));
    await TB.steam.load(true);
    const empties = read();
    TB.api = real;
    await TB.steam.load(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    return JSON.stringify({ errored, empties, restored: read() });
  })()`);
  const st = JSON.parse(states);
  console.log(`异常态 => 报错「${st.errored.muted}」/ 空库「${st.empties.muted}」/ 复原 ${st.restored.label} + ${st.restored.dom} 格`);
  if (st.errored.label !== '未就绪') failures.push(`主进程报错时计数牌是「${st.errored.label}」，应是「未就绪」`);
  if (!st.errored.muted?.includes('找不到 steamapps')) failures.push(`库不存在时没给出原因：${JSON.stringify(st.errored.muted)}`);
  if (!st.empties.muted?.includes('没有已安装的游戏')) failures.push(`空库时没有提示语：${JSON.stringify(st.empties.muted)}`);
  if (st.restored.dom !== out.domItems || st.restored.label !== `共 ${out.itemCount} 款`) failures.push(`验完没恢复到真实列表：${JSON.stringify(st.restored)}`);

  // ---------- 重扫按钮：真发 IPC（只读清单文件，安全） ----------
  const rescan = await evaluate(page, `(async () => {
    document.querySelector('#steam .st-head .link-btn').click();
    const during = document.querySelector('#steam .st-count').textContent;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return JSON.stringify({ during, after: document.querySelector('#steam .st-count').textContent, dom: document.querySelectorAll('#steam .st-item').length });
  })()`);
  const rs = JSON.parse(rescan);
  console.log(`点「重扫」=> 过程中「${rs.during}」，之后「${rs.after}」/ ${rs.dom} 格`);
  if (rs.during !== '重扫中…') failures.push(`重扫过程中没有「重扫中…」反馈，而是「${rs.during}」`);
  if (rs.after !== `共 ${out.itemCount} 款`) failures.push(`重扫后计数牌是「${rs.after}」，应回到「共 ${out.itemCount} 款」`);

  // ---------- 设置里的 Steam 卡片 ----------
  const card = JSON.parse(await evaluate(page, `(() => {
    TB.settings.open();
    const host = document.getElementById('settings');
    const section = [...host.querySelectorAll('.card')].find((c) => c.querySelector('h3')?.textContent === 'Steam');
    const input = section?.querySelector('input.input');
    const browse = [...(section?.querySelectorAll('button') || [])].find((b) => b.textContent.includes('浏览'));
    const hint = section?.querySelector('.field-hint')?.textContent || null;
    const label = section?.querySelector('.field-label')?.textContent || null;
    TB.settings.close();
    return JSON.stringify({ found: Boolean(section), value: input?.value ?? null, browse: browse?.textContent ?? null, hint, label });
  })()`));
  console.log(`设置卡片：${card.found ? '在' : '缺失'} / 输入框「${card.value}」/ 按钮「${card.browse}」/ 字段名「${card.label}」`);
  if (!card.found) failures.push('设置里没有「Steam」卡片');
  else {
    if (card.value !== out.configFolder) failures.push(`设置里库路径写着「${card.value}」，配置里是「${out.configFolder}」`);
    if (!card.browse) failures.push('「浏览…」按钮没渲染出来');
    if (card.label !== '库文件夹') failures.push(`卡片里的字段名是「${card.label}」`);
    if (!card.hint?.includes('appmanifest')) failures.push(`卡片提示没解释数据来源：${JSON.stringify(card.hint)}`);
  }

  if (SHOTS) {
    try {
      const file = path.join(APP_ROOT, 'samples', 'steam-game.png');
      await capture(page, file);
      console.log(`截图 ${file}`);
    } catch (error) {
      console.log(`截图失败（不影响功能判定）：${error.message}`);
    }
  }

  // 先还原版式（内存里那份），再切回他原来那个面板：当前面板会写进 state.json，别把界面留在主界面上
  try {
    await evaluate(page, `(() => {
      if (!window.__probeGrid) return 'already';
      TB.app.state.grid = window.__probeGrid;
      window.__probeGrid = null;
      TB.app.buildShell();
      return 'ok';
    })()`);
  } catch (error) {
    failures.push(`还原临时挂载的格子失败：${error.message}`);
  }
  try {
    await evaluate(page, `TB.app.setPage(${JSON.stringify(original.activePage)});'ok'`);
  } catch (error) {
    failures.push(`切回原面板 "${original.activePage}" 失败：${error.message}`);
  }

  if (failures.length) {
    for (const line of failures) console.log(`✗ ${line}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ Steam 格子全绿：真库 ${out.itemCount} 款渲染进「${PAGE_ID}/${SLOT}」，列表自滚不裁切、文字看得清，过滤/重扫/兜底文案/干跑链路都对上了（一个游戏都没真的交给 Steam）`);
  }
}

main().catch((error) => {
  console.error(`[steam-appprobe] 失败：${error.message}`);
  process.exitCode = 1;
});
