// 顶栏搜索栏：输入框常驻在顶栏，结果下拉面板画在渲染层。
// 查询和"打开"都在主进程——渲染层只见 (listId, 序号)，拿不到也不需要绝对路径。
TB.search = {
  init(root) {
    this.root = root;
    this.input = null;
    this.badge = null;
    this.opened = false;
    this.query = '';
    this.listId = null;
    this.items = [];
    this.active = -1;
    this.total = 0;
    this.seq = 0;
    this.inflight = false;
    this.trailing = null;
    this.timer = null;
    this.status = null;
    this.build();
    TB.api.search.status().then((status) => this.applyStatus(status));
    TB.api.search.onState((status) => this.applyStatus(status));
    // 点搜索栏和下拉之外才收起；输入框本身不算"外面"，否则点它会先关再由 focus 重开
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!this.opened) return;
        if (this.root.contains(event.target)) return;
        if (event.target.closest && event.target.closest('.search-bar')) return;
        this.close();
      },
      true
    );
  },

  build() {
    this.note = TB.util.el('div', { class: 'search-note hidden' });
    this.list = TB.util.el('ul', { class: 'search-list' });
    this.body = TB.util.el('div', { class: 'search-body' }, [this.note, this.list]);
    this.root.classList.add('search-panel', 'hidden');
    this.root.appendChild(TB.util.el('div', { class: 'search-inner' }, [this.body]));
  },

  // 顶栏重建后重新认领输入框与徽章（事件绑在新节点上，不会重复）
  attachBar(input, badge) {
    this.input = input || null;
    this.badge = badge || null;
    if (!this.input) return;
    this.input.value = this.query;
    this.input.addEventListener('input', () => this.onType());
    this.input.addEventListener('keydown', (event) => this.onKey(event));
    this.input.addEventListener('focus', () => this.open());
    this.applyStatus(this.status);
    if (this.opened) this.place();
  },

  place() {
    if (!this.input) return;
    const rect = this.input.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const width = Math.min(Math.max(rect.width + 80, 460), viewportWidth - 24);
    const left = Math.max(12, Math.min(rect.left - 40, viewportWidth - width - 12));
    this.root.style.left = `${Math.round(left)}px`;
    this.root.style.top = `${Math.round(rect.bottom + 6)}px`;
    this.root.style.width = `${Math.round(width)}px`;
    this.root.style.maxHeight = `${Math.round(Math.max(140, window.innerHeight - rect.bottom - 14))}px`;
  },

  focus() {
    if (!this.input) return;
    this.input.focus();
    this.open();
  },

  show() {
    if (this.opened) return;
    this.opened = true;
    this.place();
    this.root.classList.remove('hidden');
  },

  open() {
    this.show();
    TB.api.search.probe().then((status) => this.applyStatus(status));
    if (this.query.trim()) this.run(this.query.trim());
    else this.clear('输入文件名片段就开始搜索，回车打开高亮项。');
  },

  close() {
    this.opened = false;
    this.root.classList.add('hidden');
    clearTimeout(this.timer);
    this.trailing = null;
  },

  applyStatus(status) {
    if (!status) return;
    this.status = status;
    if (!this.badge) return;
    const b = this.badge;
    b.className = 'search-badge';
    if (!status.supported) {
      b.textContent = '仅 Windows';
    } else if (!status.installed) {
      b.classList.add('warn');
      b.textContent = '未安装';
    } else if (status.running && status.dbLoaded) {
      b.classList.add('ok');
      b.textContent = `已连接 ${status.sdkVersion || ''}`;
    } else if (status.running) {
      b.classList.add('warn');
      b.textContent = '索引中…';
    } else {
      b.classList.add('warn');
      b.textContent = status.lastError ? '连不上' : '未运行';
    }
  },

  onType() {
    this.query = this.input ? this.input.value : '';
    clearTimeout(this.timer);
    const text = this.query.trim();
    this.show();
    if (!text) {
      this.clear('再输几个字就有结果。');
      return;
    }
    this.timer = setTimeout(() => this.run(text), 180);
  },

  // 查询是阻塞调用，同一时刻只发一条：新输入先记下来，等手头这条回来再补发最后一次的输入。
  async run(text) {
    if (this.inflight) {
      this.trailing = text;
      return;
    }
    this.inflight = true;
    const seq = ++this.seq;
    let result = null;
    try {
      result = await TB.api.search.query(text);
    } finally {
      this.inflight = false;
    }
    if (seq !== this.seq) return; // 已经被更新的输入取代
    if (this.trailing != null) {
      const next = this.trailing;
      this.trailing = null;
      this.run(next);
      return;
    }
    if (!result || !result.ok) {
      this.items = [];
      this.listId = null;
      this.total = 0;
      this.active = -1;
      this.list.replaceChildren();
      let message = (result && result.message) || '没查到东西';
      if (result && result.tooShort) message = '再多打一个字才发查询（字数下限在设置里改）';
      else if (result && result.ipcDown) message = 'Everything 没在运行，正在尝试拉起…再按一次回车重试';
      this.showNote(message, !(result && result.tooShort));
      return;
    }
    this.items = result.items || [];
    this.listId = result.listId;
    this.total = result.total || this.items.length;
    this.active = this.items.length ? 0 : -1;
    this.render();
  },

  render() {
    this.showNote(this.items.length ? '' : '这个索引里没有一个文件匹配。', false);
    const rows = this.items.map((item, index) => {
      const meta = item.folder ? '文件夹' : TB.util.bytes(item.size);
      const name = TB.util.el('span', { class: 'search-name', text: item.name });
      const dir = TB.util.el('span', { class: 'search-path', text: item.path });
      const size = TB.util.el('span', { class: 'search-meta', text: meta });
      const li = TB.util.el('li', { class: 'search-row' + (index === this.active ? ' active' : '') }, [name, dir, size]);
      li.addEventListener('click', () => this.choose(index));
      li.addEventListener('dblclick', () => this.choose(index));
      li.addEventListener('pointerenter', () => this.setActive(index));
      return li;
    });
    this.list.replaceChildren(...rows);
    if (this.total > this.items.length) {
      this.list.appendChild(TB.util.el('li', { class: 'search-more', text: `还有 ${this.total - this.items.length} 条没显示，关键字再具体一点` }));
    }
  },

  setActive(index) {
    if (!this.items.length) return;
    const next = Math.max(0, Math.min(this.items.length - 1, index));
    if (next === this.active) return;
    this.active = next;
    [...this.list.children].forEach((node, i) => {
      if (node.classList.contains('search-row')) node.classList.toggle('active', i === next);
    });
    const node = this.list.children[next];
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
  },

  clear(message) {
    this.items = [];
    this.listId = null;
    this.active = -1;
    this.total = 0;
    this.list.replaceChildren();
    this.showNote(message, true);
  },

  showNote(message, dim) {
    this.note.textContent = message || '';
    this.note.classList.toggle('hidden', !message);
    this.note.classList.toggle('muted', Boolean(dim));
  },

  async choose(index) {
    if (!this.listId) return;
    const result = await TB.api.search.open(this.listId, index);
    if (!result.ok) TB.app.toast(`打不开：${result.message}`, 'error');
    else {
      this.close();
      this.input?.blur();
    }
  },

  onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      this.input?.blur();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.show();
      this.setActive(this.active + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.show();
      this.setActive(this.active - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const text = this.input ? this.input.value.trim() : '';
      if (!this.items.length && text) {
        clearTimeout(this.timer);
        this.run(text);
        return;
      }
      if (this.active >= 0) this.choose(this.active);
    }
  }
};
