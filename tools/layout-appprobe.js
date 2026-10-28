// 布局的真机验证：附着到真实运行的工具栏（需带 --remote-debugging-port 启动），
// 只读地量一遍四条要求：音乐在时钟下方、原音乐位拆两格、系统指标不被拉伸、搜索是常驻栏。
// 用法（Git Bash）:
//   1) ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
//   2) node tools/layout-appprobe.js [端口] [--shot]   # --shot 顺带存一张 samples/layout-after.png
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
    areas: {
      topbar: box('topbar'), clock: box('clock'), player: box('player'), gauges: box('gauges'),
      workbench: box('workbench'), slot1: box('slot1'), slot2: box('slot2'), clipboard: box('clipboard'), dock: box('dock')
    },
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
  const out = JSON.parse(await evaluateReady(page, EXPRESSION));
  const a = out.areas;
  console.log(`窗口 ${out.viewport.width}x${out.viewport.height} / 行 ${out.layout.grid.rows.join(' ')} / 列 ${out.layout.grid.columns.join(' ')}`);
  for (const [at, box] of Object.entries(a)) console.log(`${at.padEnd(10)} ${box ? `${box.module.padEnd(11)} ${box.w}x${box.h} @(${box.x},${box.y}) 内容${box.content} 溢出${box.overflowY}` : '缺失'}`);

  const failures = [];
  if (out.shellOverflow > 1 || out.bodyOverflow > 1) failures.push(`网格整体超出窗口：shell+${out.shellOverflow} body+${out.bodyOverflow}`);
  if (!a.clock || !a.player) failures.push('左列没有时钟或播放器');
  else {
    if (a.clock.x !== a.player.x) failures.push(`播放器没和时钟对齐同一列：${a.clock.x} vs ${a.player.x}`);
    if (a.player.y < a.clock.y + a.clock.h) failures.push('播放器没在时钟下方');
  }
  if (!a.slot1 || !a.slot2) failures.push('原音乐位没拆成两格');
  else {
    if (a.slot1.y !== a.slot2.y || Math.abs(a.slot1.x + a.slot1.w - a.slot2.x) > 12) failures.push(`两格不是左右并排：${JSON.stringify([a.slot1, a.slot2])}`);
    if (a.slot1.module !== 'placeholder' || a.slot2.module !== 'placeholder') failures.push('两格没挂占位组件');
  }
  for (const [at, box] of Object.entries(a)) {
    if (box && box.content > box.h + 1) failures.push(`「${at}」内容比位置高 ${box.content - box.h}px，会被裁掉`);
    if (box && box.overflowY > 1) failures.push(`「${at}」内容比自己的可视区高 ${box.overflowY}px，底部被裁掉了`);
  }
  if (a.gauges && out.gaugeRowHeight > a.gauges.h) failures.push(`系统指标被拉伸：行 ${a.gauges.h} 里内容 ${out.gaugeRowHeight}`);
  if (out.playerContainer !== 'player') failures.push('播放器区域没建立容器查询上下文');
  if (a.player && a.player.w <= 420 && out.playerBodyDir !== 'column') failures.push(`窄列里播放器没切到竖排：${out.playerBodyDir}`);
  if (!out.searchInBar) failures.push('搜索栏不在顶栏里');
  if (out.chipsPerRow !== 2) failures.push(`窄列里主机信息不是两列：${out.chipsPerRow}`);

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

  // 「组件与位置」面板要能把新位置（slot1/slot2）挑给别的组件：验一下行数和下拉项数
  try {
    const editor = JSON.parse(
      await evaluate(
        page,
        `(() => {
          TB.layoutEditor.open();
          const host = document.getElementById('layout-editor');
          const rows = [...host.querySelectorAll('.slot-row')];
          const out = { rows: rows.length, slots: rows.filter((r) => r.querySelector('.slot-select')).length, areas: rows.map((r) => r.querySelector('.slot-area')?.textContent).filter(Boolean).join(','), options: rows[0]?.querySelectorAll('option').length || 0 };
          TB.layoutEditor.close();
          return JSON.stringify(out);
        })()`
      )
    );
    console.log(`组件与位置面板：${editor.slots} 个可选位置（${editor.areas}）/ 每个下拉 ${editor.options} 项`);
    if (editor.slots !== out.layout.slots.length) failures.push(`面板里的位置数 ${editor.slots} 和 layout.json 的 ${out.layout.slots.length} 对不上`);
    if (editor.options < 8) failures.push(`下拉里只有 ${editor.options} 个组件，占位组件没注册上？`);
  } catch (error) {
    failures.push(`打不开「组件与位置」面板：${error.message}`);
  }

  if (failures.length) {
    for (const line of failures) console.log(`✗ ${line}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ 布局全绿：音乐在时钟下方（${a.player.w}x${a.player.h}）、原位置拆两格、指标固定 ${out.gaugeRowHeight}px、搜索栏常驻`);
  }
}

main().catch((error) => {
  console.error(`[layout-appprobe] 失败：${error.message}`);
  process.exitCode = 1;
});
