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

  app: {
    quit: () => invoke('app:quit'),
    relaunch: () => invoke('app:relaunch')
  }
});
