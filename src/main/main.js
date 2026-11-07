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
const video = require('./services/video');
const photos = require('./services/photos');
const { Store } = require('./services/store');
const { ClipboardHistory } = require('./services/clipboard-history');
const { AiChat } = require('./services/ai');
const { buildTools } = require('./services/ai-tools');
const { AiKey } = require('./services/ai-key');
const { Voice } = require('./services/voice');
const { DshHost } = require('./services/dsh');
const { DshWindow } = require('./services/dsh-window');
const { EverythingSearch } = require('./services/everything');
const { Trainers } = require('./services/trainers');
const { Steam } = require('./services/steam');
const { Library } = require('./services/library');
const { Projects } = require('./services/projects');
const { Git } = require('./services/git');
const { Mail } = require('./services/mail');
const { Bili } = require('./services/bili');
const { VdesktopFollow } = require('./services/vdesktop-follow');

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
let everything = null;
let trainers = null;
let steam = null;
let library = null;
let projects = null;
let git = null;
let mail = null;
let bili = null;
let placement = null;
let fastTimer = null;
let slowTimer = null;
let vdesktopFollow = null;
let recreating = false;
let lastRecreateAt = 0;
// 「是我们自己让桌面跳到第 N 个」的记号：看护回来的 desk|N 因此不再反查面板，
// 免得 面板→桌面→面板→桌面 来回打乒乓。超时清掉，防止一次失败的切换把记号永久挂住。
let pendingDesktop = null;
let pendingDesktopTimer = null;

// 音频 / 视频经自定义协议读取：本地文件用 file:// 直连媒体元素会被 Chromium 的跨源策略挡住。
// corsEnabled + Access-Control-Allow-Origin 是为了让 WebAudio 的 AnalyserNode 能读到频谱数据
// （跨源但没声明 CORS 的媒体会被"污染"，analyse 出来永远是 0）；视频用不到频谱，但同一个 handler
// 同时服务播放器那一格，权限照旧开着最省事。
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

// 音频 / 视频 / 下载都走这一条：扩展名在音频表里就查音频表，否则查视频表。
// 两边都查不到会回 application/octet-stream，浏览器就当下载处理——不会黑屏骗人。
function mediaMime(filePath) {
  return music.AUDIO_EXT.has(path.extname(filePath).toLowerCase()) ? music.mimeFor(filePath) : video.mimeFor(filePath);
}

function registerTrackProtocol() {
  protocol.handle('track', (request) => {
    const filePath = trackPath(request.url);
    if (!fs.existsSync(filePath)) return new Response('not found', { status: 404 });
    const size = fs.statSync(filePath).size;
    const baseHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Content-Type': mediaMime(filePath),
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

// 窗口只会落在「创建它时活动的那个虚拟桌面」上，跨桌面又没有能让窗口常驻或搬走的对外
// API（MoveWindowToDesktop 对别的进程的窗口返回 E_ACCESSDENIED），所以跟随只能靠重建：
// 助手脚本只读探测，这里销毁旧窗口再走一遍 createWindow，新窗口就落在当前桌面上。
// 代价是一次约 200–400ms 的重载闪动、正在流式的回复会被打断；面板、播放器进度、聊天
// 历史与剪贴板都在 state.json / 主进程内存里，重建后原样回来。
function recreateWindow(reason) {
  if (recreating || !win || win.isDestroyed()) return;
  // 兜住最坏情况：万一重建后仍然判定为「不在当前桌面」，5 秒内不再重建，
  // 免得看护事件变成无限重启窗口的循环
  if (Date.now() - lastRecreateAt < 5000) {
    console.warn(`[vdesk] 距上次重建不足 5 秒，跳过这次（${reason}）`);
    return;
  }
  recreating = true;
  lastRecreateAt = Date.now();
  console.log(`[vdesk] 工具栏不在当前桌面，重建窗口以跟随（${reason}）`);
  try {
    // destroy 而不是 close：close 会走 'close' 事件，而 'close' 在我们的用法里可能被别处拦截
    win.destroy();
  } catch (err) {
    console.warn(`[vdesk] 销毁旧窗口失败：${err.message}`);
  }
  win = null;
  try {
    createWindow();
  } catch (err) {
    console.error(`[vdesk] 重建窗口失败：${err.message}`);
  }
  recreating = false;
}

// ---------- 面板 ↔ 虚拟桌面 ----------
// layout.json 里给面板写了 desktop: N（1 起，任务视图从左到右）就绑这一块；
// 没写（主界面）就是「切面板不动桌面」。绑了的面板不够数时只在已有桌面里切，
// 绝不自动创建桌面。开关沿用 window.followVirtualDesktop：关掉两半都不工作。
function markPendingDesktop(index) {
  pendingDesktop = index;
  if (pendingDesktopTimer) clearTimeout(pendingDesktopTimer);
  pendingDesktopTimer = setTimeout(() => {
    pendingDesktopTimer = null;
    pendingDesktop = null;
  }, 8000);
}

function clearPendingDesktop() {
  pendingDesktop = null;
  if (pendingDesktopTimer) {
    clearTimeout(pendingDesktopTimer);
    pendingDesktopTimer = null;
  }
}

// 他点页签 → 跳到那个面板绑的桌面。切完桌面后工具栏会被看护报一次 off，进而重建窗口
// （200~400ms 的闪）——那是这条路的既有限制，不是新引入的 bug；这台 26300 上窗口本来
// 没有桌面归属，实测不会触发，详见 docs/virtual-desktop-follow.md §6。
async function syncDesktopForPage(pageId) {
  if (!vdesktopFollow?.enabled) return;
  const index = layoutStore.desktopOfPage(layout, pageId);
  if (index === null) return;
  if (vdesktopFollow.desktopIndex === index && pendingDesktop === null) return;
  markPendingDesktop(index);
  const result = await vdesktopFollow.switchTo(index);
  // 切成功了就立刻把记号交回给看护的确认流（下面 onDesktopIndex 负责清），
  // 失败/range 也留着记号到超时，避免紧接着又重试一次同样的失败。
  if (!result.ok && pendingDesktop === index) clearPendingDesktop();
}

// 他用 Win+Ctrl+←/→ 切桌面 → 反过来切到绑在这个桌面上的面板。
function onDesktopIndex(index, count) {
  // 走到这里说明桌面确实变了：不管是我们要的那一个，还是他中途自己切的，记号都作废
  if (pendingDesktop !== null) clearPendingDesktop();
  if (!vdesktopFollow?.enabled) return;
  const pageId = layoutStore.pageOfDesktop(layout, index);
  if (!pageId || store.get('activePage') === pageId) return;
  store.set('activePage', pageId);
  // 只发同步，不回头调 syncDesktopForPage：这一半是桌面引起的，不能再把桌面切回去
  push('page:sync', { page: pageId, reason: `桌面 ${index + 1}/${count ?? '?'}` });
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
    video: store.get('video'),
    clipboard: clipboardHistory.list(),
    ai: { messages: aiChat.messages, key: aiKey.status() },
    voice: voice ? voice.status() : null,
    // 当前面板存 state.json（userData），不进 layout.json：切面板是运行时行为，
    // 不该让跟着 git 走的布局文件每次切换都脏一次
    page: store.get('activePage'),
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

  // 只认 layout 里真的存在的面板 id：渲染层递来一个陌生 id（旧 state.json、手改的文件）就忽略，
  // 别把无效值存回去，否则下次启动 boot 读到一个不存在的面板，界面直接空一半
  ipcMain.handle('page:set', (_event, pageId) => {    const id = String(pageId || '');
    if (!layout.pages.some((page) => page.id === id)) return { ok: false, message: `没有面板 "${id}"` };
    const changed = store.get('activePage') !== id;
    store.set('activePage', id);
    // 只有真的换了面板才动桌面：重复收到同一个 id（比如渲染层重绘）再去切一次，
    // 会白闪一下窗口。changed 同时是第二道防打乒乓的闸——桌面那半边不再走这条 IPC。
    if (changed) syncDesktopForPage(id);
    return { ok: true, page: id };
  });

  // 看护的实况：现在第几个虚拟桌面、一共几个、工具栏在不在上面、绑了哪些面板。
  // 自检探针靠它读桌面（而不是自己每 200ms 起一个 powershell——那本身会把前台拽回
  // 命令行所在的那个桌面，把要测的东西搅乱），设置面板将来要显示也用它。
  ipcMain.handle('vdesk:status', () => ({
    ...(vdesktopFollow ? vdesktopFollow.status() : { supported: process.platform === 'win32', enabled: false, watching: false }),
    activePage: store.get('activePage'),
    pendingDesktop,
    bindings: layout.pages.map((page) => ({ id: page.id, desktop: page.desktop ?? null }))
  }));

  ipcMain.handle('displays:list', () => displayResolver.list());

  ipcMain.handle('dock:launch', (_event, item) => launcher.launch(item));
  ipcMain.handle('dock:reveal', (_event, target) => launcher.reveal(target));

  ipcMain.handle('music:scan', (_event, folder) => {
    const target = folder || config.music.folder;
    const result = music.scan(target, { recursive: config.music.recursive });
    return { ...result, tracks: result.tracks.map((track) => ({ ...track, url: trackUrl(track.path) })), folder: target };
  });

  ipcMain.handle('music:lyrics', (_event, track) => music.lyricsFor(track));

  // 视频库：扫的是 config 里那个文件夹，渲染层递进来的路径只用来选默认打开位置，不当读文件的入口
  ipcMain.handle('video:scan', (_event, folder) => {
    const target = folder || config.video.folder;
    const result = video.scan(target, { recursive: config.video.recursive });
    return { ...result, clips: result.clips.map((clip) => ({ ...clip, url: trackUrl(clip.path) })), folder: target };
  });

  ipcMain.handle('video:pickFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择视频文件夹',
      defaultPath: config.video.folder || app.getPath('videos'),
      properties: ['openDirectory']
    });
    if (canceled || !filePaths.length) return null;
    config = configStore.merge(config, { video: { ...config.video, folder: filePaths[0] } });
    configStore.save(APP_ROOT, config);
    return filePaths[0];
  });

  // 照片墙：图片直接给 file:///（<img> 不受媒体元素那条跨源策略限制），所以不走 track://，
  // url 在 service 里就拼好了；这里只负责「扫哪个文件夹」和把选中的目录写回配置。
  ipcMain.handle('photos:scan', (_event, folder) => {
    const target = folder || config.photos.folder;
    return { ...photos.scan(target, { recursive: config.photos.recursive, limit: config.photos.limit }), folder: target };
  });

  ipcMain.handle('photos:pickFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择照片文件夹',
      defaultPath: config.photos.folder || app.getPath('pictures'),
      properties: ['openDirectory']
    });
    if (canceled || !filePaths.length) return null;
    config = configStore.merge(config, { photos: { ...config.photos, folder: filePaths[0] } });
    configStore.save(APP_ROOT, config);
    return filePaths[0];
  });

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

  // 修改器：列表由主进程扫（路径只从 config 来），启动/定位只认这次缓存里的 id
  ipcMain.handle('trainers:list', (_event, force) => trainers.scan(Boolean(force)));
  ipcMain.handle('trainers:launch', (_event, id, elevated) => trainers.launch(id, { elevated: Boolean(elevated) }));
  ipcMain.handle('trainers:reveal', (_event, id) => trainers.reveal(id));

  ipcMain.handle('trainers:pickFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择修改器文件夹',
      defaultPath: config.trainers.folder || undefined,
      properties: ['openDirectory']
    });
    if (canceled || !filePaths.length) return null;
    config = configStore.merge(config, { trainers: { ...config.trainers, folder: filePaths[0] } });
    configStore.save(APP_ROOT, config);
    return filePaths[0];
  });

  // Steam 库：读 appmanifest_*.acf，启动只把 appid 拼成 steam://rungameid/ 交给客户端
  ipcMain.handle('steam:list', (_event, force) => steam.scan(Boolean(force)));
  ipcMain.handle('steam:launch', (_event, id) => steam.launch(id));
  ipcMain.handle('steam:reveal', (_event, id) => steam.reveal(id));

  ipcMain.handle('steam:pickFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择 Steam 库（SteamLibrary 或它的 steamapps 都行）',
      defaultPath: config.steam.folder || undefined,
      properties: ['openDirectory']
    });
    if (canceled || !filePaths.length) return null;
    config = configStore.merge(config, { steam: { ...config.steam, folder: filePaths[0] } });
    configStore.save(APP_ROOT, config);
    return filePaths[0];
  });

  // 游戏列表：Steam 库 + 修改器 + 别名表 + 本地图标拼成一份行数据。
  // 只读不启动——点游戏名走上面的 steam:launch，点标签走 trainers:launch，用的都是各自那批缓存 id。
  ipcMain.handle('library:list', (_event, force) => library.list(Boolean(force)));

  // 项目列表（工作面板左下那一格）：扫 repos.roots 那几个根的顶层文件夹，启动是把项目路径交给判出来的那个 IDE。
  // 和 steam / trainers 同一条规矩：只认这次缓存里的 id，渲染层递不进任何路径或 exe。
  ipcMain.handle('projects:list', (_event, force) => projects.scan(Boolean(force)));
  ipcMain.handle('projects:launch', (_event, id) => projects.launch(id));
  ipcMain.handle('projects:reveal', (_event, id) => projects.reveal(id));

  // git 状态（工作面板中间那一整块）：不自己扫盘，看哪个仓库由左边项目格选中，id 就是项目格那行的 id。
  // id 不给或对不上时服务直接回一句「要先选项目」，一个 git 进程都不起。
  // 写侧四条（抓取 / 拉取 / 提交 / 推送）全走两步：prepare 只换一个一次性 nonce 回去，
  // confirm 才真起 git 进程——所以渲染层在「确认」这一步递不进任何参数，push 这种别人看得见的动作
  // 没有绕开确认条的入口。nonce 不做强转：类型不对要留给服务那句「确认码不对」判。
  ipcMain.handle('git:status', (_event, force, id) => git.refresh(Boolean(force), id));
  ipcMain.handle('git:prepare', (_event, id, op, extra) => git.prepare(id, op, extra || {}));
  ipcMain.handle('git:confirm', (_event, nonce) => git.confirm(nonce));
  ipcMain.handle('git:cancel', (_event, nonce) => git.cancel(nonce));

  // 点一个改动文件：绝对路径由 git 服务从「项目行的目录 + 这一格缓存的相对路径」拼出来，
  // 在这儿交给项目格——用哪个 IDE 是它判的（第二个视图不另判一套）。回给渲染层的只有项目名和相对路径。
  ipcMain.handle('git:openFile', async (_event, id, index) => {
    const hit = git.fileTarget(id, index);
    if (!hit.ok) return hit;
    const res = await projects.openFile(hit.projectId, hit.path);
    return res.ok ? { ...res, file: hit.file } : res;
  });

  // 仓库根目录（项目格与 git 格共用）：这条只开目录框把选中的路径**还给设置卡片**，
  // 不在这一步落盘——那一路是数组，落盘要等「保存并应用」一起写，免得半条配置先进磁盘。
  ipcMain.handle('repos:pickFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '添加一个仓库根目录（它下面的每个文件夹算一个项目）',
      defaultPath: (config.repos?.roots || [])[0] || undefined,
      properties: ['openDirectory']
    });
    if (canceled || !filePaths.length) return null;
    return filePaths[0];
  });

  // 邮箱：只读取件箱头部。授权码即时加密写进 userData/mail-auth.bin，不跟随「保存并应用」，
  // 也永不跨 IPC 回传——mail:status 里只有 set/hint（位数 + 尾两字）。
  ipcMain.handle('mail:status', () => mail.status());
  ipcMain.handle('mail:list', (_event, force) => mail.list(Boolean(force)));
  ipcMain.handle('mail:openWebmail', () => mail.openWebmail());
  ipcMain.handle('mail:setAuth', (_event, value) => mail.setAuth(value));
  ipcMain.handle('mail:clearAuth', () => mail.clearAuth());

  // B 站（只读列表 + 交给浏览器打开）。出网全在 services/bili.js 那一层，
  // SESSDATA 即时加密写进 userData/bili-auth.bin，不跟随「保存并应用」，也永不跨 IPC 回传——
  // bili:status 里只有 set/hint/logged/mid/uname。渲染层只能递 section 名和刚返回的行 id。
  ipcMain.handle('bili:status', () => bili.status());
  ipcMain.handle('bili:list', (_event, section, opts) => bili.list(section, { force: Boolean(opts?.force), folderId: opts?.folderId }));
  ipcMain.handle('bili:open', (_event, id) => bili.open(id));
  ipcMain.handle('bili:setAuth', (_event, value) => bili.setAuth(value));
  ipcMain.handle('bili:clearAuth', () => bili.clearAuth());
  ipcMain.handle('bili:check', () => bili.check());

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

  // 上次看到哪一条、看到第几秒：和播放器一样存 state.json（userData），不进 toolbar.config.json
  ipcMain.handle('video:save', (_event, video) => {
    store.set('video', video);
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

  // Everything 文件搜索：渲染层只拿到 (listId, index)，真实路径留在主进程这边
  ipcMain.handle('search:status', () => everything.status());
  ipcMain.handle('search:probe', async () => {
    await everything.probe();
    return everything.status();
  });
  ipcMain.handle('search:query', (_event, query) => everything.search(query));
  ipcMain.handle('search:open', (_event, listId, index) => everything.open(listId, index));
  ipcMain.handle('search:startHost', async () => {
    const result = await everything.startHost();
    return { ...result, status: everything.status() };
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
  // 邮箱的看护轮询：间隔 / 开关 / 提醒改了都要立刻生效，且只允许这一条定时器
  if (mail) mail.sync();
  if (vdesktopFollow) {
    vdesktopFollow.sync();
    // 开关关掉时 pending 的桌面确认永远不会再来，留着记号会吃掉下一次合法的面板切换
    clearPendingDesktop();
  }
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

    // 虚拟桌面跟随：助手只读探测，判断和重建都在本进程（见 services/vdesktop-follow.js
    // 顶部注释：跨进程 MoveWindowToDesktop 是 E_ACCESSDENIED，所以只能重建）。
    vdesktopFollow = new VdesktopFollow({
      getConfig: () => config,
      getWindow: () => win,
      onOffDesktop: (detail) => recreateWindow(detail),
      onDesktop: (index, count) => onDesktopIndex(index, count)
    });
    vdesktopFollow.start();

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

    // Everything 搜索：工作进程很轻（只加载一个 DLL），启动时探一次好让顶栏按钮一开始就报对状态；
    // 真正的查询走懒发起，探不到 Everything 也只是状态写着"未运行"，不影响别的组件。
    everything = new EverythingSearch({ appRoot: APP_ROOT, getConfig: () => config, emit: push });
    everything.probe().catch(() => {});

    // 修改器列表：不常驻、不预扫，渲染层要的时候才扫目录；路径只从 config 读
    trainers = new Trainers({ getConfig: () => config });

    // Steam 库：同上，只在渲染层要列表时读 appmanifest；启动走 steam:// 协议交给客户端
    steam = new Steam({ getConfig: () => config });

    // 游戏列表：把上面两个服务已经缓存好的结果拼起来，本身不再扫第二遍目录
    library = new Library({ steam, trainers });

    // 项目列表（工作面板左下那一格）：根目录现读 config.repos.roots（项目格和 git 格共用这一份），
    // 没配就兜回服务里的 D:\GitProject。IDE 的位置每次 force 重扫才重新找一遍。
    projects = new Projects({ getRoots: () => config.repos?.roots });

    // git 状态（工作面板中间那一整块）：不自己扫盘，看哪个仓库由左边项目格的选中决定。
    // 给的是 projects **服务本身**而不是某一行的快照——「git 格是项目格的第二个视图」要在代码里成立，
    // 两格共用同一批行、同一套 id，点了改动文件才能找回项目格判出来的那个 IDE。
    git = new Git({ getProjects: () => projects });

    // 邮箱（163 IMAP，只读头部）：不预连、不预拉，组件第一次要数据才握手。
    // 授权码跟着 userData 走，所以这里只给目录，不传值。
    // onEvent 是往渲染层推 mail:updated / mail:new 的那条路——新邮件的判定只能在主进程做，
    // 停在别的面板时生活面板那个组件根本不存在，没有 DOM 就没有轮询。
    mail = new Mail({
      getConfig: () => config,
      dir: app.getPath('userData'),
      onEvent: (channel, payload) => push(channel, payload)
    });
    // applyPolling() 只在「保存并应用」时跑，开机这一趟得自己起，否则第一次启动后要等下一次保存才有提醒
    mail.sync();

    // B 站（只读列表 + 交给浏览器打开）：不预连、不预拉，渲染层第一次切到 B 站那一档才问 nav。
    // SESSDATA 跟着 userData 走（DPAPI），所以这里只给目录，不传值；这一段没有任何 config 字段。
    bili = new Bili({ dir: app.getPath('userData') });

    aiChat = new AiChat({
      store,
      getKey: () => aiKey.get(),
      getConfig: () => config.ai,
      emit: push,
      // 宠物能调的本机工具。两道闸：agentTools 开关（默认关）+ 搜索本身没被关掉。
      // 只给只读的那一个，「打开文件」的口子对模型永久封死（见 services/ai-tools.js 顶部注释）。
      getTools: () => (config.ai.agentTools?.enabled && config.search?.enabled ? buildTools({ everything }) : [])
    });

    registerIpc();
    startTicker();

    const onScreenChange = () => push('displays:changed', reposition().displays);
    for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(event, onScreenChange);
  });

  app.on('before-quit', () => {
    stopTicker();
    if (vdesktopFollow) vdesktopFollow.stop();
    if (clipboardHistory) clipboardHistory.stop();
    if (voice) voice.shutdown();
    if (dshWindow) dshWindow.destroy();
    if (dsh) dsh.stop();
    // Everything 客户端不在这里收：它可能是用户自己开的，也可能被顶栏搜索拉起来当常驻索引用
    if (everything) everything.dispose();
    // 邮箱那条 IMAP 连接走 logout，别留半开的 TLS 会话给 163 记着
    if (mail) mail.dispose();
    if (store) store.flush();
  });

  app.on('window-all-closed', () => {
    // 跟随虚拟桌面时走的是 destroy + create：旧窗口已销毁、新窗口还没建的这一瞬间，
    // 这条事件会照常发过来。这时候不能退，否则「切桌面」就变成了「关应用」。
    if (recreating) return;
    app.quit();
  });
}
