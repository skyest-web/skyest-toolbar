// 语音服务：管理 voice-worker 子进程的生命周期，把它的事件转成 IPC 转发给渲染层。
// 设计原则和 ai.js 一致——主进程不做重连策略之外的判断，错误一律分类后 emit，界面自己决定怎么显示。

const fs = require('node:fs');
const path = require('node:path');
const { utilityProcess } = require('electron');

const WORKER = path.join(__dirname, 'voice-worker.js');
const ASR_DIR = 'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30';
const ASR_DIR_ALT = 'sherpa-onnx-streaming-paraformer-bilingual-zh-en';
const TTS_DIR = 'kokoro-int8-multi-lang-v1_1';
const WATCHDOG_MS = 30000;

function firstExisting(modelsDir, names) {
  for (const name of names) {
    const target = path.join(modelsDir, name);
    if (fs.existsSync(target)) return target;
  }
  return null;
}

// 语速倍速 → edge 的 rate 百分数字符串：1.0 是 '+0%'，0.9 是 '-10%'
function edgeRate(speed) {
  const pct = Math.round(((Number(speed) || 1) - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

class Voice {
  constructor({ appRoot, getConfig, emit }) {
    this.appRoot = appRoot;
    this.getConfig = getConfig;
    this.emit = emit;
    this.child = null;
    this.ready = null; // { asr:{ok,error}, tts:{ok,error,...} }
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.seq = 0;
    this.restartAttempts = 0;
    this.quitting = false;
    this.disabled = false;
    this.applied = null;
  }

  modelsDir() {
    return path.join(this.appRoot, 'models');
  }

  desiredOpts() {
    const modelsDir = this.modelsDir();
    const voice = this.getConfig().voice || {};
    return {
      asrDir: firstExisting(modelsDir, [ASR_DIR, ASR_DIR_ALT]),
      ttsDir: firstExisting(modelsDir, [TTS_DIR]),
      numThreads: 2,
      ttsEngine: voice.ttsEngine || 'auto'
    };
  }

  // 设置面板每次保存都会调这里：只在影响子进程的选项真的变了时才重新加载模型。
  sync() {
    if (!this.getConfig().voice?.enabled) return this.stop();
    this.disabled = false;
    const next = this.desiredOpts();
    const signature = JSON.stringify(next);
    if (this.child && this.applied === signature) return;
    if (this.child) {
      const dying = this.child;
      this.child = null;
      this.applied = null;
      dying.kill();
      setTimeout(() => this.spawn(), 200);
      return;
    }
    this.spawn();
  }

  spawn() {
    if (this.child || this.quitting) return;
    const opts = this.desiredOpts();
    this.applied = JSON.stringify(opts);
    // utilityProcess 自己就是 Node 环境；再设 ELECTRON_RUN_AS_NODE 会让 Electron 引导失败（实测 code 9 退出）
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    this.child = utilityProcess.fork(WORKER, [], { env, stdio: 'pipe' });
    this.child.on('spawn', () => this.child.postMessage({ op: 'init', opts }));
    this.child.on('message', (message) => this.onMessage(message));
    this.child.on('stdout', (chunk) => console.log(String(chunk).trimEnd()));
    this.child.on('stderr', (chunk) => console.error(`[voice-worker] ${String(chunk).trimEnd()}`));
    this.child.on('exit', (code) => this.onExit(code));
  }

  onExit(code) {
    this.child = null;
    this.applied = null;
    this.ready = null;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject({ kind: 'worker', message: `语音进程已退出（code ${code}）` });
    }
    this.pending.clear();
    if (this.quitting || this.disabled) return;
    if (this.restartAttempts < 2) {
      this.restartAttempts += 1;
      console.warn(`[voice] 子进程退出 code=${code}，第 ${this.restartAttempts} 次重启`);
      setTimeout(() => this.spawn(), 500);
    } else {
      this.emit('voice:status', this.status());
      this.emit('voice:error', { kind: 'worker', message: `语音进程反复退出（code ${code}），已停止重启` });
    }
  }

  settle(id, value, error) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve(value);
  }

  request(timeoutMs, build) {
    return new Promise((resolve, reject) => {
      if (!this.child) return reject({ kind: 'worker', message: '语音进程未启动' });
      const id = `v${Date.now().toString(36)}${(this.seq += 1)}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject({ kind: 'timeout', message: '语音处理超时' });
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      build(id);
      return id;
    });
  }

  onMessage(message) {
    switch (message.type) {
      case 'ready':
        this.ready = message;
        this.restartAttempts = 0;
        this.emit('voice:status', this.status());
        break;
      case 'log':
        console.log(message.text);
        break;
      case 'asr.partial':
      case 'asr.committed':
        this.emit('voice:asr', { id: message.id, text: message.text, final: false });
        break;
      case 'asr.final':
        this.emit('voice:asr', { id: message.id, text: message.text, final: true });
        break;
      case 'asr.error':
        this.emit('voice:error', { kind: message.kind, message: message.message });
        break;
      case 'tts.audio':
        // 音频直接由 voice:speak 的 invoke 返回值带给渲染层，不再另发事件，避免两条到达路径
        this.settle(message.id, { format: message.format, bytes: message.bytes, engine: message.engine });
        break;
      case 'tts.error':
        this.settle(message.id, null, { kind: message.kind, message: message.message });
        this.emit('voice:error', { kind: message.kind, message: message.message });
        break;
      default:
        break;
    }
  }

  status() {
    return {
      running: Boolean(this.child),
      asr: this.ready?.asr || { ok: false, error: this.ready ? null : '语音进程未启动' },
      tts: this.ready?.tts || { ok: false, error: this.ready ? null : '语音进程未启动' },
      models: {
        asr: Boolean(firstExisting(this.modelsDir(), [ASR_DIR, ASR_DIR_ALT])),
        tts: Boolean(firstExisting(this.modelsDir(), [TTS_DIR]))
      }
    };
  }

  asrStart(sampleRate) {
    const id = `s${Date.now().toString(36)}${(this.seq += 1)}`;
    this.child.postMessage({ op: 'asr.start', id, sampleRate });
    return id;
  }

  asrChunk(id, samples, sampleRate) {
    if (this.child) this.child.postMessage({ op: 'asr.chunk', id, samples, sampleRate });
  }

  asrEnd(id) {
    if (this.child) this.child.postMessage({ op: 'asr.end', id });
  }

  asrCancel(id) {
    if (this.child) this.child.postMessage({ op: 'asr.cancel', id });
  }

  // 渲染层逐句调用；这里包一层串行队列，避免长回复时把子进程压满。
  // extra 是设置面板「试听」用的临时覆盖：改完还没保存就能听到那一声，不落盘。
  speak(text, extra = {}) {
    const voice = this.getConfig().voice || {};
    const speed = extra.speed ?? voice.ttsSpeed ?? 1.0;
    return this.request(60000, (id) => {
      this.child.postMessage({
        op: 'tts',
        id,
        text,
        sid: extra.sid ?? voice.ttsSid ?? 0,
        speed,
        // edge 的语速是百分数字符串，Kokoro 的是倍速，同一个滑杆要各自换算一次
        rate: edgeRate(speed),
        pitch: extra.pitch ?? voice.ttsPitch ?? '+0Hz',
        voice: extra.voice ?? voice.ttsVoice,
        engine: extra.engine
      });
    });
  }

  stop() {
    this.disabled = true;
    if (this.child) {
      const dying = this.child;
      this.child = null;
      this.applied = null;
      this.ready = null;
      dying.kill();
    }
  }

  shutdown() {
    this.quitting = true;
    this.stop();
  }
}

module.exports = { Voice };
