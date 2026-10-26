TB.layoutEditor = {
  // 「组件与位置」面板：位置（grid.areas 里的区域）是固定的，这里只决定
  // 每个位置放哪个组件、以及是否显示。把组件换成别的组件时，两边会自动对调。
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
    this.root.classList.remove('open');
    this.root.innerHTML = '';
  },

  get componentIds() {
    return [...TB.components.keys()];
  },

  slotIndex(module) {
    return this.draft.slots.findIndex((slot) => slot.module === module);
  },

  // 选了一个已经在别处的组件：两个位置的组件对调，位置数量不变。
  assign(index, module) {
    const slots = this.draft.slots;
    if (module === '') {
      slots[index].module = '';
      this.render();
      return;
    }
    const other = this.slotIndex(module);
    if (other >= 0 && other !== index) slots[other].module = slots[index].module;
    slots[index].module = module;
    this.render();
  },

  toggle(index, enabled) {
    this.draft.slots[index].enabled = enabled;
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
        TB.util.el('div', { class: 'layout-editor-grid' }, [this.slotCard(), this.poolCard()]),
        TB.util.el('div', { class: 'settings-footer' }, [
          TB.util.el('button', { class: 'primary', text: '保存并应用', onclick: () => this.save() }),
          TB.util.el('button', { text: '恢复默认', onclick: () => this.resetDefault() }),
          TB.util.el('button', { text: '打开 layout.json', onclick: () => TB.api.layout.openFile() }),
          TB.util.el('button', { text: '关闭 (Esc)', onclick: () => this.close() })
        ])
      ])
    );
  },

  resetDefault() {
    this.draft = structuredClone(TB.app.defaultLayout);
    this.render();
  },

  slotCard() {
    const rows = TB.util.el('div', { class: 'slot-list' });
    const used = new Set(this.draft.slots.map((slot) => slot.module).filter(Boolean));
    this.draft.slots.forEach((slot, index) => {
      const missing = slot.module && !TB.components.has(slot.module);
      const select = TB.util.el(
        'select',
        {
          class: 'input slot-select',
          onchange: (event) => this.assign(index, event.target.value)
        },
        [
          TB.util.el('option', { value: '', text: '（空着不显示）', selected: !slot.module }),
          ...this.componentIds.map((id) => {
            const def = TB.components.get(id);
            const placed = used.has(id) && id !== slot.module;
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
              onchange: (event) => this.toggle(index, event.target.checked)
            }),
            TB.util.el('span', { text: '显示' })
          ])
        ])
      );
    });

    return TB.util.el('section', { class: 'card' }, [
      TB.util.el('h3', { text: `位置 · ${this.draft.slots.length}` }),
      rows
    ]);
  },

  poolCard() {
    const used = new Set(this.draft.slots.map((slot) => slot.module).filter(Boolean));
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
