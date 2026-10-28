// dsh 窗口：把 dsh 的 Web UI 装进一个独立的系统窗口，好让它能被拖到别的屏幕上去用。
// 前身是「贴在工具栏窗口里的一块 WebContentsView」——那种做法出不了工具栏那块屏，见 docs/dsh-panel.md。
//
// 分工没变：带 token 的完整地址只在主进程里，渲染层只负责开合和显示状态。
// 用原生标题栏（frame 默认）而不是自绘拖拽条：拖动、Win+方向键贴边、最小化到任务栏、
// 混排 DPI 下的缩放全交给 Windows，我们只多了一条不搭调的标题条。
const { BrowserWindow, WebContentsView, shell, screen } = require('electron');

const DEFAULT_SIZE = { width: 1180, height: 780 };
// 记回来的位置至少要还压在某个屏幕上这么多像素，否则当成"屏被拔了"重新定位
const MIN_OVERLAP = 120;

function overlaps(bounds, saved) {
  const w = Math.min(bounds.x + bounds.width, saved.x + saved.width) - Math.max(bounds.x, saved.x);
  const h = Math.min(bounds.y + bounds.height, saved.y + saved.height) - Math.max(bounds.y, saved.y);
  return w > MIN_OVERLAP && h > MIN_OVERLAP;
}

class DshWindow {
  constructor({ host, store, onVisibility }) {
    this.host = host;
    this.store = store;
    this.onVisibility = onVisibility || (() => {});
    this.win = null;
    this.view = null;
    this.opened = false;
    this.loadedUrl = null;
  }

  isOpen() {
    return this.opened;
  }

  ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return;
    const saved = this.rememberedBounds();
    this.win = new BrowserWindow({
      ...(saved || DEFAULT_SIZE),
      x: saved ? saved.x : undefined,
      y: saved ? saved.y : undefined,
      show: false,
      title: 'DeepSeek Harness',
      backgroundColor: '#0b0f14',
      autoHideMenuBar: true,
      minimizable: true,
      maximizable: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false }
    });
    // 用户点 × 只是收起来：子进程和已加载的页面都留着，下次开是秒显而不是重走一遍登录换 cookie
    this.win.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      this.hide();
    });
    const remember = () => this.persistBounds();
    this.win.on('moved', remember);
    this.win.on('resized', remember);
  }

  ensureView() {
    if (this.view && !this.view.webContents.isDestroyed()) return;
    this.view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
    });
    this.loadedUrl = null;
    // dsh 页面里点开的链接不给它在我们窗口里换页，交回系统浏览器
    this.view.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
    this.view.webContents.on('did-fail-load', (_event, code, description) => {
      if (code !== -3) console.warn('[dsh] 页面加载失败', code, description);
    });
    // 崩了的渲染进程不会自己回血，下次开窗口必须重新 loadURL
    this.view.webContents.on('render-process-gone', () => {
      this.loadedUrl = null;
    });
    this.win.contentView.addChildView(this.view);
  }

  // 原生标题栏不在 contentView 里，所以视图铺满整块客户区就行
  syncView() {
    if (!this.win || this.win.isDestroyed() || !this.view) return;
    const [width, height] = this.win.getContentSize();
    this.view.setBounds({ x: 0, y: 0, width: Math.max(0, width), height: Math.max(0, height) });
  }

  rememberedBounds() {
    const saved = this.store.get('dshWindow');
    if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return null;
    if (!(saved.width > 200 && saved.height > 200)) return null;
    // 上次那块屏可能已经拔了或者分辨率变了，落空就别用记忆位置
    if (!screen.getAllDisplays().some((display) => overlaps(display.bounds, saved))) return null;
    return saved;
  }

  persistBounds() {
    if (!this.win || this.win.isDestroyed()) return;
    // 最大化/最小化态下 getBounds 给的是外扩后的矩形，存下来下次开就"越界"了
    if (this.win.isMaximized() || this.win.isMinimized()) return;
    const bounds = this.win.getBounds();
    // 在这台机器上（副屏非 1x），传给构造函数的宽高会被按目标屏的缩放率再乘一遍，而 getBounds 回来的
    // 已经是乘过的值——直接存回去，每次重启窗口就大一圈（实测 1180 → 1770 → 2656）。所以存之前除回去。
    const scale = screen.getDisplayMatching(bounds).scaleFactor || 1;
    this.store.set('dshWindow', {
      x: bounds.x,
      y: bounds.y,
      width: Math.max(200, Math.round(bounds.width / scale)),
      height: Math.max(200, Math.round(bounds.height / scale))
    });
  }

  async show() {
    // 先占住标记再等子进程：这段时间里用户可能已经点了 ×，回来就得看这个标记
    this.opened = true;
    const url = await this.host.start();
    if (!this.opened) return;
    this.ensureWindow();
    this.ensureView();
    // 只比"我们加载过的那条地址"：getURL() 在 dsh 303 跳 / 之后就没有 token 了，拿它比会每次都重刷页面
    if (this.loadedUrl !== url) {
      await this.view.webContents.loadURL(url);
      this.loadedUrl = url;
    }
    if (!this.opened) return;
    this.syncView();
    this.win.show();
    this.win.focus();
    this.onVisibility();
  }

  hide() {
    this.opened = false;
    this.persistBounds();
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
    this.onVisibility();
  }

  focus() {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.focus();
  }

  destroy() {
    this.quitting = true;
    this.opened = false;
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { DshWindow };
