const fs = require('node:fs');
const path = require('node:path');

const LAYOUT_FILE = 'layout.json';

// 可换位置表：面板之间只有「这几格放哪个组件」不同，grid 形状是共用的。
// 面板的起手位置一律是空白占位——内容留给使用者在「组件与位置」里填。
const PAGE_AREAS = [
  { at: 'clock', label: '左上：时钟与主机信息' },
  { at: 'player', label: '左下：音乐播放器' },
  { at: 'gauges', label: '中部上：系统指标（固定高度）' },
  { at: 'workbench', label: '右上' },
  { at: 'slot1', label: '中下左：占位' },
  { at: 'slot2', label: '中下右：占位' }
];

function pageSlots(modules = {}) {
  return PAGE_AREAS.map((area) => ({ at: area.at, label: area.label, module: modules[area.at] || 'placeholder', enabled: true }));
}

const DEFAULT_PAGES = [
  { id: 'home', name: '主界面', modules: { clock: 'clock', player: 'player', gauges: 'gauges', workbench: 'workbench' } },
  { id: 'game', name: '游戏面板' },
  { id: 'work', name: '工作面板' },
  { id: 'life', name: '生活面板' }
];

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
  shared: [
    { at: 'topbar', label: '顶栏（整行）', module: 'topbar', enabled: true },
    { at: 'clipboard', label: '右侧竖条', module: 'ai', enabled: true },
    { at: 'dock', label: '底部通栏', module: 'dock', enabled: true }
  ],
  pages: DEFAULT_PAGES.map((page) => ({ id: page.id, name: page.name, slots: pageSlots(page.modules) }))
};

function areaNames(grid) {
  const names = new Set();
  for (const row of grid.areas || []) for (const token of row) if (token !== '.') names.add(token);
  return names;
}

function slotOf(raw, fallback) {
  return {
    at: String(raw?.at || fallback?.at || ''),
    label: String(raw?.label || fallback?.label || raw?.at || ''),
    module: String(raw?.module ?? fallback?.module ?? ''),
    enabled: raw ? raw.enabled !== false : fallback?.enabled !== false
  };
}

// 按默认位置表补齐/对齐一份 slots：顺序跟默认走，多出来的（用户手写的未知位置）原样留在尾部，
// 让 validate 去报，而不是静悄悄丢掉用户写的东西。
function alignSlots(rawSlots, defaults) {
  const list = Array.isArray(rawSlots) && rawSlots.length ? rawSlots : defaults;
  const byAt = new Map(list.map((slot) => [String(slot.at || ''), slot]));
  const out = defaults.map((fallback) => slotOf(byAt.get(fallback.at), fallback));
  for (const slot of list) if (!defaults.some((fallback) => fallback.at === slot.at)) out.push(slotOf(slot));
  return out;
}

function normalize(raw) {
  const grid = { ...DEFAULT_LAYOUT.grid, ...(raw.grid || {}) };
  const names = areaNames(grid);
  const v1 = Array.isArray(raw.pages) && raw.pages.length ? null : normalizeV1Slots(raw);

  // 常驻位置：v2 直接读 shared；v1 从那份唯一的 slots 里把常驻那几格抽出来，
  // 用户改过的（比如右侧竖条换了组件）要跟着走，不能被出厂默认盖掉。
  const sharedSource = Array.isArray(raw.shared) && raw.shared.length
    ? raw.shared
    : v1
      ? DEFAULT_LAYOUT.shared.map((fallback) => v1.find((slot) => slot.at === fallback.at) || fallback)
      : DEFAULT_LAYOUT.shared;
  const shared = sharedSource
    .map((slot) => slotOf(slot, DEFAULT_LAYOUT.shared.find((fallback) => fallback.at === slot.at)))
    // 只留真的在 grid.areas 里的常驻位置；缺下的由面板那侧按默认位置补
    .filter((slot) => names.has(slot.at));

  const pageDefaults = pageSlotsFor(grid, shared);
  const pages = v1
    ? [
        { id: 'home', name: '主界面', slots: alignSlots(v1.filter((slot) => !shared.some((item) => item.at === slot.at)), pageDefaults) },
        ...DEFAULT_PAGES.slice(1).map((page) => ({ id: page.id, name: page.name, slots: alignSlots(null, pageDefaults) }))
      ]
    : Array.isArray(raw.pages) && raw.pages.length
      ? raw.pages.map((page, index) => ({
          id: String(page.id || `page${index + 1}`),
          name: String(page.name || page.id || `面板 ${index + 1}`),
          slots: alignSlots(page.slots, pageDefaults)
        }))
      : structuredClone(DEFAULT_LAYOUT.pages);

  return { grid, shared, pages };
}

// v1：顶层 slots，或更早的 modules（id 同时当位置名和组件 id）
function normalizeV1Slots(raw) {
  if (Array.isArray(raw.slots) && raw.slots.length) {
    return raw.slots.map((slot) => slotOf(slot, DEFAULT_LAYOUT.shared.find((f) => f.at === slot.at) || PAGE_AREAS.find((f) => f.at === slot.at)));
  }
  if (Array.isArray(raw.modules) && raw.modules.length) {
    return raw.modules.map((module) =>
      slotOf({ at: module.id, label: module.name, module: module.id, enabled: module.enabled })
    );
  }
  return null;
}

// 一个面板该有哪些位置：grid.areas 里出现、且不属于常驻的那些
function pageSlotsFor(grid, shared) {
  const pinned = new Set(shared.map((slot) => slot.at));
  const present = [...areaNames(grid)].filter((name) => !pinned.has(name));
  const labelOf = (at) => PAGE_AREAS.find((area) => area.at === at)?.label || at;
  return present.map((at) => ({ at, label: labelOf(at), module: 'placeholder', enabled: true }));
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
  for (const slot of layout.shared || []) {
    if (!names.has(slot.at)) errors.push(`常驻位置名 "${slot.at}" 没出现在 grid.areas 中`);
    if (seen.has(slot.at)) errors.push(`常驻位置 "${slot.at}" 重复声明`);
    seen.add(slot.at);
  }

  if (!layout.pages?.length) errors.push('pages 至少要有一个面板');
  const ids = new Set();
  for (const page of layout.pages || []) {
    if (!page.id) errors.push('面板缺少 id');
    else if (ids.has(page.id)) errors.push(`面板 id "${page.id}" 重复`);
    ids.add(page.id);

    const inPage = new Set();
    for (const slot of page.slots || []) {
      if (!names.has(slot.at)) errors.push(`面板 "${page.id}" 的位置名 "${slot.at}" 没出现在 grid.areas 中`);
      if (seen.has(slot.at)) errors.push(`位置 "${slot.at}" 是常驻位置，不该出现在面板 "${page.id}" 的 slots 里`);
      if (inPage.has(slot.at)) errors.push(`面板 "${page.id}" 里位置 "${slot.at}" 重复声明`);
      inPage.add(slot.at);
    }
    for (const name of names) if (!seen.has(name) && !inPage.has(name)) errors.push(`面板 "${page.id}" 的区域 "${name}" 没有对应的 slot`);
  }
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

// 渲染层拼外壳要的那份 slots：常驻 + 当前面板
function effectiveSlots(layout, pageId) {
  const page = layout.pages.find((item) => item.id === pageId) || layout.pages[0];
  return [...layout.shared.filter((slot) => slot.enabled && slot.module), ...(page?.slots || []).filter((slot) => slot.enabled && slot.module)];
}

module.exports = { load, save, validate, normalize, effectiveSlots, DEFAULT_LAYOUT, LAYOUT_FILE };
