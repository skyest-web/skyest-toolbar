// dsh 面板（渲染层这一半）：只画框、报尺寸、显示状态。
// 页面里从头到尾没有出现过去过 dsh 的地址：主进程把 WebContentsView 盖在 .dsh-body 这块矩形上，
// 带 token 的完整地址只存在于主进程内存。
TB.dsh = {
  init(root) {
    this.root = root;
    root.innerHTML = '';

    this.label = TB.util.el('span', { class: 'dsh-title', text: 'DeepSeek Harness' });
    this.badge = TB.util.el('span', { class: 'dsh-badge', text: '未启动' });
    this.head = TB.util.el('div', { class: 'dsh-head' }, [
      this.label,
      this.badge,
      TB.util.el('button', { class: 'dsh-close', text: '×', title: '关闭面板（焦点在这页时 Esc 也行）', onclick: () => this.close() })
    ]);

    this.note = TB.util.el('div', { class: 'dsh-note' });
    this.retry = TB.util.el('button', { class: 'link-btn hidden', text: '重试', onclick: () => this.open() });
    this.body = TB.util.el('div', { class: 'dsh-body' }, [this.note, this.retry]);

    root.append(this.head, this.body);

    this.state = null;
    TB.api.dsh.onState((status) => this.apply(status));

    // 视图的尺寸是主进程的事，渲染层只负责把这块内区量准（换屏、改布局都会触发）
    this.observer = new ResizeObserver(() => this.syncBounds());
    this.observer.observe(this.body);

    document.addEventListener('pointerdown', (event) => {
      if (this.opened && !this.root.contains(event.target)) this.close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.opened) this.close();
    });
  },

  innerBounds() {
    const rect = this.body.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  },

  syncBounds() {
    if (this.opened) TB.api.dsh.setBounds(this.innerBounds());
  },

  async open() {
    if (this.opened) return;
    this.opened = true;
    this.root.classList.add('open');
    this.showNote('正在拉起 dsh…（首次启动要装载插件，可能要几十秒）', false);
    const result = await TB.api.dsh.show(this.innerBounds());
    if (!result.ok) this.showNote(`启动失败：${result.message}`, true);
    this.apply(result.status);
  },

  close() {
    if (!this.opened) return;
    this.opened = false;
    this.root.classList.remove('open');
    TB.api.dsh.hide();
  },

  toggle() {
    if (this.opened) this.close();
    else this.open();
  },

  showNote(text, canRetry) {
    this.note.textContent = text;
    this.note.classList.remove('hidden');
    this.retry.classList.toggle('hidden', !canRetry);
  },

  apply(status) {
    if (!status) return;
    this.state = status;
    const version = status.version ? `v${status.version}` : '';
    this.badge.textContent = status.running
      ? `${version} · 运行中 :${status.port}`
      : status.installed ? `${version} · 未启动` : '未安装';
    this.badge.classList.toggle('ok', Boolean(status.running));
    this.badge.classList.toggle('warn', !status.installed);
    if (status.running) {
      // dsh 的页面会盖住这块内区，占位文字就该让位
      this.note.classList.add('hidden');
      this.retry.classList.add('hidden');
    } else if (this.opened) {
      // 子进程半路退了也要说一声，不能留一块空白
      this.showNote(status.lastError || 'dsh 现在没在跑', true);
    }
  }
};
