// AI 宠物面板的几何探针：附着到真实运行的工具栏（需带 --remote-debugging-port 启动），
// 把「都收起 / 打字浮层展开 / 完整对话展开 / 两个都开」四种状态各量一遍并截图。
// 存在的理由：屏幕矮的时候对话框被裁掉/盖住，光看 CSS 推不出来（.area 的 overflow:hidden
// 会把越界的部分静默吃掉），必须量出「谁超出了谁」。
// 气泡本身是浮在 body 上的（见 TB.ai.placeBubble），所以它「出格子」是设计如此，
// 判它对错看 bubbleInViewport / bubbleAnchored；bubbleAreaClip 只是留个证据：
// 同样的矩形若还在格子里，就会被裁掉。
// 用法（Git Bash）:
//   1) powershell -NoProfile -ExecutionPolicy Bypass -File samples/start-app.ps1 -Root "D:/GitProject/toolbar" -Port 9223
//   2) node tools/ai-appprobe.js [端口] [--shot] [--reload] [--height 420]
// --reload 先 Page.reload 一次（改完渲染层代码/样式用它，省得重启应用）；
// --height 用 Emulation 把视口临时压到那个高度来复现矮屏（Electron CDP 没有 Browser 域），
// 量完按「clear → 归零 → 重载」三种办法依次试着还原。实测（2026-10-28，Electron 33 / Chrome 130）：
// 三种都清不掉，innerHeight 一直停在覆盖值，所以最后只能把覆盖设回窗口真实尺寸——
// 量出来的数跟原生一致，但覆盖仍在（他把窗口拖大拖小不会重排），要彻底还原得重启应用。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || 9223);
const SHOTS = process.argv.includes('--shot');
const RELOAD = process.argv.includes('--reload');
const HEIGHT_ARG = (() => {
  const at = process.argv.indexOf('--height');
  return at > 0 && Number(process.argv[at + 1]) ? Number(process.argv[at + 1]) : null;
})();

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

function cdp(target, method, params = {}, id = 1, timeoutMs = 60000) {
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error(`CDP 超时 ${method}`)); }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ id, method, params })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    });
    ws.on('error', reject);
  });
}

async function evaluate(target, expression, timeoutMs = 60000) {
  const result = await cdp(target, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 1, timeoutMs);
  return result?.result?.value;
}

async function capture(target, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const result = await cdp(target, 'Page.captureScreenshot', { format: 'png' }, 2, 30000);
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  return file;
}

// 一次采样：把关键矩形、越界与互相覆盖的关系都算出来
function measureExpression(label) {
  return `(() => {
  // 气泡现在会「说完三秒自动收起」，几何采样要的是它显示时的样子：__aiProbeHold 期间把倒计时摘掉、
  // 强制保持显示（只在渲染层临时改状态，不碰主进程，也不碰 TB.voice 的真实朗读）
  if (window.__aiProbeHold && TB.ai.bubbleText?.textContent) {
    clearTimeout(TB.ai.bubbleTimer);
    TB.ai.bubbleTimer = null;
    TB.ai.bubbleHidden = false;
    TB.ai.bubbleEl.classList.add('show');
    TB.ai.placeBubble();
  }
  const r = (node) => {
    if (!node) return null;
    const b = node.getBoundingClientRect();
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height), w: Math.round(b.width) };
  };
  const covers = (a, b) => Boolean(a && b) && a.top < b.bottom - 1 && a.bottom > b.top + 1 && a.left < b.right - 1 && a.right > b.left + 1;
  const area = TB.ai.compose.closest('.area');
  const root = document.querySelector('.ai #ai');
  const out = {
    label: ${JSON.stringify(label)},
    viewport: { w: window.innerWidth, h: window.innerHeight },
    area: r(area),
    panel: r(root),
    head: r(document.querySelector('.ai-head')),
    stage: r(document.querySelector('.ai-stage')),
    pet: r(document.querySelector('.ai-pet')),
    bubble: r(document.querySelector('.ai-bubble')),
    history: r(document.querySelector('.ai-history')),
    list: r(document.querySelector('.ai-list')),
    compose: r(TB.ai.compose),
    composeOpen: TB.ai.compose.classList.contains('open'),
    historyOpen: document.querySelector('.ai-history').classList.contains('open'),
    areaOverflow: area ? getComputedStyle(area).overflow : null,
    // 行轨道和 shell 高度：用来分辨「排版真这样」还是「Emulation 改完还没重排」
    shell: r(document.getElementById('shell')),
    rows: getComputedStyle(document.getElementById('shell')).gridTemplateRows,
    composePos: getComputedStyle(TB.ai.compose).position,
    composeParent: TB.ai.compose.parentElement?.className || null,
    // 打字浮层腾地方是靠面板自己的 padding-bottom（见 .ai #ai.compose-open），类丢了就等于没腾
    panelClass: root.className || null,
    panelPaddingBottom: getComputedStyle(root).paddingBottom,
    bubbleHidden: Boolean(TB.ai.bubbleHidden),
    // 「完整对话」的列表必须自己被压住、自己滚：clientHeight 和 scrollHeight 都是几千像素就说明
    // 它没被容器限住（以前用 <details> 时就这样，匿名插槽盒子按内容算高度，底部整截被 .area 裁掉）。
    // inHistory = 列表底边还在 .ai-history 盒子里，越出去就是又被裁了。
    listBox: (() => {
      const node = document.querySelector('.ai-list');
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const holder = TB.ai.history || document.querySelector('.ai-history');
      const holderRect = holder.getBoundingClientRect();
      return {
        client: Math.round(node.clientHeight),
        scroll: Math.round(node.scrollHeight),
        box: Math.round(rect.top) + '→' + Math.round(rect.bottom),
        inHistory: Math.round(rect.bottom) <= Math.round(holderRect.bottom) + 1,
        // 漏出父盒但父盒 overflow:hidden 时是被裁掉的（看不见），不算盖住谁
        historyClip: getComputedStyle(holder).overflow
      };
    })(),
    detailsContent: typeof CSS !== 'undefined' && CSS.supports ? CSS.supports('selector(::details-content)') : null
  };
  // 越界 = 面板里的东西跑到格子外面（会被 .area 的 overflow:hidden 静默裁掉）。
  // 气泡不算：它是故意浮在 body 上的，判它「有没有出窗口」见 bubbleInViewport。
  const outside = (box) => Boolean(box && out.area) && (box.top < out.area.top - 1 || box.bottom > out.area.bottom + 1 || box.left < out.area.left - 1 || box.right > out.area.right + 1);
  out.outside = {
    panel: outside(out.panel),
    stage: outside(out.stage),
    history: outside(out.history),
    // 收起时 display:none，矩形是 0x0，别把它算成越界
    compose: out.composeOpen ? outside(out.compose) : false
  };
  out.bubbleParent = TB.ai.bubbleEl?.parentElement?.tagName || null;
  out.bubbleShown = Boolean(TB.ai.bubbleEl?.classList.contains('show'));
  out.bubbleText = (TB.ai.bubbleText?.textContent || '').slice(0, 24);
  out.persona = TB.ai.persona();
  out.bubbleInViewport = Boolean(out.bubble) && out.bubble.top >= 0 && out.bubble.bottom <= window.innerHeight + 1 && out.bubble.left >= 0 && out.bubble.right <= window.innerWidth + 1;
  // 贴在宠物头顶；顶边不够放时会压到窗口上沿（clamp 到 8），那也是「看得见」的合法落点
  out.bubbleAnchored = Boolean(out.bubble && out.pet) && (out.bubble.bottom <= out.pet.top + 1 || out.bubble.top <= 9);
  out.bubbleAreaClip = outside(out.bubble);
  // 宠物盒子（190px）比舞台高时会被格子上沿裁掉几像素：这是舞台自己的老问题，跟气泡无关，单独报
  out.petTopClip = out.pet && out.area ? Math.max(0, out.area.top - out.pet.top) : 0;
  // 盖住 = 浮层把面板里的东西挡住了（矮屏上最容易撞车）
  out.covers = {
    composeOverPet: covers(out.compose, out.pet),
    composeOverBubble: covers(out.compose, out.bubble),
    composeOverStage: covers(out.compose, out.stage),
    composeOverHistory: covers(out.compose, out.history),
    composeOverList: covers(out.compose, out.list)
  };
  out.stageClipped = Boolean(out.stage && out.panel && out.stage.bottom > out.panel.bottom + 1);
  return JSON.stringify(out);
})()`;
}

function stateExpression(patch) {
  const open = patch.compose ? 'TB.ai.openCompose(true)' : 'TB.ai.closeCompose(true)';
  // 「完整对话」的开合走**点标题行**这条真实路径（它是 div + .open，不是原生 details 了），
  // 直接调 setHistory() 会把 click 处理器整条跳过，等于自证了一条没人走的路
  const hist = `(() => {
    const box = document.querySelector('.ai-history');
    const want = ${patch.history ? 'true' : 'false'};
    for (let i = 0; i < 2 && box.classList.contains('open') !== want; i++) box.querySelector('.ai-history-head').click();
    return String(box.classList.contains('open') === want);
  })()`;
  // 末尾补一个 resize：真换屏/拖窗口时浏览器一定会发这个事件（Emulation 只改度量不发它），
  // 应用正是靠它把气泡重贴到宠物头顶的；不发就等于测了一条现实里不存在的路径。
  return `(() => { const histOK = ${hist}; ${open}; window.dispatchEvent(new Event('resize')); if (!histOK.startsWith('true')) throw new Error('点标题行没能开合「完整对话」'); return 'ok'; })()`;
}

// 气泡的文本来自历史里最后一条 assistant，没聊过就没有气泡可量。这里只在渲染层临时塞一条，
// 不发给模型、不落 state.json（那是主进程 commit 的事），量完用 restoreExpression 摘掉。
function seedBubbleExpression(text) {
  return `(() => {
  const ai = TB.app.state.ai || {};
  window.__aiProbeSeeded = (ai.messages || []).length;
  TB.app.state.ai = { ...ai, messages: [...(ai.messages || []), { role: 'assistant', content: ${JSON.stringify(text)}, at: Date.now() }] };
  TB.ai.update(TB.app.state);
  return JSON.stringify({ seeded: window.__aiProbeSeeded, shown: TB.ai.bubbleEl?.classList.contains('show') });
})()`;
}

function restoreBubbleExpression() {
  return `(() => {
  const ai = TB.app.state.ai || {};
  const keep = Number(window.__aiProbeSeeded || 0);
  TB.app.state.ai = { ...ai, messages: (ai.messages || []).slice(0, keep) };
  TB.ai.update(TB.app.state);
  return 'ok';
})()`;
}

// 重载之后渲染层要重新跑 init（挂组件、拉密钥状态），直接量会拿到半个面板
async function waitReady(page) {
  const expression = `(typeof TB !== 'undefined' && Boolean(TB.ai?.compose) && Boolean(document.querySelector('.ai-bubble'))) ? 'ready' : 'no'`;
  for (let i = 0; i < 40; i++) {
    try {
      if ((await evaluate(page, expression, 5000)) === 'ready') return;
    } catch {
      /* reload 瞬间上下文还没建好，继续等 */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('重载后 10s 内面板还没起来');
}

// 排版是否还在动：整份读数（矩形 + 越界/覆盖判定）连续两次一模一样才算落定
function layoutKey(box) {
  return JSON.stringify(box);
}

async function measureSettled(page, label) {
  let prev = null;
  let box = null;
  for (let i = 0; i < 20; i++) {
    box = JSON.parse(await evaluate(page, measureExpression(label), 20000));
    if (prev && layoutKey(prev) === layoutKey(box)) return box;
    prev = box;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log(`⚠ ${label}: 4s 内布局一直没落定，下面用的是最后一次读数`);
  return box;
}

async function sample(page, label, patch, shotName) {
  await evaluate(page, stateExpression(patch), 20000);
  // 开合浮层/展开历史都会改 grid，等排版落定再量，否则量到的是过渡中的矩形
  const box = await measureSettled(page, label);
  console.log(`\n[${label}] viewport ${box.viewport.w}x${box.viewport.h} / area ${box.area?.w}x${box.area?.h} (top ${box.area?.top} bottom ${box.area?.bottom})`);
  console.log(`  compose ${box.compose?.top}→${box.compose?.bottom} (h ${box.compose?.h}) pos:${box.composePos} 面板底部留白 ${box.panelPaddingBottom} [${box.panelClass}]`);
  console.log(`  stage ${box.stage?.top}→${box.stage?.bottom}  pet ${box.pet?.top}→${box.pet?.bottom} (h ${box.pet?.h})  bubble ${box.bubble?.top}→${box.bubble?.bottom}  history ${box.history?.top}→${box.history?.bottom}  list ${box.list?.top}→${box.list?.bottom}`);
  console.log(`  越界 ${JSON.stringify(box.outside)} / 覆盖 ${JSON.stringify(box.covers)} / stageClipped ${box.stageClipped}`);
  console.log(`  shell ${box.shell?.h} rows ${box.rows}`);
  console.log(`  气泡 show:${box.bubbleShown} parent:${box.bubbleParent} 在视口内:${box.bubbleInViewport} 贴宠物头顶:${box.bubbleAnchored} 出格子:${box.bubbleAreaClip}「${box.bubbleText}」(persona ${box.persona})`);
  console.log(`  列表 client ${box.listBox?.client} / scroll ${box.listBox?.scroll}（${box.listBox?.box}，在容器内:${box.listBox?.inHistory}）::details-content ${box.detailsContent}`);
  if (SHOTS) {
    const file = path.join(APP_ROOT, 'samples', shotName);
    try {
      await capture(page, file);
      console.log(`  shot ${file}`);
    } catch (error) {
      console.log(`  shot 失败：${error.message}`);
    }
  }
  return box;
}

// 视口尺寸：outerWidth/outerHeight 不受 Emulation 覆盖影响，拿它当「窗口真有多高」的尺子
async function metrics(page, widthExpr, heightExpr) {
  const expression = `JSON.stringify({w:${widthExpr},h:${heightExpr}})`;
  return JSON.parse(await evaluate(page, expression, 10000));
}

const inner = (page) => metrics(page, 'window.innerWidth', 'window.innerHeight');

// 还原视口。这份 Electron 的 Emulation 覆盖实测「设了 420 → clear → 还是 420」，
// 而覆盖不清干净，后面那些探针就会拿着矮屏排版去判高屏的格子。
// 这里把三种办法挨个试一遍，每种都量一次：只要 innerHeight 从 420 松开了就算清掉，输出会说清是哪一种。
// 全都无效时退回到「把覆盖设回真实尺寸」——那只是遮住，覆盖还在（改窗口大小不会跟着重排），
// 所以这条会明确打印出来，提醒要彻底还原就重启应用。
async function restoreViewport(page, real, shortHeight) {
  const attempts = [
    ['Emulation.clearDeviceMetricsOverride', async () => cdp(page, 'Emulation.clearDeviceMetricsOverride', {})],
    ['Emulation.setDeviceMetricsOverride 归零', async () => cdp(page, 'Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: 1, mobile: false })],
    ['Page.reload', async () => {
      await cdp(page, 'Page.reload', { ignoreCache: false });
      await new Promise((resolve) => setTimeout(resolve, 700));
      await waitReady(page);
    }]
  ];
  for (const [name, run] of attempts) {
    let error = null;
    try {
      await run();
    } catch (caught) {
      error = caught.message;
    }
    const now = await inner(page);
    const freed = now.h !== shortHeight;
    console.log(`  试 ${name}${error ? `（报错：${error}）` : ''} → 视口 ${now.w}x${now.h}${freed ? ' ✓ 覆盖松开了' : ''}`);
    if (freed) {
      const native = await metrics(page, 'window.outerWidth || window.innerWidth', 'window.outerHeight || window.innerHeight');
      if (Math.abs(now.h - native.h) > 1 || Math.abs(now.w - native.w) > 1) console.log(`  ⚠ 松开后是 ${now.w}x${now.h}，和窗口尺寸 ${native.w}x${native.h} 对不上`);
      return { freed: true, now };
    }
  }
  await setViewport(page, real.w, real.h);
  console.log(`  三种办法都清不掉覆盖（实测：clear / 归零 / Page.reload 之后 innerHeight 都还停在 ${shortHeight}）`);
  console.log(`  已把覆盖设回窗口尺寸 ${real.w}x${real.h}：量出来的和原生一致，但覆盖还在——他把窗口拖大拖小不会跟着重排`);
  console.log('  要彻底还原就重启应用：CDP 里跑 TB.api.app.quit()，再用 samples/start-app.ps1 起（别 taskkill 不带 /F）');
  return { freed: false, now: await inner(page) };
}

// 气泡的「读完三秒收起」只能在这条探针里验：它靠渲染层的计时器 + TB.voice.speaking 的转折，
// 没有别的观察口子。这里借一下 speaking（走生产路径 setSpeaking，测完还原），
// 制造一轮「说完 → 朗读中 → 朗读结束」，看气泡什么时候收。
async function checkAutoHide(page) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const read = async () => JSON.parse(await evaluate(page, 'JSON.stringify({shown: Boolean(TB.ai.bubbleEl?.classList.contains("show")), hidden: Boolean(TB.ai.bubbleHidden), speaking: Boolean(TB.voice?.speaking)})', 10000));
  const notes = [];
  await evaluate(page, 'window.__aiProbeHold = false; "ok"', 10000);
  // 末条回复多加一个字 = roundKey 变了 = 当成新一轮回复（这条消息是探针塞的，量完会整条摘掉）
  const started = await evaluate(
    page,
    `(() => {
      const list = TB.app.state.ai?.messages || [];
      const last = [...list].reverse().find((item) => item.role === 'assistant');
      if (!last) return 'no-assistant';
      last.content += '。';
      TB.ai.update(TB.app.state);
      return 'ok';
    })()`,
    10000
  );
  if (started !== 'ok') {
    notes.push(`自动收起：造不出新一轮回复（${started}），这条没验成`);
    return notes;
  }
  if (!(await read()).shown) notes.push('自动收起：新一轮回复刚出来气泡就该显示');
  await evaluate(page, 'TB.voice?.setSpeaking(true); "ok"', 10000);
  await wait(3400);
  if (!(await read()).shown) notes.push('自动收起：朗读还在进行就把气泡收了（用户听得出声、看不见字）');
  await evaluate(page, 'TB.voice?.setSpeaking(false); "ok"', 10000);
  await wait(1200);
  if (!(await read()).shown) notes.push('自动收起：朗读结束不足三秒就收了');
  await wait(2400);
  if ((await read()).shown) notes.push('自动收起：朗读结束三秒后气泡还挂着（说完了就该收）');
  // 收起之后必须还能被新一轮叫回来：流式期间 messages 还没变（用户那句要到整轮结束才落），
  // 只认 roundKey 的实现会让气泡在下一轮回复里全程不出现
  const streaming = await evaluate(
    page,
    `(() => {
      window.__aiProbeStream = TB.app.state.ai?.stream || null;
      TB.app.state.ai = { ...TB.app.state.ai, streaming: true, stream: { text: '新一轮正在吐字', reasoning: '', tools: [] } };
      TB.ai.update(TB.app.state);
      return String(Boolean(TB.ai.bubbleEl?.classList.contains('show')));
    })()`,
    20000
  );
  if (streaming !== 'true') notes.push('自动收起：收过一次之后，下一轮流式没把气泡叫回来（整轮都看不见它在说什么）');
  // 万一应用真在朗读或有流式在跑，把状态交还给原样
  await evaluate(
    page,
    `(() => {
      TB.app.state.ai = { ...TB.app.state.ai, streaming: false, stream: window.__aiProbeStream || null };
      TB.voice?.setSpeaking(false);
      TB.ai.bubbleHidden = false;
      TB.ai.bubbleTimer = null;
      TB.ai.update(TB.app.state);
      return 'ok';
    })()`,
    20000
  );
  return notes;
}

async function setViewport(page, width, height) {
  await cdp(page, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  // Emulation 只改度量，不发 resize：真换屏/拖窗口是带 resize 的，应用里的跟着布局走的逻辑
  // （气泡重贴、gauges 高度判断）不会跑。所以覆盖完自己补发一个，否则量到的是「换屏但没人醒着」的假状态。
  // 光发事件还不够：grid 轨道此时还是上一档的尺寸（实测第一个样本 area 顶边 236 vs 落定 183），
  // 得改一下属性把样式判脏、逼浏览器重排一次。
  await evaluate(
    page,
    `(() => {
      const shell = document.getElementById('shell');
      shell.dataset.probe = '1';
      void shell.offsetHeight;
      delete shell.dataset.probe;
      window.dispatchEvent(new Event('resize'));
      return 'ok';
    })()`,
    10000
  );
  // 改了 innerHeight，grid 轨道不是同一帧就重排好的：直接量会拿重排前的矩形，
  // 于是 area/宠物/气泡全是上一档的尺寸，越界结论跟着错（实测踩过）。等 .shell 真的高度追上新视口再放行。
  const probe = 'JSON.stringify({h:window.innerHeight,shell:Math.round(document.querySelector(".shell").getBoundingClientRect().height)})';
  let last = null;
  for (let i = 0; i < 25; i++) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    last = JSON.parse(await evaluate(page, probe, 8000));
    if (last.h === height && Math.abs(last.shell - height) <= 1) return;
  }
  throw new Error(`视口没稳住：目标 ${width}x${height}，实测 ${JSON.stringify(last)}`);
}

async function main() {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((item) => item.type === 'page' && item.url.includes('renderer/index.html'));
  if (!page) throw new Error(`CDP 端口 ${PORT} 上找不到工具栏渲染层，先跑 samples/start-app.ps1`);
  console.log(`[appprobe] 附着 ${page.title || page.url}`);

  // 改了渲染层代码/样式后不用重启应用：--reload 走一次 Page.reload，新 CSS 立刻生效
  if (RELOAD) {
    await cdp(page, 'Page.reload', { ignoreCache: true });
    await new Promise((resolve) => setTimeout(resolve, 700));
    await waitReady(page);
    console.log('[appprobe] 已重载渲染层');
  }

  // Electron 的 CDP 没开 Browser 域（Browser.setWindowBounds 报 wasn't found），改不了真窗口，
  // 只能用 Emulation 覆盖视口来复现矮屏——grid 轨道按 innerHeight 算，跟换一块矮屏看到的一样。
  // 坑（实测）：这份 Electron 的 Emulation.clearDeviceMetricsOverride 不生效，innerHeight 会一直停在旧覆盖值，
  // 而 outerWidth/outerHeight 不受覆盖影响。所以「恢复原尺寸」= 把覆盖重新设回 outer 尺寸，
  // 开工时也先拿 outer 当尺子，把上一轮被 Ctrl+C 留下的覆盖拉回来，免得"原生"量到的其实是上次的矮屏。
  const real = await metrics(page, 'window.outerWidth || window.innerWidth', 'window.outerHeight || window.innerHeight');
  const now = await metrics(page, 'window.innerWidth', 'window.innerHeight');
  if (real.w !== now.w || real.h !== now.h) {
    await setViewport(page, real.w, real.h);
    console.log(`清掉上一轮残留的视口覆盖 ${now.w}x${now.h} → 窗口真实尺寸 ${real.w}x${real.h}`);
  }
  const native = await metrics(page, 'window.innerWidth', 'window.innerHeight');
  console.log(`原生视口 ${native.w}x${native.h}`);

  if (HEIGHT_ARG) {
    await setViewport(page, real.w, HEIGHT_ARG);
    console.log(`视口压到 ${real.w}x${HEIGHT_ARG}`);
  }

  const seeded = JSON.parse(await evaluate(page, seedBubbleExpression('这段是用来量气泡浮层几何的占位文本，会写得足够长，好让矮屏下顶边放不下。'), 20000));
  if (!seeded.shown) console.log('注意：塞了文本气泡也没显示（persona 为 plain 时会收舞台），下面 bubble 一栏会是 0x0');
  // 气泡现在会「读完三秒收起」，几何采样期间先把它按住（见 measureExpression 里的 __aiProbeHold）
  await evaluate(page, 'window.__aiProbeHold = true; "ok"', 10000);

  const closed = await sample(page, '都收起', { compose: false, history: false }, 'ai-closed.png');
  const typing = await sample(page, '打字浮层', { compose: true, history: false }, 'ai-compose.png');
  const history = await sample(page, '完整对话展开', { compose: false, history: true }, 'ai-history.png');
  const both = await sample(page, '两个都开', { compose: true, history: true }, 'ai-both.png');

  // 自动收起要在「探针不按住气泡」的状态下量，所以放在四个几何样本之后、还原消息之前
  const autoHide = await checkAutoHide(page);

  await evaluate(page, restoreBubbleExpression(), 20000);
  await evaluate(page, 'TB.ai.closeCompose(true);TB.ai.setHistory(false);"ok"', 20000);
  if (HEIGHT_ARG) {
    console.log('\n[还原视口]');
    await restoreViewport(page, real, HEIGHT_ARG);
  }

  const all = [closed, typing, history, both];
  const problems = [];
  for (const box of all) {
    for (const [key, value] of Object.entries(box.outside)) if (value) problems.push(`${box.label}: ${key} 越出格子（会被 overflow:hidden 裁掉）`);
    if (box.composeOpen && box.compose && box.compose.bottom > box.viewport.h + 1) problems.push(`${box.label}: 打字浮层底边超出窗口 ${box.compose.bottom} > ${box.viewport.h}`);
    // 气泡是故意浮出格子的：判据换成「还在不在窗口里」+「有没有贴回宠物头顶」
    if (box.bubbleShown) {
      if (box.bubbleParent !== 'BODY') problems.push(`${box.label}: 气泡还挂在 ${box.bubbleParent} 上，矮屏会被 overflow:hidden 裁掉`);
      if (!box.bubbleInViewport) problems.push(`${box.label}: 气泡跑出窗口（${JSON.stringify(box.bubble)} / 视口 ${box.viewport.w}x${box.viewport.h}）`);
      if (!box.bubbleAnchored) problems.push(`${box.label}: 气泡没贴在宠物头顶（bubble bottom ${box.bubble?.bottom} vs pet top ${box.pet?.top}）`);
    }
    // 宠物头顶被格子上沿裁掉 = 舞台没让宠物跟着缩；浮层盖到面板里的任何东西 = 底部那条带没腾出来
    if (box.petTopClip) problems.push(`${box.label}: 宠物头顶被格子上沿裁掉 ${box.petTopClip}px（舞台没给宠物留收缩余地）`);
    if (box.composeOpen) {
      if (!/compose-open/.test(box.panelClass || '')) problems.push(`${box.label}: 浮层开着但面板没挂 compose-open，没给底部腾地方`);
      for (const key of ['pet', 'stage', 'history', 'bubble']) {
        const flag = `composeOver${key[0].toUpperCase()}${key.slice(1)}`;
        if (box.covers[flag]) {
          problems.push(`${box.label}: 打字浮层盖住了${key}（compose ${box.compose.top}→${box.compose.bottom} vs ${key} ${box[key]?.top}→${box[key]?.bottom}）`);
        }
      }
      // 列表只有在「展开且没撑出容器」时才真的画在那儿，否则它的矩形是 details 隐藏内容的空盒子，不算遮挡
      if (box.historyOpen && box.listBox?.inHistory && box.covers.composeOverList) {
        problems.push(`${box.label}: 打字浮层盖住了聊天列表（compose ${box.compose.top}→${box.compose.bottom} vs list ${box.listBox.box}）`);
      }
    }
    if (box.historyOpen && box.listBox && !box.listBox.inHistory) {
      if (box.listBox.historyClip === 'visible') {
        problems.push(`${box.label}: 完整对话的列表撑出容器（list ${box.listBox.box} vs history ${box.history?.bottom}），会盖到下面去`);
      } else {
        console.log(`  ℹ ${box.label}: 空间不够，聊天列表被 .ai-history 裁到只剩标题行（overflow:${box.listBox.historyClip}）`);
      }
    }
  }
  problems.push(...autoHide);
  console.log(`\n越界与遮挡：${problems.length ? '' : '无'}`);
  for (const line of problems) console.log(`✗ ${line}`);
  if (problems.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[appprobe] 失败：${error.message}`);
  process.exitCode = 1;
});
