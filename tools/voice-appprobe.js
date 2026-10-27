// 完整链路验证：附着到真实运行的工具栏（需带 --remote-debugging-port 启动），
// 在渲染层里跑一遍 麦克风→ASR→输入框/自动发送 和 TTS→解码→播放→宠物口型，不依赖真的说话。
// 用法（Git Bash）:
//   1) ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
//   2) node tools/voice-appprobe.js [端口] [--with-ai] [--shot]
// 「说完即发送」默认开着，所以脚本期间会临时关掉它、只把 submit 打桩来验接线；
// --with-ai 是唯一真发一条 DeepSeek 消息的分支（花钱、进对话历史），用来验「回复完成→自动朗读」这一段。
// --shot 再截两张真实画面（对话浮层收起 / 打开）到 samples/，改布局时用它肉眼核对。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || 9223);
const WITH_AI = process.argv.includes('--with-ai');
const SHOTS = process.argv.includes('--shot');
const WAV = path.join(APP_ROOT, 'models', 'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30', 'test_wavs', '0.wav');

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

function pcm16Base64(wavFile) {
  const buf = fs.readFileSync(wavFile);
  for (let cursor = 12; cursor + 8 <= buf.length; ) {
    const id = buf.toString('ascii', cursor, cursor + 4);
    const size = buf.readUInt32LE(cursor + 4);
    if (id === 'data') return buf.subarray(cursor + 8, cursor + 8 + size).toString('base64');
    cursor += 8 + size + (size % 2);
  }
  throw new Error(`${wavFile} 没有 data 段`);
}

// 这一段在渲染层里执行，返回值必须是可 JSON 序列化的字符串
function buildExpression(pcmBase64) {
  return `(async () => {
  const LIVE_AI = ${WITH_AI};
  const out = {};
  // 「说完即发送」默认开着，下面伪造的 final 事件会真发一条 AI 消息（花钱、进历史）。
  // 先全局关掉，只有 2b 那段临时打开并把 submit 接住。
  const voiceCfg = TB.app.state.config?.voice;
  const autoSendBackup = voiceCfg ? voiceCfg.autoSend : undefined;
  if (voiceCfg) voiceCfg.autoSend = false;
  out.autoSendDefaultConfig = autoSendBackup === undefined ? null : autoSendBackup;
  const status = await TB.api.voice.status();
  out.workerRunning = status.running;
  out.asrOk = Boolean(status.asr && status.asr.ok);
  out.ttsOk = Boolean(status.tts && status.tts.ok);
  out.micButton = Boolean(document.querySelector('.voice-mic'));
  out.micDisabled = Boolean(document.querySelector('.voice-mic')?.disabled);
  // 对话栏原来是常驻的：开跑前先确认它默认是收起来的（后面各段会把它撑开）
  out.composeOpenAtStart = TB.ai?.compose ? TB.ai.compose.classList.contains('open') : null;

  try {
  // ---- 1. 用测试音频冒充麦克风，走 renderer→preload→main→worker 的上行 ----
  if (out.asrOk) {
    const bytes = Uint8Array.from(atob('${pcmBase64}'), (c) => c.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer);
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) samples[i] = pcm[i] / 32768;
    const id = await TB.api.voice.asrStart(16000);
    let finalText = null;
    const partials = [];
    TB.api.voice.onAsr((event) => {
      if (event.id !== id) return;
      if (event.final) finalText = event.text;
      else partials.push(event.text);
    });
    const block = 1600;
    for (let offset = 0; offset < samples.length; offset += block) {
      TB.api.voice.asrChunk(id, samples.slice(offset, offset + block), 16000);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    TB.api.voice.asrEnd(id);
    for (let wait = 0; wait < 250 && finalText === null; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    out.asrPartials = partials.length;
    out.asrFinal = finalText;
  }

  // ---- 2. 草稿进输入框是组件里的 TB.voice.onAsr 干的，单独验一次接线 ----
  if (TB.voice?.ai?.input) {
    const backup = TB.voice.ai.input.value;
    TB.voice.onAsr({ text: '接线检查', final: false });
    out.draftInInput = TB.voice.ai.input.value;
    out.draftMarked = TB.voice.ai.input.classList.contains('voice-live');
    TB.voice.onAsr({ text: backup, final: true });
    out.draftRestored = TB.voice.ai.input.value === backup;
  }

  // ---- 2b. 「说完即发送」开关：final 事件要叫起 submit，但不让它真发消息 ----
  if (TB.voice?.ai?.input) {
    const comp = TB.voice.ai;
    const backupInput = comp.input.value;
    const backupSubmit = comp.submit;
    let captured = null;
    comp.submit = () => { captured = comp.input.value; };
    // 只改内存里的配置，不写盘：落盘的开关状态由设置面板负责
    voiceCfg.autoSend = true;
    TB.voice.onAsr({ text: '说完即发送', final: true });
    out.autoSendSubmits = captured;
    voiceCfg.autoSend = false;
    TB.voice.onAsr({ text: '留给手改', final: true });
    out.autoSendOffKeepsDraft = comp.input.value;
    out.autoSendOffFocused = document.activeElement === comp.input;
    comp.submit = backupSubmit;
    comp.input.value = backupInput;
    comp.input.classList.remove('voice-live');
  }

  // ---- 3. 合成一句，确认渲染层拿得到字节并解码得动 ----
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const res = await TB.api.voice.speak('链路验证。', {});
    out.ttsInvokeOk = res.ok;
    out.ttsEngine = res.audio && res.audio.engine;
    out.ttsFormat = res.audio && res.audio.format;
    out.ttsBytes = res.audio ? res.audio.bytes.byteLength : res.message;
    if (res.ok) {
      const ctx = new AudioContext();
      out.audioCtxState = ctx.state;
      const buffer = await ctx.decodeAudioData(res.audio.bytes.slice().buffer);
      out.ttsDurationMs = Math.round(buffer.duration * 1000);
      await ctx.close();
    }
  } catch (error) {
    out.ttsError = String((error && error.message) || error);
  }

  // ---- 4. 真走组件路径：speak → playing → speaking → 宠物口型 ----
  if (TB.voice && TB.voice.ai) {
    const startedAt = Date.now();
    TB.voice.speak('链路验证，看看口型。');
    out.speakingDuring = TB.voice.speaking;
    out.petTalkingDuring = TB.ai.petShown ? TB.ai.petShown.talk : null;
    const deadline = startedAt + 30000;
    while (TB.voice.speaking && Date.now() < deadline) await sleep(250);
    out.speakingAfter = TB.voice.speaking;
    out.petTalkingAfter = TB.ai.petShown ? TB.ai.petShown.talk : null;
    out.speakSpanMs = Date.now() - startedAt;
  } else {
    out.componentPathSkipped = 'AI 组件未挂载（TB.voice.ai 为空）';
  }

  // ---- 5. 自动朗读这一段是 ai:done 触发的，伪造一条回复把同一段代码跑一遍 ----
  const ai = TB.app.state.ai || {};
  out.aiKeySet = Boolean(ai.key && ai.key.set);
  out.autoSpeakConfig = Boolean(TB.app.state.config?.voice?.autoSpeak);
  out.ttsReady = TB.voice ? TB.voice.ttsReady() : null;
  if (TB.voice && TB.ai) {
    const backup = ai.messages;
    TB.app.state.ai.messages = [{ role: 'assistant', content: '这是自动朗读接线的测试句。' }];
    TB.voice.onAiDone();
    await sleep(1500);
    out.autoSpeakSpeaking = TB.voice.speaking;
    out.autoSpeakPetTalk = TB.ai.petShown ? TB.ai.petShown.talk : null;
    const deadline = Date.now() + 20000;
    while (TB.voice.speaking && Date.now() < deadline) await sleep(250);
    out.autoSpeakFinished = !TB.voice.speaking;
    TB.app.state.ai.messages = backup;
    TB.app.refresh('ai');
  }

  // ---- 6. 真发一条 AI 消息：ai:done 之后自动朗读到底起不起（要花钱）----
  if (LIVE_AI && TB.voice) {
    const before = (TB.app.state.ai.messages || []).length;
    let doneSawAssistant = null;
    TB.api.ai.onDone(() => {
      const messages = TB.app.state.ai.messages || [];
      const last = [...messages].reverse().find((item) => item.role === 'assistant');
      doneSawAssistant = { count: messages.length, text: last ? String(last.content).slice(0, 24) : null };
    });
    await TB.api.ai.send('用不超过十二个字回答：你好吗');
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (TB.voice.speaking) { out.liveSpeakStarted = true; break; }
      if (TB.app.state.ai.error) break;
      await sleep(250);
    }
    out.doneSawAssistant = doneSawAssistant;
    out.liveError = TB.app.state.ai.error ? TB.app.state.ai.error.message : null;
    out.liveLastMessage = String(((TB.app.state.ai.messages || [])[before] || {}).content || '').slice(0, 30);
    const settle = Date.now() + 30000;
    while (TB.voice.speaking && Date.now() < settle) await sleep(250);
    out.liveSpeakFinished = !TB.voice.speaking;
  }

  // ---- 7. 设置面板字段齐全：语音卡片每加一个键都要有控件+保存，漏了就静默丢 ----
  TB.settings.open('voice');
  const voiceCard = document.querySelector('[data-card="voice"]');
  out.voiceCardFields = voiceCard ? [...voiceCard.querySelectorAll('.field-label')].map((node) => node.textContent) : null;
  out.configVoiceKeys = Object.keys(TB.app.state.config.voice || {}).sort();
  TB.settings.close();

  // ---- 8. 对话栏浮层：常驻栏去掉了，开合和「录音中/有草稿不许收」都得验 ----
  if (TB.ai?.compose) {
    const compose = TB.ai.compose;
    out.composeParentIsPanel = compose.parentElement === document.querySelector('#ai');
    out.micInCompose = TB.voice?.mic ? compose.contains(TB.voice.mic) : null;
    TB.ai.input.value = '';
    TB.ai.closeCompose(true);
    out.composeForceCloses = !compose.classList.contains('open');
    TB.ai.openCompose(true);
    out.composeOpens = compose.classList.contains('open');
    out.composeFocusesInput = document.activeElement === TB.ai.input;
    TB.voice.recording = true;
    TB.ai.closeCompose();
    out.staysOpenWhileRecording = compose.classList.contains('open');
    TB.voice.recording = false;
    TB.ai.input.value = '留着别丢';
    TB.ai.closeCompose();
    out.staysOpenWithDraft = compose.classList.contains('open');
    TB.ai.input.value = '';
    TB.ai.closeCompose();
    out.composeClosesWhenEmpty = !compose.classList.contains('open');
    // 不发真消息（submit 会花钱），只验 submit 用来收口的那句 closeCompose(true) 确实能收
    TB.ai.input.value = '浮层收起检查';
    TB.ai.openCompose(false);
    TB.ai.closeCompose(true);
    out.submitStyleClose = !compose.classList.contains('open');
    TB.ai.input.value = '';
  } else {
    out.composeMissing = 'TB.ai.compose 不存在';
  }
  // ---- 9. 宠物手势接线：不碰真麦克风（把 asrReady 暂时判死），看单击有没有退回打字 ----
  if (TB.ai?.compose && TB.voice) {
    const pet = document.querySelector('.ai-pet');
    out.tapIsFunction = typeof TB.voice.tap === 'function';
    TB.ai.closeCompose(true);
    const realReady = TB.voice.asrReady;
    TB.voice.asrReady = () => false;
    pet.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(400);
    out.clickFallsBackToCompose = TB.ai.compose.classList.contains('open');
    TB.voice.asrReady = realReady;
    TB.ai.closeCompose(true);
    pet.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await sleep(60);
    out.dblclickOpensCompose = TB.ai.compose.classList.contains('open');
    // 右键=打断朗读/生成：这里没有流式请求，只要不抛就算接线通
    pet.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    out.rightClickNoThrow = true;
    TB.ai.closeCompose(true);
    out.composeClosedAtEnd = !TB.ai.compose.classList.contains('open');
  }
  return JSON.stringify(out);
  } finally {
    // 中途抛异常也不能把内存里的默认值留在关闭状态，否则下一次保存设置会写进配置
    if (voiceCfg) voiceCfg.autoSend = autoSendBackup;
  }
})()`;
}

async function evaluate(target, expression, timeoutMs) {
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  try {
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`渲染层执行超时（${timeoutMs}ms）`)), timeoutMs);
      ws.on('message', (raw) => {
        const message = JSON.parse(raw);
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error) return reject(new Error(JSON.stringify(message.error)));
        const value = message.result?.result?.value;
        const details = message.result?.exceptionDetails;
        if (details) return reject(new Error(details.exception?.description || details.text));
        return value === undefined ? reject(new Error(`没拿到返回值：${JSON.stringify(message.result)}`)) : resolve(value);
      });
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true }
      }));
    });
  } finally {
    ws.close();
  }
}

// 截一张真实画面：先跑 before 表达式布置状态，250ms 后取 Page 截图（响应 id=2）
async function capture(target, file, before) {
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  try {
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('截图超时')), 20000);
      ws.on('message', (raw) => {
        const message = JSON.parse(raw);
        if (message.id !== 2) return;
        clearTimeout(timer);
        if (message.error) return reject(new Error(JSON.stringify(message.error)));
        fs.writeFileSync(file, Buffer.from(message.result.data, 'base64'));
        return resolve();
      });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: before, returnByValue: true } }));
      ws.send(JSON.stringify({ id: 3, method: 'Page.enable' }));
      setTimeout(() => ws.send(JSON.stringify({
        id: 2,
        method: 'Page.captureScreenshot',
        params: { format: 'png', captureBeyondViewport: false }
      })), 250);
    });
  } finally {
    ws.close();
  }
}

(async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const target = targets.find((item) => item.type === 'page' && item.url.includes('renderer/index.html'));
  if (!target) throw new Error(`CDP 端口 ${PORT} 上找不到工具栏渲染层，先跑: ./node_modules/electron/dist/electron.exe . --remote-debugging-port=${PORT}`);
  console.log(`[appprobe] 附着 ${target.title || target.url}`);
  const result = await evaluate(target, buildExpression(pcm16Base64(WAV)), 120000);
  console.log(result);
  if (SHOTS) {
    const dir = path.join(APP_ROOT, 'samples');
    fs.mkdirSync(dir, { recursive: true });
    const closed = path.join(dir, 'ui-compose-closed.png');
    const open = path.join(dir, 'ui-compose-open.png');
    await capture(target, closed, "TB.ai.input.value='';TB.voice.recording=false;TB.ai.closeCompose(true);'closed'");
    await capture(target, open, "TB.ai.openCompose(true);TB.ai.input.value='打字或单击宠物说话';'open'");
    // 布置用的草稿不能留在他的输入框里
    await evaluate(target, "TB.ai.input.value='';TB.ai.closeCompose(true);'reset'", 10000);
    console.log(`[appprobe] 截图：${closed}\n           ${open}`);
  }
})().catch((error) => {
  console.error('[appprobe] 失败:', error.message);
  process.exit(1);
});
