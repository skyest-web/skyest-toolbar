// dsh 窗口真机验证：附着到真实运行的工具栏（需带 --remote-debugging-port 启动），
// 用 CDP 走一遍 状态→开窗口→窗口是独立 target→token 不外泄→收起不退子进程→位置有落盘。
// 用法（Git Bash）:
//   1) ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
//   2) node tools/dsh-appprobe.js [端口] [--shot]
// --shot 额外截两张：工具栏页面和 dsh 窗口自己，都落在 samples/。
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

function capture(target, file, before, fromSurface = true) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error(`截图超时（fromSurface=${fromSurface}）`)); }, 30000);
    let sent = false;
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }));
      ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: before, returnByValue: true } }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id === 2 && !sent) {
        sent = true;
        ws.send(JSON.stringify({ id: 3, method: 'Page.captureScreenshot', params: { format: 'png', fromSurface } }));
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

// 视图挂在别的窗口上时，从Surface 抓不到（那是给合成器准备的位图），退回抓渲染面
async function captureOrFallback(target, file, before) {
  try {
    return await capture(target, file, before);
  } catch (error) {
    console.log(`[appprobe] ${file} 常规截图失败（${error.message}），改用 fromSurface=false 再试`);
    return capture(target, file, before, false);
  }
}

// 这一段在渲染层里执行：只验接线，不碰 token 也不碰密钥
function buildExpression() {
  return `(async () => {
  const out = {};
  const visible = async () => (await TB.api.dsh.status()).visible;
  // 每一帧推给渲染层的 dsh 状态都留档：lastError 里曾经夹过 dsh 打印的带 token 地址，
  // 只在某一个瞬间取样会漏掉，所以订阅 + 逐帧扫
  const seen = [];
  TB.api.dsh.onState((status) => { seen.push(status); });
  // 上一轮跑挂了可能把窗口留在打开状态，先归零再验「关得掉」
  out.startedVisible = await visible();
  TB.dsh.close();
  out.beforeOpen = await TB.api.dsh.status();

  const started = Date.now();
  await TB.dsh.open();
  out.openedMs = Date.now() - started;
  out.afterOpen = TB.dsh.state;
  out.showOk = Boolean(TB.dsh.state?.running);

  // 只盯「真 token」：主进程把尾段里的 token 打码成 token=…，那串是要显示给用户排错用的，不算泄密。
  // 判定按「等号后面还有 6 个以上非空白字符」，打码后紧跟的是 … 或换行，不会被误判。
  const RAW_TOKEN = /token=[^\\s"'&<>…]{6,}/;
  // token 纪律：工具栏这页的 DOM 和每一帧状态里都不该出现真 token
  const domMatch = RAW_TOKEN.exec(document.body.innerHTML);
  out.tokenInDom = Boolean(domMatch);
  out.tokenInDomContext = domMatch
    ? document.body.innerHTML.slice(Math.max(0, domMatch.index - 220), domMatch.index + 40).replace(/token=[^"'&\\s]+/g, 'token=…')
    : null;
  seen.push(out.beforeOpen, out.afterOpen, TB.dsh.state);
  out.tokenInStatus = RAW_TOKEN.test(JSON.stringify(seen));
  out.headButtons = [...document.querySelectorAll('#ai .ai-head .link-btn')].map((b) => b.textContent);

  // 收起只该藏窗口，不该退子进程
  TB.dsh.close();
  out.closedAgain = !(await visible());
  out.stillRunning = (await TB.api.dsh.status()).running;

  // 再开一次：应当是秒显（复用在跑的实例，不再 spawn）
  const again = Date.now();
  await TB.dsh.open();
  out.reopenMs = Date.now() - again;
  TB.dsh.close();

  // 手势本身：双击宠物该把窗口召唤出来（上面都是直接调方法）
  document.querySelector('.ai-pet').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  out.dblclickOpens = await visible();
  TB.dsh.close();
  return JSON.stringify(out);
})()`;
}

// 窗口位置是主进程存进 state.json 的（dshWindow），渲染层看不到，只能在 node 这边复核。
// 关掉窗口走的是 hide()，里面会 persistBounds，所以跑完这轮就该有记录。
function readSavedBounds() {
  const file = path.join(process.env.APPDATA || '', 'screen-toolbar', 'state.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')).dshWindow;
    if (!saved) return null;
    return Number.isFinite(saved.x) && Number.isFinite(saved.y) && saved.width > 200 && saved.height > 200 ? saved : null;
  } catch {
    return null;
  }
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
  if (!out.showOk) failures.push(`开窗口失败：${out.afterOpen?.lastError || '没拿到运行态'}`);
  if (out.tokenInDom || out.tokenInStatus) failures.push('token 泄到渲染层了');
  if (!out.headButtons.some((text) => text.startsWith('Harness')) || !out.headButtons.includes('打字')) failures.push('头部按钮没补齐');
  if (!out.closedAgain) failures.push('close() 没把窗口收起');
  if (!out.stillRunning) failures.push('收起把子进程也退了（应只藏窗口）');
  if (out.reopenMs > 1500) failures.push(`重开走了重新 spawn（${out.reopenMs}ms）`);
  if (!out.dblclickOpens) failures.push('双击宠物没召唤出窗口');

  await new Promise((resolve) => setTimeout(resolve, 800));
  const saved = readSavedBounds();
  console.log(`落盘位置: ${saved ? JSON.stringify(saved) : '无'}`);
  if (!saved) failures.push('窗口位置没写进 state.json 的 dshWindow（换屏后重开就找不到）');

  if (SHOTS && !failures.length) {
    await evaluate(page, 'TB.dsh.open()', 180000);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // 截图只是留证据，抓不到不该把功能验证判死
    try {
      await captureOrFallback(page, path.join(APP_ROOT, 'samples', 'dsh-frame.png'), "document.body.style.cursor='auto';'x'");
    } catch (error) {
      console.log(`[appprobe] dsh-frame.png 没截到：${error.message}`);
    }
    const dshPort = out.afterOpen?.port || 3080;
    const inner = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((item) => item.url && item.url.includes(`127.0.0.1:${dshPort}`));
    if (inner) {
      console.log(`[appprobe] dsh 页面目标 ${inner.url.replace(/token=[^&]+/, 'token=…')}`);
      // 这页是挂在独立窗口里的 WebContentsView：常规 fromSurface 抓不到，captureOrFallback 会自己退回 fromSurface=false
      try {
        await captureOrFallback(inner, path.join(APP_ROOT, 'samples', 'dsh-view.png'), 'window.screenX + "," + window.screenY');
      } catch (error) {
        console.log(`[appprobe] dsh-view.png 没截到：${error.message}`);
      }
    } else {
      console.log('[appprobe] CDP 目标列表里没有 dsh 页面');
      failures.push('dsh 页面没作为独立目标出现（说明窗口没真开起来）');
    }
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
