TB.player = {
  // audio 元素挂在 <body> 上而不是网格里：改 layout.json 会重建 DOM，
  // 播放器若跟着重建就会中断播放。
  audio: null,
  tracks: [],
  index: -1,
  folder: null,
  lyrics: [],
  lyricIndex: -1,
  repeat: 'all',
  shuffle: false,
  volume: 0.7,
  seeking: false,
  ctx: null,
  analyser: null,
  bins: null,
  spectrumRaf: null,

  init(root) {
    this.root = root;
    this.nodes = {};
    this.ensureAudio();

    const button = (text, title, onclick) => TB.util.el('button', { class: 'pl-btn', text, title, onclick });
    this.nodes.prev = button('⏮', '上一首', () => this.step(-1));
    this.nodes.play = button('▶', '播放 / 暂停（空格）', () => this.toggle());
    this.nodes.next = button('⏭', '下一首', () => this.step(1));
    this.nodes.repeat = button('🔁', '循环方式', () => this.cycleRepeat());
    this.nodes.shuffle = button('🔀', '随机播放', () => {
      this.shuffle = !this.shuffle;
      this.renderModes();
      this.persist();
    });
    this.nodes.pick = button('📁', '选择音乐文件夹', () => this.pickFolder());
    this.nodes.title = TB.util.el('div', { class: 'pl-title', text: '未选择音乐文件夹' });
    this.nodes.artist = TB.util.el('div', { class: 'pl-artist muted', text: '点右侧 📁 选一个本地文件夹，自动扫描里面的音乐' });
    this.nodes.time = TB.util.el('span', { class: 'pl-time', text: '-- / --' });
    this.nodes.volume = TB.util.el('input', { class: 'pl-volume', type: 'range', min: '0', max: '1', step: '0.02' });
    this.nodes.volume.addEventListener('input', () => this.setVolume(Number(this.nodes.volume.value)));

    this.nodes.progress = TB.util.el('input', { class: 'pl-progress', type: 'range', min: '0', max: '0', step: '0.5', value: '0' });
    this.nodes.progress.addEventListener('input', () => {
      if (this.audio.duration) this.audio.currentTime = Number(this.nodes.progress.value);
    });
    this.nodes.progress.addEventListener('pointerdown', () => (this.seeking = true));
    for (const type of ['pointerup', 'pointercancel', 'change']) {
      this.nodes.progress.addEventListener(type, () => (this.seeking = false));
    }

    this.nodes.list = TB.util.el('div', { class: 'pl-list' });
    this.nodes.lyrics = TB.util.el('div', { class: 'pl-lyrics' });
    this.nodes.spectrum = TB.util.el('canvas', { class: 'pl-spectrum' });

    root.append(
      TB.util.el('div', { class: 'pl-head' }, [
        TB.util.el('div', { class: 'pl-btns' }, [this.nodes.prev, this.nodes.play, this.nodes.next]),
        TB.util.el('div', { class: 'pl-meta' }, [this.nodes.title, this.nodes.artist]),
        TB.util.el('div', { class: 'pl-side' }, [
          this.nodes.time,
          TB.util.el('div', { class: 'pl-btns' }, [this.nodes.pick, this.nodes.shuffle, this.nodes.repeat, this.nodes.volume])
        ])
      ]),
      this.nodes.progress,
      TB.util.el('div', { class: 'pl-body' }, [this.nodes.list, this.nodes.lyrics]),
      this.nodes.spectrum
    );

    this.bindAudio();
    this.repaint();
  },

  ensureAudio() {
    if (this.audio) return;
    this.audio = document.createElement('audio');
    this.audio.preload = 'metadata';
    // 频谱要用 WebAudio 读取媒体：跨源却没声明 CORS 的音频会被"污染"，analyser 永远是 0
    this.audio.crossOrigin = 'anonymous';
    document.body.appendChild(this.audio);
    this.bindAudio();
  },

  bindAudio() {
    // 重建 DOM 时 audio 元素是复用的，重复绑定会让 pause/persist 与频谱 rAF 各跑两份
    if (this.audioBound) return;
    this.audioBound = true;
    const audio = this.audio;
    audio.addEventListener('play', () => {
      this.setPlayIcon(true);
      this.ensureAudioGraph();
      this.drawSpectrum();
    });
    audio.addEventListener('pause', () => {
      this.setPlayIcon(false);
      this.stopSpectrum();
      this.persist();
    });
    audio.addEventListener('ended', () => this.onEnded());
    audio.addEventListener('timeupdate', () => this.syncTime());
    audio.addEventListener('loadedmetadata', () => this.syncTime());
    audio.addEventListener('error', () => this.onAudioError());
  },

  onAudioError() {
    this.setPlayIcon(false);
    const track = this.tracks[this.index];
    TB.app.toast(`无法播放：${track?.file || '未知文件'}`, 'error');
  },

  setPlayIcon(playing) {
    if (this.nodes.play) this.nodes.play.textContent = playing ? '⏸' : '▶';
  },

  // ---------- 曲库 ----------
  update(state) {
    const music = state.config?.music || {};
    const folder = music.folder || '';
    if (folder === this.folder) return;
    this.folder = folder;
    this.index = -1;
    this.rescan();
  },

  async rescan() {
    if (!this.folder) {
      this.tracks = [];
      this.repaint();
      return;
    }
    const result = await TB.api.music.scan(this.folder);
    this.tracks = result.tracks || [];
    if (result.error) {
      TB.app.toast(result.error, 'warn');
      this.repaint();
      return;
    }
    this.restore();
    this.repaint();
  },

  // 换曲库：原生对话框选目录 → 写回 toolbar.config.json → 重建页面并重新扫描
  async pickFolder() {
    const picked = await TB.api.music.pickFolder();
    if (!picked) return;
    const music = { ...(TB.app.state.config?.music || {}), folder: picked };
    const result = await TB.api.config.save({ music });
    if (!result?.config) {
      TB.app.toast(`保存配置失败：${result?.error || '未知错误'}`, 'error');
      return;
    }
    TB.app.applyConfigResult(result);
    if (picked === this.folder) this.rescan();
    TB.app.toast(`已加载音乐文件夹 ${picked}`);
  },

  renderList() {
    const list = this.nodes.list;
    if (!list) return;
    list.innerHTML = '';
    if (!this.tracks.length) {
      list.appendChild(TB.util.el('div', { class: 'pl-none muted', text: '曲库为空' }));
      return;
    }
    this.tracks.forEach((track, index) => {
      list.appendChild(
        TB.util.el(
          'button',
          {
            class: `pl-item${index === this.index ? ' active' : ''}`,
            title: track.path,
            onclick: () => this.play(index)
          },
          [TB.util.el('span', { class: 'pl-item-name', text: track.title }), TB.util.el('span', { class: 'pl-item-artist', text: track.artist || track.album })]
        )
      );
    });
  },

  // ---------- 播放控制 ----------
  play(index) {
    const track = this.tracks[index];
    if (!track) return;
    this.index = index;
    this.audio.src = track.url;
    this.audio.play().catch(() => {});
    this.showTrack(track);
    this.loadLyrics(track);
    this.renderList();
    this.persist();
    this.nodes.list.querySelector('.pl-item.active')?.scrollIntoView({ block: 'nearest' });
  },

  showTrack(track) {
    this.nodes.title.textContent = track.title || track.file;
    this.nodes.artist.textContent = [track.artist, track.album].filter(Boolean).join(' · ');
  },

  toggle() {
    if (!this.audio.src) {
      if (this.tracks.length) this.play(this.index >= 0 ? this.index : 0);
      return;
    }
    if (this.audio.paused) this.audio.play().catch(() => {});
    else this.audio.pause();
  },

  step(direction) {
    if (!this.tracks.length) return;
    const count = this.tracks.length;
    this.play(((this.index + direction) % count + count) % count);
  },

  onEnded() {
    if (this.repeat === 'one') {
      this.audio.currentTime = 0;
      this.audio.play().catch(() => {});
      return;
    }
    if (this.shuffle) return this.play(this.pickRandom());
    const isLast = this.index >= this.tracks.length - 1;
    if (isLast && this.repeat === 'none') {
      this.setPlayIcon(false);
      return;
    }
    this.step(1);
  },

  pickRandom() {
    if (this.tracks.length < 2) return this.index;
    let index = this.index;
    while (index === this.index) index = Math.floor(Math.random() * this.tracks.length);
    return index;
  },

  cycleRepeat() {
    const order = ['none', 'all', 'one'];
    this.repeat = order[(order.indexOf(this.repeat) + 1) % order.length];
    this.renderModes();
    this.persist();
  },

  renderModes() {
    if (!this.nodes.repeat) return;
    this.nodes.repeat.classList.toggle('on', this.repeat !== 'none');
    this.nodes.repeat.textContent = this.repeat === 'one' ? '🔂' : '🔁';
    this.nodes.repeat.title = { none: '不循环', all: '列表循环', one: '单曲循环' }[this.repeat];
    this.nodes.shuffle.classList.toggle('on', !!this.shuffle);
  },

  setVolume(value) {
    this.volume = TB.util.clamp(value, 0, 1);
    this.audio.volume = this.volume;
    if (this.nodes.volume) this.nodes.volume.value = String(this.volume);
    this.persist();
  },

  // ---------- 进度与歌词 ----------
  syncTime() {
    if (!this.nodes.time) return;
    const current = this.audio.currentTime || 0;
    const total = Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
    const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    this.nodes.time.textContent = `${clock(current)} / ${total ? clock(total) : '--:--'}`;
    this.nodes.progress.max = String(Math.floor(total));
    if (!this.seeking) this.nodes.progress.value = String(current);
    this.highlightLyric(current);
  },

  async loadLyrics(track) {
    this.lyrics = (await TB.api.music.lyrics(track)) || [];
    this.lyricIndex = -1;
    this.nodes.lyrics.innerHTML = '';
    if (!this.lyrics.length) {
      this.nodes.lyrics.appendChild(TB.util.el('div', { class: 'pl-none muted', text: track.hasLyrics ? '歌词格式无法解析' : '这首歌没有 .lrc 歌词' }));
      return;
    }
    for (const cue of this.lyrics) this.nodes.lyrics.appendChild(TB.util.el('div', { class: 'lyric', text: cue.text }));
  },

  highlightLyric(current) {
    if (!this.lyrics.length || !this.nodes.lyrics.childElementCount) return;
    let index = -1;
    for (const [i, cue] of this.lyrics.entries()) {
      if (cue.time <= current + 0.3) index = i;
      else break;
    }
    if (index === this.lyricIndex) return;
    this.lyricIndex = index;
    const lines = Array.from(this.nodes.lyrics.children);
    lines.forEach((node, i) => node.classList.toggle('on', i === index));
    lines[index]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  },

  // ---------- 频谱 ----------
  ensureAudioGraph() {
    if (this.ctx || !this.audio.src) return;
    try {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.82;
      this.bins = new Uint8Array(this.analyser.frequencyBinCount);
      this.ctx.createMediaElementSource(this.audio).connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    } catch (err) {
      console.warn('[player] 频谱初始化失败', err.message);
      this.analyser = null;
    }
  },

  drawSpectrum() {
    if (this.spectrumRaf) return;
    const tick = () => {
      this.spectrumRaf = requestAnimationFrame(tick);
      const canvas = this.nodes.spectrum;
      if (!canvas || !this.analyser || this.audio.paused) return;
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 1;
      const height = canvas.clientHeight || 1;
      if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
        canvas.width = width * ratio;
        canvas.height = height * ratio;
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      this.analyser.getByteFrequencyData(this.bins);
      const bars = 56;
      const stepWidth = width / bars;
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#57b6ff';
      for (let i = 0; i < bars; i += 1) {
        const bin = this.bins[Math.round((i / bars) * (this.bins.length * 0.72))];
        const barHeight = Math.max(2, (bin / 255) * (height - 2));
        ctx.globalAlpha = 0.3 + (bin / 255) * 0.7;
        ctx.fillRect(i * stepWidth + 1, height - barHeight, stepWidth - 2, barHeight);
      }
      ctx.globalAlpha = 1;
    };
    this.spectrumRaf = requestAnimationFrame(tick);
  },

  stopSpectrum() {
    if (!this.spectrumRaf) return;
    cancelAnimationFrame(this.spectrumRaf);
    this.spectrumRaf = null;
    const canvas = this.nodes.spectrum;
    if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  },

  // ---------- 重绘（布局重建后复用同一份播放状态） ----------
  repaint() {
    const track = this.tracks[this.index];
    if (track) {
      this.showTrack(track);
    } else if (!this.folder) {
      this.nodes.title.textContent = '未选择音乐文件夹';
      this.nodes.artist.textContent = '点右侧 📁 选一个本地文件夹，自动扫描里面的音乐';
    } else {
      this.nodes.title.textContent = this.tracks.length ? '选择左侧曲目播放' : '没有可播放的文件';
      this.nodes.artist.textContent = this.folder;
    }
    this.nodes.volume.value = String(this.volume);
    this.setPlayIcon(!this.audio.paused && !!this.audio.src);
    this.renderModes();
    this.renderList();
    this.loadLyrics(track || {});
    this.syncTime();
  },

  // ---------- 记忆 ----------
  restore() {
    const saved = TB.app.state.player;
    this.repeat = saved?.repeat || TB.app.state.config?.music?.repeat || 'all';
    this.shuffle = !!saved?.shuffle;
    this.volume = saved?.volume ?? TB.app.state.config?.music?.volume ?? 0.7;
    this.audio.volume = this.volume;
    const index = this.tracks.findIndex((track) => track.id === saved?.trackId);
    if (index < 0) return;
    this.index = index;
    const track = this.tracks[index];
    this.audio.src = track.url;
    if (Number.isFinite(saved.position)) this.audio.currentTime = saved.position;
    this.loadLyrics(track);
  },

  persist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      TB.api.player.save({
        trackId: this.tracks[this.index]?.id ?? null,
        position: this.audio.currentTime || 0,
        volume: this.volume,
        repeat: this.repeat,
        shuffle: this.shuffle
      });
    }, 600);
  }
};
