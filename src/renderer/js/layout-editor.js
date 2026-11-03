TB.layoutEditor = {
  // 「组件与位置」面板：位置（grid.areas 里的区域）是固定的，这里只决定
  // 每个位置放哪个组件、以及是否显示。换组件时两个位置的组件自动对调。
  // 面板（page）分两层：常驻位置所有面板共用、只有一份；本面板位置每页各有一套。
  init(root) {
    this.root = root;
    root.addEventListener('click', (event) => {
      if (event.target === root) this.close();
    });
    if (!this.escBound) {
      this.escBound = true;
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && root.classList.contains('open')) this.close();
      });
    }
  },

  open() {
    this.draft = structuredClone(TB.app.state.grid);
    this.selectPage(TB.app.state.page);
    this.files = [];
    TB.api.components
      .list()
      .then((files) => {
        this.files = files;
        if (this.root.classList.contains('open')) this.render();
      })
      .catch(() => {});
    this.render();
    this.root.classList.add('open');
  },

  close() {
    this.draft = null;
    this.pageIndex = 0;
    this.root.classList.remove('open');
    this.root.innerHTML = '';
  },

  selectPage(id) {
    const index = this.draft.pages.findIndex((page) => page.id === id);
    this.pageIndex = index >= 0 ? index : 0;
  },

  get page() {
    return this.draft.pages[this.pageIndex];
  },

  get componentIds() {
    return [...TB.components.keys()];
  },

  // 当前画面上真的会同时出现的位置 = 常驻 + 本面板；组件对调只在这个范围内找
  visibleSlots() {
    return [...this.draft.shared, ...this.page.slots];
  },

  // 选了一个已经在别处的组件：两个位置的组件对调，位置数量不变。
  // 「空白占位」不算组件——它是清空的意思，跟它对调会把别的格子无辜卷走。
  assign(slot, module) {
    if (module === '') {
      slot.module = '';
      this.render();
      return;
    }
    if (module !== 'placeholder') {
      const other = this.visibleSlots().find((item) => item.module === module && item !== slot);
      if (other) other.module = slot.module;
    }
    slot.module = module;
    this.render();
  },

  toggle(slot, enabled) {
    slot.enabled = enabled;
    this.render();
  },

  async save() {
    const result = await TB.api.layout.save(this.draft);
    if (result?.errors) {
      TB.app.toast(`布局保存失败：${result.errors.join('；')}`, 'error');
      return;
    }
    TB.app.applyLayoutResult(result);
    TB.app.toast('组件位置已应用', 'ok');
    this.close();
  },

  render() {
    if (!this.draft) return;
    this.root.innerHTML = '';
    this.root.appendChild(
      TB.util.el('div', { class: 'settings-modal' }, [
        TB.util.el('div', { class: 'settings-head' }, [
          TB.util.el('h2', { text: '组件与位置' }),
          TB.util.el('span', {
            class: 'muted',
            text: '位置固定，只能换组件或关掉不显示；换组件时两个位置的组件自动对调，写入 layout.json'
          })
        ]),
        this.pageBar(),
        TB.util.el('div', { class: 'layout-editor-grid' }, [
          this.slotCard(this.page.slots, `本面板位置 · ${this.page.slots.length}`, `切到「${this.page.name}」后要配的格子，只影响这一页`),
          // 常驻那三格不跟着页变，放右列和可用组件叠着：550px 高的窗口里左右两列各滚各的，
          // 再往左列下面塞第三张卡就得先滚动才能看见它
          TB.util.el('div', { class: 'card-col' }, [
            this.slotCard(this.draft.shared, `常驻位置 · ${this.draft.shared.length}`, '所有面板共用，切页不动它'),
            this.poolCard()
          ])
        ]),
        TB.util.el('div', { class: 'settings-footer' }, [
          TB.util.el('button', { class: 'primary', text: '保存并应用', onclick: () => this.save() }),
          TB.util.el('button', { text: '恢复默认', onclick: () => this.resetDefault() }),
          TB.util.el('button', { text: '打开 layout.json', onclick: () => TB.api.layout.openFile() }),
          TB.util.el('button', { text: '关闭 (Esc)', onclick: () => this.close() })
        ])
      ])
    );
  },

  // 面板选择条：改的是哪一页，点一下就在草稿里切过去（不切界面，保存后才生效）
  pageBar() {
    return TB.util.el(
      'div',
      { class: 'page-tabs' },
      this.draft.pages.map((page, index) =>
        TB.util.el('button', {
          class: `page-tab${index === this.pageIndex ? ' active' : ''}`,
          text: page.name,
          'data-page': page.id,
          onclick: () => {
            this.pageIndex = index;
            this.render();
          }
        })
      )
    );
  },

  resetDefault() {
    this.draft = structuredClone(TB.app.defaultLayout);
    this.pageIndex = Math.min(this.pageIndex, this.draft.pages.length - 1);
    this.render();
  },

  slotCard(slots, title, hint) {
    const rows = TB.util.el('div', { class: 'slot-list' });
    const used = new Set(this.visibleSlots().map((slot) => slot.module).filter(Boolean));
    for (const slot of slots) {
      const missing = slot.module && !TB.components.has(slot.module);
      const select = TB.util.el(
        'select',
        {
          class: 'input slot-select',
          onchange: (event) => this.assign(slot, event.target.value)
        },
        [
          TB.util.el('option', { value: '', text: '（空着不显示）', selected: !slot.module }),
          ...this.componentIds.map((id) => {
            const def = TB.components.get(id);
            const placed = id !== 'placeholder' && used.has(id) && id !== slot.module;
            return TB.util.el('option', {
              value: id,
              text: placed ? `${def.name}（换到此处，原位置对调）` : def.name,
              selected: id === slot.module
            });
          }),
          ...(missing ? [TB.util.el('option', { value: slot.module, text: `未找到组件「${slot.module}」`, selected: true })] : [])
        ]
      );
      rows.appendChild(
        TB.util.el('div', { class: 'slot-row' }, [
          TB.util.el('div', { class: 'slot-where' }, [
            TB.util.el('span', { class: 'slot-label', text: slot.label || slot.at }),
            TB.util.el('span', { class: 'slot-area muted', text: slot.at })
          ]),
          select,
          TB.util.el('label', { class: 'slot-show' }, [
            TB.util.el('input', {
              type: 'checkbox',
              checked: slot.enabled ? 'checked' : undefined,
              onchange: (event) => this.toggle(slot, event.target.checked)
            }),
            TB.util.el('span', { text: '显示' })
          ])
        ])
      );
    }

    return TB.util.el('section', { class: 'card' }, [
      TB.util.el('h3', { text: title }),
      TB.util.el('p', { class: 'muted drop-hint', text: hint }),
      rows
    ]);
  },

  poolCard() {
    const used = new Set(this.visibleSlots().map((slot) => slot.module).filter(Boolean));
    const idle = this.componentIds.filter((id) => !used.has(id));
    const list = TB.util.el('div', { class: 'slot-list' });
    if (!idle.length) {
      list.appendChild(TB.util.el('div', { class: 'muted dk-empty', text: '所有已注册的组件都已经在某个位置上了' }));
    }
    for (const id of idle) {
      const def = TB.components.get(id);
      list.appendChild(
        TB.util.el('div', { class: 'slot-row' }, [
          TB.util.el('div', { class: 'slot-where' }, [
            TB.util.el('span', { class: 'slot-label', text: def.name }),
            TB.util.el('span', { class: 'slot-area muted', text: id })
          ]),
          TB.util.el('span', { class: 'muted', text: '尚未放置，在上面的下拉里选它即可' })
        ])
      );
    }

    return TB.util.el('section', { class: 'card' }, [
      TB.util.el('h3', { text: `可用组件 · ${this.componentIds.length}` }),
      list,
      TB.util.el('p', {
        class: 'muted drop-hint',
        text: `新增组件：往 src/renderer/js/components/ 放一个 .js 并调用 TB.register()，重启后自动出现在这里（当前目录 ${this.files.length} 个文件）。`
      })
    ]);
  }
};
