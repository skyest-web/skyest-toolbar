// 游戏列表那一整块的真机验证：附着到真实运行的工具栏（需带 --remote-debugging-port 启动），
// 切到游戏面板，量「中间那一大格挂的是 games、gamezone 的形状正好等于原来中间三格、
// 每行左边是 32×32 图标、右上游戏名、右下它的修改器，图标真的加载出来了，列表自滚不被格子裁掉」。
//
// 启动链路在这里只走"劫持 IPC"的干跑：DOM 上真点、组件真处理，但 TB.api 里的 steam/trainers/library
// 换成只记账的替身，所以一个游戏都不会交给 Steam、一个修改器都不会被拉起来。
// 真启动交给人工点；离线那份对应关系由 tools/games-check.js 验。
//
// 用法（Git Bash）:
//   1) unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
//   2) node tools/games-appprobe.js [端口] [--shot]   # --shot 存 samples/games-panel.png
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..');
// 端口从参数里挑数字，别把 "--shot" 当成端口号（那会拼出 http://127.0.0.1:NaN/ 这种地址）
const PORT = Number(process.argv.slice(2).find((arg) => /^\d+$/.test(arg)) || 9223);
const SHOTS = process.argv.includes('--shot');
const PAGE_ID = 'game';
const SLOT = 'gamezone';

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
  const host = document.getElementById('games');
  const list = host?.querySelector('.gz-list');
  const rows = [...(list?.querySelectorAll('.gz-item') || [])];
  const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), cy: Math.round(r.top + r.height / 2) }; };
  // 字形矩形自己量，不量容器：button 上写 overflow:hidden 会在自动行高里把内容盒塌成 0，
  // DOM 全在、探针全绿，人却看不清（修改器那格踩过一次）。
  const glyphOf = (row) => {
    if (!row) return null;
    const name = row.querySelector('.gz-name');
    if (!name) return null;
    const range = document.createRange();
    range.selectNodeContents(name);
    const t = range.getBoundingClientRect();
    const p = row.getBoundingClientRect();
    return { h: Math.round(t.height * 10) / 10, top: Math.round(t.top - p.top), bottomGap: Math.round(p.bottom - t.bottom), rowH: Math.round(p.height) };
  };
  const withChips = rows.find((r) => r.querySelector('.gz-chip'));
  const imgs = [...(host?.querySelectorAll('img.gz-icon') || [])];
  const data = TB.games?.data || null;
  const rowKeys = new Set();
  for (const row of data?.rows || []) for (const key of Object.keys(row)) rowKeys.add(key);
  const chipKeys = new Set();
  for (const row of data?.rows || []) for (const chip of row.trainers) for (const key of Object.keys(chip)) chipKeys.add(key);
  return JSON.stringify({
    activePage: TB.app.state.page,
    registered: TB.components.has('games'),
    module: sec?.dataset.module || null,
    // 旧的那三格不该还在这块面板上（合成一个了）
    leftovers: ['gauges', 'slot1', 'slot2'].filter((at) => document.querySelector(\`#shell > section[data-slot="\${at}"]\`)),
    steamFolder: data?.steamFolder ?? null,
    trainersFolder: data?.trainersFolder ?? null,
    error: data?.error ?? null,
    stats: data?.stats || null,
    statsLabel: document.querySelector('#games .gz-count')?.textContent ?? null,
    rowCount: (data?.rows || []).length,
    domRows: rows.length,
    firstRow: (data?.rows || [])[0] ? { name: data.rows[0].name, appid: data.rows[0].appid, idType: typeof data.rows[0].id, icon: Boolean(data.rows[0].icon), chips: data.rows[0].trainers.length } : null,
    rowKeys: [...rowKeys],
    chipKeys: [...chipKeys],
    chipTotal: (data?.rows || []).reduce((n, row) => n + row.trainers.length, 0),
    domChips: (host?.querySelectorAll('.gz-chip') || []).length,
    domChipText: [...(host?.querySelectorAll('.gz-chip') || [])].slice(0, 4).map((c) => c.textContent),
    glyphs: { first: glyphOf(rows[0]), chipsRow: glyphOf(withChips) },
    nameFontSize: rows.length ? Math.round(parseFloat(getComputedStyle(rows[0].querySelector('.gz-name')).fontSize) * 10) / 10 : null,
    chipFontSize: withChips ? Math.round(parseFloat(getComputedStyle(withChips.querySelector('.gz-chip')).fontSize) * 10) / 10 : null,
    ellipsisNames: [...(host?.querySelectorAll('.gz-name') || [])].filter((n) => n.scrollWidth > n.clientWidth + 1).length,
    ago: rows[0]?.querySelector('.gz-ago')?.textContent ?? null,
    titleTip: rows[0]?.title ?? null,
    chipTip: withChips?.querySelector('.gz-chip')?.title ?? null,
    // 图标：真加载出来的字节尺寸 + 有没有破图
    iconImgs: imgs.length,
    iconLoaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
    iconBroken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
    iconPending: imgs.filter((i) => !i.complete).length,
    // 图标几何量第一行那个（跟 bodyBox 是同一行才比得出左右关系），加载情况统计全列表
    iconTag: rows[0]?.querySelector('.gz-icon')?.tagName ?? null,
    iconBox: box(rows[0]?.querySelector('.gz-icon')),
    iconNatural: imgs.find((i) => i.naturalWidth > 0) ? { w: imgs.find((i) => i.naturalWidth > 0).naturalWidth, h: imgs.find((i) => i.naturalWidth > 0).naturalHeight } : null,
    spanPlaceholders: [...(host?.querySelectorAll('span.gz-icon') || [])].length,
    secBox: box(sec),
    rowBox: box(rows[0]),
    bodyBox: box(rows[0]?.querySelector('.gz-body')),
    titleBox: box(rows[0]?.querySelector('.gz-title')),
    chipsRowBox: box(withChips),
    chipsTitleBox: box(withChips?.querySelector('.gz-title')),
    chipsBox: box(withChips?.querySelector('.gz-chips')),
    chipBox: box(withChips?.querySelector('.gz-chip')),
    filterBox: box(host?.querySelector('.gz-filter')),
    listStyle: list ? { overflowY: getComputedStyle(list).overflowY, sh: Math.round(list.scrollHeight), ch: Math.round(list.clientHeight), scrollTop: Math.round(list.scrollTop), anchor: getComputedStyle(list).overflowAnchor } : null,
    // 两列 + 「按行排」：第 2 条要和第 1 条同一行、在它右边，第 3 条回到左列下面。
    // 写成 grid-auto-flow: column 的话顺序变成「先填满左列」，看上去还是两列，但读的顺序全乱。
    gridCols: list ? getComputedStyle(list).gridTemplateColumns.split(' ').length : 0,
    flow: rows.length >= 3 ? (() => {
      const a = rows[0].getBoundingClientRect(), b = rows[1].getBoundingClientRect(), c = rows[2].getBoundingClientRect();
      return { rightShift: Math.round(b.left - a.left), sameRow: Math.abs(Math.round(b.top - a.top)), downShift: Math.round(c.top - a.top), backLeft: Math.abs(Math.round(c.left - a.left)) };
    })() : null,
    listWide: list ? Math.round(list.scrollWidth - list.clientWidth) : null,
    wideRows: list ? [...list.querySelectorAll('.gz-item')].filter((n) => n.getBoundingClientRect().right > list.getBoundingClientRect().right + 1).length : 0,
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
  if (!original.registered) failures.push('组件注册表里没有 "games"（loader 没注入 src/renderer/js/components/games.js？）');

  // 走真实点击切到游戏面板：tab 接线、外壳按本面板自带的 grid 重建、组件重新 init 都在这一趟里验
  await evaluate(page, `document.querySelector('.topbar .page-tab[data-page="${PAGE_ID}"]').click();'ok'`);
  // 图标是 60 张本地 file:// 图，刚重建时还在解码；等它们落地再量，别把"没加载完"当成"加载坏了"
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const out = JSON.parse(await evaluateReady(page, MEASURE));

  console.log(`面板 ${out.activePage} / ${SLOT} => ${out.module}（旧格子残留：${out.leftovers.join(',') || '无'}）`);
  console.log(`库 ${out.steamFolder} / 修改器 ${out.trainersFolder}`);
  console.log(`列表 ${out.domRows} 行（主进程给 ${out.rowCount} 行），标签 ${out.domChips} 个（数据 ${out.chipTotal} 个），计数牌「${out.stats?.games} 款 / ${out.stats?.withTrainer} 款有修改器 / 图标 ${out.stats?.icons}」`);
  console.log(`图标 <img> ${out.iconImgs} 张：加载 ${out.iconLoaded}、破图 ${out.iconBroken}、还没完 ${out.iconPending}，原始尺寸 ${out.iconNatural?.w}x${out.iconNatural?.h}`);
  console.log(`格子 ${out.secBox?.w}x${out.secBox?.h} @(${out.secBox?.x},${out.secBox?.y})，${out.gridCols} 列（第 2 条右移 ${out.flow?.rightShift}px 同行，第 3 条回到左列下移 ${out.flow?.downShift}px），列表 ${out.listStyle?.ch}px 可视 / ${out.listStyle?.sh}px 内容 / scrollTop ${out.listStyle?.scrollTop}，横向溢出 ${out.listWide}px，overflow-y=${out.listStyle?.overflowY}、锚定=${out.listStyle?.anchor}`);
  console.log(`首行「${out.firstRow?.name}」名字 ${out.nameFontSize}px、行高 ${out.glyphs?.first?.rowH}px（字形 ${out.glyphs?.first?.h}px），「${out.ago}」；带修改器那行标签 ${out.chipFontSize}px`);

  if (out.activePage !== PAGE_ID) failures.push(`点 tab 没切到 "${PAGE_ID}"，还在 "${out.activePage}"`);
  if (out.module !== 'games') failures.push(`「${SLOT}」这格挂的是 "${out.module}"，layout.json 里游戏面板中间那一大格应写 "games"`);
  if (out.leftovers.length) failures.push(`游戏面板还留着旧格子 "${out.leftovers.join(',')}"：中间三格本该合成 gamezone`);
  if (out.error) failures.push(`主进程报的错直接显示在格子里：${out.error}`);
  if (!out.rowCount) failures.push('列表是空的：检查设置 → Steam 库文件夹、修改器文件夹，以及盘有没有挂载');
  if (out.domRows !== out.rowCount) failures.push(`DOM 渲染 ${out.domRows} 行，主进程给了 ${out.rowCount} 行，对不上`);
  if (out.domChips !== out.chipTotal) failures.push(`DOM 有 ${out.domChips} 个修改器标签，数据里有 ${out.chipTotal} 个，对不上`);
  if (out.stats?.games !== out.rowCount) failures.push(`计数牌的款数 ${out.stats?.games} 和实际行数 ${out.rowCount} 不一致`);
  if (out.stats?.icons !== out.iconImgs) failures.push(`计数牌说图标 ${out.stats?.icons} 张，DOM 里 <img> 只有 ${out.iconImgs} 张（其余 ${out.spanPlaceholders} 行是占位）`);
  if (out.rowCount && out.rowKeys.some((key) => ['dir', 'path', 'exe', 'clientRoot'].includes(key))) failures.push(`给渲染层的行里带了路径字段：${JSON.stringify(out.rowKeys)}`);
  if (out.rowCount && out.chipKeys.length !== 3) failures.push(`标签对象该只有 id/name/short 三个字段，实际是 ${JSON.stringify(out.chipKeys)}`);
  if (out.firstRow?.idType !== 'number') failures.push(`行 id 不是数字（steam 那边的缓存序号）：${JSON.stringify(out.firstRow?.idType)}`);
  if (typeof out.firstRow?.appid !== 'number') failures.push(`appid 不是数字：${JSON.stringify(out.firstRow?.appid)}`);
  if (!/^(今天|昨天|\d+ 天前|\d+ 个月前|\d+ 年前|没玩过)$/.test(out.ago || '')) failures.push(`右侧「多久之前」不是人话：${JSON.stringify(out.ago)}`);
  if (!out.titleTip?.includes('appid') || !out.titleTip.includes('Steam 启动')) failures.push(`行提示没写清 appid 或手势：${JSON.stringify(out.titleTip)}`);
  if (!out.chipTip?.includes('管理员')) failures.push(`标签提示没写清右键以管理员启动：${JSON.stringify(out.chipTip)}`);

  // ---------- 「左侧图标 / 右上名字 / 右下修改器」这几句话的几何含义 ----------
  if (!out.iconBox) failures.push('一行图标都没量到：主进程没给 icon 路径，或 librarycache 里没有图');
  else {
    if (out.iconBox.w !== 32 || out.iconBox.h !== 32) failures.push(`图标盒子 ${out.iconBox.w}x${out.iconBox.h}，应该是 32×32 的方图`);
    if (out.iconNatural && out.iconNatural.w < 32) failures.push(`原图只有 ${out.iconNatural.w}px 宽，放大到 32 会糊：${JSON.stringify(out.iconNatural)}`);
    if (out.bodyBox && !(out.iconBox.right <= out.bodyBox.left)) failures.push(`图标没在文字块左边：图标右 ${out.iconBox.right} > 文字块左 ${out.bodyBox.left}`);
    if (out.rowBox && Math.abs(out.iconBox.cy - out.rowBox.cy) > 3) failures.push(`图标没在行里垂直居中：图标中心 ${out.iconBox.cy} vs 行中心 ${out.rowBox.cy}`);
    if (out.secBox && (out.iconBox.top < out.secBox.top || out.iconBox.bottom > out.secBox.bottom)) failures.push('图标被格子裁掉了');
  }
  if (out.iconBroken) failures.push(`${out.iconBroken} 张图标请求失败（complete 但 naturalWidth=0）：路径给了但文件不在`);
  if (out.iconPending) failures.push(`${out.iconPending} 张图标等 2.5 秒还没加载完，列表里是空的`);
  if (out.iconLoaded < out.stats?.icons) failures.push(`主进程说图标 ${out.stats?.icons} 张，DOM 里真加载出来的只有 ${out.iconLoaded} 张`);

  if (!out.bodyBox) failures.push('行里没有 .gz-body（名字和标签那块）');
  else if (out.rowBox && !(out.bodyBox.top >= out.rowBox.top - 1 && out.bodyBox.bottom <= out.rowBox.bottom + 1)) failures.push(`文字块超出行：${out.bodyBox.top}..${out.bodyBox.bottom} vs 行 ${out.rowBox.top}..${out.rowBox.bottom}`);
  if (out.titleBox && out.rowBox && (out.titleBox.top < out.rowBox.top || out.titleBox.bottom > out.rowBox.bottom)) failures.push('游戏名那一行被裁到行外面');
  if (out.glyphs?.first && (out.glyphs.first.top < 0 || out.glyphs.first.bottomGap < 1)) failures.push(`名字被行高裁掉了：行 ${out.glyphs.first.rowH}px，字 ${out.glyphs.first.h}px，上留 ${out.glyphs.first.top}px、下留 ${out.glyphs.first.bottomGap}px`);
  if (out.glyphs?.first && out.glyphs.first.rowH < 40) failures.push(`每行只有 ${out.glyphs.first.rowH}px，放不下「图标 + 名字 + 标签」两层`);
  if (out.nameFontSize !== null && out.nameFontSize < 13) failures.push(`游戏名字号 ${out.nameFontSize}px，低于 13px 的可读下限`);
  if (out.chipFontSize !== null && out.chipFontSize < 13) failures.push(`修改器标签字号 ${out.chipFontSize}px，低于 13px 的可读下限`);

  if (out.domChips) {
    if (!out.chipsBox) failures.push('有修改器标签但没量到 .gz-chips 那块');
    else {
      if (out.chipsTitleBox && !(out.chipsBox.top >= out.chipsTitleBox.top)) failures.push(`修改器没在名字下面：标签顶 ${out.chipsBox.top} < 名字行顶 ${out.chipsTitleBox.top}`);
      if (out.iconBox && !(out.chipsBox.left >= out.iconBox.right)) failures.push(`修改器标签压到了图标左边：${out.chipsBox.left} < ${out.iconBox.right}`);
      if (out.chipsRowBox && out.chipsBox.bottom > out.chipsRowBox.bottom + 1) failures.push(`标签掉到行外面：${out.chipsBox.bottom} > ${out.chipsRowBox.bottom}`);
      if (out.chipBox && out.secBox && out.chipBox.right > out.secBox.right) failures.push(`标签右边超出了格子右边界，会被裁：${out.chipBox.right} > ${out.secBox.right}`);
    }
  }
  // 「只显示对上的」：没对应修改器的行不该留一个空标签盒占位，有标签的行数要等于计数牌上那个数
  const chipBoxes = JSON.parse(await evaluate(page, `(() => {
    const boxes = [...document.querySelectorAll('#games .gz-chips')];
    const withChips = boxes.filter((b) => b.children.length > 0);
    return JSON.stringify({
      rows: document.querySelectorAll('#games .gz-item').length,
      boxes: boxes.length,
      withChips: withChips.length,
      emptyHidden: boxes.filter((b) => !b.children.length).every((b) => getComputedStyle(b).display === 'none'),
      onlyChips: withChips.every((b) => [...b.children].every((c) => c.classList.contains('gz-chip')))
    });
  })()`));
  if (chipBoxes.boxes !== chipBoxes.rows) failures.push(`${chipBoxes.rows} 行里只有 ${chipBoxes.boxes} 个标签盒，有一行没被建出来`);
  if (chipBoxes.withChips !== out.stats.withTrainer) failures.push(`DOM 里 ${chipBoxes.withChips} 行挂着修改器，计数牌说 ${out.stats.withTrainer} 款有修改器`);
  if (!chipBoxes.emptyHidden) failures.push('没有对应修改器的行还留着一个可见的空标签盒占位');
  if (!chipBoxes.onlyChips) failures.push('标签盒里混进了别的元素');

  // .area 是 overflow:hidden：内容比格子高不报错，只是看不见。列表要自己滚，而且刚进来必须停在最上面。
  if (out.hostClip > 1) failures.push(`#games 内容比格子高 ${out.hostClip}px，底部会被裁掉`);
  if (out.secClip > 1) failures.push(`「${SLOT}」格里内容超了 ${out.secClip}px`);
  if (out.listStyle?.overflowY !== 'auto') failures.push(`列表不是自己滚的：overflow-y=${out.listStyle?.overflowY}`);
  if (out.listStyle?.anchor !== 'none') failures.push(`列表没关掉滚动锚定（overflow-anchor=${out.listStyle?.anchor}）：60 张图异步加载会把列表弹到底部`);
  if (out.listStyle?.scrollTop > 2) failures.push(`刚进这一格列表就滚到了 ${out.listStyle.scrollTop}px（该停在顶部）——Chromium 的滚动锚定又犯了`);
  // ---------- 两列：横向排两条，第三条换行回左列 ----------
  if (out.gridCols !== 2) failures.push(`列表不是两列：grid-template-columns 量出来是 ${out.gridCols} 列`);
  if (out.flow) {
    if (!(out.flow.rightShift > 100 && out.flow.sameRow <= 1)) failures.push(`第 2 条没排在第 1 条右边的同一行：右移 ${out.flow.rightShift}px、上下差 ${out.flow.sameRow}px`);
    if (!(out.flow.downShift > 10 && out.flow.backLeft <= 1)) failures.push(`第 3 条没回到左列第二行：相对第 1 条下移 ${out.flow.downShift}px、左右差 ${out.flow.backLeft}px（排成「先填满左列」了？）`);
  } else failures.push('列表不足 3 行，验不出两列的排布顺序');
  if (out.listWide > 1) failures.push(`列表横向溢出 ${out.listWide}px：两列把格子撑宽了，minmax(0,1fr) 没生效`);
  if (out.wideRows) failures.push(`${out.wideRows} 行的右边缘越过列表可视宽度，会被 .area 裁掉`);
  if (out.filterBox && out.secBox && out.filterBox.bottom > out.secBox.bottom) failures.push('过滤输入框掉到格子外面了');
  if (out.rowBox && out.secBox && out.rowBox.bottom > out.secBox.bottom + 1) failures.push(`第一行本身就在格子外面：${out.rowBox.bottom} > ${out.secBox.bottom}`);

  // ---------- 过滤 ----------
  const needle = out.firstRow.name.slice(0, 2);
  const filtered = JSON.parse(await evaluate(page, `(() => {
    const input = document.querySelector('#games .gz-filter');
    input.value = ${JSON.stringify(needle)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const vis = TB.games.visible();
    return JSON.stringify({
      dom: document.querySelectorAll('#games .gz-item').length,
      vis: vis.length,
      allMatch: vis.every((row) => row.name.toLowerCase().includes(${JSON.stringify(needle.toLowerCase())})),
      label: document.querySelector('#games .gz-count').textContent,
      // 过滤剩两条时它们该并排在同一行，而不是又叠成一列
      spread: (() => { const t = [...document.querySelectorAll('#games .gz-item')].map((n) => Math.round(n.getBoundingClientRect().top)); return t.length > 1 ? Math.max(...t) - Math.min(...t) : null; })()
    });
  })()`));  console.log(`过滤「${needle}」=> ${filtered.dom} 行（计数牌仍写「${filtered.label}」= 总数，不是过滤后的数）`);
  if (!filtered.dom || filtered.dom > out.domRows) failures.push(`过滤「${needle}」后 DOM 有 ${filtered.dom} 行，不合理`);
  if (filtered.dom !== filtered.vis) failures.push(`过滤后 DOM ${filtered.dom} 行 vs visible() ${filtered.vis} 行，对不上`);
  if (!filtered.allMatch) failures.push(`过滤「${needle}」出现了不匹配的名字`);
  if (filtered.label !== out.statsLabel) failures.push(`过滤后计数牌变了：「${filtered.label}」`);
  if (filtered.dom === 2 && !(filtered.spread <= 1)) failures.push(`过滤后剩 2 行却不在同一行（上下差 ${filtered.spread}px），两列没生效`);
  const firstHasChips = JSON.parse(await evaluate(page, `(() => {
    const row = document.querySelector('#games .gz-item');
    const chips = row?.querySelector('.gz-chips');
    return JSON.stringify({
      inData: Boolean((TB.games.data.rows[0].trainers || []).length),
      inDom: Boolean(row?.querySelector('.gz-chip')),
      emptyBox: chips ? getComputedStyle(chips).display : null
    });
  })()`));
  if (firstHasChips.inData !== firstHasChips.inDom) failures.push(`第一行数据里${firstHasChips.inData ? '有' : '没有'}修改器，DOM 里却${firstHasChips.inDom ? '有' : '没有'}标签`);
  if (!firstHasChips.inData && firstHasChips.emptyBox !== 'none') failures.push('没有对应修改器的行还留着一个空的标签盒占位');

  const nomatch = JSON.parse(await evaluate(page, `(() => {
    const input = document.querySelector('#games .gz-filter');
    input.value = '这个肯定没有';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return JSON.stringify({ dom: document.querySelectorAll('#games .gz-item').length, hint: document.querySelector('#games .gz-list .muted')?.textContent || null, wide: (() => { const m = document.querySelector('#games .gz-list > .muted'), l = document.querySelector('#games .gz-list'); return m && l ? Math.round(l.getBoundingClientRect().width - m.getBoundingClientRect().width) : null; })() });
  })()`));
  if (nomatch.dom !== 0 || !nomatch.hint) failures.push(`过滤不存在的词后还有 ${nomatch.dom} 行或没有提示语`);
  // 提示语要横跨两列，否则它只占左列半宽，看着像少了半句
  else if (nomatch.wide === null || nomatch.wide > 12) failures.push(`无匹配的提示语没横跨两列（比列表窄 ${nomatch.wide}px）`);
  else console.log(`无匹配时提示：${nomatch.hint}`);

  await evaluate(page, `(() => { const i = document.querySelector('#games .gz-filter'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); return 'cleared'; })()`);

  // ---------- 干跑：真点 DOM，只把 IPC 那一层换成记账替身 ----------
  const dry = JSON.parse(await evaluate(page, `(async () => {
    const real = TB.api;
    const calls = [];
    // deskToolbar 是 contextBridge 造的，属性只读且不可配置，Proxy 拦不住（会直接抛）。
    // 所以把键浅拷成一份普通对象，只换掉 steam / trainers 两层。
    const wrap = (overlays) => { const copy = {}; for (const key of Object.keys(real)) copy[key] = real[key]; Object.assign(copy, overlays); return copy; };
    TB.api = wrap({
      steam: {
        list: (force) => real.steam.list(force),
        launch: (id) => { calls.push({ m: 'steam.launch', id }); return Promise.resolve({ ok: true }); },
        reveal: (id) => { calls.push({ m: 'steam.reveal', id }); return Promise.resolve({ ok: true }); },
        pickFolder: () => Promise.resolve(null)
      },
      trainers: {
        list: (force) => real.trainers.list(force),
        launch: (id, elevated) => { calls.push({ m: 'trainers.launch', id, elevated: Boolean(elevated) }); return Promise.resolve({ ok: true }); },
        reveal: (id) => { calls.push({ m: 'trainers.reveal', id }); return Promise.resolve({ ok: true }); },
        pickFolder: () => Promise.resolve(null)
      }
    });
    const vis = TB.games.visible();
    const rows = [...document.querySelectorAll('#games .gz-item')];
    const expect = [];
    rows[0].click();
    expect.push({ m: 'steam.launch', id: vis[0].id });
    rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect.push({ m: 'steam.reveal', id: vis[1].id });
    // 挑一行真有修改器的：标签左键 = 普通启动、右键 = 管理员启动，而且都不该顺带把游戏也交给 Steam
    const chipRowIndex = vis.findIndex((row) => row.trainers.length);
    const chip = chipRowIndex >= 0 ? rows[chipRowIndex].querySelector('.gz-chip') : null;
    if (chip) {
      chip.click();
      expect.push({ m: 'trainers.launch', id: vis[chipRowIndex].trainers[0].id, elevated: false });
      chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      expect.push({ m: 'trainers.launch', id: vis[chipRowIndex].trainers[0].id, elevated: true });
    }
    document.querySelector('#games .gz-filter').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    expect.push({ m: 'steam.launch', id: vis[0].id });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // #toast 是堆叠的（活 3.1 秒），要的是**最后一次**点击那条，不是最早残留的那条
    const stack = [...document.querySelectorAll('#toast .toast')].map((n) => n.textContent);
    const toast = stack[stack.length - 1] || null;
    TB.api = real;
    return JSON.stringify({
      calls,
      toast,
      expect,
      // Enter 走的是 visible()[0]，过滤框此时是空的，所以它该等于 vis[0] —— 这一条由下面的 expect 比出来
      chipRowName: chipRowIndex >= 0 ? vis[chipRowIndex].name : null,
      enterWentWrong: calls.filter((c) => c.m === 'steam.launch').some((c) => c.id !== vis[0].id)
    });
  })()`));
  console.log(`干跑点击（首行 / Ctrl 第二行 / 标签「${dry.chipRowName}」左键+右键 / 过滤框 Enter）=> ${JSON.stringify(dry.calls)}`);
  const same = (a, b) => a.m === b.m && a.id === b.id && (a.m !== 'trainers.launch' || a.elevated === b.elevated);
  if (!dry.chipRowName) failures.push('没有任何一行挂着修改器标签：别名表没对上，或修改器目录不对');
  if (dry.enterWentWrong) failures.push('过滤框 Enter 没落到 visible() 的第一行');
  if (dry.calls.length !== dry.expect.length) failures.push(`${dry.expect.length} 次点击只发出 ${dry.calls.length} 次 IPC 调用（点标签时不该再多发一次 steam.launch——行上的 onclick 要挡住 .gz-chip）`);
  dry.expect.forEach((want, i) => {
    const got = dry.calls[i];
    if (got && !same(got, want)) failures.push(`第 ${i + 1} 次点击期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
  });
  if (!/交给 Steam|已启动|已请求管理员|定位失败|启动失败/.test(dry.toast || '')) failures.push(`点完没有任何反馈提示（toast）：${JSON.stringify(dry.toast)}`);

  // ---------- 提示条怎么说：服务报的三种结果要三种话 ----------
  // EACCES → 自动补发 RunAs 那条只有真点才验得到；这一层验的是"服务说了，提示条有没有照着说"。
  // 提示条是**堆叠**的（#toast 里 appendChild，活 3.1 秒），所以要清空再读最后一条；
  // steam 那一层也换成替身——这个块里真发出去的话就把游戏真交给 Steam 了。
  const toasts = JSON.parse(await evaluate(page, `(async () => {
    const real = TB.api;
    const wrap = (overlays) => { const copy = {}; for (const key of Object.keys(real)) copy[key] = real[key]; Object.assign(copy, overlays); return copy; };
    const vis = TB.games.visible();
    const idx = vis.findIndex((row) => row.trainers.length);
    const chip = idx >= 0 ? [...document.querySelectorAll('#games .gz-item')][idx].querySelector('.gz-chip') : null;
    const out = [];
    for (const payload of [
      { ok: true, autoElevated: true, elevated: true },
      { ok: true },
      { ok: false, error: 'UAC 弹窗被取消，没有启动' }
    ]) {
      if (!chip) break;
      TB.api = wrap({
        steam: Object.assign({}, real.steam, { launch: () => Promise.resolve({ ok: true }), reveal: () => Promise.resolve({ ok: true }) }),
        trainers: Object.assign({}, real.trainers, { launch: () => Promise.resolve(payload) })
      });
      document.getElementById('toast').innerHTML = '';
      chip.click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      const all = [...document.querySelectorAll('#toast .toast')].map((n) => n.textContent);
      out.push({ kind: payload.autoElevated ? 'autoElevated' : payload.ok ? 'plain' : 'fail', toast: all[all.length - 1] || null, count: all.length });
      TB.api = real;
    }
    document.getElementById('toast').innerHTML = '';
    return JSON.stringify(out);
  })()`));
  const wantToast = {
    autoElevated: (t) => /已请求管理员权限/.test(t) && /要求管理员/.test(t),
    plain: (t) => /已启动「/.test(t) && !/管理员/.test(t),
    fail: (t) => /启动失败：UAC 弹窗被取消/.test(t)
  };
  if (toasts.length !== 3) failures.push('三种启动结果只量到 ' + toasts.length + ' 条提示（没有一行挂修改器标签？）');
  toasts.forEach((item) => {
    if (item.count !== 1) failures.push(`点标签本该只出一条提示，实际 ${item.count} 条（行上的 onclick 没挡住 .gz-chip？）：${JSON.stringify(item.toast)}`);
    if (!wantToast[item.kind](item.toast || '')) failures.push(`服务报「${item.kind}」时提示条说的是：${JSON.stringify(item.toast)}`);
  });
  console.log(`提示条三种结果 => ${toasts.map((t) => `${t.kind}=「${t.toast}」`).join(' / ')}`);

  // ---------- 主进程出错/空库时的兜底文案 ----------
  const states = JSON.parse(await evaluate(page, `(async () => {
    const real = TB.api;
    const wrap = (library) => { const copy = {}; for (const key of Object.keys(real)) copy[key] = real[key]; copy.library = library; return copy; };
    const mk = (payload) => ({ list: () => Promise.resolve(payload) });
    const read = () => ({
      label: document.querySelector('#games .gz-count')?.textContent,
      muted: document.querySelector('#games .gz-list .muted')?.textContent || null,
      dom: document.querySelectorAll('#games .gz-item').length
    });
    TB.api = wrap(mk({ rows: [], stats: {}, steamFolder: 'X:\\\\没这个库', trainersFolder: '', error: '找不到 steamapps 目录（ENOENT）：X:\\\\没这个库\\\\steamapps' }));
    await TB.games.load(true);
    const errored = read();
    TB.api = wrap(mk({ rows: [], stats: { games: 0, withTrainer: 0, icons: 0 }, steamFolder: 'X:\\\\空库', trainersFolder: 'Y:\\\\修改器' }));
    await TB.games.load(true);
    const empties = read();
    TB.api = real;
    await TB.games.load(true);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return JSON.stringify({ errored, empties, restored: read() });
  })()`));
  console.log(`异常态 => 报错「${states.errored.muted}」/ 空库「${states.empties.muted}」/ 复原 ${states.restored.dom} 行`);
  if (states.errored.label !== '未就绪') failures.push(`主进程报错时计数牌是「${states.errored.label}」，应是「未就绪」`);
  if (!states.errored.muted?.includes('找不到 steamapps')) failures.push(`库不存在时没给出原因：${JSON.stringify(states.errored.muted)}`);
  if (!states.empties.muted?.includes('没有已安装的游戏')) failures.push(`空库时没有提示语：${JSON.stringify(states.empties.muted)}`);
  if (!states.empties.muted?.includes('X:\\空库')) failures.push(`空库提示没带上当前库路径，他不知道该去改哪里：${JSON.stringify(states.empties.muted)}`);
  if (states.restored.dom !== out.domRows) failures.push(`验完没恢复到真实列表：${states.restored.dom} 行 vs 原来 ${out.domRows} 行`);

  // ---------- 重扫按钮：真发 IPC（只读清单和目录，安全） ----------
  const rescan = JSON.parse(await evaluate(page, `(async () => {
    document.querySelector('#games .gz-head .link-btn').click();
    const during = document.querySelector('#games .gz-count').textContent;
    await new Promise((resolve) => setTimeout(resolve, 4000));
    return JSON.stringify({ during, after: document.querySelector('#games .gz-count').textContent, dom: document.querySelectorAll('#games .gz-item').length, chips: document.querySelectorAll('#games .gz-chip').length, loaded: [...document.querySelectorAll('#games img.gz-icon')].filter((i) => i.complete && i.naturalWidth > 0).length });
  })()`));
  console.log(`点「重扫」=> 过程中「${rescan.during}」，之后「${rescan.after}」/ ${rescan.dom} 行 + ${rescan.chips} 标签 / 图标 ${rescan.loaded} 张`);
  if (rescan.during !== '重扫中…') failures.push(`重扫过程中没有「重扫中…」反馈，而是「${rescan.during}」`);
  if (rescan.dom !== out.domRows || rescan.chips !== out.domChips) failures.push(`重扫后变成 ${rescan.dom} 行 / ${rescan.chips} 标签，原来是 ${out.domRows} / ${out.domChips}`);
  if (rescan.after !== out.statsLabel) failures.push(`重扫后计数牌是「${rescan.after}」，应回到「${out.statsLabel}」`);

  // ---------- 设置里看得见「这块面板自带骨架」 ----------
  const settingsText = await evaluate(page, `(async () => {
    TB.settings.open();
    const host = document.getElementById('settings');
    const card = [...host.querySelectorAll('.card')].find((c) => c.querySelector('h3')?.textContent === '组件与位置');
    const summary = card?.querySelector('p.muted')?.textContent || null;
    TB.settings.close();
    return summary;
  })()`);
  console.log(`设置里的位置说明：${settingsText}`);
  if (!settingsText?.includes('（本面板自带骨架）')) failures.push(`游戏面板的说明里没标出「本面板自带骨架」：${JSON.stringify(settingsText)}`);
  if (!settingsText?.includes('游戏面板')) failures.push(`说明里没写出当前面板名：${JSON.stringify(settingsText)}`);

  if (SHOTS) {
    try {
      const file = path.join(APP_ROOT, 'samples', 'games-panel.png');
      await capture(page, file);
      console.log(`截图 ${file}`);
    } catch (error) {
      console.log(`截图失败（不影响功能判定）：${error.message}`);
    }
  }

  // 验完切回他原来那个面板：当前面板会写进 state.json，别把界面留在游戏面板上
  try {
    await evaluate(page, `TB.app.setPage(${JSON.stringify(original.activePage)});'ok'`);
  } catch (error) {
    failures.push(`切回原面板 "${original.activePage}" 失败：${error.message}`);
  }

  if (failures.length) {
    for (const line of failures) console.log(`✗ ${line}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ 游戏列表全绿：${out.rowCount} 款进「${PAGE_ID}/${SLOT}」（图标 ${out.iconLoaded} 张真加载、修改器标签 ${out.domChips} 个挂在各自游戏行里），几何是「左图标 / 右上名字 / 右下修改器」，过滤/重扫/兜底文案/干跑链路都对上了（一个游戏、一个修改器都没真的启动）`);
  }
}

main().catch((error) => {
  console.error(`[games-appprobe] 失败：${error.message}`);
  process.exitCode = 1;
});
