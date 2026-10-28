// 宠物接本机工具（只读 search_files）的真机整链验证。
// 开关、工具执行、界面提示、落盘内容这几件事只有在模型真的点一次工具才验得出来，
// 所以这条探针会发一次真实的 DeepSeek 请求（这就是本功能唯一的行为差异点）。
// 用法（Git Bash）:
//   1) powershell -NoProfile -ExecutionPolicy Bypass -File samples/start-app.ps1 -Root "D:/GitProject/toolbar" -Port 9223
//   2) node tools/agent-appprobe.js [端口] [--shot] [--check] [--keep] [--ask "换个问题"]
// 默认那条问题会往 %TEMP% 建一个随机两层目录里的文件、验完删掉，保证模型只能靠工具答。
// 结尾一定把 ai.agentTools.enabled / model / search.enabled 恢复成进来时的值——
// 万一进程被杀在这中间，手动把 toolbar.config.json 里的 ai.agentTools.enabled 改回 false 即可。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(process.env.APPDATA || '', 'screen-toolbar', 'state.json');
const PORT = Number(process.argv[2] || 9223);
const SHOTS = process.argv.includes('--shot');
// --check 只看前置（密钥在不在、Everything 跑没跑），不发真实请求、不动配置、不建文件
const CHECK = process.argv.includes('--check');
// --keep 跑完不恢复 ai.agentTools.enabled，把开关留在「开」——他要「开着用」的时候用这条
const KEEP = process.argv.includes('--keep');
// --ask 是给手工试玩的：自己换成一个历史里没答过、本机又真有的文件名，
// 否则下面「回答里必须出现这个文件名」那条会照样判失败。
const ASK_ARG = (() => {
  const at = process.argv.indexOf('--ask');
  return at > 0 ? process.argv[at + 1] || null : null;
})();
// 问题必须问一个「历史里没出现过、也猜不出来」的文件：模型一旦能从上一轮的回答里抄
// （真机上一回就栽在这：%TEMP%\toolbar-agent-probe-xxx.txt 这个形状被它学去了，
// 直接凭历史答出正确路径、根本不点工具），验的就不是工具链而是它的记忆力了。
// 所以随机文件名 + 随机两层目录，谁都不可能猜中；能答对只可能是真查了索引。
const R = () => Math.random().toString(36).slice(2, 8);
const PROBE_ROOT = path.join(require('node:os').tmpdir(), `tb-agent-${R()}`);
const PROBE_FILE = path.join(PROBE_ROOT, `nest-${R()}`, `probe-${R()}.txt`);
const PROBE_NAME = path.basename(PROBE_FILE);
const PROBE_DIR = path.basename(path.dirname(PROBE_FILE));
const ASK = ASK_ARG || `帮我用本机文件索引查一下 ${PROBE_NAME} 这个文件在哪个目录`;

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

// 进来时什么样先记住，还有跑这条验证需要的两个前置（密钥、Everything）在不在
function snapshotExpression() {
  return `(async () => {
  const cfg = TB.app.state.config || {};
  const key = await TB.api.ai.keyStatus();
  let status = await TB.api.search.status();
  if (status.installed && !status.running) status = await TB.api.search.startHost();
  if (!status.running) status = await TB.api.search.probe();
  return JSON.stringify({
    agentTools: cfg.ai?.agentTools?.enabled === true,
    model: cfg.ai?.model || 'deepseek-chat',
    search: cfg.search?.enabled !== false,
    keySet: Boolean(key?.set),
    searchInstalled: Boolean(status.installed),
    searchRunning: Boolean(status.running),
    searchError: status.lastError || null,
    historyLength: (TB.app.state.ai?.messages || []).length
  });
})()`;
}

// 打开关：走用户路径 config.save → applyConfigResult（会重建界面，工具清单每轮现取所以不用重启）
function enableExpression() {
  return `(async () => {
  const cfg = TB.app.state.config || {};
  const result = await TB.api.config.save({
    ai: { agentTools: { ...(cfg.ai?.agentTools || {}), enabled: true }, model: 'deepseek-chat' },
    search: { enabled: true }
  });
  TB.app.applyConfigResult(result);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const now = TB.app.state.config;
  return JSON.stringify({ agentTools: now.ai.agentTools?.enabled === true, model: now.ai.model, search: now.search?.enabled !== false });
})()`;
}

// 真的问一句：工具事件、泡下面的提示行、最终回答都在这一步收。
// 注意 submit() 里那句 invoke('ai:send') 要等整轮请求跑完才 resolve，
// 所以提示行必须在它 pending 期间采样——await 它再采样就永远只会看到空。
// 提问分成「起」和「采样」两步，中间由本进程轮询：
// submit() 里那句 invoke('ai:send') 要等整轮请求跑完才 resolve，
// 在一次 evaluate 里 await 它就永远采不到流式期间才存在的提示行（第一版就栽在这）。
function startAskExpression(question, historyLength) {
  const literal = JSON.stringify(question);
  const keep = Number(historyLength) || 0;
  return `(() => {
  const p = (window.__agentProbe = { toolEvents: [], hints: [], samples: 0, settled: false, submitError: null, before: ${keep} });
  TB.api.ai.onTool((payload) => p.toolEvents.push({ name: payload.name, label: payload.label, count: payload.count }));
  TB.ai.input.value = ${literal};
  TB.ai.submit().then(() => { p.settled = true; }).catch((error) => { p.settled = true; p.submitError = String(error?.message || error); });
  return 'started';
})()`;
}

function pollAskExpression() {
  return `(() => {
  const p = window.__agentProbe;
  if (!p) return JSON.stringify({ missing: true });
  p.samples += 1;
  const node = document.querySelector('.ai-tool');
  const hint = node?.textContent?.trim() || '';
  if (hint && !p.hints.includes(hint)) p.hints.push(hint);
  // 只在提示行有内容的那几拍记 class，否则最后一次采样会把「已经空掉」的样子当成全程
  if (node && hint) p.hintClass = node.className;
  p.streaming = Boolean(TB.app.state.ai.streaming);
  const stream = TB.app.state.ai.stream;
  if (stream?.text) p.liveText = stream.text;
  const messages = (TB.app.state.ai?.messages || []).slice(p.before);
  p.roles = messages.map((item) => item.role);
  const final = messages.filter((item) => item.role === 'assistant').at(-1)?.content || '';
  p.answer = final || p.liveText || '';
  p.promptShown = (document.querySelector('.ai-ask')?.textContent || '').length > 0;
  return JSON.stringify({ settled: p.settled, streaming: p.streaming, hint: Boolean(hint), samples: p.samples });
})()`;
}

// 新文件要先进 Everything 的索引，模型才查得到；没等到就提问会把索引慢判成工具坏了
function indexedExpression(name) {
  return `(async () => {
  const r = await TB.api.search.query(${JSON.stringify(name)});
  return JSON.stringify({ ok: Boolean(r.ok), items: (r.items || []).length, message: r.message || null });
})()`;
}

function collectAskExpression() {
  return `(() => {
  const p = window.__agentProbe || {};
  p.hintGoneAfter = !document.querySelector('.ai-tool.show');
  return JSON.stringify(p);
})()`;
}

function restoreExpression(snapshot) {
  const before = JSON.stringify(snapshot);
  return `(async () => {
  const before = ${before};
  const cfg = TB.app.state.config || {};
  const result = await TB.api.config.save({
    ai: { agentTools: { ...(cfg.ai?.agentTools || {}), enabled: before.agentTools }, model: before.model },
    search: { enabled: before.search }
  });
  TB.app.applyConfigResult(result);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const now = TB.app.state.config;
  return JSON.stringify({ agentTools: now.ai.agentTools?.enabled === true, model: now.ai.model, search: now.search?.enabled !== false });
})()`;
}

// 工具结果里的绝对路径是模型回答的一部分，但它不该作为「工具轮次」落盘：
// state.json 里只许有 user/assistant，且不许出现 tool_calls / role:"tool"
function readState(historyLength) {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (error) {
    return { readable: false, error: error.message };
  }
  const chat = Array.isArray(parsed.aiChat) ? parsed.aiChat : [];
  const raw = JSON.stringify(chat);
  const mine = chat.slice(Number(historyLength) || 0);
  return {
    readable: true,
    roles: mine.map((item) => item.role),
    hasToolRole: chat.some((item) => item.role === 'tool'),
    hasToolCalls: chat.some((item) => item.tool_calls),
    // 工具原始输出那行的形状是「关键字「x」全盘命中 N 条，给你前 M 条：」
    hasRawToolText: /全盘命中.*条/.test(raw),
    total: chat.length
  };
}

function mainPathsFrom(answer) {
  // 允许路径里有空格（"Program Files"），但到行尾就停：模型是列点回答的
  const found = String(answer).match(/[A-Za-z]:[\\/][^\n"'`，。；、]*/g) || [];
  const cleaned = [...new Set(found.map((item) => item.replace(/[.,;:)\]]+$/, '').trim()))];
  return cleaned.map((item) => {
    let exists = false;
    try {
      exists = fs.existsSync(item);
    } catch {
      exists = false;
    }
    return { path: item, exists };
  }).slice(0, 5);
}

async function waitForPage(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      const page = targets.find((item) => item.type === 'page' && item.url.includes('renderer/index.html'));
      if (page) return page;
    } catch {
      // 应用还在起，CDP 端口没就绪
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`CDP 端口 ${PORT} 上等不到工具栏渲染层，先跑 samples/start-app.ps1`);
}

let probeFileCreated = false;

function cleanupProbeFile() {
  if (probeFileCreated) fs.rmSync(PROBE_ROOT, { recursive: true, force: true });
  probeFileCreated = false;
}

async function main() {
  const page = await waitForPage();
  console.log(`[appprobe] 附着 ${page.title || page.url}`);

  const snap = JSON.parse(await evaluate(page, snapshotExpression(), 30000));
  for (const [key, value] of Object.entries(snap)) console.log(`snap.${key}: ${JSON.stringify(value)}`);
  if (!snap.keySet) throw new Error('这台机器还没保存 DeepSeek 密钥，验不了真实一轮工具调用');
  if (!snap.searchInstalled) throw new Error('vendor/everything 没装好，工具会只回「没查成」');
  if (CHECK) {
    console.log(snap.searchRunning ? '[appprobe] --check 通过：前置都在，可以跑整链（会发一次真实请求）' : '[appprobe] --check：Everything 没起来，整链会走到但工具只回「没查成」');
    return;
  }

  let asked = null;
  let enabled = null;
  let restored = null;
  let shotFile = null;
  try {
    if (!ASK_ARG) {
      fs.mkdirSync(path.dirname(PROBE_FILE), { recursive: true });
      fs.writeFileSync(PROBE_FILE, 'toolbar agent appprobe\n', 'utf8');
      probeFileCreated = true;
      console.log(`probe-file: ${PROBE_FILE}`);
    }
    enabled = JSON.parse(await evaluate(page, enableExpression(), 60000));
    for (const [key, value] of Object.entries(enabled)) console.log(`enable.${key}: ${JSON.stringify(value)}`);
    console.log(`question: ${ASK}`);
    if (!ASK_ARG) {
      let seen = null;
      for (let i = 0; i < 20; i++) {
        seen = JSON.parse(await evaluate(page, indexedExpression(PROBE_NAME), 20000));
        if (seen.items > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      console.log(`indexed: ${JSON.stringify(seen)}`);
      if (!seen?.items) throw new Error('刚建的探针文件 14 秒后仍没进 Everything 索引，问了也是白问');
    }
    await evaluate(page, startAskExpression(ASK, snap.historyLength), 30000);
    let tick = null;
    for (let i = 0; i < 300; i++) {
      tick = JSON.parse(await evaluate(page, pollAskExpression(), 20000));
      // 提示行只在流式期间存在，截图必须趁它还在的时候抓
      if (SHOTS && tick.hint && !shotFile) {
        try {
          shotFile = path.join(APP_ROOT, 'samples', 'agent-panel.png');
          await capture(page, shotFile);
          console.log(`[appprobe] 截图（提示行还在屏上时）${shotFile}`);
        } catch (error) {
          console.log(`[appprobe] 截图失败（不影响功能判定）：${error.message}`);
        }
      }
      if (tick.settled && !tick.streaming) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    asked = JSON.parse(await evaluate(page, collectAskExpression(), 20000));
    asked.settled = tick?.settled;
    asked.samples = tick?.samples;
    for (const [key, value] of Object.entries(asked)) {
      if (key === 'before') continue;
      console.log(`ask.${key}: ${typeof value === 'object' && value ? JSON.stringify(value) : value}`);
    }
  } finally {
    // 不管前面走到哪一步，开关都要恢复原值；这一步失败只报告，不掩盖前面的结论
    try {
      restored = JSON.parse(await evaluate(page, restoreExpression({ ...snap, agentTools: KEEP ? true : snap.agentTools }), 60000));
      for (const [key, value] of Object.entries(restored)) console.log(`restore.${key}: ${JSON.stringify(value)}`);
    } catch (error) {
      console.log(`restore 失败：${error.message}（请手动确认 toolbar.config.json 里 ai.agentTools.enabled）`);
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 800));
  const state = readState(snap.historyLength);
  for (const [key, value] of Object.entries(state)) console.log(`state.${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);

  const paths = mainPathsFrom(asked?.answer || '');
  for (const item of paths) console.log(`answer-path: ${item.path} exists=${item.exists}`);
  // 那个探针文件要活到 existsSync 之后才能删：先删再验就会把「路径是真的」判成「模型在编」
  cleanupProbeFile();

  const failures = [];
  if (!snap.searchRunning) failures.push(`Everything 没在跑：${snap.searchError}`);
  if (!enabled) failures.push('没走到开启这一步');
  else if (!enabled.agentTools || enabled.model !== 'deepseek-chat') failures.push(`开关没生效：${JSON.stringify(enabled)}`);
  if (!asked) failures.push('没走到提问这一步');
  else {
    if (asked.error || asked.submitError) failures.push(`这轮请求报错：${asked.error || asked.submitError}`);
    if (!asked.settled || asked.streaming) failures.push(`等不到流式结束（采样 ${asked.samples} 次）`);
    if (asked.toolEvents.length !== 1) failures.push(`ai:tool 事件应是 1 条，实际 ${asked.toolEvents.length}：${JSON.stringify(asked.toolEvents)}（模型没点工具？问题是不是历史里答过）`);
    else if (asked.toolEvents[0].name !== 'search_files' || !(asked.toolEvents[0].count > 0)) failures.push(`工具事件内容不对：${JSON.stringify(asked.toolEvents[0])}`);
    if (!asked.hints.length) failures.push(`泡下面那行「查了本机文件索引…」没出现过（class=${asked.hintClass}）`);
    if (!asked.hintGoneAfter) failures.push('回答结束后提示行还挂在屏上');
    if (JSON.stringify(asked.roles) !== '["user","assistant"]') failures.push(`这一轮历史里只该有 user+assistant：${JSON.stringify(asked.roles)}`);
    if (!paths.length) failures.push('回答里一个绝对路径都没有——工具结果没进最终文案');
    else if (!paths.some((item) => item.exists)) failures.push('回答里的路径本机都不存在（模型在编）');
    if (!ASK_ARG && !String(asked.answer).includes(PROBE_NAME)) failures.push('回答里没提到刚建的那个文件名（工具结果没进回答）');
    if (!ASK_ARG && !String(asked.answer).includes(PROBE_DIR)) failures.push('回答里没有那层随机目录名——它没查索引，是照着上一轮的历史编的');
  }
  if (!state.readable) failures.push(`读不到 ${STATE_FILE}：${state.error}`);
  else {
    if (state.hasToolRole || state.hasToolCalls) failures.push('工具轮次落盘了（state.json 里出现 role:"tool" 或 tool_calls）');
    if (state.hasRawToolText) failures.push('工具原始输出整段落盘了（命中统计那行出现在 state.json）');
  }
  if (!restored) failures.push('没恢复到原配置');
  else {
    const want = KEEP ? true : snap.agentTools;
    if (restored.agentTools !== want) failures.push(`ai.agentTools.enabled 没写成 ${want}（现在是 ${restored.agentTools}）`);
    if (restored.model !== snap.model) failures.push(`模型没恢复成 ${snap.model}`);
    if (restored.search !== snap.search) failures.push(`search.enabled 没恢复成 ${snap.search}`);
  }

  if (failures.length) {
    for (const line of failures) console.log(`✗ ${line}`);
    process.exitCode = 1;
  } else {
    const hit = asked.toolEvents[0];
    console.log(`✓ 宠物→Everything 全绿：${hit.label} 命中 ${hit.count} 条，回答里的路径本机存在，工具轮次没落盘，${KEEP ? '开关留在「开」' : '配置已恢复'}`);
  }
}

main().catch((error) => {
  cleanupProbeFile();
  console.error(`[appprobe] 失败：${error.message}`);
  process.exitCode = 1;
});
