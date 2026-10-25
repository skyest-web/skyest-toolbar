TB.dock = {
  init(root) {
    root.innerHTML = '';
    this.list = TB.util.el('div', { class: 'dock-items' });
    const add = TB.util.el('button', { class: 'dock-add', title: '添加工具栏入口（写入配置 dock）', text: '＋', onclick: () => TB.settings.open('dock') });
    root.append(this.list, add);

    if (!this.escBound) {
      this.escBound = true;
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && this.active) this.toggle(this.active);
      });
    }
  },

  iconNode(item, cls = 'dock-icon') {
    const icon = item.icon || '';
    if (/^(https?:|data:|file:|[a-z]:[\\/])/i.test(icon)) {
      return TB.util.el('img', { class: cls, src: icon.startsWith('http') ? icon : `file:///${icon.replace(/\\/g, '/')}`, alt: '' });
    }
    return TB.util.el('span', { class: 'dock-emoji', text: icon || '▹' });
  },

  // ---------- 分类 ----------
  groups(items) {
    const declared = (TB.app.state.config?.dockCategories || []).filter((group) => group?.name);
    const map = new Map(declared.map((group) => [group.name, { ...group, items: [] }]));
    for (const item of items) {
      const name = item.category || '未分类';
      if (!map.has(name)) map.set(name, { name, icon: '📦' });
      map.get(name).items.push(item);
    }
    return [...map.values()].filter((group) => group.items.length);
  },

  update(state) {
    const items = (state.config?.dock || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    this.groups_ = this.groups(items);
    const signature = JSON.stringify(this.groups_);
    // 只有曲库真的变了才重建 DOM：展开/收起靠切 class，重建会让宽度过渡直接跳到终值
    if (signature !== this.signature) {
      this.signature = signature;
      this.active = this.groups_[0]?.name || null;
      this.render();
    }
    this.markActive();
  },

  render() {
    this.list.innerHTML = '';
    this.wraps = new Map();
    if (!this.groups_.length) {
      this.list.appendChild(TB.util.el('div', { class: 'dock-empty', text: '还没有快捷入口，点右边的 ＋ 添加常用程序、文件夹或网页' }));
      return;
    }
    for (const group of this.groups_) {
      const entries = TB.util.el(
        'div',
        { class: 'dock-entries' },
        group.items.map((item) =>
          TB.util.el(
            'button',
            {
              class: 'dock-entry',
              title: `${item.name}\n${item.target}`,
              onclick: (event) => this.launch(item, event.currentTarget),
              oncontextmenu: (event) => {
                event.preventDefault();
                this.reveal(item);
              }
            },
            [this.iconNode(item, 'dock-entry-icon'), TB.util.el('span', { class: 'dock-name', text: item.name || '未命名' })]
          )
        )
      );
      const wrap = TB.util.el('div', { class: 'dock-cat-wrap' }, [
        TB.util.el('button', {
          class: 'dock-cat',
          title: `${group.name} · ${group.items.length} 项`,
          onclick: () => this.toggle(group.name)
        }, [this.iconNode(group, 'dock-icon'), TB.util.el('span', { class: 'dock-name', text: group.name })]),
        entries
      ]);
      this.wraps.set(group.name, wrap);
      this.list.appendChild(wrap);
    }
  },

  toggle(name) {
    this.active = this.active === name ? null : name;
    this.markActive();
    if (this.active) this.wraps.get(name)?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  },

  markActive() {
    for (const [name, wrap] of this.wraps || []) wrap.classList.toggle('active', name === this.active);
  },

  async launch(item, button) {
    button?.classList.add('busy');
    const result = await TB.api.dock.launch(item);
    button?.classList.remove('busy');
    if (!result.ok) TB.app.toast(`启动失败：${result.error}`, 'error');
  },

  reveal(item) {
    if (item.type === 'url') TB.api.dock.launch({ type: 'url', target: item.target });
    else TB.api.dock.reveal(item.target);
  }
};
