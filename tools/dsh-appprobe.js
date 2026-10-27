// dsh 面板真机验证：附着到真实运行的工具栏（需带 --remote-debugging-port 启动），
// 用 CDP 走一遍 状态→开面板→视图真的加载了 dsh 页面→token 不外泄→收起不退子进程。
// 用法（Git Bash）:
//   1) ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
//   2) node tools/dsh-appprobe.js [端口] [--shot]
// --shot 额外截两张：工具栏页面（面板框）和 dsh 视图自己（内嵌内容），都落在 samples/。
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

function evaluate(target, expression, timeoutMs = 30000) {
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

function capture(target, file, before) {
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('截图超时')); }, 30000);
    let sent = false;
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }));
      ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: before, returnByValue: true } }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id === 2 && !sent) {
        sent = true;
        ws.send(JSON.stringify({ id: 3, method: 'Page.captureScreenshot', params: { format: 'png' } }));
      }
      if (msg.id === 3 && msg.result) {
        clearTimeout(timer);
        fs.writeFileSync(file, Buffer.from(msg.result.data, 'base64'));
        ws.close();
        resolve(file);
      }
      if (msg.error && msg.error.code === 3) {
        clearTimeout(timer);
        ws.close();
        reject(new Error(`${target.url} 不是可截图的页面`));
      }
    });
    ws.on('error', reject);
  });
}

// 这一段在渲染层里执行：只验接线，不碰 token 也不碰密钥
function buildExpression() {
  return `(async () => {
  const out = {};
  const clean = () => document.querySelector('#dsh-panel').classList.contains('open');
  // 上一轮跑挂了可能把面板留在打开状态，先归零再验「关得掉」
  out.startedOpen = clean();
  TB.dsh.close();
  const status = await TB.api.dsh.status();
  out.beforeOpen = status;
  out.panelExists = Boolean(document.querySelector('#dsh-panel .dsh-body'));
  out.closedByDefault = !clean();

  const started = Date.now();
  await TB.dsh.open();
  out.openedMs = Date.now() - started;
  out.showOk = TB.dsh.state?.running;
  out.afterOpen = TB.dsh.state;

  const rect = document.querySelector('#dsh-panel .dsh-body').getBoundingClientRect();
  out.innerRect = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)];

  // token 纪律：面板的 HTML、状态对象里都不该出现 token 或 dsh 的地址
  const html = document.querySelector('#dsh-panel').outerHTML;
  out.tokenInDom = /token=/.test(html) || /127\\.0\\.0\\.1/.test(html);
  out.tokenInStatus = /token=/.test(JSON.stringify(TB.dsh.state));
  out.headButtons = [...document.querySelectorAll('#ai .ai-head .link-btn')].map((b) => b.textContent);

  // 收起只该拿走视图，不该退子进程
  TB.dsh.close();
  out.closedAgain = !clean();
  out.stillRunning = (await TB.api.dsh.status()).running;

  // 再开一次：应当是秒显（复用在跑的实例，不再 spawn）
  const again = Date.now();
  await TB.dsh.open();
  out.reopenMs = Date.now() - again;
  TB.dsh.close();

  // 手势本身：双击宠物该召唤面板（上面都是直接调方法）
  document.querySelector('.ai-pet').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  out.dblclickOpens = clean();
  TB.dsh.close();
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
  for (const [key, value] of Object.entries(out)) console.log(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);

  const failures = [];
  if (!out.beforeOpen.installed) failures.push('dsh 没装进项目（node_modules/@deepseek-ai/dsh 找不到）');
  if (!out.panelExists) failures.push('面板 DOM 不在');
  if (!out.closedByDefault) failures.push('面板默认就是开着的');
  if (!out.showOk) failures.push(`开面板失败：${out.afterOpen?.lastError || '没拿到运行态'}`);
  if (out.tokenInDom || out.tokenInStatus) failures.push('token 泄到渲染层了');
  if (!out.headButtons.includes('Harness') || !out.headButtons.includes('打字')) failures.push('头部按钮没补齐');
  if (!out.closedAgain) failures.push('close() 没把面板收起');
  if (!out.stillRunning) failures.push('收起把子进程也退了（应只撤视图）');
  if (out.reopenMs > 1500) failures.push(`重开走了重新 spawn（${out.reopenMs}ms）`);
  if (!out.dblclickOpens) failures.push('双击宠物没召唤出面板');

  if (SHOTS && !failures.length) {
    await evaluate(page, 'TB.dsh.open()', 180000);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await capture(page, path.join(APP_ROOT, 'samples', 'dsh-frame.png'), "document.body.style.cursor='auto';'x'");
    const inner = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((item) => /127\.0\.0\.1:3080/.test(item.url));
    if (inner) {
      console.log(`[appprobe] dsh 视图目标 ${inner.url.replace(/token=[^&]+/, 'token=…')}`);
      await capture(inner, path.join(APP_ROOT, 'samples', 'dsh-view.png'), "document.title");
    } else {
      console.log('[appprobe] CDP 目标列表里没有 dsh 视图（子视图可能不单独暴露），只看 dsh-frame.png');
    }
    // 上面两张分别是「我们这页」和「dsh 那页」，都看不到合成后的样子；
    // 这块由主进程的 WebContentsView 盖在 .dsh-body 上，只能抓真实屏幕区域来验对位。
    // Electron 的 bounds 是 DIP，抓屏要物理像素：原点按主屏缩放率换算，尺寸按本屏缩放率算。
    const geo = JSON.parse(await evaluate(page, `(function () {
      const b = TB.app.state.placement.bounds;
      const primary = (TB.app.state.displays || []).find((d) => d.isPrimary) || { scaleFactor: 1 };
      const self = (TB.app.state.displays || []).find((d) => d.id === TB.app.state.placement.display?.id) || { scaleFactor: 1 };
      return JSON.stringify({
        x: Math.round(b.x * primary.scaleFactor),
        y: Math.round(b.y * primary.scaleFactor),
        width: Math.round(b.width * self.scaleFactor),
        height: Math.round(b.height * self.scaleFactor)
      });
    })()`));
    const shot = path.join(APP_ROOT, 'samples', 'dsh-composite.png');
    const { execFileSync } = require('node:child_process');
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(APP_ROOT, 'tools', 'grab-region.ps1'),
      '-X', String(geo.x), '-Y', String(geo.y), '-W', String(geo.width), '-H', String(geo.height), '-Out', shot], { stdio: 'inherit' });
    console.log(`[appprobe] 合成画面 ${shot}`);
    await evaluate(page, 'TB.dsh.close()', 10000);
  }

  if (failures.length) {
    console.error('\n未通过：\n- ' + failures.join('\n- '));
    process.exit(1);
  }
  console.log('\n全部通过');
}

main().catch((error) => {
  console.error('[appprobe] 出错：', error.message || error);
  process.exit(1);
});
