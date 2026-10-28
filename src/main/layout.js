const fs = require('node:fs');
const path = require('node:path');

const LAYOUT_FILE = 'layout.json';

// 位置（grid.areas 里的区域名）是固定的；slots 决定每个位置放哪个组件、是否显示。
// 换位置 = 交换两个 slot 的 module；隐藏 = enabled:false，该区域留空。
const DEFAULT_LAYOUT = {
  grid: {
    columns: ['330px', 'minmax(0, 1fr)', 'minmax(0, 1fr)', '400px'],
    rows: ['32px', '176px', 'minmax(150px, 1fr)', '78px'],
    areas: [
      ['topbar', 'topbar', 'topbar', 'topbar'],
      ['clock', 'gauges', 'gauges', 'workbench'],
      ['player', 'slot1', 'slot2', 'clipboard'],
      ['dock', 'dock', 'dock', 'clipboard']
    ]
  },
  slots: [
    { at: 'topbar', label: '顶栏（整行）', module: 'topbar', enabled: true },
    { at: 'clock', label: '左上：时钟与主机信息', module: 'clock', enabled: true },
    { at: 'player', label: '左下：音乐播放器', module: 'player', enabled: true },
    { at: 'gauges', label: '中部上：系统指标（固定高度）', module: 'gauges', enabled: true },
    { at: 'workbench', label: '右上', module: 'workbench', enabled: true },
    { at: 'slot1', label: '中下左：占位', module: 'placeholder', enabled: true },
    { at: 'slot2', label: '中下右：占位', module: 'placeholder', enabled: true },
    { at: 'clipboard', label: '右侧竖条', module: 'ai', enabled: true },
    { at: 'dock', label: '底部通栏', module: 'dock', enabled: true }
  ]
};

function areaNames(grid) {
  const names = new Set();
  for (const row of grid.areas || []) for (const token of row) if (token !== '.') names.add(token);
  return names;
}

// 兼容 v1（modules: [{id, name, enabled}]）：id 同时当位置名和组件 id 用
function normalize(raw) {
  const grid = { ...DEFAULT_LAYOUT.grid, ...(raw.grid || {}) };
  let slots;
  if (Array.isArray(raw.slots) && raw.slots.length) {
    slots = raw.slots.map((slot) => ({
      at: String(slot.at || ''),
      label: String(slot.label || slot.at || ''),
      module: String(slot.module || ''),
      enabled: slot.enabled !== false
    }));
  } else if (Array.isArray(raw.modules) && raw.modules.length) {
    slots = raw.modules.map((module) => ({
      at: String(module.id || ''),
      label: String(module.name || module.id || ''),
      module: String(module.id || ''),
      enabled: module.enabled !== false
    }));
  } else {
    slots = structuredClone(DEFAULT_LAYOUT.slots);
  }
  return { grid, slots };
}

function validate(layout) {
  const errors = [];
  const { columns = [], rows = [], areas = [] } = layout.grid || {};
  if (!columns.length || !rows.length) errors.push('grid.columns / grid.rows 不能为空');
  if (areas.length !== rows.length) errors.push(`grid.areas 行数(${areas.length})与 rows(${rows.length})不一致`);
  for (const [rowIndex, row] of areas.entries()) {
    if (row.length !== columns.length) {
      errors.push(`grid.areas[${rowIndex}] 有 ${row.length} 列，应为 ${columns.length} 列`);
    }
    for (const token of row) {
      if (token !== '.' && !/^[a-z][a-z0-9]*$/.test(token)) errors.push(`grid.areas[${rowIndex}] 出现非法单元名 "${token}"`);
    }
  }

  const names = areaNames(layout.grid);
  const seen = new Set();
  for (const slot of layout.slots || []) {
    if (!names.has(slot.at)) errors.push(`slots 里的位置名 "${slot.at}" 没出现在 grid.areas 中`);
    if (seen.has(slot.at)) errors.push(`位置 "${slot.at}" 重复声明`);
    seen.add(slot.at);
  }
  for (const name of names) if (!seen.has(name)) errors.push(`区域 "${name}" 没有对应的 slot`);
  return errors;
}

function load(appRoot) {
  let layout = structuredClone(DEFAULT_LAYOUT);
  try {
    layout = normalize(JSON.parse(fs.readFileSync(path.join(appRoot, LAYOUT_FILE), 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[layout] ${LAYOUT_FILE} 解析失败（${err.message}），使用默认布局`);
  }
  const errors = validate(layout);
  if (errors.length) {
    console.warn(`[layout] ${LAYOUT_FILE} 有问题，已退回默认布局：\n  - ${errors.join('\n  - ')}`);
    layout = structuredClone(DEFAULT_LAYOUT);
  }
  return layout;
}

function save(appRoot, rawLayout) {
  const layout = normalize(rawLayout);
  const errors = validate(layout);
  if (errors.length) return { errors };
  const file = path.join(appRoot, LAYOUT_FILE);
  fs.writeFileSync(file, `${JSON.stringify(layout, null, 2)}\n`, 'utf8');
  return { file };
}

module.exports = { load, save, validate, normalize, DEFAULT_LAYOUT, LAYOUT_FILE };
