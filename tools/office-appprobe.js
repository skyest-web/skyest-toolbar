// 办公文档格子（工作面板 officezone）的真机验证：附着到真实运行的工具栏（需带 --remote-debugging-port 启动）。
//
// 验的是「他眼睛看到的那一格」：
//   1) 真点顶栏 tab 切到工作面板：officezone 挂 office，另外三格（projzone / gitzone / workbench）与常驻三格不动，
//      工作面板的格子清单是合掉 gauges / slot2 之后的那四格；
//   2) 新几何：officezone 是第 3 列两行合成的一整块——和同排的 gitzone 等宽、同顶、同底，
//      紧贴 gitzone 右边，高度通到第 3 行底（旧尺寸 176px 那半格会被这几条咬住）；
//   3) 真扫一次他配置的文件夹（真 IPC，只读）：主进程回几条，列表就渲染几行；
//      里面没文档时那句「该文件夹里没有 …」原样出现在格子里，而不是一个空白块，
//      且计数牌写「0 份」——那句必须和主进程的 empty 位一起来，只回句子不回 empty 就是跑着旧主进程，直接判不绿；
//   4) 六种「没东西可看」的文案互不相同，且报错时就算还揣着一批旧行也只留那句（替身喂，不写任何配置文件）；
//   5) 替身 40 行的几何：列表自己纵向滚（不是被 .area 静默裁掉）、每行横向不出格、
//      纵向落在列表的滚动内容里（第 13 行以后本来就该在画面外等滚动）、
//      行字号 ≥13px、四类牌子的颜色四样、长文件名自己省略而不把格子撑破；
//   6) 四类筛选是本地的事：点「表格」只剩表格行，且一次 IPC 都不发；
//   7) 三种手势干跑：左键只发 open(id) 一次（同一条 500ms 内的第二发 click 自己咽掉，不许再发）、
//      Ctrl+左键只发 reveal(id)、任何一路都不许把 item.path 递给 IPC；
//   8) 跑完恢复真 API 与他原来那一页；--shot 存 samples/office-panel.png（真扫）和 office-rows.png（替身 40 行）。
//
// 用法（Git Bash）:
//   1) unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
//   2) node tools/office-appprobe.js [端口] [--shot] [--reload]
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv.slice(2).find((arg) => /^\d+$/.test(arg)) || 9223);
const SHOTS = process.argv.includes('--shot');
const RELOAD = process.argv.includes('--reload');
const PAGE_ID = 'work';
const SLOT = 'officezone';
const WANT = { officezone: 'office', projzone: 'projects', gitzone: 'git', workbench: 'clipboard' };

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
      else if (msg.result?.exceptionDetails) {
        // 光抛 exceptionDetails.text 只会得到一句 "Uncaught"（替身里的语法错误就曾被它吞掉），
        // 把描述和出错的行一起带出来，下一次才知道是哪一段脚本没跑起来
        const detail = msg.result.exceptionDetails;
        const where = `${(detail.url || 'eval').split('/').pop()}:${detail.lineNumber + 1}:${detail.column}`;
        const reason = detail.exception?.description || detail.exception?.value || detail.text;
        reject(new Error(`${where} => ${reason}`));
      }
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
  const sec = (at) => document.querySelector('#shell > section[data-slot="' + at + '"]');
  const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  const moduleAt = (at) => sec(at)?.dataset.module || null;
  const font = (n) => (n ? Math.round(parseFloat(getComputedStyle(n).fontSize) * 10) / 10 : null);
  const host = document.getElementById('office');
  const list = host?.querySelector('.of-list');
  const rows = [...(host?.querySelectorAll('.of-item') || [])];
  const chips = [...(host?.querySelectorAll('.of-tabs .seg-btn') || [])];
  const style = list ? getComputedStyle(list) : null;
  return JSON.stringify({
    activePage: TB.app.state.page,
    registered: TB.components?.has?.('office') || false,
    modules: { officezone: moduleAt('officezone'), projzone: moduleAt('projzone'), gitzone: moduleAt('gitzone'), workbench: moduleAt('workbench') },
    cells: Object.fromEntries(['officezone', 'projzone', 'gitzone', 'workbench', 'topbar', 'clipboard', 'dock'].map((at) => [at, box(sec(at))])),
    slots: (TB.app.pages().find((p) => p.id === 'work')?.slots || []).map((s) => s.at).join(','),
    shared: ['topbar', 'clipboard', 'dock'].map((at) => moduleAt(at)).join(','),
    count: host?.querySelector('.of-count')?.textContent || null,
    note: host?.querySelector('.of-note')?.textContent || null,
    rowTexts: rows.map((n) => n.querySelector('.of-name')?.textContent),
    rowBoxes: rows.map((n) => box(n)),
    rowFonts: rows.map((n) => font(n.querySelector('.of-name'))),
    kindColors: [...new Set(rows.map((n) => getComputedStyle(n.querySelector('.of-kind')).color))],
    secBox: box(sec('officezone')),
    listBox: box(list),
    listScroll: style ? { overflowY: style.overflowY, overflowX: style.overflowX, anchor: style.overflowAnchor, sh: list.scrollHeight, ch: list.clientHeight, top: list.scrollTop } : null,
    // 截断交给 .of-name 自己：内容宽超过元素宽就是没省略号，会把整格撑破
    nameClip: rows.map((n) => { const el = n.querySelector('.of-name'); return el ? el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis' : false; }),
    chips: chips.map((n) => ({ text: n.textContent.trim(), on: n.classList.contains('on') })),
    firstTitle: rows[0]?.getAttribute('title') || null
  });
})();`;

// 替身那 40 行：四类各占一批，其中一条名字长到必须截断
const FAKE_40 = `
  const mkFake = () => Array.from({ length: 40 }, (_, i) => {
    const kinds = [['word', '文档', 'docx'], ['sheet', '表格', 'xlsx'], ['slides', '演示', 'pptx'], ['pdf', 'PDF', 'pdf']][i % 4];
    const file = i === 3 ? '这份文件名长得离谱，悬浮说明应该自己截断而不要把那一行撑破.docx' : \`季度材料 \${String(i).padStart(2, '0')}.rel\`;
    return {
      id: \`d:\\\\办公\\\\材料 \${String(i).padStart(2, '0')}.\${kinds[2]}\`,
      path: \`D:\\\\办公\\\\材料 \${String(i).padStart(2, '0')}.rel\`.replace('.rel', '.' + kinds[2]),
      folder: 'D:\\\\办公',
      dir: '2026 第' + (1 + (i % 4)) + '季度',
      file,
      ext: kinds[2],
      kind: kinds[0],
      kindLabel: kinds[1],
      title: file.replace(/\\.[a-z]+$/i, ''),
      size: 40000 + i * 7777,
      mtime: Math.floor(Date.now() / 1000) - i * 5400
    };
  });
`;

// 替身只能换 TB.api 这个键本身：window.deskToolbar 由 contextBridge 造，属性只读且不可配置，
// TB.api.office = 替身 会**静默失败**（渲染层不是严格模式），于是「切筛选 0 次 IPC」那种断言恒真。
// 这里把键浅拷成一份普通对象、只换掉 office 那一层，收尾再把 TB.api 指回去——和 projects-appprobe 同一招。
// 浅拷的**来源**必须写 window.deskToolbar 而不是 TB.api：上一趟探针崩在半路时 TB.api 已经是一份替身，
// 拿它当"真的那份"记下来，收尾就是把假 API 还回去了（实测过：后面每个探针都跑在替身上）。
const API_STUB = `
    const realApi = window.deskToolbar;
    const shallow = () => { const copy = {}; for (const key of Object.keys(window.deskToolbar)) copy[key] = window.deskToolbar[key]; return copy; };
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
  if (!boot.registered) failures.push('组件注册表里没有 "office"（loader 没注入 src/renderer/js/components/office.js？）');

  // 这版应用没带上主进程那段的话，下面全是假绿——先问一句，不对就直接停
  const api = JSON.parse(await evaluate(page, `JSON.stringify({ has: Boolean(TB.api?.office), methods: TB.api?.office ? Object.keys(TB.api.office).sort() : [], folder: TB.app.state.config?.office?.folder ?? null })`));
  if (!api.has) throw new Error('TB.api.office 不存在：跑的还是旧的主进程，重启应用（带 --remote-debugging-port 那条）再跑本探针');
  console.log(`preload => office.${api.methods.join('/')}；他的办公文件夹 ${JSON.stringify(api.folder ?? '')}`);

  // 起手先收干净上一趟留下的页内替身：TB.api 要是还指着某个探针浅拷出来的对象，本探针收尾"还原"的
  // 就是那份假的，后面每个探针都跑在替身上（office 自己那条 apiReal 断言也会一直红）。
  const stale = JSON.parse(await evaluate(page, `(() => { const dirty = TB.api !== window.deskToolbar; if (dirty) TB.api = window.deskToolbar; return JSON.stringify({ dirty }); })()`));
  if (stale.dirty) console.log('起手发现 TB.api 还指着上一趟留下的替身，已指回 window.deskToolbar');

  const original = boot.activePage;

  // ---------- 1. 真点 tab 切过去：officezone=office，其余三格与常驻三格不动 ----------
  await evaluate(page, `document.querySelector('.topbar .page-tab[data-page="${PAGE_ID}"]').click();'ok'`);
  const out = JSON.parse(await evaluateReady(page, MEASURE));
  console.log(`面板 ${out.activePage} / ${SLOT} => ${out.modules.officezone}（projzone=${out.modules.projzone}，gitzone=${out.modules.gitzone}，workbench=${out.modules.workbench}）`);
  console.log(`格子 ${out.secBox?.w}x${out.secBox?.h} @(${out.secBox?.x},${out.secBox?.y})；计数牌「${out.count}」；列表 ${out.listScroll?.sh}/${out.listScroll?.ch}`);

  if (out.activePage !== PAGE_ID) failures.push(`点 tab 没切到 "${PAGE_ID}"，还在 "${out.activePage}"`);
  for (const [at, want] of Object.entries(WANT)) {
    if (out.modules[at] !== want) failures.push(`「${at}」这格挂的是 "${out.modules[at]}"，应为 "${want}"（layout.json 里工作面板那一格）`);
  }
  if (out.slots !== 'projzone,gitzone,officezone,workbench') failures.push(`工作面板的格子清单是 "${out.slots}"，应为 projzone,gitzone,officezone,workbench（gauges / slot2 都被合掉了）`);
  if (out.shared !== 'topbar,ai,dock') failures.push(`常驻三格跟着面板变了：${out.shared}`);

  // ---------- 2. 新几何：第 3 列两行是一整块，和同排 gitzone 等宽同顶同底 ----------
  const here = out.cells?.officezone;
  const git = out.cells?.gitzone;
  const proj = out.cells?.projzone;
  if (!here) failures.push(`DOM 上没有 data-slot="${SLOT}" 这一格（工作面板那份 grid 没落位？）`);
  else {
    if (here.h < 300) failures.push(`officezone 只有 ${here.h}px 高：两行合成一整块以后该通到第 3 行底（旧尺寸 176px 会被这条咬住）`);
    if (here.w < 400) failures.push(`officezone 只有 ${here.w}px 宽：该是第 3 列那一整列（330px 那半格会被这条咬住）`);
    if (git && Math.abs(here.w - git.w) > 2) failures.push(`officezone 宽 ${here.w} 和同排的 gitzone ${git.w} 不一样：第 2、3 列都是 1fr，该等宽`);
    if (git && Math.abs(here.y - git.y) > 2) failures.push(`officezone 顶边和同排 gitzone 不齐：${here.y} vs ${git.y}`);
    if (git && Math.abs(here.bottom - git.bottom) > 2) failures.push(`officezone 下沿 ${here.bottom} 和 gitzone ${git.bottom} 不齐：有一块没跨过第 3 行`);
    if (git && here.x < git.right - 2) failures.push(`officezone 压到 gitzone 上了：左 ${here.x} < gitzone 右边缘 ${git.right}`);
    // 「紧贴」在这儿是「相隔恰好一个列间距」：左边那对（projzone→gitzone）量出来的就是 gap，
    // 拿 0 去比会被真机那 9px 列间距咬响（layout-appprobe 同一件事踩过一次）
    const gapX = proj && git ? git.left - (proj.left + proj.w) : 0;
    if (git && proj && Math.abs((here.x - git.right) - gapX) > 2) failures.push(`officezone 和 gitzone 之间不是「一个列间距」：${here.x - git.right} vs 左边的 ${gapX}`);
    if (proj && Math.abs(here.h - proj.h) > 2) failures.push(`三块不同高：officezone ${here.h} vs projzone ${proj.h}`);
  }

  // ---------- 3. 真扫他配置的那个文件夹：主进程回几条就渲染几行 ----------
  const real = JSON.parse(await evaluate(page, `(async () => {
    const res = await TB.api.office.scan(true);
    TB.office.data = res; TB.office.render();
    await new Promise((r) => setTimeout(r, 60));
    const host = document.getElementById('office');
    return JSON.stringify({
      folder: res.folder || '', count: (res.items || []).length, error: res.error || null, empty: Boolean(res.empty),
      cached: Boolean(res.cached), domRows: host.querySelectorAll('.of-item').length,
      note: host.querySelector('.of-note')?.textContent || null,
      badge: host.querySelector('.of-count')?.textContent || null,
      paths: (res.items || []).slice(0, 3).map((item) => item.path)
    });
  })()`));
  console.log(`真扫「${real.folder}」=> ${real.count} 份，DOM ${real.domRows} 行${real.error ? `，那句是「${real.error}」` : ''}`);
  // 这句「里面没有」在新主进程里一定和 empty 位一起来。只回句子、不回 empty = 跑的是改了渲染层但没重启的旧主进程，
  // 而下面那句 want 是照着返回值现算的（undefined 会算成「未就绪」），旧进程照样能骗绿——真踩过：截图里牌子就是「未就绪」。
  if (real.error === '该文件夹里没有 Word / Excel / PPT / PDF 文件' && !real.empty) {
    failures.push('主进程是旧的：那句「里面没有」没带 empty 位（重启应用再跑，这一趟的绿不算）');
  }
  if (real.domRows !== real.count) failures.push(`主进程回 ${real.count} 条，DOM 却渲染了 ${real.domRows} 行`);
  if (real.count === 0) {
    // 空文件夹和没配置是两件事：他这一格现在空着，那句必须写在格子里而不是留一块空白
    if (!real.note) failures.push('列表是空的，格子里却没有那句话（.of-note 没渲染）');
    if (real.error && real.note !== real.error) failures.push(`主进程那句「${real.error}」没原样出现在格子里，显示的是「${real.note}」`);
    // 计数牌跟着主进程的 empty 位走：扫到了但没有 = 0 份，压根没扫成 = 未就绪
    const want = real.error && !real.empty ? '未就绪' : `${real.count} 份`;
    if (real.badge !== want) failures.push(`里面没文档时计数牌写「${real.badge}」，应为「${want}」（empty=${real.empty}，error=${JSON.stringify(real.error)}）`);
  } else {
    if (real.paths.length && !real.paths.every((x) => path.isAbsolute(x))) failures.push(`真扫回来的 path 不是绝对路径：${JSON.stringify(real.paths)}`);
  }
  if (SHOTS) console.log(`  截图 ${await capture(page, path.join(APP_ROOT, 'samples', 'office-panel.png'))}`);

  // ---------- 4. 六种「没东西可看」各说一句，报错时就算还揣着一批旧行也不渲染（替身喂，不碰任何配置文件） ----------
  const fallbacks = JSON.parse(await evaluate(page, `(async () => {
    ${FAKE_40}
    const keep = TB.office.data;
    const wants = [
      ['还没配置办公文档文件夹（设置 → 办公文档 → 文件夹）', [], false],
      ['文件夹路径要写绝对路径：办公\\\\子目录', [], false],
      ['文件夹不存在或不可读（ENOENT）', [], false],
      ['所选路径不是文件夹', [], false],
      ['没有读取权限', [], false],
      // 这一档是「扫成了、里面就是没有」，主进程用 empty 位说清，牌子该写 0 份而不是「未就绪」
      ['该文件夹里没有 Word / Excel / PPT / PDF 文件', [], true],
      // 最后一档给 6 条旧行：主进程一说 error，渲染层就该只留那句，点开旧行只会「文件不存在」
      ['列表已过期，请点「重扫」', mkFake().slice(0, 6), false]
    ];
    const seen = [];
    for (const [error, items, empty] of wants) {
      TB.office.data = { folder: 'D:\\\\办公', items, error, empty };
      TB.office.filter = 'all';
      TB.office.render();
      await new Promise((r) => setTimeout(r, 20));
      const host = document.getElementById('office');
      seen.push({ error, empty, note: host.querySelector('.of-note')?.textContent || null, badge: host.querySelector('.of-count')?.textContent || null, rows: host.querySelectorAll('.of-item').length });
    }
    // 报错时不许还留着上一批行：上面那档给了 6 条旧行，下面逐条比对时 rows 必须归零
    TB.office.data = keep; TB.office.filter = 'all'; TB.office.render();
    return JSON.stringify({ seen });
  })()`));
  for (const one of fallbacks.seen) {
    if (one.error && one.note !== one.error) failures.push(`那句兜底文案没原样出现：主进程「${one.error}」vs 格子「${one.note}」`);
    if (one.error && one.rows > 0) failures.push(`报错时还留着 ${one.rows} 行旧文档（点开只会「文件不存在」）`);
    if (one.error && !one.empty && one.badge !== '未就绪') failures.push(`没扫成那一档的计数牌写的是「${one.badge}」，应为「未就绪」`);
    // 「扫到了但里面没有」不是故障：牌子写「未就绪」就是给他一个假故障（这一格真踩过：空目录一直亮着未就绪）
    if (one.error && one.empty && one.badge !== '0 份') failures.push(`空文件夹那档的计数牌写的是「${one.badge}」，应为「0 份」`);
  }
  // 只比前六句：第七句是「列表过期」那一类，不该算进「没东西可看」的对照里
  const notes = new Set(fallbacks.seen.slice(0, 6).map((one) => one.note));
  if (notes.size < 6) failures.push(`六种「没东西可看」在格子里只分辨出 ${notes.size} 句：${JSON.stringify([...notes])}`);

  // ---------- 5. 替身 40 行：竖向吃满整块、列表自己滚、字号与颜色 ----------
  const many = JSON.parse(await evaluate(page, `(async () => {
    ${FAKE_40}
    TB.office.data = { folder: 'D:\\\\办公', items: mkFake(), error: null };
    TB.office.filter = 'all';
    TB.office.render();
    await new Promise((r) => setTimeout(r, 60));
    return ${MEASURE};
  })()`));
  const sec = many.secBox;
  console.log(`替身 40 行：列表可视 ${many.listScroll?.ch} / 内容 ${many.listScroll?.sh}，格子 ${sec?.w}x${sec?.h}，牌子颜色 ${many.kindColors.length} 样`);
  if (many.rowTexts.length !== 40) failures.push(`替身 40 行只渲染出 ${many.rowTexts.length} 行`);
  if (!many.listScroll || many.listScroll.overflowY !== 'auto') failures.push(`列表纵向不是 overflow-y:auto（超出就被 .area 静默裁掉，看不见也说不清）：${JSON.stringify(many.listScroll)}`);
  if (many.listScroll && many.listScroll.anchor !== 'none') failures.push(`没写 overflow-anchor:none（边下边动的目录会让滚动自己跳）：${many.listScroll.anchor}`);
  if (many.listScroll && !(many.listScroll.sh > many.listScroll.ch)) failures.push(`40 行却没超出可视高度（${many.listScroll.sh}/${many.listScroll.ch}）：这一格没吃满竖向？`);
  if (sec && many.listBox && many.listBox.bottom > sec.bottom + 1) failures.push(`列表底 ${many.listBox.bottom} 越出格子底 ${sec.bottom}：内容被 .area 裁掉`);
  // 横向一行都不许出格；纵向比的是「行在滚动内容里的位置」——第 13 行以后落在可视高度之外是滚动容器
  // 自己在裁（这正是这一格的设计），拿视口矩形和格子比会把每一条滚出画面的行都误判成越界
  const scroll = many.listScroll || {};
  for (const [index, row] of (many.rowBoxes || []).entries()) {
    if (!row || !sec || !many.listBox) continue;
    if (row.left < sec.left - 1 || row.right > sec.right + 1) failures.push(`第 ${index + 1} 行横向出了格子：${JSON.stringify([row, sec])}`);
    const offset = -many.listBox.top + (scroll.top || 0);
    if (row.top + offset < -1 || row.bottom + offset > (scroll.sh || 0) + 1) failures.push(`第 ${index + 1} 行不在列表的内容高度里：${JSON.stringify([row, scroll])}`);
  }
  for (const px of many.rowFonts || []) {
    if (px !== null && px < 13) failures.push(`行字号 ${px}px，低于 13px（这屏 dpr=1）`);
  }
  if ((many.kindColors || []).length < 4) failures.push(`四类牌子只有 ${many.kindColors.length} 种颜色，文档/表格/演示/PDF 该分开设`);
  if ((many.nameClip || []).some(Boolean)) failures.push('有行的长名字没走省略号（会把整行撑破）');
  if (!many.firstTitle || !many.firstTitle.includes('左键')) failures.push(`悬浮说明没写「左键打开」那句话：${JSON.stringify(many.firstTitle)}`);

  // ---------- 6. 四类筛选：本地的事，一次 IPC 都不发 ----------
  const filtered = JSON.parse(await evaluate(page, `(async () => {
    ${API_STUB}
    const spies = { scan: [], open: [], reveal: [] };
    TB.api = Object.assign(shallow(), { office: {
      scan: (f) => { spies.scan.push(f); return Promise.resolve({ folder: '', items: [], error: '探针不该重扫' }); },
      open: (id) => { spies.open.push(id); return Promise.resolve({ ok: true }); },
      reveal: (id) => { spies.reveal.push(id); return Promise.resolve({ ok: true }); },
      pickFolder: () => { spies.scan.push('pickFolder'); return Promise.resolve(null); }
    } });
    // 替身没换上就是整段假绿（contextBridge 那个对象改不动），先自己问一句
    if (TB.api.office === realApi.office) return JSON.stringify({ installed: false, out1: { kinds: [], count: 0, scans: 0, on: [] }, out2: { count: 0, scans: 0 } });
    const chips = [...document.querySelectorAll('#office .of-tabs .seg-btn')];
    const sheetBtn = chips.find((n) => n.textContent.trim() === '表格');
    sheetBtn.click();
    await new Promise((r) => setTimeout(r, 40));
    const host = document.getElementById('office');
    const sheetRows = [...host.querySelectorAll('.of-item')];
    const out1 = {
      on: chips.map((n) => n.classList.contains('on')),
      kinds: [...new Set(sheetRows.map((n) => n.dataset.kind))],
      count: sheetRows.length,
      scans: spies.scan.length
    };
    chips[0].click();
    await new Promise((r) => setTimeout(r, 40));
    const out2 = { count: host.querySelectorAll('.of-item').length, scans: spies.scan.length };
    TB.api = realApi;
    return JSON.stringify({ installed: true, out1, out2 });
  })()`));
  if (!filtered.installed) failures.push('筛选那一步的 IPC 替身没换上（TB.api 换不动？）——那一段断言全是假的');
  console.log(`筛选：点「表格」=> ${filtered.out1.count} 行（类别 ${filtered.out1.kinds.join('/')}），重扫 ${filtered.out1.scans} 次`);
  if (filtered.out1.kinds.join(',') !== 'sheet') failures.push(`点「表格」之后列表里还有 ${filtered.out1.kinds.join(',')} 这几类`);
  if (filtered.out1.count !== 10) failures.push(`40 行里表格该有 10 行，实际 ${filtered.out1.count} 行`);
  if (filtered.out1.scans !== 0) failures.push(`切一次筛选重扫了 ${filtered.out1.scans} 次（筛选是本地的事，不许发 IPC）`);
  if (filtered.out2.count !== 40) failures.push(`切回「全部」只剩 ${filtered.out2.count} 行`);
  if (filtered.out2.scans !== 0) failures.push(`切回「全部」也重扫了：${filtered.out2.scans} 次`);

  // ---------- 7. 三种手势干跑：只递 id，第二发 click 自己咽掉 ----------
  const gestures = JSON.parse(await evaluate(page, `(async () => {
    ${API_STUB}
    const calls = { open: [], reveal: [] };
    TB.api = Object.assign(shallow(), { office: {
      scan: () => Promise.resolve({ folder: '', items: [], error: null }),
      open: (id) => { calls.open.push(id); return Promise.resolve({ ok: true, name: id }); },
      reveal: (id) => { calls.reveal.push(id); return Promise.resolve({ ok: true }); },
      pickFolder: () => Promise.resolve(null)
    } });
    if (TB.api.office === realApi.office) return JSON.stringify({ installed: false, afterTwo: 0, ids: { open: [], reveal: [] }, wantId: null });
    TB.office.lastClick = { id: null, at: 0 };
    const rows = [...document.querySelectorAll('#office .of-item')];
    const third = rows[2];
    third.click();
    await new Promise((r) => setTimeout(r, 10));
    third.click();
    await new Promise((r) => setTimeout(r, 10));
    const afterTwo = calls.open.length;
    const ev = new MouseEvent('click', { bubbles: true, ctrlKey: true });
    third.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 10));
    const ids = { open: [...calls.open], reveal: [...calls.reveal] };
    TB.api = realApi;
    TB.office.load(true);
    return JSON.stringify({ installed: true, afterTwo, ids, wantId: third.dataset.id, kind: third.dataset.kind });
  })()`));
  if (!gestures.installed) failures.push('干跑那一步的 IPC 替身没换上（TB.api 换不动？）——手势断言全是假的');
  console.log(`干跑：左键两次 => open ${gestures.ids.open.length} 次（前两次里只 ${gestures.afterTwo} 次）；Ctrl+左键 => reveal ${gestures.ids.reveal.length} 次`);
  if (gestures.afterTwo !== 1) failures.push(`同一条连点两次起了 ${gestures.afterTwo} 次 open（双击的第二发 click 必须咽掉，否则主进程那句「刚刚已经点开过同一个」会当失败弹回来）`);
  if (gestures.ids.open.length !== 1) failures.push(`左键那一路发了 ${gestures.ids.open.length} 次 open，应为 1 次`);
  if (gestures.ids.open[0] !== gestures.wantId) failures.push(`open 收到的不是列表里那条 id：${JSON.stringify(gestures.ids.open[0])} vs ${gestures.wantId}`);
  if (gestures.ids.reveal.length !== 1) failures.push(`Ctrl+左键发了 ${gestures.ids.reveal.length} 次 reveal，应为 1 次`);
  if (gestures.ids.reveal[0] !== gestures.wantId) failures.push(`reveal 收到的不是 id：${JSON.stringify(gestures.ids.reveal[0])}`);
  if (gestures.ids.open.some((id) => id !== gestures.wantId)) failures.push('open 收到了第二条别的路径（那条路就成了「递路径我帮你打开」）');

  // 真 API 换回来了，且没被干跑污染：最后一次是真 IPC 的重扫。
  // 别拿 scan.length 当标志——跨过 contextBridge 的函数是包过的代理，形参个数会变 0。
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = JSON.parse(await evaluate(page, `(() => { const host = document.getElementById('office'); return JSON.stringify({ rows: host.querySelectorAll('.of-item').length, badge: host.querySelector('.of-count')?.textContent || null, apiReal: TB.api === window.deskToolbar && TB.api.office === window.deskToolbar.office }); })()`));
  if (!after.apiReal) failures.push('收尾时 TB.api 还指着替身（后面再跑别的探针就全在这一份假 API 上）');
  if (after.rows !== real.count) failures.push(`恢复真 API 后列表是 ${after.rows} 行，真扫回来的是 ${real.count} 条`);

  if (SHOTS) {
    await evaluate(page, `(async () => {
      ${FAKE_40}
      TB.office.data = { folder: 'D:\\\\办公', items: mkFake(), error: null };
      TB.office.filter = 'all';
      TB.office.render();
    })()`);
    console.log(`  截图 ${await capture(page, path.join(APP_ROOT, 'samples', 'office-rows.png'))}`);
    await evaluate(page, `TB.office.load(true)`);
  }

  // ---------- 8. 收尾：切回他原来那一页 ----------
  await evaluate(page, `TB.app.setPage(${JSON.stringify(original)});'ok'`);
  const restored = JSON.parse(await evaluate(page, `JSON.stringify({ page: TB.app.state.page })`));
  if (restored.page !== original) failures.push(`收尾没切回原来的面板 "${original}"，现在停在 "${restored.page}"`);

  if (failures.length) {
    for (const line of failures) console.log(`✗ ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ 办公文档格子真机全绿：点 tab 后 officezone=office 且另三格与常驻三格不动、格子清单是那四格；` +
    `第 3 列两行合成一整块（和同排 gitzone 等宽同顶同底、通到第 3 行底）；真扫「${real.folder}」${real.count} 份与 DOM 行数一致、牌子按主进程回的 empty 位写成「${real.badge}」（旧主进程不回 empty 就直接判不绿）；` +
    `六种「没东西可看」各说一句且报错时不留旧行；替身 40 行列表自己滚、行不出格子、字号 ≥13px、四类四色、长名字走省略号；` +
    `切筛选 0 次重扫；左键两次只发 1 次 open、Ctrl+左键只发 1 次 reveal 且都只递 id；收尾真 API 与原面板都回来了`);
}

main().catch((error) => {
  console.error(`[office-appprobe] 失败：${error.message}`);
  process.exitCode = 1;
});
