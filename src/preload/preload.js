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
    openFile: () => invoke('layout:openFile')
  },

  components: {
    list: () => invoke('components:list')
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
    onError: (handler) => on('ai:error', handler)
  },

  dsh: {
    status: () => invoke('dsh:status'),
    show: () => invoke('dsh:show'),
    hide: () => invoke('dsh:hide'),
    focus: () => invoke('dsh:focus'),
    onState: (handler) => on('dsh:state', handler)
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
