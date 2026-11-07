TB.api = window.deskToolbar;

TB.app = {
  state: { config: null, tasks: [], notes: '', player: null, video: null, grid: null, page: null, project: null, clipboard: [], ai: { messages: [], streaming: null, stream: null, error: null, key: null }, fast: null, full: null, placement: null, displays: [] },
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
    this.state.page = info.layout.pages.some((page) => page.id === info.page) ? info.page : info.layout.pages[0]?.id;
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
      const stream = this.state.ai.stream || { text: '', reasoning: '', tools: [] };
      this.state.ai = { ...this.state.ai, stream: { text: stream.text + (payload.text || ''), reasoning: stream.reasoning + (payload.reasoning || ''), tools: stream.tools } };
      this.refresh('ai');
    });
    // 它每调一次本机工具补一条，攒在 stream.tools 里：流式一结束就跟着 stream 一起消失，
    // 不进对话历史（工具回给模型的那些绝对路径本来也不落盘）
    TB.api.ai.onTool((payload) => {
      const stream = this.state.ai.stream || { text: '', reasoning: '', tools: [] };
      const tools = (stream.tools || []).concat([{ label: payload.label, count: payload.count }]);
      this.state.ai = { ...this.state.ai, stream: { ...stream, tools } };
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
    // 桌面反过来驱动面板：他用 Win+Ctrl+←/→ 切到某个绑了面板的桌面，主进程挑好面板发过来。
    // 这里只换界面，绝不再走 layout.setPage——那条 IPC 会把桌面又切回去，两边打乒乓。
    TB.api.layout.onSync((payload) => {
      this.applyPageFromDesktop(payload?.page, payload?.reason);
    });
    // 邮箱的两条推送都由主进程那条看护轮询发出来：updated 只管让开着的那一格重画，
    // new 才是「刚到了新邮件」——宠物动一下 + 一句固定文案，走本地/在线 TTS，不发 DeepSeek。
    TB.api.mail.onNew((news) => this.notifyMail(news));

    document.body.classList.add('ready');
  },

  applyPayload(payload) {
    this.state.config = payload.config;
    this.config = payload.config;
    if (payload.tasks) this.state.tasks = payload.tasks;
    if (payload.notes !== undefined) this.state.notes = payload.notes;
    if (payload.player !== undefined) this.state.player = payload.player;
    if (payload.video !== undefined) this.state.video = payload.video;
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

    const placed = this.effectiveSlots().filter((slot) => {
      if (!TB.components.has(slot.module)) {
        console.warn(`[layout] 位置 "${slot.at}" 引用的组件 "${slot.module}" 不存在，已留空`);
        return false;
      }
      return true;
    });

    const visible = new Set(placed.map((slot) => slot.at));
    const grid = this.activeGrid();
    shell.style.gridTemplateColumns = grid.columns.join(' ');
    shell.style.gridTemplateRows = grid.rows.join(' ');
    shell.style.gridTemplateAreas = grid.areas
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
    const pages = result.layout.pages || [];
    if (!pages.some((page) => page.id === this.state.page)) this.state.page = pages[0]?.id || null;
    this.applyPayload({ ...this.state, layout: result.layout });
  },

  // ---------- 面板（page）----------
  // shared 是跨面板常驻的那几格，pages 决定可换位置放哪个组件；
  // 面板还可以自带一份 grid（游戏面板把中间四格合成一个大格），没带就用全局的。
  pages() {
    return this.state.grid?.pages || [];
  },

  activePage() {
    const pages = this.pages();
    return pages.find((page) => page.id === this.state.page) || pages[0] || null;
  },

  activeGrid() {
    const layout = this.state.grid;
    return this.activePage()?.grid || layout?.grid;
  },

  effectiveSlots() {
    const layout = this.state.grid;
    if (!layout) return [];
    const page = this.activePage();
    return [...(layout.shared || []), ...(page?.slots || [])].filter((slot) => slot.enabled && slot.module);
  },

  setPage(id) {
    const page = this.pages().find((item) => item.id === id);
    if (!page || this.state.page === id) return;
    this.state.page = id;
    // 存失败（比如面板刚被删掉）不打断切换，只是下次启动回到原来的页
    TB.api.layout.setPage(id).catch(() => {});
    this.buildShell();
  },

  // 桌面驱动的换页：activePage 主进程已经写好了，这边只照着重建外壳。
  applyPageFromDesktop(id, reason) {
    const page = this.pages().find((item) => item.id === id);
    if (!page || this.state.page === id) return;
    this.state.page = id;
    this.buildShell();
    this.toast(`${reason || '虚拟桌面'} → 「${page.name}」`);
  },

  // ---------- 项目选中态（工作面板：左边项目格 → 中间 git 格）----------
  // 存整条项目行而不是只有 id：git 格的「非仓库」那一态要说「该用哪个 IDE、按哪条规则判的、
  // 多久没动过、从哪个根扫出来的」，这些话本来就写在项目格的行上，为它们再开一条 IPC 是重复。
  // 放这里而不是组件里，理由和 tasks/notes 一样——切面板会整体重建 shell，组件字段跟着 DOM 没了；
  // 切回来时左边还是那个选中项、右边还是那个仓库，不该退回「请先选项目」。
  selectProject(item) {
    const next = item && Number.isInteger(item.id) ? item : null;
    const current = this.state.project;
    // 同一个项目重选（重扫后 id 和路径都没变）不重渲染：否则点一下选中项会把展开态和滚动位置洗掉
    if (Boolean(next) === Boolean(current) && (!next || (next.id === current.id && next.path === current.path))) return false;
    this.state.project = next;
    this.refresh('projects');
    this.refresh('git');
    return true;
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
  },

  // 新邮件提醒：动作 + 语音都只走本机这一套（宠物 react、固定模板的句子直接喂 TTS）。
  // 一句话不值得发一次 DeepSeek 请求，所以这里一条 AI 的 IPC 都不碰。
  notifyMail(news) {
    const count = Number(news?.count) || 0;
    if (!count) return;
    TB.ai?.poke?.();
    const speaker = this.speakerName(news.name);
    const text = count === 1 && speaker
      ? `邮箱来了新邮件，来自${speaker}`
      : `邮箱来了 ${count} 封新邮件`;
    this.toast(count === 1 ? `来了一封新邮件${news.name ? `：${news.name}` : ''}` : `来了 ${count} 封新邮件`, 'info');
    // 正在念 AI 回复时不插嘴；语音开关在设置 → 邮箱里，关掉只安静，动作和提示条照旧
    if (this.config?.mail?.notifyVoice !== false && !TB.voice?.speaking && TB.voice?.ttsReady()) {
      TB.voice.speak(text);
    }
  },

  // 念出来的是发件人显示名，不是地址：带 @ 的没法听（「no-reply@cmbchina.com」），
  // 太长的一律不念——TTS 念到第七个字人就听不出重点了，宁可只报数量。
  speakerName(name) {
    const clean = String(name || '').replace(/[《》【】[\]()（）]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean || clean.includes('@') || clean.length > 12) return '';
    return clean;
  }
};

window.addEventListener('error', (event) => TB.app?.toast?.(`界面错误：${event.message}`, 'error'));
