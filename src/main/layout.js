const fs = require('node:fs');
const path = require('node:path');

const LAYOUT_FILE = 'layout.json';

const DEFAULT_LAYOUT = {
  grid: {
    columns: ['330px', 'minmax(0, 1fr)', '400px'],
    rows: ['32px', 'minmax(118px, 0.82fr)', 'minmax(150px, 1.18fr)', '78px'],
    areas: [
      ['topbar', 'topbar', 'topbar'],
      ['clock', 'gauges', 'workbench'],
      ['clock', 'player', 'clipboard'],
      ['dock', 'dock', 'clipboard']
    ]
  },
  modules: [
    { id: 'topbar', name: '顶栏（设置与退出）', enabled: true },
    { id: 'clock', name: '时钟与主机信息', enabled: true },
    { id: 'gauges', name: '系统指标卡片', enabled: true },
    { id: 'workbench', name: '待办与便签', enabled: true },
    { id: 'player', name: '音乐播放器', enabled: true },
    { id: 'clipboard', name: '剪贴板历史', enabled: true },
    { id: 'dock', name: '快捷入口', enabled: true }
  ]
};

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
  const ids = new Set(layout.modules.map((module) => module.id));
  for (const row of areas) {
    for (const token of row) if (token !== '.' && !ids.has(token)) errors.push(`区域名 "${token}" 未在 modules 中声明`);
  }
  return errors;
}

function load(appRoot) {
  let layout = structuredClone(DEFAULT_LAYOUT);
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(appRoot, LAYOUT_FILE), 'utf8'));
    layout = {
      grid: { ...DEFAULT_LAYOUT.grid, ...(raw.grid || {}) },
      modules: Array.isArray(raw.modules) && raw.modules.length ? raw.modules : DEFAULT_LAYOUT.modules
    };
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

function save(appRoot, layout) {
  const errors = validate(layout);
  if (errors.length) return { errors };
  const file = path.join(appRoot, LAYOUT_FILE);
  fs.writeFileSync(file, `${JSON.stringify(layout, null, 2)}\n`, 'utf8');
  return { file };
}

module.exports = { load, save, validate, LAYOUT_FILE };
