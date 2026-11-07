// 生活面板 gauges 那一格（1152×176 的宽条）：本地照片墙。
// 一排缩略图横向滚，点一张在整窗上开大图浮层，←/→ 翻页、Esc 或点暗色背景关。
//
// 图走 file:///（CSP 的 img-src 本来就放了 file:，游戏列表图标一直是这么来的），**不走 track://**——
// 那条自定义协议是为 <audio>/<video> 准备的，媒体元素受跨源策略限制，<img> 不受。
// 所以这一格连 save 都没有：照片看完就看完，不需要「上次第几张」。
//
// 浮层挂在 document.body 上而不是格子里：.area 有 overflow:hidden，越出格子的部分会被**静默**吃掉
// （DOM 在、量得到、就是看不见），要盖住整个窗口只能挂 body + position:fixed。
// 浮层一开就盖住顶栏，切面板得先关它，所以它不会跟着面板重建而留在原地。
//
// EXIF 方向不用自己解析：Chromium 默认 `image-orientation: from-image`，竖拍的照片会自己转正。

TB.photos = {
  items: [],
  index: -1,
  folder: null,
  error: null,
  busy: false,
  opened: -1,
  el: null,

  init(root) {
    this.root = root;
    root.innerHTML = '';

    this.count = TB.util.el('span', { class: 'ph-count', text: '' });
    this.revealBtn = TB.util.el('button', {
      class: 'link-btn',
      text: '定位',
      title: '在资源管理器里选中当前放大看的那张',
      onclick: () => this.reveal()
    });
    this.pickBtn = TB.util.el('button', {
      class: 'link-btn',
      text: '选文件夹',
      title: '挑一个本地照片文件夹，只扫里面的 jpg / jpeg / png / webp / avif / gif / bmp',
      onclick: () => this.pickFolder()
    });
    this.head = TB.util.el('div', { class: 'ph-head' }, [
      TB.util.el('span', { class: 'panel-title', text: '相册' }),
      this.count,
      TB.util.el('span', { class: 'ph-grow' }),
      this.revealBtn,
      this.pickBtn
    ]);

    this.strip = TB.util.el('div', { class: 'ph-strip' });
    root.append(this.head, this.strip);

    this.ensureOverlay();
    if (!this.bound) this.bind();
    this.repaint();
  },

  // 浮层只建一次：每次点开都重建 <img> 会让大图重新解码，翻页就闪一下
  ensureOverlay() {
    if (this.el) return;
    this.full = TB.util.el('img', { class: 'ph-full', alt: '' });
    this.cap = TB.util.el('span', { class: 'ph-cap-text' });
    const prev = TB.util.el('button', { class: 'ph-nav', text: '‹', title: '上一张（←）', onclick: () => this.step(-1) });
    const next = TB.util.el('button', { class: 'ph-nav', text: '›', title: '下一张（→）', onclick: () => this.step(1) });
    const close = TB.util.el('button', { class: 'ph-nav ph-close', text: '×', title: '关闭（Esc）', onclick: () => this.close() });
    this.bar = TB.util.el('div', { class: 'ph-bar' }, [this.cap, TB.util.el('span', { class: 'ph-grow' }), prev, next, close]);
    this.stage = TB.util.el('div', { class: 'ph-stage' }, [this.full]);
    this.el = TB.util.el('div', { class: 'ph-view', onclick: (event) => { if (event.target === this.el || event.target === this.stage) this.close(); } }, [this.bar, this.stage]);
    this.el.hidden = true;
    document.body.appendChild(this.el);
  },

  // 键盘只绑一次：init 每次切面板都会跑，绑两遍就是一按 ← 翻两张
  bind() {
    this.bound = true;
    document.addEventListener('keydown', (event) => {
      if (this.el?.hidden) return;
      // 输入框里的方向键是编辑操作（顶栏搜索栏就在同一层），别抢
      if (event.target instanceof Element && event.target.closest('input, textarea, select')) return;
      if (event.key === 'Escape') { this.close(); event.preventDefault(); }
      else if (event.key === 'ArrowLeft') { this.step(-1); event.preventDefault(); }
      else if (event.key === 'ArrowRight') { this.step(1); event.preventDefault(); }
    });
    // 切面板、缩窗口时浮层要跟着重贴，图片本身有 max-width/height 兜着，这里只收起
    window.addEventListener('resize', () => this.close());
  },

  // ---------- 清单 ----------
  update(state) {
    const cfg = state?.config?.photos || {};
    const folder = cfg.folder || '';
    if (folder === this.folder) return;
    this.folder = folder;
    this.index = -1;
    this.opened = -1;
    this.close();
    this.rescan();
  },

  async rescan() {
    if (!this.folder) {
      this.items = [];
      this.error = null;
      this.repaint();
      return;
    }
    this.busy = true;
    this.renderHead();
    const result = await TB.api.photos.scan(this.folder);
    this.busy = false;
    this.items = result.photos || [];
    this.error = result.error || null;
    if (!this.items.length && this.error) TB.app.toast(this.error, 'warn');
    this.repaint();
  },

  async pickFolder() {
    const picked = await TB.api.photos.pickFolder();
    if (!picked) return;
    const result = await TB.api.config.save({ photos: { folder: picked } });
    if (!result?.config) {
      TB.app.toast(`保存配置失败：${result?.error || '未知错误'}`, 'error');
      return;
    }
    TB.app.applyConfigResult(result);
    // applyConfigResult → renderAll → update() 通常已经重扫过，这里只兜「那一趟没走到本组件」的情况
    if (picked !== this.folder) this.rescan();
    TB.app.toast(`已加载照片文件夹 ${picked}`);
  },

  reveal() {
    const item = this.items[this.opened >= 0 ? this.opened : this.index];
    if (!item) {
      TB.app.toast('先点一张照片，才能定位到那个文件', 'warn');
      return;
    }
    TB.api.dock.reveal(item.path);
  },

  // ---------- 浮层 ----------
  open(index) {
    const item = this.items[index];
    if (!item) return;
    this.opened = index;
    this.index = index;
    this.full.src = item.url;
    this.full.alt = item.title;
    this.el.hidden = false;
    this.renderCap();
    this.renderStrip();
  },

  close() {
    if (!this.el || this.el.hidden) return;
    this.el.hidden = true;
    // 关掉就把 src 摘掉：留着一张全屏大图会把解码后的位图一直占在内存里
    this.full.removeAttribute('src');
    this.renderStrip();
  },

  step(delta) {
    if (!this.items.length) return;
    const next = (this.opened + delta + this.items.length) % this.items.length;
    this.open(next);
    this.items[next]?.element?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  },

  // ---------- 重绘 ----------
  repaint() {
    this.renderHead();
    this.renderStrip();
  },

  renderHead() {
    if (!this.count) return;
    if (this.busy) this.count.textContent = '扫描中…';
    else if (!this.folder) this.count.textContent = '没设置文件夹';
    else if (this.error) this.count.textContent = '没扫到';
    else this.count.textContent = `${this.items.length} 张`;
    this.count.title = this.folder || '点右上「选文件夹」挑一个本地目录';
    this.revealBtn.classList.toggle('on', this.opened >= 0 || this.index >= 0);
  },

  renderStrip() {
    if (!this.strip) return;
    this.strip.innerHTML = '';
    if (!this.items.length) {
      this.strip.appendChild(TB.util.el('div', { class: 'ph-none', text: this.error || (this.folder ? '该文件夹里没有能显示的图片' : '还没选照片文件夹') }));
      return;
    }
    // opened 关掉后仍留着（「定位」靠它找最后看过那张），但那一圈光只在浮层真开着的时候才有：
    // 关掉之后整条里还亮着一张，看着像浮层没关干净
    const showing = !this.el?.hidden;
    this.items.forEach((item, index) => {
      const img = TB.util.el('img', { class: 'ph-thumb', src: item.url, alt: item.title, loading: 'eager' });
      const button = TB.util.el('button', {
        class: `ph-item${showing && index === this.opened ? ' open' : ''}${index === this.index && !showing ? ' active' : ''}`,
        title: `${item.path}\n${TB.util.date(item.mtime)} · ${TB.util.bytes(item.size)}`,
        onclick: () => this.open(index)
      }, [img]);
      item.element = button;
      this.strip.appendChild(button);
    });
  },

  renderCap() {
    if (!this.cap) return;
    const item = this.items[this.opened];
    if (!item) {
      this.cap.textContent = '';
      return;
    }
    this.cap.textContent = `${item.title} · ${TB.util.date(item.mtime)} · ${TB.util.bytes(item.size)} · ${this.opened + 1}/${this.items.length}`;
    this.cap.title = item.path;
  }
};

TB.register({
  id: 'photos',
  name: '相册（本地照片墙）',
  cls: 'area photos-area',
  build: () => TB.util.el('div', { id: 'photos' }),
  init: (node) => TB.photos.init(node),
  update: (state) => TB.photos.update(state)
});
