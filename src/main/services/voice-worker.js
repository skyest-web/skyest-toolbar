// 语音工作进程：由 voice.js 用 utilityProcess.fork 拉起，跑 sherpa-onnx 原生模块。
// 放子进程的原因：原生模块崩溃/加载失败不能带走工具栏主进程；模型加载的几十毫秒阻塞也不卡 UI。
// 协议见文件末尾的 post() 调用点，全部消息都是 {op|type, id, ...}。

const fs = require('fs');
const path = require('path');

const sherpa = require('sherpa-onnx-node');
const { EdgeTTS } = require('node-edge-tts');

const post = (message) => process.parentPort.postMessage(message);
const log = (text) => post({ type: 'log', text: `[voice-worker] ${text}` });

// 模型目录里的文件名随版本变（int8/fp16/多分片），只按语义优先级找，不写死。
function pick(dir, candidates) {
  if (!dir || !fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir);
  for (const candidate of candidates) {
    const hit = entries.find((name) => candidate.test(name));
    if (hit) return path.join(dir, hit);
  }
  return null;
}

function findSubdir(dir, name) {
  return fs.existsSync(path.join(dir, name)) ? path.join(dir, name) : null;
}

const ASR_FILEPLAN = {
  tokens: [/^tokens\.txt$/],
  encoder: [/^encoder(?:-\d+)?\.int8\.onnx$/, /^encoder(?:-\d+)?\.onnx$/],
  decoder: [/^decoder\.onnx$/],
  joiner: [/^joiner(?:-\d+)?\.int8\.onnx$/, /^joiner(?:-\d+)?\.onnx$/],
  paraformerEncoder: [/^model\.encoder\.int8\.onnx$/, /^model\.encoder\.onnx$/],
  paraformerDecoder: [/^model\.decoder\.int8\.onnx$/, /^model\.decoder\.onnx$/]
};

function buildAsrConfig(asrDir, numThreads) {
  const tokens = pick(asrDir, ASR_FILEPLAN.tokens);
  if (!tokens) throw new Error(`ASR 模型目录缺少 tokens.txt: ${asrDir}`);
  const modelConfig = { tokens, numThreads, provider: 'cpu', debug: false, modelingUnit: 'cjk' };

  const encoder = pick(asrDir, ASR_FILEPLAN.encoder);
  const decoder = pick(asrDir, ASR_FILEPLAN.decoder);
  const joiner = pick(asrDir, ASR_FILEPLAN.joiner);
  if (encoder && decoder && joiner) {
    modelConfig.transducer = { encoder, decoder, joiner };
    return {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig,
      decodingMethod: 'greedy_search',
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 30
    };
  }

  const pEnc = pick(asrDir, ASR_FILEPLAN.paraformerEncoder);
  const pDec = pick(asrDir, ASR_FILEPLAN.paraformerDecoder);
  if (pEnc && pDec) {
    modelConfig.paraformer = { encoder: pEnc, decoder: pDec };
    return {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig,
      decodingMethod: 'greedy_search',
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 30
    };
  }
  throw new Error(`ASR 模型文件不完整（既非 transducer 也非 paraformer）: ${asrDir}`);
}

function buildTtsConfig(ttsDir, numThreads) {
  // int8 优先：全 CPU 推理下体积和内存都吃这个，换量化版本不该改代码
  const model = pick(ttsDir, [/^model\.int8\.onnx$/, /^model\.onnx$/, /^model\.fp16\.onnx$/]);
  const voices = pick(ttsDir, [/^voices\.bin$/]);
  const tokens = pick(ttsDir, [/^tokens\.txt$/]);
  if (!model || !voices || !tokens) throw new Error(`TTS 模型缺少 model(.int8).onnx/voices.bin/tokens.txt: ${ttsDir}`);
  const kokoro = {
    model,
    voices,
    tokens,
    lexicon: pick(ttsDir, [/^lexicon-zh\.txt$/]) || undefined,
    lengthScale: 1.0
    // lang 在 sherpa-onnx >= 2.0 里已废弃并忽略（语言由 lexicon 决定）；
    // espeak-ng-data 也不用再指 dataDir，留着只会打 WARNING
  };
  const dataDir = findSubdir(ttsDir, 'espeak-ng-data');
  if (dataDir) kokoro.dataDir = dataDir;
  // Kokoro 会无视 maxNumSentences 并打警告，所以这里不传
  return { model: { kokoro }, numThreads, provider: 'cpu' };
}

const state = {
  asr: { recognizer: null, error: null },
  tts: { engine: null, error: null, sampleRate: 0, numSpeakers: 0 },
  sessions: new Map(),
  opts: {}
};

function initAsr() {
  const dir = state.opts.asrDir;
  if (!dir || !fs.existsSync(dir)) {
    state.asr.error = `未安装 ASR 模型（${dir}），先跑 npm run voice:install`;
    return;
  }
  try {
    state.asr.recognizer = new sherpa.OnlineRecognizer(buildAsrConfig(dir, state.opts.numThreads || 2));
    log('ASR 就绪');
  } catch (error) {
    state.asr.error = `ASR 初始化失败: ${error.message}`;
    log(state.asr.error);
  }
}

function initTts() {
  const dir = state.opts.ttsDir;
  if (!dir || !fs.existsSync(dir)) {
    state.tts.error = `未安装离线 TTS 模型（${dir}），先跑 npm run voice:install`;
    return;
  }
  try {
    const engine = new sherpa.OfflineTts(buildTtsConfig(dir, state.opts.numThreads || 2));
    state.tts.engine = engine;
    state.tts.sampleRate = engine.sampleRate;
    state.tts.numSpeakers = engine.numSpeakers;
    log(`Kokoro 就绪 sampleRate=${engine.sampleRate} speakers=${engine.numSpeakers}`);
  } catch (error) {
    state.tts.error = `Kokoro 初始化失败: ${error.message}`;
    log(state.tts.error);
  }
}

// ---- ASR ----

function asrStart(message) {
  if (!state.asr.recognizer) {
    post({ type: 'asr.error', id: message.id, kind: 'model', message: state.asr.error || 'ASR 未就绪' });
    return;
  }
  const rate = message.sampleRate || 16000;
  state.sessions.set(message.id, {
    stream: state.asr.recognizer.createStream(),
    committed: [],
    // 麦克风采样率由浏览器决定（常见 48k），模型只吃 16k，在这里统一降采样
    resampler: rate === 16000 ? null : new sherpa.LinearResampler(rate, 16000)
  });
  post({ type: 'asr.ready', id: message.id });
}

function emitPartial(id) {
  const session = state.sessions.get(id);
  if (!session) return;
  const live = state.asr.recognizer.getResult(session.stream).text || '';
  post({ type: 'asr.partial', id, text: [...session.committed, live].join('') });
}

function drain(id, session) {
  const recognizer = state.asr.recognizer;
  while (recognizer.isReady(session.stream)) recognizer.decode(session.stream);
  const result = recognizer.getResult(session.stream);
  if (result.isEndpoint) {
    if (result.text) session.committed.push(result.text);
    recognizer.reset(session.stream);
    post({ type: 'asr.committed', id, text: session.committed.join('') });
  } else if (result.text) {
    emitPartial(id);
  }
}

function asrChunk(message) {
  const session = state.sessions.get(message.id);
  if (!session) return;
  const samples = message.samples instanceof Float32Array ? message.samples : new Float32Array(message.samples);
  session.stream.acceptWaveform({ samples: session.resampler ? session.resampler.resample(samples) : samples, sampleRate: 16000 });
  drain(message.id, session);
}

function asrEnd(message) {
  const session = state.sessions.get(message.id);
  if (!session) return;
  const recognizer = state.asr.recognizer;
  if (session.resampler) {
    const tail = session.resampler.flush(new Float32Array(0));
    if (tail?.length) session.stream.acceptWaveform({ samples: tail, sampleRate: 16000 });
  }
  try { session.stream.inputFinished(); } catch { /* 老版本没有该接口，退化成直接取结果 */ }
  drain(message.id, session);
  const text = [...session.committed, recognizer.getResult(session.stream).text || ''].join('').trim();
  recognizer.reset(session.stream);
  state.sessions.delete(message.id);
  post({ type: 'asr.final', id: message.id, text });
}

// ---- TTS ----

function encodeWav(samples, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length * 2, 40);
  const body = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    body.writeInt16LE(Math.round(clamped * (clamped < 0 ? 0x8000 : 0x7fff)), i * 2);
  }
  return Buffer.concat([header, body]);
}

async function ttsKokoro(message) {
  const audio = state.tts.engine.generate({
    text: message.text,
    sid: message.sid || 0,
    speed: message.speed || 1.0,
    // Electron 的 V8 禁外部缓冲（napi_create_external_arraybuffer 直接抛
    // "External buffers are not allowed"），默认路径正好是外部缓冲，必须让它拷一份
    enableExternalBuffer: false
  });
  if (!audio?.samples?.length) throw new Error('Kokoro 返回空音频');
  return { format: 'wav', bytes: encodeWav(audio.samples, audio.sampleRate || state.tts.sampleRate) };
}

async function ttsEdge(message) {
  const edge = new EdgeTTS({
    voice: message.voice || 'zh-CN-XiaoyiNeural',
    lang: 'zh-CN',
    // rate/pitch 由上层从配置算好传进来：edge 的 rate 是百分数、pitch 是 Hz，
    // 写死 '+8%' 会让「语速」滑杆对在线音色完全不生效
    rate: message.rate || '+0%',
    pitch: message.pitch || '+0Hz',
    timeout: 20000
  });
  const chunks = [];
  for await (const item of edge.streamAudio(message.text)) {
    if (Buffer.isBuffer(item)) chunks.push(item);
  }
  if (!chunks.length) throw new Error('edge-tts 返回空音频');
  return { format: 'mp3', bytes: Buffer.concat(chunks) };
}

async function tts(message) {
  // 单次请求显式指定的引擎优先于配置，否则 selftest 与「试听」都没法临时换引擎
  const wanted = message.engine || state.opts.ttsEngine || 'auto';
  // auto 走在线优先：edge 音色明显更像人，而且宠物本来就要联网问 DeepSeek；
  // 断网/限流时才落回离线 Kokoro，保证不哑。想要纯离线把 ttsEngine 设成 kokoro。
  const order = wanted === 'edge' ? ['edge'] : wanted === 'kokoro' ? ['kokoro'] : ['edge', 'kokoro'];
  const errors = [];
  for (const engine of order) {
    try {
      if (engine === 'kokoro') {
        if (!state.tts.engine) throw new Error(state.tts.error || 'Kokoro 未就绪');
        const result = await ttsKokoro(message);
        post({ type: 'tts.audio', id: message.id, engine, ...result });
        return;
      }
      const result = await ttsEdge(message);
      post({ type: 'tts.audio', id: message.id, engine, ...result });
      return;
    } catch (error) {
      errors.push(`${engine}: ${error.message}`);
    }
  }
  post({ type: 'tts.error', id: message.id, kind: 'tts', message: errors.join(' | ').slice(0, 300) });
}

// ---- 入口 ----

function handle(message) {
  switch (message.op) {
    case 'init':
      state.opts = message.opts || {};
      initAsr();
      initTts();
      post({
        type: 'ready',
        asr: { ok: Boolean(state.asr.recognizer), error: state.asr.error },
        tts: { ok: Boolean(state.tts.engine), error: state.tts.error, sampleRate: state.tts.sampleRate, numSpeakers: state.tts.numSpeakers }
      });
      break;
    case 'asr.start': asrStart(message); break;
    case 'asr.chunk': asrChunk(message); break;
    case 'asr.end': asrEnd(message); break;
    case 'asr.cancel':
      state.sessions.delete(message.id);
      post({ type: 'asr.cancelled', id: message.id });
      break;
    case 'tts': tts(message).catch((error) => post({ type: 'tts.error', id: message.id, kind: 'tts', message: String(error.message).slice(0, 300) })); break;
    default: log(`未知 op: ${message.op}`);
  }
}

process.parentPort.on('message', (event) => handle(event.data));
