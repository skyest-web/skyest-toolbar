TB.api = window.deskToolbar;

// layout.json 里的模块 id 与这里的键一一对应；新增模块只要在这里注册一次，
// 就能在 layout.json / 设置页里开关和摆放。
const REGISTRY = {
  topbar: {
    cls: 'topbar',
    init: () => TB.app.bindTopbar(),
    build: () =>
      TB.util.el('div', { class: 'topbar-inner' }, [
        TB.util.el('div', { class: 'brand' }, [TB.util.el('span', { class: 'dot' }), TB.util.el('span', { text: '桌面工具栏' })]),
        TB.util.el('div', { class: 'topbar-right' }, [
          TB.util.el('span', { class: 'muted', id: 'placement-label' }),
          TB.util.el('button', { class: 'ghost-btn', id: 'btn-settings', text: '设置', title: '设置 (Ctrl+,)' }),
          TB.util.el('button', { class: 'ghost-btn danger-text', id: 'btn-quit', text: '退出', title: '退出工具栏' })
        ])
      ])
  },
  clock: { cls: 'area clock-area', build: () => TB.util.el('div', { id: 'clock' }), init: (node) => TB.clock.init(node) },
  gauges: {
    cls: 'area gauges',
    build: () => TB.util.el('div', { id: 'gauges', class: 'gauge-row' }),
    init: (node) => TB.gauges.init(node)
  },
  workbench: { cls: 'area workbench', build: () => TB.util.el('div', { id: 'workbench' }), init: (node) => TB.workbench.init(node) },
  player: { cls: 'area player-area', build: () => TB.util.el('div', { id: 'player' }), init: (node) => TB.player.init(node) },
  clipboard: { cls: 'area clipboard', build: () => TB.util.el('div', { id: 'clipboard' }), init: (node) => TB.clipboard.init(node) },
  dock: { cls: 'area dock-area', build: () => TB.util.el('div', { id: 'dock' }), init: (node) => TB.dock.init(node) }
};

TB.app = {
  state: { config: null, tasks: [], notes: '', player: null, grid: null, clipboard: [], fast: null, full: null, placement: null, displays: [] },
  info: { electron: '', appVersion: '' },
  config: null,
  nodes: {},

  async boot() {
    this.nodes.settings = document.getElementById('settings');
    this.nodes.toast = document.getElementById('toast');
    TB.settings.init(this.nodes.settings);
    this.bindKeys();

    const info = await TB.api.boot();
    this.info = { electron: info.electron, appVersion: info.appVersion };
    this.state.grid = info.layout;
    this.applyPayload(info);

    TB.api.metrics.onFast((fast) => {
      this.state.fast = fast;
      TB.gauges.update(this.state);
    });
    TB.api.metrics.onFull((full) => {
      this.state.full = full;
      TB.gauges.update(this.state);
      TB.clock.update(this.state);
    });
    TB.api.clipboard.onUpdate((items) => {
      this.state.clipboard = items;
      TB.clipboard.update(this.state);
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
    if (payload.placement) this.state.placement = payload.placement;
    if (payload.displays) this.state.displays = payload.displays;
    if (payload.layout) this.state.grid = payload.layout;
    this.buildShell();
  },

  buildShell() {
    const layout = this.state.grid;
    const shell = document.getElementById('shell');
    if (!layout || !shell) return;

    const enabled = new Set(layout.modules.filter((module) => module.enabled).map((module) => module.id));
    for (const row of layout.grid.areas) {
      for (const token of row) {
        if (token !== '.' && !REGISTRY[token]) console.warn(`[layout] layout.json 里的区域 "${token}" 没有对应模块，已留空`);
      }
    }

    shell.style.gridTemplateColumns = layout.grid.columns.join(' ');
    shell.style.gridTemplateRows = layout.grid.rows.join(' ');
    shell.style.gridTemplateAreas = layout.grid.areas
      .map((row) => `"${row.map((token) => (enabled.has(token) ? token : '.')).join(' ')}"`)
      .join(' ');

    shell.innerHTML = '';
    this.nodes = { settings: this.nodes.settings, toast: this.nodes.toast };
    for (const module of layout.modules) {
      const entry = REGISTRY[module.id];
      if (!entry || !module.enabled) continue;
      const section = TB.util.el('section', { class: entry.cls, 'data-module': module.id, title: module.name });
      section.style.gridArea = module.id;
      const node = entry.build();
      section.appendChild(node);
      shell.appendChild(section);
      this.nodes[module.id] = node;
      entry.init?.(node);
    }

    this.renderAll();
    this.bindIdleCursor();
  },

  applyConfigResult(result) {
    this.applyPayload({ ...this.state, config: result.config, placement: result.placement, displays: result.displays });
  },

  renderAll() {
    document.documentElement.style.setProperty('--accent', this.state.config?.theme?.accent || '#57b6ff');
    for (const id of ['dock', 'player', 'clipboard', 'clock', 'workbench', 'gauges']) {
      if (this.nodes[id]) TB[id]?.update(this.state);
    }
    this.updatePlacementLabel();
  },

  updatePlacementLabel() {
    const placement = this.state.placement;
    const node = document.getElementById('placement-label');
    if (!placement || !node) return;
    node.textContent = `${placement.bounds.width}x${placement.bounds.height} @(${placement.bounds.x},${placement.bounds.y})`;
  },

  bindTopbar() {
    document.getElementById('btn-settings')?.addEventListener('click', () => TB.settings.open());
    document.getElementById('btn-quit')?.addEventListener('click', () => TB.api.app.quit());
  },

  bindKeys() {
    document.addEventListener('keydown', (event) => {
      if (event.key === ',' && (event.ctrlKey || event.altKey)) {
        event.preventDefault();
        TB.settings.open();
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

window.addEventListener('DOMContentLoaded', () => TB.app.boot());
window.addEventListener('error', (event) => TB.app?.toast?.(`界面错误：${event.message}`, 'error'));
