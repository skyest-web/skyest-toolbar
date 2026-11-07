const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel, handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('deskToolbar', {
  boot: () => invoke('boot:get'),

  config: {
    save: (patch) => invoke('config:save', patch),
    reload: () => invoke('config:reload'),
    openFile: () => invoke('config:openFile')
  },

  layout: {
    save: (layout) => invoke('layout:save', layout),
    openFile: () => invoke('layout:openFile'),
    setPage: (pageId) => invoke('page:set', pageId),
    // 桌面反过来驱动面板：主进程已经存好 activePage，这里只把界面切过去。
    // 千万别再走 setPage 那条 IPC——那等于把桌面又切回上一块，两边会打乒乓。
    onSync: (handler) => on('page:sync', handler)
  },

  components: {
    list: () => invoke('components:list')
  },

  // 虚拟桌面看护的实况（自检探针用）：当前第几个桌面、共几个、绑了哪些面板
  vdesk: {
    status: () => invoke('vdesk:status')
  },

  displays: {
    list: () => invoke('displays:list'),
    onChanged: (handler) => on('displays:changed', handler)
  },

  metrics: {
    onFast: (handler) => on('metrics:fast', handler),
    onFull: (handler) => on('metrics:full', handler)
  },

  dock: {
    launch: (item) => invoke('dock:launch', item),
    reveal: (target) => invoke('dock:reveal', target),
    pickPath: (kind) => invoke('dock:pickPath', kind)
  },

  tasks: { save: (tasks) => invoke('tasks:save', tasks) },
  notes: { save: (notes) => invoke('notes:save', notes) },
  player: { save: (player) => invoke('player:save', player) },

  music: {
    scan: (folder) => invoke('music:scan', folder),
    lyrics: (track) => invoke('music:lyrics', track),
    pickFolder: () => invoke('music:pickFolder')
  },

  // 本地视频：主进程扫文件夹，播放走和音乐同一条 track://（分段响应是手写的，进度条才拿得到时长）。
  // 这一层不发网络请求，也不碰 file://；save 只记「上次哪条、看到第几秒」，进 state.json。
  video: {
    scan: (folder) => invoke('video:scan', folder),
    pickFolder: () => invoke('video:pickFolder'),
    save: (video) => invoke('video:save', video)
  },

  // 本地照片：主进程扫文件夹，图片地址是 file:///（<img> 不受媒体元素那条跨源策略限制，
  // 所以不走 track://）。没有 save——照片看完就看完，不需要「上次第几张」。
  photos: {
    scan: (folder) => invoke('photos:scan', folder),
    pickFolder: () => invoke('photos:pickFolder')
  },

  // B 站（只读列表 + 交给浏览器打开）。这一层不发网络请求：出网全在主进程 services/bili.js。
  // open 只递行 id（主进程自己发出去的那批），渲染层递不进 URL；
  // setAuth 之后也只能看到 hint，SESSDATA 一个字节都不回这里。
  bili: {
    status: () => invoke('bili:status'),
    list: (section, opts) => invoke('bili:list', section, opts),
    open: (id) => invoke('bili:open', id),
    setAuth: (value) => invoke('bili:setAuth', value),
    clearAuth: () => invoke('bili:clearAuth'),
    check: () => invoke('bili:check')
  },

  trainers: {
    list: (force) => invoke('trainers:list', force),
    launch: (id, elevated) => invoke('trainers:launch', id, elevated),
    reveal: (id) => invoke('trainers:reveal', id),
    pickFolder: () => invoke('trainers:pickFolder')
  },

  steam: {
    list: (force) => invoke('steam:list', force),
    launch: (id) => invoke('steam:launch', id),
    reveal: (id) => invoke('steam:reveal', id),
    pickFolder: () => invoke('steam:pickFolder')
  },

  // 游戏列表：拼好的行数据（图标 + 游戏名 + 对应修改器）；启动仍然分别走 steam / trainers 那两条
  library: {
    list: (force) => invoke('library:list', force)
  },

  // 项目列表（工作面板左下那一格）：主进程扫 repos.roots 那几个根的顶层文件夹、按标记文件判 IDE。
  // launch / reveal 只递行 id——项目路径和 IDE 的 exe 都留在主进程这次的缓存里。
  projects: {
    list: (force) => invoke('projects:list', force),
    launch: (id) => invoke('projects:launch', id),
    reveal: (id) => invoke('projects:reveal', id)
  },

  // git 状态（工作面板中间那一整块）：行数据是主进程拿项目格那批行现读的，路径只到「仓库内相对路径」。
  // status(force, id) 里的 id 就是项目格选中那行的 id；不给 id 服务就回「先点左边一个项目」，不起 git 进程。
  // 写侧两步走：prepare(id, op) 只换一个一次性 nonce 和几句要给他看的话回来，
  // confirm(nonce) 才真起 git 进程——id、参数、提交说明全留在主进程那一次 prepare 里，这条路递不进去。
  // openFile 递的是 (行 id, 第几条)，绝对路径和用哪个 IDE 都由主进程那两侧现查。
  git: {
    status: (force, id) => invoke('git:status', force, id),
    prepare: (id, op, extra) => invoke('git:prepare', id, op, extra),
    confirm: (nonce) => invoke('git:confirm', nonce),
    cancel: (nonce) => invoke('git:cancel', nonce),
    openFile: (id, index) => invoke('git:openFile', id, index)
  },

  // 仓库根目录（项目格与 git 格共用那一份配置）：只把选中的目录还给设置卡片，落盘走「保存并应用」
  repos: {
    pickFolder: () => invoke('repos:pickFolder')
  },

  // 邮箱（163 IMAP，只读）：行数据来自主进程那批缓存，渲染层拿不到任何凭据；
  // 授权码只进不出——setAuth 之后也只能看到 hint。
  // 提醒只送「几条、谁」：payload 里没有主题、没有正文，更没有授权码。
  mail: {
    status: () => invoke('mail:status'),
    list: (force) => invoke('mail:list', force),
    openWebmail: () => invoke('mail:openWebmail'),
    setAuth: (value) => invoke('mail:setAuth', value),
    clearAuth: () => invoke('mail:clearAuth'),
    // 主进程那条看护轮询推过来的两条：updated 让开着的那一格跟着刷新，new 让宠物动一下 + 念一句
    onUpdated: (handler) => on('mail:updated', handler),
    onNew: (handler) => on('mail:new', handler)
  },

  clipboard: {
    copy: (id) => invoke('clipboard:copy', id),
    clear: () => invoke('clipboard:clear'),
    onUpdate: (handler) => on('clipboard:update', handler)
  },

  ai: {
    send: (text) => invoke('ai:send', text),
    retry: () => invoke('ai:retry'),
    abort: () => invoke('ai:abort'),
    clear: () => invoke('ai:clear'),
    keyStatus: () => invoke('ai:key:status'),
    setKey: (key) => invoke('ai:key:set', key),
    clearKey: () => invoke('ai:key:clear'),
    onState: (handler) => on('ai:state', handler),
    onDelta: (handler) => on('ai:delta', handler),
    onDone: (handler) => on('ai:done', handler),
    onTool: (handler) => on('ai:tool', handler),
    onError: (handler) => on('ai:error', handler)
  },

  dsh: {
    status: () => invoke('dsh:status'),
    show: () => invoke('dsh:show'),
    hide: () => invoke('dsh:hide'),
    focus: () => invoke('dsh:focus'),
    onState: (handler) => on('dsh:state', handler)
  },

  search: {
    status: () => invoke('search:status'),
    probe: () => invoke('search:probe'),
    query: (text) => invoke('search:query', text),
    open: (listId, index) => invoke('search:open', listId, index),
    startHost: () => invoke('search:startHost'),
    onState: (handler) => on('search:state', handler)
  },

  app: {
    quit: () => invoke('app:quit'),
    relaunch: () => invoke('app:relaunch')
  },

  voice: {
    status: () => invoke('voice:status'),
    asrStart: (sampleRate) => invoke('voice:asr-start', sampleRate),
    asrChunk: (id, samples, sampleRate) => invoke('voice:asr-chunk', id, samples, sampleRate),
    asrEnd: (id) => invoke('voice:asr-end', id),
    asrCancel: (id) => invoke('voice:asr-cancel', id),
    speak: (text, extra) => invoke('voice:speak', text, extra),
    onAsr: (handler) => on('voice:asr', handler),
    onStatus: (handler) => on('voice:status', handler),
    onError: (handler) => on('voice:error', handler)
  }
});
