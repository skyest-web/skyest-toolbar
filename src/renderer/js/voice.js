// 语音前端：录音→ASR 最终文本默认直接问 AI（voice.autoSend 关掉才停在输入框）；AI 回复→分句 TTS→WebAudio 播放并驱动宠物口型。
// 不用 <audio>+blob：CSP 的 media-src 是 'self' track:，blob 会被挡；decodeAudioData 走 WebAudio 不受限。
TB.voice = {
  status: { running: false, asr: { ok: false }, tts: { ok: false }, models: { asr: false, tts: false } },
  recording: false,
  speaking: false,
  generation: 0,
  queue: Promise.resolve(),

  enabled() {
    return Boolean(TB.app.state.config?.voice?.enabled);
  },

  asrReady() {
    return this.enabled() && this.status.running && this.status.asr?.ok;
  },

  ttsReady() {
    if (!this.enabled() || !this.status.running) return false;
    const engine = TB.app.state.config?.voice?.ttsEngine || 'auto';
    // kokoro 必须有离线模型；edge/auto 只要 worker 活着（auto 会在离线失败时走在线）
    return engine === 'kokoro' ? Boolean(this.status.tts?.ok) : true;
  },

  async init(ai) {
    this.ai = ai;
    // 组件重建（换布局/重载配置）会再调一次：foot 是新 DOM，按钮必须重挂，
    // 但 IPC 订阅只能有一次，否则一次识别结果会被灌进输入框两遍
    if (!this.bound) {
      this.bound = true;
      TB.api.voice.onStatus((payload) => {
        this.status = { ...this.status, ...payload };
        this.paintButton();
      });
      TB.api.voice.onAsr((payload) => this.onAsr(payload));
      TB.api.voice.onError((payload) => {
        TB.app.toast(`语音：${payload.message}`, 'warn');
        this.setSpeaking(false);
      });
      TB.api.ai.onDone(() => this.onAiDone());
    }
    try {
      const status = await TB.api.voice.status();
      if (status) this.status = status;
    } catch { /* 主进程没起 worker 时保持默认值 */ }
    this.buildButton();
  },

  // ---- 麦克风按钮 ----

  buildButton() {
    if (this.mic?.parentNode === this.ai.compose) {
      this.paintButton();
      return;
    }
    this.mic = TB.util.el('button', {
      class: 'voice-mic',
      title: '点这里说话',
      // 不用 🎤 表情：Windows 下会画成灰色斜杠，且不吃 currentColor，禁用/录音态分不出来
      html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>',
      onclick: () => this.toggle()
    });
    this.mic.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.stopSpeaking();
    });
    this.ai.compose.insertBefore(this.mic, this.ai.send);
    this.paintButton();
  },

  paintButton() {
    if (!this.mic) return;
    const usable = this.asrReady();
    this.mic.disabled = !usable && !this.recording;
    this.mic.classList.toggle('recording', this.recording);
    this.mic.title = this.recording
      ? '点击结束（再点一次宠物也行）'
      : usable
        ? '点击说话（打字就直接在旁边的框里写）'
        : this.enabled()
          ? '语音模型未安装：先跑 npm run voice:install'
          : '语音已在设置里关闭';
  },

  toggle() {
    if (this.recording) return this.stopRecord();
    if (!this.asrReady()) {
      TB.app.toast(this.status.models?.asr ? '语音进程未就绪，稍后再试' : '未安装语音模型，先跑 npm run voice:install', 'warn');
      return;
    }
    return this.startRecord();
  },

  // ---- 录音 → ASR ----

  async startRecord() {
    if (this.recording) return;
    this.stopSpeaking();
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (error) {
      TB.app.toast(`打不开麦克风：${error.name === 'NotAllowedError' ? '系统里拒绝了录音权限' : error.message}`, 'warn');
      return;
    }
    this.micCtx = new AudioContext();
    if (this.micCtx.state === 'suspended') await this.micCtx.resume();
    this.asrId = await TB.api.voice.asrStart(this.micCtx.sampleRate);
    this.liveText = '';
    this.pcm = [];
    this.pcmLength = 0;
    this.flushTarget = Math.round(this.micCtx.sampleRate * 0.1);

    const source = this.micCtx.createMediaStreamSource(this.micStream);
    const proc = this.micCtx.createScriptProcessor(4096, 1, 1);
    const mute = this.micCtx.createGain();
    mute.gain.value = 0;
    proc.onaudioprocess = (event) => this.collect(event.inputBuffer.getChannelData(0));
    source.connect(proc);
    proc.connect(mute);
    mute.connect(this.micCtx.destination);
    this.proc = proc;
    this.source = source;
    this.mute = mute;

    this.recording = true;
    this.paintButton();
    // 录音时把浮层撑开：识别中的字要看得见，不然不知道它在听什么
    this.ai.openCompose?.(true);
  },

  collect(channel) {
    this.pcm.push(Float32Array.from(channel));
    this.pcmLength += channel.length;
    if (this.pcmLength < this.flushTarget) return;
    const merged = new Float32Array(this.pcmLength);
    let offset = 0;
    for (const piece of this.pcm) {
      merged.set(piece, offset);
      offset += piece.length;
    }
    this.pcm = [];
    this.pcmLength = 0;
    TB.api.voice.asrChunk(this.asrId, merged, this.micCtx.sampleRate);
  },

  async stopRecord() {
    if (!this.recording) return;
    this.recording = false;
    if (this.pcmLength) {
      this.flushTarget = 0;
      this.collect(new Float32Array(0));
    }
    this.teardownMic();
    TB.api.voice.asrEnd(this.asrId);
    this.paintButton();
  },

  teardownMic() {
    for (const node of [this.proc, this.source, this.mute]) node?.disconnect?.();
    this.proc = this.source = this.mute = null;
    for (const track of this.micStream?.getTracks() || []) track.stop();
    this.micStream = null;
    this.micCtx?.close().catch(() => {});
    this.micCtx = null;
  },

  onAsr(payload) {
    this.liveText = payload.text;
    this.ai.input.value = payload.text;
    this.ai.input.classList.toggle('voice-live', !payload.final);
    if (!payload.final) return;
    this.ai.input.classList.remove('voice-live');
    if (!payload.text) return;
    if (TB.app.state.config?.voice?.autoSend) {
      this.ai.submit();
      return;
    }
    // 关掉「说完即发送」时文字才停在输入框等人改
    this.ai.openCompose?.(true);
  },

  // ---- TTS：回复 → 分句 → 串行合成播放 ----

  onAiDone() {
    const cfg = TB.app.state.config?.voice || {};
    if (!cfg.autoSpeak || !this.ttsReady()) return;
    const last = [...(TB.app.state.ai?.messages || [])].reverse().find((item) => item.role === 'assistant');
    if (!last?.content) return;
    this.speak(last.content);
  },

  // 攒到句末标点就交给 TTS，首声延迟从"整段回复"压到"第一句"；超长句在逗号处断开，48 字兜底强断。
  split(text) {
    const clean = String(text).replace(/\s+/g, ' ').trim();
    if (!clean) return [];
    const out = [];
    let current = '';
    for (const ch of clean) {
      current += ch;
      const ends = '。！？；!?;'.includes(ch);
      const tooLong = current.length >= 48;
      if (ends || (tooLong && '，,、'.includes(ch)) || current.length >= 96) {
        out.push(current.trim());
        current = '';
      }
    }
    if (current.trim()) out.push(current.trim());
    return out;
  },

  speak(text, extra) {
    this.generation += 1;
    const gen = this.generation;
    this.setSpeaking(true);
    this.queue = (async () => {
      for (const sentence of this.split(text)) {
        if (gen !== this.generation) return;
        let result;
        try {
          result = await TB.api.voice.speak(sentence, extra);
        } catch {
          break;
        }
        if (!result?.ok || gen !== this.generation) break;
        await this.play(result.audio, gen);
      }
      if (gen === this.generation) this.setSpeaking(false);
    })();
  },

  async play(audio, gen) {
    if (!audio?.bytes) return;
    this.audioCtx = this.audioCtx || new AudioContext();
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
    if (gen !== this.generation) return;
    let buffer;
    try {
      // decodeAudioData 会接管这个 ArrayBuffer，所以传副本而不是原 buffer
      buffer = await this.audioCtx.decodeAudioData(audio.bytes.slice().buffer);
    } catch {
      return;
    }
    if (gen !== this.generation) return;
    const src = this.audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.audioCtx.destination);
    this.current = src;
    await new Promise((resolve) => {
      src.onended = resolve;
      try { src.start(); } catch { resolve(); }
    });
    if (this.current === src) this.current = null;
  },

  stopSpeaking() {
    this.generation += 1;
    try { this.current?.stop(); } catch { /* 已结束的 source 重复 stop 会抛 */ }
    this.current = null;
    this.setSpeaking(false);
  },

  setSpeaking(value) {
    if (this.speaking === value) return;
    this.speaking = value;
    // 口型由 ai.render 统一算：它读 TB.voice.speaking，避免这里再猜一次当前情绪
    TB.app.refresh('ai');
    this.paintButton();
  },

  // 供设置面板「试听」用
  preview(extra) {
    if (!this.ttsReady()) {
      TB.app.toast('朗读未就绪，先跑 npm run voice:install 装离线模型', 'warn');
      return;
    }
    this.speak('你好，我是工具栏里的小助手，现在声音这样可以吗？', extra);
  }
};
