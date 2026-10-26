TB.dockEditor = {
  // dock 的表单式配置面板：新增 / 修改 / 删除快捷入口，以及分类的改名、换图标、排序。
  // 每次操作都立刻写回 toolbar.config.json，不留"未保存"状态。
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

  get items() {
    return (TB.app.state.config?.dock || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  },

  get categories() {
    return TB.app.state.config?.dockCategories || [];
  },

  open(index = null) {
    this.editing = index;
    this.form = null;
    this.render();
    this.root.classList.add('open');
  },

  close() {
    this.editing = null;
    this.form = null;
    this.root.classList.remove('open');
    this.root.innerHTML = '';
  },

  async write({ dock, dockCategories }) {
    const result = await TB.api.config.save({
      dock: (dock ?? this.items).map((item, index) => ({ ...item, order: index + 1 })),
      dockCategories: dockCategories ?? this.categories
    });
    if (!result?.config) {
      TB.app.toast(`保存失败：${result?.error || '未知错误'}`, 'error');
      return;
    }
    TB.app.applyConfigResult(result);
    this.render();
  },

  render() {
    if (this.editing !== null && !this.items[this.editing]) this.editing = null;
    this.root.innerHTML = '';
    this.root.appendChild(
      TB.util.el('div', { class: 'settings-modal' }, [
        TB.util.el('div', { class: 'settings-head' }, [
          TB.util.el('h2', { text: '快捷方式' }),
          TB.util.el('span', { class: 'muted', text: '改动立刻写入 toolbar.config.json 的 dock / dockCategories' })
        ]),
        TB.util.el('div', { class: 'dock-editor-grid' }, [this.listCard(), this.formCard(), this.categoryCard()]),
        TB.util.el('div', { class: 'settings-footer' }, [
          TB.util.el('button', { text: '关闭 (Esc)', onclick: () => this.close() })
        ])
      ])
    );
  },

  // ---------- 左：已有入口 ----------
  listCard() {
    const rows = TB.util.el('div', { class: 'entry-list' });
    if (!this.items.length) {
      rows.appendChild(TB.util.el('div', { class: 'muted dk-empty', text: '还没有快捷入口，用右边的表单添加第一个' }));
    }
    this.items.forEach((item, index) => {
      rows.appendChild(
        TB.util.el(
          'div',
          { class: `entry-row${index === this.editing ? ' current' : ''}` },
          [
            TB.util.el('span', { class: 'entry-emoji', text: item.icon && !/[\\/:]/.test(item.icon) ? item.icon : '▹' }),
            TB.util.el('div', { class: 'entry-main' }, [
              TB.util.el('span', { class: 'entry-name', text: item.name || '未命名' }),
              TB.util.el('span', { class: 'entry-target muted', text: item.target || '' })
            ]),
            TB.util.el('span', { class: 'entry-cat', text: item.category || '未分类' }),
            TB.util.el('div', { class: 'entry-ops' }, [
              TB.util.el('button', { class: 'mini-btn', text: '↑', title: '上移', onclick: () => this.move(index, -1) }),
              TB.util.el('button', { class: 'mini-btn', text: '↓', title: '下移', onclick: () => this.move(index, 1) }),
              TB.util.el('button', { class: 'mini-btn', text: '编辑', onclick: () => this.edit(index) }),
              TB.util.el('button', { class: 'mini-btn danger', text: '删除', onclick: () => this.remove(index) })
            ])
          ]
        )
      );
    });

    return TB.util.el('section', { class: 'card' }, [
      TB.util.el('h3', { text: `已有入口 · ${this.items.length}` }),
      rows,
      TB.util.el('button', { class: 'ghost-btn dk-add', text: '＋ 新建入口', onclick: () => this.edit(null) })
    ]);
  },

  async move(index, delta) {
    const list = this.items;
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    await this.write({ dock: list, dockCategories: null });
    if (this.editing === index) this.editing = target;
    else if (this.editing === target) this.editing = index;
    this.render();
  },

  async remove(index) {
    const item = this.items[index];
    const list = this.items.filter((_, position) => position !== index);
    this.editing = null;
    this.form = null;
    await this.write({ dock: list, dockCategories: null });
    TB.app.toast(`已删除「${item?.name || '未命名'}」`, 'ok');
  },

  // ---------- 中：表单 ----------
  edit(index) {
    this.editing = index;
    this.form = index === null ? {} : { ...this.items[index] };
    this.render();
  },

  formCard() {
    const isNew = this.editing === null || !this.items[this.editing];
    const data = this.form || (isNew ? { type: 'path', category: this.categories[0]?.name || '' } : this.items[this.editing]);
    const field = (label, control, hint) =>
      TB.util.el('label', { class: 'field' }, [
        TB.util.el('span', { class: 'field-label', text: label }),
        TB.util.el('div', { class: 'field-control' }, [control, hint ? TB.util.el('span', { class: 'field-hint', text: hint }) : null])
      ]);
    const text = (value, placeholder) => TB.util.el('input', { class: 'input', type: 'text', value: value ?? '', placeholder: placeholder || '' });
    const pick = (kind, into, label) =>
      TB.util.el('button', {
        class: 'mini-btn',
        text: label,
        onclick: async () => {
          const picked = await TB.api.dock.pickPath(kind);
          if (picked) into.value = picked;
        }
      });

    const name = text(data.name, '例如 任务管理器');
    const type = TB.util.el('select', { class: 'input' }, [
      TB.util.el('option', { value: 'path', text: '程序 / 文件夹 / 文档（本机路径）', selected: (data.type || 'path') === 'path' }),
      TB.util.el('option', { value: 'url', text: '链接（https: 或 ms-settings: 这类协议）', selected: data.type === 'url' }),
      TB.util.el('option', { value: 'cmd', text: '命令（直接起进程）', selected: data.type === 'cmd' })
    ]);
    const target = text(data.target, 'C:\\Windows\\System32\\Taskmgr.exe');
    const targetRow = TB.util.el('div', { class: 'inline' }, [
      target,
      pick('file', target, '选文件…'),
      pick('folder', target, '选文件夹…')
    ]);
    const category = TB.util.el('select', { class: 'input' }, [
      TB.util.el('option', { value: '', text: '未分类', selected: !data.category }),
      ...[...new Set([...this.categories.map((group) => group.name), ...this.items.map((item) => item.category).filter(Boolean)])].map((categoryName) =>
        TB.util.el('option', { value: categoryName, text: categoryName, selected: categoryName === data.category })
      )
    ]);
    const icon = text(data.icon, 'emoji（📁）或图片路径');
    const iconRow = TB.util.el('div', { class: 'inline' }, [icon, pick('image', icon, '选图片…')]);

    const submit = async () => {
      const entry = {
        name: name.value.trim(),
        type: type.value,
        target: target.value.trim(),
        category: category.value,
        icon: icon.value.trim()
      };
      if (!entry.name || !entry.target) return TB.app.toast('名称和目标都要填', 'error');
      if (!entry.category) delete entry.category;
      if (!entry.icon) delete entry.icon;

      const list = this.items.slice();
      if (isNew || this.editing === null) list.push(entry);
      else list[this.editing] = { ...list[this.editing], ...entry };
      this.editing = null;
      this.form = null;
      await this.write({ dock: list, dockCategories: null });
      TB.app.toast(`${isNew ? '已添加' : '已保存'}「${entry.name}」`, 'ok');
    };

    return TB.util.el('section', { class: 'card' }, [
      TB.util.el('h3', { text: isNew ? '新建入口' : `编辑「${this.items[this.editing]?.name || '未命名'}」` }),
      field('名称', name, 'dock 上显示的文字'),
      field('类型', type),
      field('目标', targetRow, '路径、链接或命令都可以直接粘贴'),
      field('分类', category, '想新加一个分类，先到右边「分类」里添加'),
      field('图标', iconRow, '留空显示 ▹'),
      TB.util.el('div', { class: 'inline dk-form-ops' }, [
        TB.util.el('button', { class: 'primary', text: isNew ? '添加' : '保存修改', onclick: submit }),
        isNew ? null : TB.util.el('button', { text: '取消', onclick: () => this.edit(null) })
      ])
    ]);
  },

  // ---------- 右：分类 ----------
  categoryCard() {
    const rows = TB.util.el('div', { class: 'entry-list' });
    const groups = this.categories;
    if (!groups.length) {
      rows.appendChild(TB.util.el('div', { class: 'muted dk-empty', text: '还没有分类，下面的入口默认进「未分类」' }));
    }
    groups.forEach((group, index) => {
      const nameInput = TB.util.el('input', { class: 'input', type: 'text', value: group.name });
      const iconInput = TB.util.el('input', { class: 'input dk-icon-input', type: 'text', value: group.icon || '' });
      const commit = () => {
        const next = groups.map((item, position) => (position === index ? { ...item, name: nameInput.value.trim() || item.name, icon: iconInput.value.trim() } : item));
        const renamed = next[index].name !== group.name;
        const dock = renamed
          ? this.items.map((item) => (item.category === group.name ? { ...item, category: next[index].name } : item))
          : null;
        this.write({ dock, dockCategories: next });
      };
      rows.appendChild(
        TB.util.el('div', { class: 'entry-row dk-cat-row' }, [
          iconInput,
          nameInput,
          TB.util.el('span', { class: 'entry-cat', text: `${this.items.filter((item) => (item.category || '未分类') === group.name).length} 项` }),
          TB.util.el('div', { class: 'entry-ops' }, [
            TB.util.el('button', {
              class: 'mini-btn',
              text: '↑',
              onclick: () => {
                if (!index) return;
                const next = groups.slice();
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                this.write({ dock: null, dockCategories: next });
              }
            }),
            TB.util.el('button', {
              class: 'mini-btn',
              text: '↓',
              onclick: () => {
                if (index === groups.length - 1) return;
                const next = groups.slice();
                [next[index + 1], next[index]] = [next[index], next[index + 1]];
                this.write({ dock: null, dockCategories: next });
              }
            }),
            TB.util.el('button', { class: 'mini-btn', text: '存', title: '保存改名 / 换图标', onclick: commit }),
            TB.util.el('button', {
              class: 'mini-btn danger',
              text: '删',
              title: '只删分类定义，条目会退回未分类',
              onclick: () => this.write({ dock: null, dockCategories: groups.filter((_, position) => position !== index) })
            })
          ])
        ])
      );
    });

    return TB.util.el('section', { class: 'card' }, [
      TB.util.el('h3', { text: `分类 · ${groups.length}` }),
      rows,
      TB.util.el('button', {
        class: 'ghost-btn dk-add',
        text: '＋ 添加分类',
        onclick: () => this.write({ dock: null, dockCategories: [...groups, { name: `分类 ${groups.length + 1}`, icon: '📦' }] })
      })
    ]);
  }
};
