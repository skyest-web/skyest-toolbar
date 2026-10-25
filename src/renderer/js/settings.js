TB.settings = {
  init(root) {
    this.root = root;
    root.addEventListener('click', (event) => {
      if (event.target === root) this.close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && root.classList.contains('open')) this.close();
    });
  },

  field(labelText, control, hint) {
    return TB.util.el('label', { class: 'field' }, [
      TB.util.el('span', { class: 'field-label', text: labelText }),
      TB.util.el('div', { class: 'field-control' }, [control, hint ? TB.util.el('span', { class: 'field-hint', text: hint }) : null])
    ]);
  },

  number(value, min, max, step = 1) {
    return TB.util.el('input', { class: 'input num', type: 'number', value, min, max, step });
  },

  checkbox(checked) {
    const box = TB.util.el('input', { type: 'checkbox' });
    box.checked = !!checked;
    return box;
  },

  jsonArea(value) {
    return TB.util.el('textarea', { class: 'json-area', spellcheck: 'false', text: JSON.stringify(value, null, 2) });
  },

  parseJson(area, label) {
    try {
      const parsed = JSON.parse(area.value);
      if (!Array.isArray(parsed)) throw new Error(`${label} 顶层需要是数组 []`);
      return { value: parsed };
    } catch (err) {
      return { error: `${label} 不是合法 JSON：${err.message}` };
    }
  },

  card(title, ...fields) {
    return TB.util.el('section', { class: 'card' }, [TB.util.el('h3', { text: title }), ...fields]);
  },

  open(focusDock) {
    const state = TB.app.state;
    const config = structuredClone(state.config);
    const layout = structuredClone(state.grid);
    const displays = state.displays || [];

    // ----- 屏幕 -----
    const modeSelect = TB.util.el('select', { class: 'input' }, [
      TB.util.el('option', { value: 'auto', text: '自动匹配（推荐）', selected: config.display.mode === 'auto' }),
      TB.util.el('option', { value: 'index', text: '按屏幕序号', selected: config.display.mode === 'index' }),
      TB.util.el('option', { value: 'bounds', text: '手动坐标', selected: config.display.mode === 'bounds' })
    ]);
    const indexSelect = TB.util.el('select', { class: 'input' });
    const activeIndex = state.placement?.display?.index ?? config.display.index;
    for (const disp of displays) {
      indexSelect.appendChild(
        TB.util.el('option', {
          value: disp.index,
          text: `${disp.label}${disp.isPrimary ? '（主屏）' : ''} · 缩放 ${disp.scaleFactor}x`,
          selected: disp.index === activeIndex
        })
      );
    }
    const bounds = config.display.bounds || state.placement?.bounds || { x: 0, y: 0, width: 1920, height: 540 };
    const boundsInputs = {
      x: this.number(bounds.x, -10000, 10000),
      y: this.number(bounds.y, -10000, 10000),
      width: this.number(bounds.width, 320, 10000),
      height: this.number(bounds.height, 240, 10000)
    };
    const matchInputs = {
      width: this.number(config.display.match.width, 320, 10000),
      height: this.number(config.display.match.height, 240, 10000),
      tolerance: this.number(config.display.match.tolerance, 0, 500)
    };
    const alwaysOnTop = this.checkbox(config.window.alwaysOnTop);
    const current = state.placement
      ? `${state.placement.source} → ${state.placement.bounds.width}x${state.placement.bounds.height} @(${state.placement.bounds.x},${state.placement.bounds.y})`
      : '--';

    // ----- 轮询与剪贴板 -----
    const fastMs = this.number(config.metrics.pollMs, 500, 60000, 100);
    const slowMs = this.number(config.metrics.slowPollMs, 1000, 120000, 500);
    const historySize = this.number(config.metrics.historySize, 20, 600, 10);
    const clipEnabled = this.checkbox(config.clipboard.enabled);
    const clipMax = this.number(config.clipboard.maxItems, 5, 200, 5);

    // ----- 音乐 -----
    const musicFolder = TB.util.el('input', { class: 'input', type: 'text', value: config.music.folder, placeholder: '例如 D:\\Music' });
    const browse = TB.util.el('button', {
      class: 'ghost-btn',
      text: '浏览…',
      onclick: async () => {
        const picked = await TB.api.music.pickFolder();
        if (picked) musicFolder.value = picked;
      }
    });
    const musicRecursive = this.checkbox(config.music.recursive);
    const musicVolume = this.number(Math.round(config.music.volume * 100), 0, 100, 5);

    // ----- 模块开关（来自 layout.json 的 modules 数组） -----
    const moduleRows = TB.util.el('div', { class: 'module-list' });
    const renderModules = () => {
      moduleRows.innerHTML = '';
      layout.modules.forEach((module, index) => {
        const box = this.checkbox(module.enabled);
        box.addEventListener('change', () => (module.enabled = box.checked));
        const move = (delta) => () => {
          const target = index + delta;
          if (target < 0 || target >= layout.modules.length) return;
          [layout.modules[index], layout.modules[target]] = [layout.modules[target], layout.modules[index]];
          renderModules();
        };
        moduleRows.appendChild(
          TB.util.el('div', { class: 'module-row' }, [
            box,
            TB.util.el('span', { class: 'module-id', text: module.id }),
            TB.util.el('span', { class: 'module-name', text: module.name }),
            TB.util.el('span', { class: 'module-move' }, [
              TB.util.el('button', { class: 'mini-btn', text: '↑', title: '上移（只影响 JSON 顺序）', onclick: move(-1) }),
              TB.util.el('button', { class: 'mini-btn', text: '↓', title: '下移', onclick: move(1) })
            ])
          ])
        );
      });
    };
    renderModules();

    const gridSummary = `${layout.grid.columns.length} 列 × ${layout.grid.rows.length} 行`;
    const dockArea = this.jsonArea(config.dock);
    const categoriesArea = this.jsonArea(config.dockCategories);

    const screenCard = this.card(
      '屏幕目标',
      this.field('定位方式', modeSelect, '自动模式挑选与目标分辨率最接近的非主屏'),
      this.field(
        '目标分辨率',
        TB.util.el('div', { class: 'inline' }, [
          matchInputs.width,
          TB.util.el('span', { text: '×' }),
          matchInputs.height,
          TB.util.el('span', { text: '容差' }),
          matchInputs.tolerance
        ]),
        current
      ),
      this.field('屏幕序号', indexSelect, '仅在“按屏幕序号”时生效'),
      this.field(
        '手动坐标',
        TB.util.el('div', { class: 'inline' }, [
          TB.util.el('span', { class: 'mini-label', text: 'X' }),
          boundsInputs.x,
          TB.util.el('span', { class: 'mini-label', text: 'Y' }),
          boundsInputs.y,
          TB.util.el('span', { class: 'mini-label', text: '宽' }),
          boundsInputs.width,
          TB.util.el('span', { class: 'mini-label', text: '高' }),
          boundsInputs.height
        ]),
        '仅在“手动坐标”时生效'
      ),
      this.field('窗口置顶', alwaysOnTop, '只有被其他窗口遮挡时才需要')
    );

    const refreshCard = this.card(
      '刷新与剪贴板',
      this.field('快轮询 (ms)', fastMs, 'CPU、内存'),
      this.field('慢轮询 (ms)', slowMs, 'GPU、网络、磁盘、进程（走 nvidia-smi 与 PowerShell）'),
      this.field('曲线点数', historySize),
      this.field('记录剪贴板', clipEnabled, '内容只留内存，不落盘'),
      this.field('保留条数', clipMax)
    );

    const musicCard = this.card(
      '音乐',
      this.field('文件夹', TB.util.el('div', { class: 'inline' }, [musicFolder, browse]), '扫描 mp3 / flac / m4a / wav 等'),
      this.field('含子目录', musicRecursive, '最深 4 层'),
      this.field('默认音量 %', musicVolume, '播放器上的音量优先'),
      this.field('歌词', TB.util.el('span', { class: 'field-hint', text: '与音频同名、同目录的 .lrc 自动同步' }))
    );

    const moduleCard = TB.util.el('section', { class: 'card' }, [
      TB.util.el('h3', { text: '模块开关' }),
      TB.util.el('p', { class: 'muted', text: `关掉后该区域留空；网格与位置直接改 layout.json（当前 ${gridSummary}）` }),
      moduleRows
    ]);

    const dockCard = TB.util.el('section', { class: 'card' }, [
      TB.util.el('h3', { text: '导航分类 dockCategories' }),
      TB.util.el('p', { class: 'muted', text: '决定 dock 上分类标签的顺序与图标：{ "name": "系统", "icon": "⚙️" }；条目里出现但这里没声明的分类会自动补到末尾' }),
      categoriesArea,
      TB.util.el('h3', { text: '快捷入口 dock' }),
      TB.util.el('p', { class: 'muted', text: '每项：{ "name": "名称", "icon": "emoji 或图片路径", "category": "分类名", "type": "path|url|cmd", "target": "路径或链接" }' }),
      dockArea
    ]);

    const modal = TB.util.el('div', { class: 'settings-modal' }, [
      TB.util.el('div', { class: 'settings-head' }, [
        TB.util.el('h2', { text: '工具栏设置' }),
        TB.util.el('span', { class: 'muted', text: '保存到项目根目录 toolbar.config.json + layout.json' })
      ]),
      TB.util.el('div', { class: 'settings-grid' }, [screenCard, refreshCard, TB.util.el('div', { class: 'card-col' }, [musicCard, moduleCard]), dockCard]),
      TB.util.el('div', { class: 'settings-footer' }, [
        TB.util.el('button', {
          class: 'primary',
          text: '保存并应用',
          onclick: async () => {
            const dock = this.parseJson(dockArea, 'dock');
            const categories = this.parseJson(categoriesArea, 'dockCategories');
            if (dock.error || categories.error) return TB.app.toast(dock.error || categories.error, 'error');

            config.display = {
              mode: modeSelect.value,
              index: Number(indexSelect.value),
              match: {
                width: Number(matchInputs.width.value),
                height: Number(matchInputs.height.value),
                tolerance: Number(matchInputs.tolerance.value)
              },
              bounds: Object.fromEntries(Object.entries(boundsInputs).map(([key, input]) => [key, Number(input.value)]))
            };
            config.window.alwaysOnTop = alwaysOnTop.checked;
            config.metrics = { pollMs: Number(fastMs.value), slowPollMs: Number(slowMs.value), historySize: Number(historySize.value) };
            config.clipboard = { enabled: clipEnabled.checked, maxItems: Number(clipMax.value), pollMs: config.clipboard.pollMs };
            config.music = {
              folder: musicFolder.value.trim(),
              recursive: musicRecursive.checked,
              volume: TB.util.clamp(Number(musicVolume.value) / 100, 0, 1),
              repeat: config.music.repeat
            };
            config.dockCategories = categories.value;
            config.dock = dock.value;

            const layoutResult = await TB.api.layout.save(layout);
            if (layoutResult.errors) return TB.app.toast(`layout.json：${layoutResult.errors.join('；')}`, 'error');

            const result = await TB.api.config.save(config);
            state.grid = layoutResult.layout;
            TB.app.applyConfigResult(result);
            TB.app.toast(`已写入 ${result.file} 与 ${layoutResult.file}`, 'ok');
            this.close();
          }
        }),
        TB.util.el('button', { text: '打开配置文件', onclick: () => TB.api.config.openFile() }),
        TB.util.el('button', { text: '打开布局文件', onclick: () => TB.api.layout.openFile() }),
        TB.util.el('button', { text: '重载文件', onclick: async () => TB.app.applyConfigResult(await TB.api.config.reload()) }),
        TB.util.el('button', { text: '重启工具栏', onclick: () => TB.api.app.relaunch() }),
        TB.util.el('button', { class: 'danger', text: '退出', onclick: () => TB.api.app.quit() }),
        TB.util.el('button', { text: '关闭 (Esc)', onclick: () => this.close() })
      ])
    ]);

    this.root.innerHTML = '';
    this.root.appendChild(modal);
    this.root.classList.add('open');
    if (focusDock) dockArea.focus();
  },

  close() {
    this.root.classList.remove('open');
    this.root.innerHTML = '';
  }
};
