const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { app, BrowserWindow, dialog, ipcMain, protocol, screen, shell } = require('electron');

const configStore = require('./config');
const layoutStore = require('./layout');
const displayResolver = require('./display');
const metrics = require('./services/metrics');
const launcher = require('./services/launcher');
const music = require('./services/music');
const { Store } = require('./services/store');
const { ClipboardHistory } = require('./services/clipboard-history');
const { AiChat } = require('./services/ai');
const { AiKey } = require('./services/ai-key');
const { Voice } = require('./services/voice');
const { DshHost } = require('./services/dsh');
const { DshWindow } = require('./services/dsh-window');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const COMPONENT_DIR = path.join(APP_ROOT, 'src', 'renderer', 'js', 'components');

// 组件是 drop-in 的：往 src/renderer/js/components/ 里放一个 .js 就会出现在组件列表里
function componentFiles() {
  try {
    return fs.readdirSync(COMPONENT_DIR).filter((name) => name.endsWith('.js')).sort();
  } catch (err) {
    console.warn(`[components] 读取目录失败：${err.message}`);
    return [];
  }
}

let config = null;
let layout = null;
let win = null;
let store = null;
let clipboardHistory = null;
let aiKey = null;
let aiChat = null;
let voice = null;
let dsh = null;
let dshWindow = null;
let placement = null;
let fastTimer = null;
let slowTimer = null;

// 音频经自定义协议读取：本地文件用 file:// 直连媒体元素会被 Chromium 的跨源策略挡住。
// corsEnabled + Access-Control-Allow-Origin 是为了让 WebAudio 的 AnalyserNode 能读到频谱数据
// （跨源但没声明 CORS 的媒体会被"污染"，analyse 出来永远是 0）。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'track',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true }
  }
]);

function trackUrl(filePath) {
  return `track://play/${encodeURIComponent(filePath)}`;
}

function trackPath(requestUrl) {
  const encoded = new URL(requestUrl).pathname.replace(/^\//, '');
  return decodeURIComponent(encoded);
}

function registerTrackProtocol() {
  protocol.handle('track', (request) => {
    const filePath = trackPath(request.url);
    if (!fs.existsSync(filePath)) return new Response('not found', { status: 404 });
    const size = fs.statSync(filePath).size;
    const baseHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Content-Type': music.mimeFor(filePath),
      'Accept-Ranges': 'bytes'
    };

    // 自己做分段响应：net.fetch 走 file:// 时常把 Content-Length 漏掉，
    // Chromium 拿不到长度就把 duration 报成 Infinity，进度条和总时长全废。
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
    if (!range) {
      return new Response(Readable.toWeb(fs.createReadStream(filePath)), { status: 200, headers: { ...baseHeaders, 'Content-Length': String(size) } });
    }

    const suffix = !range[1] && range[2];
    const start = range[1] ? Number(range[1]) : suffix ? Math.max(0, size - Number(range[2])) : 0;
    const end = range[2] && !suffix ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || end < start) {
      return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` } });
    }
    return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
      status: 206,
      headers: { ...baseHeaders, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` }
    });
  });
}

function createWindow() {
  placement = displayResolver.resolve(config);
  win = new BrowserWindow({
    // 只给 x/y：若把 width/height 一起传进构造函数，Windows 会先按窗口初始所在屏
    // （主屏）截断宽度，导致 1920 被压成主屏的 1707。真正的尺寸在 setBounds 里落定。
    x: placement.bounds.x,
    y: placement.bounds.y,
    width: 320,
    height: 240,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: '#0b0f14',
    hasShadow: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  win.setBounds(placement.bounds);
  console.log('[toolbar] 目标屏:', placement.source, JSON.stringify(placement.bounds), 'scale=', placement.display?.scaleFactor);
  if (config.window.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(APP_ROOT, 'src', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', async () => {
    const env = await win.webContents.executeJavaScript('JSON.stringify({ dpr: window.devicePixelRatio, css: [innerWidth, innerHeight] })');
    console.log('[toolbar] 窗口', JSON.stringify(win.getBounds()), '页面', env);
  });
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

function push(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// 给渲染层的 dsh 状态：子进程状态 + 窗口是否开着。这里面不含 token，也不含带 token 的地址。
function dshStatus() {
  return { ...(dsh ? dsh.status() : {}), visible: dshWindow ? dshWindow.isOpen() : false };
}

function startTicker() {
  stopTicker();
  const fast = Math.max(500, config.metrics.pollMs);
  const slow = Math.max(fast, config.metrics.slowPollMs);

  fastTimer = setInterval(() => push('metrics:fast', metrics.fastSnapshot()), fast);
  slowTimer = setInterval(() => {
    metrics
      .snapshot()
      .then((full) => push('metrics:full', full))
      .catch((err) => console.warn('[metrics] full snapshot failed', err.message));
  }, slow);

  // Prime both channels immediately so the UI is never blank on start.
  push('metrics:fast', metrics.fastSnapshot());
  metrics
    .snapshot()
    .then((full) => push('metrics:full', full))
    .catch(() => {});
}

function stopTicker() {
  if (fastTimer) clearInterval(fastTimer);
  if (slowTimer) clearInterval(slowTimer);
  fastTimer = null;
  slowTimer = null;
}

function reposition() {
  placement = displayResolver.resolve(config);
  win.setBounds(placement.bounds);
  win.setAlwaysOnTop(Boolean(config.window.alwaysOnTop), 'screen-saver');
  return { placement, displays: displayResolver.list() };
}

function registerIpc() {
  ipcMain.handle('boot:get', () => ({
    config,
    layout,
    tasks: store.get('tasks'),
    notes: store.get('notes'),
    player: store.get('player'),
    clipboard: clipboardHistory.list(),
    ai: { messages: aiChat.messages, key: aiKey.status() },
    voice: voice ? voice.status() : null,
    placement,
    displays: displayResolver.list(),
    components: componentFiles(),
    defaultLayout: layoutStore.DEFAULT_LAYOUT,
    appVersion: app.getVersion(),
    electron: process.versions.electron
  }));

  ipcMain.handle('components:list', () => componentFiles());

  ipcMain.handle('config:save', (_event, patch) => {
    config = configStore.merge(configStore.load(APP_ROOT), patch);
    const file = configStore.save(APP_ROOT, config);
    applyPolling();
    return { config, file, ...reposition() };
  });

  ipcMain.handle('config:reload', () => {
    config = configStore.load(APP_ROOT);
    applyPolling();
    return { config, ...reposition() };
  });

  ipcMain.handle('layout:save', (_event, nextLayout) => {
    const result = layoutStore.save(APP_ROOT, nextLayout);
    if (result.errors) return result;
    layout = layoutStore.load(APP_ROOT);
    return { layout, file: result.file };
  });

  ipcMain.handle('displays:list', () => displayResolver.list());

  ipcMain.handle('dock:launch', (_event, item) => launcher.launch(item));
  ipcMain.handle('dock:reveal', (_event, target) => launcher.reveal(target));

  ipcMain.handle('music:scan', (_event, folder) => {
    const target = folder || config.music.folder;
    const result = music.scan(target, { recursive: config.music.recursive });
    return { ...result, tracks: result.tracks.map((track) => ({ ...track, url: trackUrl(track.path) })), folder: target };
  });

  ipcMain.handle('music:lyrics', (_event, track) => music.lyricsFor(track));

  ipcMain.handle('dock:pickPath', async (_event, kind) => {
    const options = {
      title: kind === 'folder' ? '选择文件夹' : kind === 'image' ? '选择图标图片' : '选择程序或文档',
      defaultPath: kind === 'folder' ? app.getPath('home') : app.getPath('desktop'),
      properties: kind === 'folder' ? ['openDirectory'] : ['openFile']
    };
    if (kind === 'image') options.filters = [{ name: '图片', extensions: ['png', 'ico', 'svg', 'jpg', 'jpeg', 'webp', 'bmp'] }];
    else if (kind !== 'folder') options.filters = [
      { name: '程序与文档', extensions: ['exe', 'lnk', 'bat', 'cmd', 'msi', 'msc', 'url', 'txt', 'md', 'pdf', 'docx', 'xlsx', 'pptx', 'html'] },
      { name: '所有文件', extensions: ['*'] }
    ];
    const { canceled, filePaths } = await dialog.showOpenDialog(win, options);
    return canceled || !filePaths.length ? null : filePaths[0];
  });

  ipcMain.handle('music:pickFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择音乐文件夹',
      defaultPath: config.music.folder || app.getPath('music'),
      properties: ['openDirectory']
    });
    if (canceled || !filePaths.length) return null;
    config = configStore.merge(config, { music: { ...config.music, folder: filePaths[0] } });
    configStore.save(APP_ROOT, config);
    return filePaths[0];
  });

  ipcMain.handle('tasks:save', (_event, tasks) => {
    store.set('tasks', tasks);
    return true;
  });
  ipcMain.handle('notes:save', (_event, notes) => {
    store.set('notes', notes);
    return true;
  });
  ipcMain.handle('player:save', (_event, player) => {
    store.set('player', player);
    return true;
  });

  ipcMain.handle('clipboard:copy', (_event, id) => clipboardHistory.copy(id));
  ipcMain.handle('clipboard:clear', () => {
    clipboardHistory.clear();
    return true;
  });

  ipcMain.handle('ai:send', (_event, text) => aiChat.send(text));
  ipcMain.handle('ai:retry', () => aiChat.retry());
  ipcMain.handle('ai:abort', () => aiChat.abort());
  ipcMain.handle('ai:clear', () => {
    aiChat.clear();
    return true;
  });
  ipcMain.handle('ai:key:status', () => aiKey.status());
  ipcMain.handle('ai:key:set', (_event, key) => aiKey.set(key));
  ipcMain.handle('ai:key:clear', () => aiKey.clear());

  ipcMain.handle('voice:status', () => voice.status());
  ipcMain.handle('voice:asr-start', (_event, sampleRate) => voice.asrStart(sampleRate));
  ipcMain.handle('voice:asr-chunk', (_event, id, samples, sampleRate) => {
    voice.asrChunk(id, new Float32Array(samples), sampleRate);
    return true;
  });
  ipcMain.handle('voice:asr-end', (_event, id) => {
    voice.asrEnd(id);
    return true;
  });
  ipcMain.handle('voice:asr-cancel', (_event, id) => {
    voice.asrCancel(id);
    return true;
  });
  ipcMain.handle('voice:speak', async (_event, text, extra) => {
    try {
      return { ok: true, audio: await voice.speak(text, extra) };
    } catch (error) {
      return { ok: false, kind: error.kind || 'tts', message: error.message || String(error) };
    }
  });

  // dsh：状态里不带 token，渲染层只管开合。窗口是独立系统窗口，尺寸归 Windows 管，不再报 bounds
  ipcMain.handle('dsh:status', () => dshStatus());
  ipcMain.handle('dsh:show', async () => {
    try {
      await dshWindow.show();
      return { ok: true, status: dshStatus() };
    } catch (error) {
      return { ok: false, message: error.message || String(error), status: dshStatus() };
    }
  });
  ipcMain.handle('dsh:hide', () => {
    dshWindow.hide();
    return true;
  });
  ipcMain.handle('dsh:focus', () => {
    dshWindow.focus();
    return true;
  });

  ipcMain.handle('app:quit', () => app.quit());  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.quit();
  });
  ipcMain.handle('config:openFile', () => shell.openPath(path.join(APP_ROOT, configStore.CONFIG_FILE)));
  ipcMain.handle('layout:openFile', () => shell.openPath(path.join(APP_ROOT, layoutStore.LAYOUT_FILE)));
}

function applyPolling() {
  if (clipboardHistory) {
    clipboardHistory.stop();
    clipboardHistory.maxItems = config.clipboard.maxItems;
    clipboardHistory.pollMs = config.clipboard.pollMs;
    clipboardHistory.enabled = config.clipboard.enabled;
    clipboardHistory.start();
  }
  if (aiChat) aiChat.syncPersistence();
  if (voice) voice.sync();
  startTicker();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => win && win.show());

  app.whenReady().then(() => {
    registerTrackProtocol();
    config = configStore.load(APP_ROOT);
    layout = layoutStore.load(APP_ROOT);
    store = new Store(app.getPath('userData'));

    createWindow();

    clipboardHistory = new ClipboardHistory(config.clipboard);
    clipboardHistory.onChange((items) => push('clipboard:update', items));
    clipboardHistory.start();

    aiKey = new AiKey(app.getPath('userData'));

    voice = new Voice({ appRoot: APP_ROOT, getConfig: () => config, emit: push });
    voice.sync();

    // dsh 是懒启动的：只有第一次双击宠物开窗口才拉子进程
    // dsh 自己只报子进程状态，窗口开合由 dshStatus 补齐，省得渲染层看到两种形状的状态对象
    dsh = new DshHost({
      appRoot: APP_ROOT,
      getConfig: () => config,
      getKey: () => aiKey.get(),
      emit: (channel, payload) => push(channel, channel === 'dsh:state' ? dshStatus() : payload)
    });
    dshWindow = new DshWindow({
      host: dsh,
      store,
      onVisibility: () => push('dsh:state', dshStatus())
    });

    aiChat = new AiChat({
      store,
      getKey: () => aiKey.get(),
      getConfig: () => config.ai,
      emit: push
    });

    registerIpc();
    startTicker();

    const onScreenChange = () => push('displays:changed', reposition().displays);
    for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(event, onScreenChange);
  });

  app.on('before-quit', () => {
    stopTicker();
    if (clipboardHistory) clipboardHistory.stop();
    if (voice) voice.shutdown();
    if (dshWindow) dshWindow.destroy();
    if (dsh) dsh.stop();
    if (store) store.flush();
  });

  app.on('window-all-closed', () => app.quit());
}
