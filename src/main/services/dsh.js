// DeepSeek Harness（dsh）子进程管理。
// dsh 是官方开源的 agent 外壳，我们只负责三件事：把它拉起来、把它打印的那条带 token 的
// URL 拿到、退出时把进程收干净。token 和密钥都只活在这一个文件所在的内存里，不进渲染层、不落盘。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

// dsh web 只在 stdout 打一行：http://127.0.0.1:<port>/?token=<随机>
// 没有这条 token，任何页面都会被 401 挡回来（它把 token 换成 30 天的 HttpOnly cookie）。
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/;
// dsh 的输出带颜色：ANSI 转义会紧贴着 URL 尾巴，不洗掉直接拿去 loadURL 就是个坏地址
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
// 尾段（tail）会被拼进 lastError，lastError 又进 status、回渲染层、进日志——所以先把 token 打码。
// 拿地址走的是 takeUrl()，它看的是原始 stdout，不受这里影响。
const TOKEN_PATTERN = /([?&]token=)[^\s"'&<>]+/g;

function redact(text) {
  return String(text).replace(TOKEN_PATTERN, '$1…');
}

// 装了就有 { bin, version }，没装返回 null。version 是要回给界面看的：
// dsh 保持可升级（^0.2.1-rc.x），所以「现在跑的是哪一版」得随时看得见，坏了才知道回滚到哪。
function installInfo(appRoot) {
  const pkgDir = path.join(appRoot, 'node_modules', '@deepseek-ai', 'dsh');
  const entry = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(entry)) return null;
  const pkg = JSON.parse(fs.readFileSync(entry, 'utf8'));
  const raw = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin || {}).dsh;
  if (!raw) return null;
  return { bin: path.join(pkgDir, raw), version: pkg.version || '未知' };
}

// dsh 的入口是全 ESM 的 CLI，Electron 33 自带的那份 Node（20.18）跑它会静默退 0、一行输出都没有
// （实测），所以宁可要系统 node；纯 Node 环境（跑自检脚本）里 process.execPath 本身就是 node。
function resolveRuntime() {
  if (!process.versions.electron) return process.execPath;
  const names = process.platform === 'win32' ? ['node.exe'] : ['node'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir.trim(), name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // 不在这个目录里，继续找下一个
      }
    }
  }
  return null;
}

// 探一次端口：拿到任意 HTTP 响应就算活着（401 也是活着 —— 那正说明服务在、只是我们没带 cookie）
function probe(url, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(true);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

class DshHost {
  constructor({ appRoot, getConfig, getKey, emit }) {
    this.appRoot = appRoot;
    this.getConfig = getConfig;
    this.getKey = getKey;
    this.emit = emit || (() => {});
    this.child = null;
    this.url = null;
    this.starting = null;
    this.tail = '';
    this.stdoutBuf = '';
    this.stopped = false;
  }

  nodeRuntime() {
    if (this.runtimeCache === undefined) this.runtimeCache = resolveRuntime();
    return this.runtimeCache;
  }

  status() {
    const install = installInfo(this.appRoot);
    return {
      running: Boolean(this.child && !this.child.killed && this.url),
      ready: Boolean(this.url),
      // 只报端口和状态，绝不把 token 带回渲染层
      port: this.url ? new URL(this.url).port : null,
      installed: Boolean(install),
      version: install ? install.version : null,
      runtime: this.nodeRuntime(),
      workspace: this.workspaceDir(),
      lastError: this.lastError || null
    };
  }

  workspaceDir() {
    const cfg = this.getConfig().dsh || {};
    const raw = cfg.workspace && String(cfg.workspace).trim();
    if (!raw) return path.join(this.appRoot, 'dsh-workspace');
    return path.isAbsolute(raw) ? raw : path.resolve(this.appRoot, raw);
  }

  // 懒启动：第一次双击宠物才拉。已经在起就复用同一个 promise，避免连点开出两个服务。
  start() {
    if (this.url) return Promise.resolve(this.url);
    if (this.starting) return this.starting;
    this.starting = this.spawnOnce().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async spawnOnce() {
    const cfg = { port: 3080, ...(this.getConfig().dsh || {}) };
    if (cfg.enabled === false) throw new Error('dsh 在配置里被关掉了（toolbar.config.json 的 dsh.enabled）');
    const install = installInfo(this.appRoot);
    if (!install) {
      this.lastError = '没装 dsh：在项目目录跑 npm install';
      throw new Error(this.lastError);
    }
    const script = install.bin;

    const workspace = this.workspaceDir();
    fs.mkdirSync(workspace, { recursive: true });

    // dsh 是普通的 Node CLI，用它自己的 Node（PATH 上的 node），别借 Electron 那份
    const runtime = this.nodeRuntime();
    if (!runtime) {
      this.lastError = '没找到系统 node：dsh 需要一个独立的 Node 运行时（Electron 自带的那份跑不了它）';
      throw new Error(this.lastError);
    }

    const env = { ...process.env };
    // 遥测默认关掉：dsh 官方默认 FEEDBACK_ONLY，会往 deepseeksvc.com 发会话日志
    env.DSH_TELEMETRY_MODE = cfg.telemetry ? env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY' : 'off';
    const key = this.getKey ? this.getKey() : null;
    if (key) env.DEEPSEEK_API_KEY = key;

    const args = ['--profile', 'web', '--no-open', '--port', String(cfg.port)];

    // 直接拿 node 跑入口脚本，不套 cmd.exe：少一层 shell，退出时 kill() 就能收干净
    const child = spawn(runtime, [script, ...args], {
      cwd: workspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;
    this.stopped = false;
    this.tail = '';
    this.stdoutBuf = '';

    child.stdout.on('data', (chunk) => this.onStdout(String(chunk)));
    child.stderr.on('data', (chunk) => {
      this.tail = (this.tail + redact(String(chunk))).slice(-4000);
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      this.url = null;
      if (!this.stopped) {
        this.lastError = `dsh 退出（code=${code} signal=${signal || '-'}）：${this.tail.slice(-200)}`;
        console.warn('[dsh]', this.lastError);
      }
      this.emit('dsh:state', this.status());
    });
    child.on('error', (err) => {
      this.lastError = err.message;
      console.warn('[dsh] 启动失败', err.message);
      this.emit('dsh:state', this.status());
    });

    const deadline = Date.now() + (cfg.startupTimeoutMs || 120000);
    while (Date.now() < deadline) {
      if (this.url) return this.url;
      if (!this.child) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    this.lastError = this.child ? '等不到 dsh 打印访问地址（启动超时）' : this.lastError || 'dsh 起来了又立刻退了';
    this.stop();
    throw new Error(this.lastError);
  }

  onStdout(text) {
    this.stdoutBuf += text;
    // 按行取：地址被 chunk 切成半截时，宁等下一块也不要拿截断的 token 当真地址
    const lines = this.stdoutBuf.split('\n');
    this.stdoutBuf = lines.pop();
    for (const raw of lines) {
      const line = raw.replace(ANSI_PATTERN, '');
      this.tail = (this.tail + redact(line) + '\n').slice(-4000);
      this.takeUrl(line);
    }
    // 万一它打完地址不再换行，只要地址后面跟了别的字符（色码、空格）也算收全了
    const rest = this.stdoutBuf.replace(ANSI_PATTERN, '');
    const match = rest.match(URL_PATTERN);
    if (match && match.index + match[0].length < rest.length) this.takeUrl(rest);
  }

  takeUrl(text) {
    if (this.url) return;
    const match = text.match(URL_PATTERN);
    if (!match || !/[?&]token=/.test(match[0])) return;
    this.url = match[0];
    this.lastError = null;
    this.emit('dsh:state', this.status());
  }

  // dsh 自己可能再拉工作子进程，Windows 上按进程树收，避免留下占着 3080 的孤儿
  stop() {
    const child = this.child;
    this.stopped = true;
    this.url = null;
    this.child = null;
    if (!child) return;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        child.kill();
      }
    } catch (err) {
      console.warn('[dsh] 回收失败', err.message);
    }
  }

  async healthy() {
    if (!this.url) return false;
    return probe(this.url);
  }
}

module.exports = { DshHost, installInfo, probe };
