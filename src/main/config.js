const fs = require('node:fs');
const path = require('node:path');

const CONFIG_FILE = 'toolbar.config.json';

const DEFAULTS = {
  display: {
    mode: 'auto',
    index: 1,
    match: { width: 1920, height: 540, tolerance: 80 },
    bounds: null
  },
  window: {
    alwaysOnTop: false,
    autoHideCursorMs: 4000
  },
  metrics: { pollMs: 1500, historySize: 90, slowPollMs: 3000 },
  clipboard: { enabled: true, maxItems: 30, pollMs: 800 },
  theme: { accent: '#57b6ff' },
  dockCategories: [],
  dock: [],
  music: { folder: '', recursive: true, volume: 0.7, repeat: 'all' }
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (!isObject(base) || !isObject(patch)) return structuredClone(patch);
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = deepMerge(base[key], value);
  return out;
}

function load(appRoot) {
  const file = path.join(appRoot, CONFIG_FILE);
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[config] ${CONFIG_FILE} is not valid JSON (${err.message}); using defaults`);
    }
  }
  return deepMerge(structuredClone(DEFAULTS), raw);
}

function save(appRoot, config) {
  const file = path.join(appRoot, CONFIG_FILE);
  const ordered = {
    display: config.display,
    window: config.window,
    metrics: config.metrics,
    clipboard: config.clipboard,
    theme: config.theme,
    dockCategories: config.dockCategories,
    dock: config.dock,
    music: config.music
  };
  fs.writeFileSync(file, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
  return file;
}

module.exports = { load, save, merge: deepMerge, CONFIG_FILE };
