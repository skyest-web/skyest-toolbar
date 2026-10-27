// 音色试听：同一句话把「在线各音色 × 各音高」和「离线各 sid」都合成一遍，
// 文件落在 samples/voice-tryout/，双击就能听，挑好了再去设置面板填。
// 跑法（Git Bash）: npm run voice:tryout
//   等价于 ./node_modules/electron/dist/electron.exe tools/voice-tryout.js
// 在线那几项要联网；离线那几项要先 npm run voice:install。
const path = require('node:path');
const fs = require('node:fs');
const { app, utilityProcess } = require('electron');

const APP_ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(APP_ROOT, 'src', 'main', 'services', 'voice-worker.js');
const MODELS = path.join(APP_ROOT, 'models');
const ASR_DIR = path.join(MODELS, 'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30');
const TTS_DIR = path.join(MODELS, 'kokoro-int8-multi-lang-v1_1');
const OUT_DIR = path.join(APP_ROOT, 'samples', 'voice-tryout');

const TEXT = '你好呀，今天心情特别好，要不要一起喝杯奶茶？';

// label 直接进文件名，用 ASCII 免得 shell 里引用麻烦
const EDGE_CASES = [
  { label: 'xiaoxiao_p0', voice: 'zh-CN-XiaoxiaoNeural', pitch: '+0Hz' },
  { label: 'xiaoyi_p0', voice: 'zh-CN-XiaoyiNeural', pitch: '+0Hz' },
  { label: 'xiaoyi_p3', voice: 'zh-CN-XiaoyiNeural', pitch: '+3Hz' },
  { label: 'xiaoyi_p6', voice: 'zh-CN-XiaoyiNeural', pitch: '+6Hz' },
  { label: 'xiaoyi_p9', voice: 'zh-CN-XiaoyiNeural', pitch: '+9Hz' },
  { label: 'xiaoyi_p6_slow', voice: 'zh-CN-XiaoyiNeural', pitch: '+6Hz', rate: '-8%' },
  { label: 'yunxia_p3', voice: 'zh-CN-YunxiaNeural', pitch: '+3Hz' }
];
const KOKORO_SIDS = [0, 1, 2, 3, 4, 8];

// 听不出差别时先看数：对离线样本估一个中位基频（autocorrelation，60Hz–500Hz），
// F0 越高越"少女/亮"，越低越"沉"。在线那几项是微软现成人声，直接听。
function readWavMono(file) {
  const buf = fs.readFileSync(file);
  let sampleRate = 0;
  let channels = 1;
  let data = null;
  for (let cursor = 12; cursor + 8 <= buf.length; ) {
    const id = buf.toString('ascii', cursor, cursor + 4);
    const size = buf.readUInt32LE(cursor + 4);
    const body = cursor + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    cursor = body + size + (size % 2);
  }
  const mono = [];
  for (let i = 0; i + 1 < data.length; i += 2 * channels) mono.push(data.readInt16LE(i) / 32768);
  return { sampleRate, samples: Float32Array.from(mono) };
}

function medianF0(file) {
  const { sampleRate, samples } = readWavMono(file);
  const frame = Math.round(sampleRate * 0.04);
  const minLag = Math.round(sampleRate / 500);
  const maxLag = Math.round(sampleRate / 60);
  const pitches = [];
  for (let start = 0; start + frame < samples.length; start += frame) {
    let energy = 0;
    for (let i = 0; i < frame; i += 1) energy += samples[start + i] * samples[start + i];
    if (energy / frame < 0.002) continue; // 跳过静音和很轻的尾音
    let bestLag = 0;
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let sum = 0;
      for (let i = 0; i + lag < frame; i += 4) sum += samples[start + i] * samples[start + i + lag];
      if (sum > best) { best = sum; bestLag = lag; }
    }
    if (bestLag) pitches.push(sampleRate / bestLag);
  }
  if (!pitches.length) return null;
  pitches.sort((a, b) => a - b);
  return Math.round(pitches[Math.floor(pitches.length / 2)]);
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

async function synth(child, engine, params, index) {
  const id = `tts-${index}`;
  const startedAt = Date.now();
  child.postMessage({
    op: 'tts',
    id,
    text: TEXT,
    engine,
    sid: params.sid ?? 0,
    speed: 1.0,
    rate: params.rate || '+0%',
    pitch: params.pitch || '+0Hz',
    voice: params.voice
  });
  try {
    // 离线首句要现编 espeak/jieba，比后续慢一个量级
    const audio = await waitType(child, 'tts.audio', 180000, `${engine} ${params.label}`);
    const file = path.join(OUT_DIR, `${String(index).padStart(2, '0')}-${params.label}.${audio.format}`);
    fs.writeFileSync(file, Buffer.from(audio.bytes));
    const line = `${path.basename(file)}  ${audio.engine}  ${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ')}  ${((Date.now() - startedAt) / 1000).toFixed(1)}s  ${(audio.bytes.byteLength / 1024).toFixed(0)}KB`;
    console.log('  ok ', line);
    return line;
  } catch (error) {
    const err = await waitType(child, 'tts.error', 2000).catch(() => null);
    const line = `(失败) ${engine} ${params.label}: ${err?.message || error.message}`;
    console.log('  fail', line);
    return line;
  }
}

async function run() {
  if (!fs.existsSync(ASR_DIR)) throw new Error(`缺 ASR 模型：${ASR_DIR}，先跑 npm run voice:install`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = utilityProcess.fork(WORKER, [], { env });
  child.on('stderr', (chunk) => console.log('[worker stderr]', String(chunk).trimEnd()));
  child.on('spawn', () => {
    child.postMessage({
      op: 'init',
      opts: { asrDir: ASR_DIR, ttsDir: fs.existsSync(TTS_DIR) ? TTS_DIR : null, numThreads: 2, ttsEngine: 'auto' }
    });
  });

  const ready = await waitType(child, 'ready', 60000, 'ready');
  console.log(`[tryout] 离线朗读${ready.tts.ok ? `就绪，speakers=${ready.tts.numSpeakers}` : `不可用（${ready.tts.error}）`}；同一句：${TEXT}`);

  const lines = [`句子：${TEXT}`, ''];
  let index = 1;
  console.log('\n[edge 在线]');
  for (const item of EDGE_CASES) lines.push(await synth(child, 'edge', item, index++));
  if (ready.tts.ok) {
    console.log('\n[kokoro 离线]');
    for (const sid of KOKORO_SIDS) {
      if (sid >= ready.tts.numSpeakers) continue;
      lines.push(await synth(child, 'kokoro', { label: `sid${sid}`, sid }, index++));
    }
  } else {
    lines.push('(跳过离线：Kokoro 未就绪)');
  }

  const offline = fs.readdirSync(OUT_DIR).filter((name) => /-sid\d+\.wav$/.test(name)).sort();
  if (offline.length) {
    const rows = offline
      .map((name) => ({ name, f0: medianF0(path.join(OUT_DIR, name)) }))
      .filter((row) => row.f0)
      .sort((a, b) => b.f0 - a.f0);
    lines.push('', '离线 sid 中位基频（越高越亮/少女，只用于排序，还得靠听）:');
    rows.forEach((row) => lines.push(`  ${row.name}  F0≈${row.f0}Hz`));
    console.log('\n[离线 F0 排序]');
    rows.forEach((row) => console.log(`  ${row.name}  F0≈${row.f0}Hz`));
  }

  fs.writeFileSync(path.join(OUT_DIR, 'README.txt'), `${lines.join('\n')}\n`, 'utf8');
  console.log(`\n[tryout] 清单写到 ${path.join(OUT_DIR, 'README.txt')}`);
  child.kill();
  app.exit(0);
}

app.whenReady().then(() => {
  run().catch((error) => {
    console.error('[tryout] 失败:', error.stack || error.message);
    app.exit(1);
  });
});
