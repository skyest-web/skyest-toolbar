// 语音链路自测：不依赖麦克风与 AI 密钥，直接喂模型自带的 test_wavs，验证 worker 真的能出字/出声。
// 跑法：./node_modules/electron/dist/electron.exe tools/voice-selftest.js
const path = require('node:path');
const fs = require('node:fs');
const { app, utilityProcess } = require('electron');

const APP_ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(APP_ROOT, 'src', 'main', 'services', 'voice-worker.js');
const MODELS = path.join(APP_ROOT, 'models');
const ASR_DIR = path.join(MODELS, 'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30');
const TTS_DIR = path.join(MODELS, 'kokoro-int8-multi-lang-v1_1');

const log = (...args) => console.log(...args);

// 不用 sherpa.readWave：它用 napi_create_external_arraybuffer 返回缓冲，
// Electron 主进程禁外部缓冲，直接抛「External buffers are not allowed」。这里自己解 PCM16 WAV。
function readPcmWave(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path.basename(file)} 不是 WAV`);
  }
  let sampleRate = 0;
  let bits = 0;
  let data = null;
  for (let cursor = 12; cursor + 8 <= buf.length; ) {
    const id = buf.toString('ascii', cursor, cursor + 4);
    const size = buf.readUInt32LE(cursor + 4);
    const body = cursor + 8;
    if (id === 'fmt ') {
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    cursor = body + size + (size % 2);
  }
  if (!data) throw new Error(`${path.basename(file)} 缺 data 段`);
  if (bits !== 16) throw new Error(`${path.basename(file)} 位深=${bits}，自测只支持 PCM16`);
  const samples = new Float32Array(data.length / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = data.readInt16LE(i * 2) / 32768;
  }
  return { sampleRate, samples };
}

function waitType(child, type, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('message', onMessage);
      reject(new Error(`等 ${label || type} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    function onMessage(message) {
      if (message.type !== type) return;
      clearTimeout(timer);
      child.off('message', onMessage);
      resolve(message);
    }
    child.on('message', onMessage);
  });
}

async function run() {
  if (!fs.existsSync(ASR_DIR)) throw new Error(`缺 ASR 模型：${ASR_DIR}，先跑 npm run voice:install`);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = utilityProcess.fork(WORKER, [], { env });
  child.on('stderr', (chunk) => log('[worker stderr]', String(chunk).trimEnd()));

  child.on('spawn', () => {
    child.postMessage({ op: 'init', opts: { asrDir: ASR_DIR, ttsDir: fs.existsSync(TTS_DIR) ? TTS_DIR : null, numThreads: 2, ttsEngine: 'auto' } });
  });

  const ready = await waitType(child, 'ready', 60000, 'ready');
  log('ASR 就绪:', ready.asr.ok, ready.asr.error || '');
  log('TTS 就绪:', ready.tts.ok, ready.tts.error || '', ready.tts.ok ? `sampleRate=${ready.tts.sampleRate} speakers=${ready.tts.numSpeakers}` : '');

  // ---- ASR：把 wav 切成 100ms 一块喂进去，模拟实时流 ----
  const wavPath = path.join(ASR_DIR, 'test_wavs', '0.wav');
  const wave = readPcmWave(wavPath);
  const samples = wave.samples;
  log(`\n[ASR] 喂 ${path.basename(wavPath)} sampleRate=${wave.sampleRate} 时长=${(samples.length / wave.sampleRate).toFixed(2)}s`);
  const id = 'test-asr';
  child.postMessage({ op: 'asr.start', id, sampleRate: wave.sampleRate });
  await waitType(child, 'asr.ready', 10000);

  const block = Math.round(wave.sampleRate * 0.1);
  let lastPartial = '';
  const partials = [];
  const collector = (message) => {
    if (message.id !== id) return;
    if (message.type === 'asr.partial') {
      if (message.text !== lastPartial) {
        lastPartial = message.text;
        partials.push(message.text);
        log('  partial:', message.text);
      }
    }
  };
  child.on('message', collector);

  for (let offset = 0; offset < samples.length; offset += block) {
    child.postMessage({ op: 'asr.chunk', id, samples: samples.slice(offset, offset + block), sampleRate: wave.sampleRate });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.postMessage({ op: 'asr.end', id });
  const final = await waitType(child, 'asr.final', 30000);
  child.off('message', collector);
  log('[ASR] 最终结果:', JSON.stringify(final.text));
  log(`[ASR] 中途出过 ${partials.length} 次增量${partials.length ? '（流式生效）' : '（未流式，可能是整块一次到达）'}`);

  // ---- TTS：离线 + 在线各来一句 ----
  const kokoroOk = ready.tts.ok;
  for (const [engine, text] of [[kokoroOk ? 'kokoro' : null, '我是工具栏里的语音自测。'], ['edge', '我是在线音色的自测。']]) {
    if (!engine) {
      log('\n[TTS] 跳过 Kokoro（离线模型未就绪）');
      continue;
    }
    const ttsId = `tts-${engine}`;
    log(`\n[TTS] ${engine}: ${text}`);
    const startedAt = Date.now();
    child.postMessage({ op: 'tts', id: ttsId, text, engine, sid: 0, speed: 1.0, voice: 'zh-CN-XiaoxiaoNeural' });
    try {
      // 首次合成要在子进程里现编 espeak/jieba，比后续慢一个量级，预算给到 180s
      const audio = await waitType(child, 'tts.audio', 180000, `${engine} audio`);
      const out = path.join(APP_ROOT, 'samples', `voice-selftest-${audio.engine}.${audio.format}`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(audio.bytes));
      log(`[TTS] ${audio.engine} → ${out} (${audio.bytes.byteLength} bytes) 耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    } catch (error) {
      const err = await waitType(child, 'tts.error', 2000).catch(() => null);
      log(`[TTS] ${engine} 失败（${((Date.now() - startedAt) / 1000).toFixed(1)}s）:`, err?.message || error.message);
    }
  }

  child.kill();
  app.exit(0);
}

app.whenReady().then(() => {
  run().catch((error) => {
    console.error('[selftest] 失败:', error.stack || error.message);
    app.exit(1);
  });
});
