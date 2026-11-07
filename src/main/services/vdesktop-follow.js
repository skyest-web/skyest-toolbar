// 「工具栏跟着虚拟桌面走」的看护侧。
//
// 为什么只能这样：Windows 把窗口钉在「创建它时活动的那个桌面」上，而且没有对外文档
// 的 API 能让窗口跨桌面常驻。实测下来 IVirtualDesktopManager 的三个方法里，
// IsWindowOnCurrentVirtualDesktop 跨进程读是通的（S_OK），但 MoveWindowToDesktop
// 对别的进程的窗口返回 E_ACCESSDENIED —— 只有窗口所属进程自己能挪，而 Electron
// 没有暴露这个能力。所以这里只做只读探测，改写动作交给主进程重建窗口：
// 新窗口天然落在当前活动桌面上，这也是微软文档给的替代方案。
//
// 探测为什么放 PowerShell 而不是这里的 koffi：koffi 擅长 C 导出函数（Everything 就靠它），
// 但 IVirtualDesktopManager 是 COM 接口，用它得手搭 CoCreateInstance + vtable 偏移，
// 脆、而且没法脱离应用单独自检。PowerShell + C# 的 [ComImport] 是现成的，代价是一个
// 常驻 powershell.exe（几十 MB 内存）。

const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'tools', 'vdesktop-watch.ps1');
const SWITCH_SCRIPT = path.join(__dirname, '..', '..', '..', 'tools', 'vdesktop-switch.ps1');
const RESTART_DELAY_MS = 5000;
const MAX_RESTARTS = 5;
const POLL_MS = 800;
// 切桌面是一次性子进程（powershell 启动 + 一次 COM 往返），给它一点余量；
// 超时就当没切成，别把「等确认」的守卫一直挂着。
const SWITCH_TIMEOUT_MS = 6000;

// BrowserWindow.getNativeWindowHandle() 给的是 HWND 的原始字节：64 位是 8 字节。
function hwndOf(win) {
  if (!win || win.isDestroyed()) return 0;
  try {
    const buf = win.getNativeWindowHandle();
    return buf.length >= 8 ? Number(buf.readBigInt64LE(0)) : buf.readInt32LE(0);
  } catch (err) {
    console.warn(`[vdesk] 取 HWND 失败：${err.message}`);
    return 0;
  }
}

class VdesktopFollow {
  constructor({ getConfig, getWindow, onOffDesktop, onDesktop }) {
    this.getConfig = getConfig;
    this.getWindow = getWindow;
    this.onOffDesktop = onOffDesktop || (() => {});
    this.onDesktop = onDesktop || (() => {});
    this.child = null;
    this.buffer = '';
    this.restarts = 0;
    this.giveUp = false;
    this.stopped = false;
    this.timer = null;
    this.lastState = null;
    this.desktopIndex = null;
    this.desktopCount = null;
  }

  get enabled() {
    // 非 Windows 没有虚拟桌面这套 API；开关关掉就什么都不留
    return process.platform === 'win32' && Boolean(this.getConfig()?.window?.followVirtualDesktop);
  }

  start() {
    if (!this.enabled || this.child || this.giveUp) return;
    this.stopped = false;
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SCRIPT,
      '-Hwnd',
      String(hwndOf(this.getWindow())),
      '-IntervalMs',
      String(POLL_MS)
    ];
    // TB_VDESK_PRETEND=3：让助手在第 3 秒报一次「不在当前桌面」，这样不真的开第二个
    // 虚拟桌面也能验到主进程的重建路径。TB_VDESK_PRETEND_DESK=2 同理，报的是「第 3 个
    // 桌面变成了活动的」，用来单验桌面→面板这一半。只在手动验证时用。
    const pretend = Number(process.env.TB_VDESK_PRETEND || 0);
    if (pretend > 0) args.push('-PretendOff', '-PretendAfterS', String(pretend));
    const pretendDesk = Number(process.env.TB_VDESK_PRETEND_DESK || -1);
    if (pretendDesk >= 0) args.push('-PretendDesk', String(pretendDesk), '-PretendDeskAfterS', String(pretend || 3));
    this.buffer = '';
    this.child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.consume(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.warn(`[vdesk] 助手 stderr：${text.slice(0, 200)}`);
    });
    // spawn 失败（powershell 不在 PATH、策略拦了 -ExecutionPolicy）是异步 'error'，
    // 不会走 'exit'：不接住就是主进程未捕获异常，跟修改器启动那次是同一类坑。
    this.child.on('error', (err) => {
      console.warn(`[vdesk] 助手起不来：${err.message}`);
      this.child = null;
    });
    this.child.on('exit', (code, signal) => this.onExit(code, signal));
    console.log(`[vdesk] 看护已启动（hwnd=${args[args.indexOf('-Hwnd') + 1]}）`);
  }

  onExit(code, signal) {
    this.child = null;
    if (this.stopped || this.giveUp || !this.enabled) return;
    // 正常切换桌面不会杀助手；非零退出多半是助手自己放弃（COM 不可用）或被系统带走
    if (code === 0 && signal === null) return;
    if (this.restarts >= MAX_RESTARTS) {
      this.giveUp = true;
      console.warn(`[vdesk] 助手连续退出 ${this.restarts} 次（code=${code} signal=${signal}），本次运行不再跟随虚拟桌面`);
      return;
    }
    this.restarts += 1;
    console.warn(`[vdesk] 助手退出（code=${code} signal=${signal}），${RESTART_DELAY_MS / 1000} 秒后重拉（第 ${this.restarts} 次）`);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, RESTART_DELAY_MS);
  }

  consume(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.handle(trimmed);
    }
  }

  handle(line) {
    const [state, detail = ''] = line.split('|', 2);
    // desk|N count=C 和活动/离线那套状态是两条独立的线：它不该参与 lastState 的去重，
    // 否则 on/off 的日志会被它穿插掉。
    if (state === 'desk') {
      const index = Number.parseInt(String(detail).trim().split(/\s+/)[0], 10);
      const count = Number.parseInt(/count=(\d+)/.exec(String(detail))?.[1] || '', 10);
      if (!Number.isInteger(index) || index < 0) return;
      this.desktopIndex = index;
      this.desktopCount = Number.isInteger(count) ? count : null;
      console.log(`[vdesk] 当前桌面：第 ${index + 1} 个（共 ${this.desktopCount ?? '?'} 个）`);
      this.onDesktop(index, this.desktopCount);
      return;
    }
    // 'gone' 是重建途中的正常空档（旧窗口已销毁、新窗口还没起来）；
    // 'err' 是本轮 COM 读失败，交给下一轮
    if (state !== this.lastState) {
      this.lastState = state;
      if (state !== 'on') console.log(`[vdesk] ${state}|${detail}`);
    }
    if (state === 'off') this.onOffDesktop(detail);
    if (state === 'fatal') {
      this.giveUp = true;
      this.stop();
      console.warn(`[vdesk] 助手报不可用：${detail}；本次运行不再跟随虚拟桌面`);
    }
  }

  // 把活动桌面切到第 index 个（0-based，任务视图从左到右）。一次性子进程，跑完就退；
  // 「已经在这一页」由脚本自己判成 noop，所以重复点同一个页签不会反复触发桌面动画。
  // 桌面不够就是 range 且什么都不动——绝不做的是替他创建桌面。
  switchTo(index) {
    if (!Number.isInteger(index) || index < 0) return Promise.resolve({ ok: false, line: 'bad index' });
    return new Promise((resolve) => {
      const args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        SWITCH_SCRIPT,
        '-Index',
        String(index)
      ];
      const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let done = false;
      let timer = null;
      const finish = (result) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch (err) {
          /* 已经退了就没什么可杀的 */
        }
        finish({ ok: false, line: 'timeout' });
      }, SWITCH_TIMEOUT_MS);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
      child.on('error', (err) => finish({ ok: false, line: `spawn: ${err.message}` }));
      child.on('exit', (code) => {
        const line = out.trim().split(/\r?\n/)[0] || `exit=${code}`;
        if (code !== 0) console.warn(`[vdesk] 切到桌面 ${index} 没成：${line}`);
        finish({ ok: code === 0, code, line });
      });
    });
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.child) {
      const child = this.child;
      this.child = null;
      child.kill();
    }
  }

  // 设置面板改完开关后调用：关掉就收进程，打开就立刻开始看护
  sync() {
    if (!this.enabled) {
      this.stop();
      this.lastState = null;
      this.desktopIndex = null;
      this.desktopCount = null;
      return;
    }
    this.giveUp = false;
    this.restarts = 0;
    if (!this.child) this.start();
  }

  status() {
    return {
      supported: process.platform === 'win32',
      enabled: this.enabled,
      watching: Boolean(this.child),
      state: this.lastState,
      giveUp: this.giveUp,
      desktopIndex: this.desktopIndex,
      desktopCount: this.desktopCount
    };
  }
}

module.exports = { VdesktopFollow, hwndOf };
