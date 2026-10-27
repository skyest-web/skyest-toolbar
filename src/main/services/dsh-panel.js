// dsh 面板：把 dsh 的 Web UI 用 WebContentsView 贴在工具栏窗口的一块矩形里。
// 分工是「渲染层画框、主进程塞内容」：带 token 的完整地址只活在这两个主进程文件里，
// 渲染层只上报一块 bounds，所以 token 不会跨 IPC 出现在页面脚本能读到的地方。
const { WebContentsView, shell } = require('electron');

class DshPanel {
  constructor({ win, host }) {
    this.win = win;
    this.host = host;
    this.view = null;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.open = false;
  }

  // bounds 由渲染层量好面板内区后报上来：窗口是无边框的，CSS 像素和这里的 DIP 是同一套坐标
  setBounds(bounds) {
    if (!bounds) return;
    this.bounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    };
    if (this.view && this.open) this.view.setBounds(this.bounds);
  }

  async show() {
    // 先占住 open 再等子进程：这段时间里用户可能已经点了 ×，回来就得看这个标记
    this.open = true;
    const url = await this.host.start();
    if (!this.open || this.win.isDestroyed()) return;

    if (!this.view) {
      this.view = new WebContentsView({
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
      });
      // dsh 页面里点开的链接（外链、文档）不给它在我们窗口里换页，交回系统浏览器
      this.view.webContents.setWindowOpenHandler(({ url: target }) => {
        shell.openExternal(target);
        return { action: 'deny' };
      });
      this.view.webContents.on('did-fail-load', (_event, code, description) => {
        if (code !== -3) console.warn('[dsh] 面板加载失败', code, description);
      });
    }

    this.win.contentView.addChildView(this.view);
    this.view.setBounds(this.bounds);
    // 已经加载过就直接显出来，别重新走一遍 token 换 cookie
    if (this.view.webContents.getURL() !== url) await this.view.webContents.loadURL(url);
  }

  hide() {
    this.open = false;
    if (!this.view || this.win.isDestroyed()) return;
    this.win.contentView.removeChildView(this.view);
  }

  destroy() {
    this.hide();
    if (this.view) {
      this.view.webContents.close();
      this.view = null;
    }
  }
}

module.exports = { DshPanel };
