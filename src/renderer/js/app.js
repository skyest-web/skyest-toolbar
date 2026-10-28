TB.api = window.deskToolbar;

TB.app = {
  state: { config: null, tasks: [], notes: '', player: null, grid: null, clipboard: [], ai: { messages: [], streaming: null, stream: null, error: null, key: null }, fast: null, full: null, placement: null, displays: [] },
  info: { electron: '', appVersion: '' },
  defaultLayout: null,
  config: null,
  nodes: {},

  async boot() {
    this.nodes.settings = document.getElementById('settings');
    this.nodes.dockEditor = document.getElementById('dock-editor');
    this.nodes.layoutEditor = document.getElementById('layout-editor');
    this.nodes.searchPanel = document.getElementById('search-panel');
    this.nodes.toast = document.getElementById('toast');
    TB.settings.init(this.nodes.settings);
    TB.dockEditor.init(this.nodes.dockEditor);
    TB.layoutEditor.init(this.nodes.layoutEditor);
    TB.dsh.init();
    TB.search.init(this.nodes.searchPanel);
    this.bindKeys();

    const info = await TB.api.boot();
    this.info = { electron: info.electron, appVersion: info.appVersion };
    this.defaultLayout = info.defaultLayout;
    this.state.grid = info.layout;
    this.applyPayload(info);

    TB.api.metrics.onFast((fast) => {
      this.state.fast = fast;
      this.refresh('gauges');
    });
    TB.api.metrics.onFull((full) => {
      this.state.full = full;
      this.refresh('gauges');
      this.refresh('clock');
    });
    TB.api.clipboard.onUpdate((items) => {
      this.state.clipboard = items;
      this.refresh('clipboard');
    });
    TB.api.ai.onState((payload) => {
      this.state.ai = { ...this.state.ai, messages: payload.messages, streaming: payload.streaming };
      this.refresh('ai');
    });
    TB.api.ai.onDelta((payload) => {
      const stream = this.state.ai.stream || { text: '', reasoning: '' };
      this.state.ai = { ...this.state.ai, stream: { text: stream.text + (payload.text || ''), reasoning: stream.reasoning + (payload.reasoning || '') } };
      this.refresh('ai');
    });
    TB.api.ai.onDone(() => {
      this.state.ai = { ...this.state.ai, stream: null };
      this.refresh('ai');
    });
    TB.api.ai.onError((payload) => {
      this.state.ai = { ...this.state.ai, stream: null, error: payload };
      this.refresh('ai');
    });
    TB.api.displays.onChanged((displays) => {
      this.state.displays = displays;
      this.toast('屏幕布局变化，已重新贴合工具栏屏', 'warn');
    });

    document.body.classList.add('ready');
  },

  applyPayload(payload) {
    this.state.config = payload.config;
    this.config = payload.config;
    if (payload.tasks) this.state.tasks = payload.tasks;
    if (payload.notes !== undefined) this.state.notes = payload.notes;
    if (payload.player !== undefined) this.state.player = payload.player;
    if (payload.clipboard) this.state.clipboard = payload.clipboard;
    if (payload.ai) this.state.ai = { ...this.state.ai, ...payload.ai };
    if (payload.placement) this.state.placement = payload.placement;
    if (payload.displays) this.state.displays = payload.displays;
    if (payload.layout) this.state.grid = payload.layout;
    this.buildShell();
  },

  buildShell() {
    const layout = this.state.grid;
    const shell = document.getElementById('shell');
    if (!layout || !shell) return;

    const placed = layout.slots.filter((slot) => {
      if (!slot.enabled || !slot.module) return false;
      if (!TB.components.has(slot.module)) {
        console.warn(`[layout] 位置 "${slot.at}" 引用的组件 "${slot.module}" 不存在，已留空`);
        return false;
      }
      return true;
    });

    const visible = new Set(placed.map((slot) => slot.at));
    shell.style.gridTemplateColumns = layout.grid.columns.join(' ');
    shell.style.gridTemplateRows = layout.grid.rows.join(' ');
    shell.style.gridTemplateAreas = layout.grid.areas
      .map((row) => `"${row.map((token) => (visible.has(token) ? token : '.')).join(' ')}"`)
      .join(' ');

    shell.innerHTML = '';
    this.nodes = {
      settings: this.nodes.settings,
      dockEditor: this.nodes.dockEditor,
      layoutEditor: this.nodes.layoutEditor,
      toast: this.nodes.toast
    };
    for (const slot of placed) {
      const def = TB.components.get(slot.module);
      const section = TB.util.el('section', { class: def.cls, 'data-slot': slot.at, 'data-module': slot.module, title: def.name });
      section.style.gridArea = slot.at;
      const node = def.build();
      section.appendChild(node);
      shell.appendChild(section);
      this.nodes[slot.module] = node;
      def.init?.(node);
    }

    this.renderAll();
    this.bindIdleCursor();
  },

  applyConfigResult(result) {
    this.applyPayload({ ...this.state, config: result.config, placement: result.placement, displays: result.displays });
  },

  applyLayoutResult(result) {
    this.applyPayload({ ...this.state, layout: result.layout });
  },

  refresh(module) {
    if (!this.nodes[module]) return;
    TB.components.get(module)?.update?.(this.state);
  },

  renderAll() {
    document.documentElement.style.setProperty('--accent', this.state.config?.theme?.accent || '#57b6ff');
    for (const module of Object.keys(this.nodes)) this.refresh(module);
    this.updatePlacementLabel();
  },

  updatePlacementLabel() {
    const placement = this.state.placement;
    const node = document.getElementById('placement-label');
    if (!placement || !node) return;
    node.textContent = `${placement.bounds.width}x${placement.bounds.height} @(${placement.bounds.x},${placement.bounds.y})`;
  },

  bindKeys() {
    document.addEventListener('keydown', (event) => {
      // 输入框里的 Ctrl+, / Ctrl+L 是编辑操作（逗号常见于中文输入与代码），不该被当成打开面板
      const inField = event.target instanceof Element && event.target.closest('input, textarea, select');
      if (inField) return;
      if (event.key === ',' && (event.ctrlKey || event.altKey)) {
        event.preventDefault();
        TB.settings.open();
      }
      if (event.key === 'l' && (event.ctrlKey || event.altKey)) {
        event.preventDefault();
        TB.layoutEditor.open();
      }
      if (event.key === 'f' && (event.ctrlKey || event.altKey)) {
        event.preventDefault();
        TB.search.focus();
      }
      if (event.key === ' ' && event.target === document.body) {
        event.preventDefault();
        TB.player.toggle();
      }
    });
  },

  bindIdleCursor() {
    const idleMs = this.state.config?.window?.autoHideCursorMs ?? 4000;
    if (!idleMs) return;
    if (this.cursorBound) return;
    this.cursorBound = true;
    let timer = null;
    const wake = () => {
      document.body.classList.remove('cursor-idle');
      clearTimeout(timer);
      timer = setTimeout(() => document.body.classList.add('cursor-idle'), idleMs);
    };
    for (const type of ['mousemove', 'mousedown', 'keydown']) window.addEventListener(type, wake, { passive: true });
    wake();
  },

  toast(message, kind = 'info') {
    const node = TB.util.el('div', { class: `toast ${kind}`, text: message });
    this.nodes.toast.appendChild(node);
    setTimeout(() => node.classList.add('hide'), 2600);
    setTimeout(() => node.remove(), 3100);
  }
};

window.addEventListener('error', (event) => TB.app?.toast?.(`界面错误：${event.message}`, 'error'));
