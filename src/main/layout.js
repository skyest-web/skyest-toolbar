const fs = require('node:fs');
const path = require('node:path');

const LAYOUT_FILE = 'layout.json';

// 可换位置表：面板之间不只「这几格放哪个组件」不同，面板还可以自带一份 grid（见 GAME_GRID），
// 所以这张表只是**位置名 → 人话标签**的字典，某页到底有哪几格由那页的 grid 决定。
const PAGE_AREAS = [
  { at: 'clock', label: '左上：时钟与主机信息' },
  { at: 'player', label: '左下：音乐播放器' },
  { at: 'gauges', label: '中部上：系统指标（固定高度）' },
  { at: 'workbench', label: '右上' },
  { at: 'slot1', label: '中下左：占位' },
  { at: 'slot2', label: '中下右：占位' },
  { at: 'gamezone', label: '中部整块：游戏列表' },
  { at: 'leftzone', label: '左侧整块：原 clock+player 合并' },
  { at: 'projzone', label: '左侧整块：项目列表（原 clock+player 合并）' },
  { at: 'gitzone', label: '中部整块：git 状态（原 slot1 + gauges 左半合并）' }
];

const SHARED_AT = ['topbar', 'clipboard', 'dock'];

// 常驻三块（顶栏 / 右侧竖条 / 底部通栏）在每张 grid 里都必须待在同一个格子，
// 面板自带的 grid 只能重排中间那些可换的格子。
const GRID_COLUMNS = ['330px', 'minmax(0, 1fr)', 'minmax(0, 1fr)', '400px'];
const GRID_ROWS = ['32px', '176px', 'minmax(150px, 1fr)', '78px'];

// 游戏面板自带的一份：中间 2 列 × 2 行合成一个大格，装 Steam 游戏 + 对应修改器
const GAME_GRID = {
  columns: GRID_COLUMNS,
  rows: GRID_ROWS,
  areas: [
    ['topbar', 'topbar', 'topbar', 'topbar'],
    ['clock', 'gamezone', 'gamezone', 'workbench'],
    ['player', 'gamezone', 'gamezone', 'clipboard'],
    ['dock', 'dock', 'dock', 'clipboard']
  ]
};

// 生活面板自带的一份：左列第 2、3 行（原本 clock 在上、player 在下）合成一格 leftzone 装邮箱。
// 中间那块逐字照全局——gauges 占第 2 行中间两列、slot1/slot2 占第 3 行，不跟着合。
const LIFE_GRID = {
  columns: GRID_COLUMNS,
  rows: GRID_ROWS,
  areas: [
    ['topbar', 'topbar', 'topbar', 'topbar'],
    ['leftzone', 'gauges', 'gauges', 'workbench'],
    ['leftzone', 'slot1', 'slot2', 'clipboard'],
    ['dock', 'dock', 'dock', 'clipboard']
  ]
};

// 工作面板自带的一份：左边两格（clock 在上、player 在下）合成 projzone 放项目列表，
// 中间第 2 列那两格（gauges 的左半 + slot1）合成 gitzone 放 git 状态——左边点一行，右边就是那个仓库。
// gauges 因此只占第 3 列第 2 行（它剩下的那一半），slot2 / workbench 照旧跟着全局。
const WORK_GRID = {
  columns: GRID_COLUMNS,
  rows: GRID_ROWS,
  areas: [
    ['topbar', 'topbar', 'topbar', 'topbar'],
    ['projzone', 'gitzone', 'gauges', 'workbench'],
    ['projzone', 'gitzone', 'slot2', 'clipboard'],
    ['dock', 'dock', 'dock', 'clipboard']
  ]
};

// 某个面板该有哪几格：它那一份 grid 里出现、且不属于常驻的那些
function slotsOfGrid(grid, modules = {}) {
  const pinned = new Set(SHARED_AT);
  const names = [...areaNames(grid)].filter((name) => !pinned.has(name));
  const labelOf = (at) => PAGE_AREAS.find((area) => area.at === at)?.label || at;
  return names.map((at) => ({ at, label: labelOf(at), module: modules[at] || 'placeholder', enabled: true }));
}

// 页签顺序由这张表决定（顶栏从左到右）。他点名的顺序：主界面 → 生活 → 工作 → 游戏，
// 生活/工作/游戏 同时按这个先后对应虚拟桌面 1/2/3（见 docs/virtual-desktop-follow.md）。
// desktop 写的是「第几个虚拟桌面」（1 起，跟任务视图从左到右一致），不写就是「切面板不动桌面」。
const DEFAULT_PAGES = [
  { id: 'home', name: '主界面', modules: { clock: 'clock', player: 'player', gauges: 'gauges', workbench: 'workbench' } },
  { id: 'life', name: '生活面板', grid: LIFE_GRID, modules: { leftzone: 'mail', gauges: 'photos', slot1: 'player', slot2: 'video' }, desktop: 1 },
  { id: 'work', name: '工作面板', desktop: 2, grid: WORK_GRID, modules: { projzone: 'projects', gitzone: 'git' } },
  { id: 'game', name: '游戏面板', grid: GAME_GRID, modules: { gamezone: 'games' }, desktop: 3 }
];

const BASE_GRID = {
  columns: GRID_COLUMNS,
  rows: GRID_ROWS,
  areas: [
    ['topbar', 'topbar', 'topbar', 'topbar'],
    ['clock', 'gauges', 'gauges', 'workbench'],
    ['player', 'slot1', 'slot2', 'clipboard'],
    ['dock', 'dock', 'dock', 'clipboard']
  ]
};

const DEFAULT_LAYOUT = {
  grid: BASE_GRID,
  shared: [
    { at: 'topbar', label: '顶栏（整行）', module: 'topbar', enabled: true },
    { at: 'clipboard', label: '右侧竖条', module: 'ai', enabled: true },
    { at: 'dock', label: '底部通栏', module: 'dock', enabled: true }
  ],
  pages: DEFAULT_PAGES.map((page) => ({
    id: page.id,
    name: page.name,
    ...(page.desktop ? { desktop: page.desktop } : {}),
    ...(page.grid ? { grid: page.grid } : {}),
    slots: slotsOfGrid(page.grid || BASE_GRID, page.modules)
  }))
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

// 面板自带 grid 的合并：以全局 grid 为底，raw 里写了什么覆盖什么（只写 areas 也够）。
// 没写 grid 的面板返回 null，表示「跟全局走」——落盘时也不写这个字段，别把默认形状抄进每一页。
function normalizePageGrid(rawGrid, globalGrid) {
  if (!rawGrid) return null;
  return { ...globalGrid, ...rawGrid };
}

// 一页该有哪些格子，由**这页自己的** grid 决定：常驻那几块剔掉，剩下的就是可换位置。
// 顺序跟 grid.areas 的行列走（行优先），所以游戏面板的大格 gamezone 会排在 clock 后面。
function normalizePage(page, index, globalGrid) {
  const grid = normalizePageGrid(page.grid, globalGrid);
  return {
    id: String(page.id || `page${index + 1}`),
    name: String(page.name || page.id || `面板 ${index + 1}`),
    // 原样留着（"first" / 0 / 1.5 都照抄），让 validate 去报错——静悄悄丢掉的话，
    // 他只会看到「点了这个面板桌面不动」，查不到是自己把这个字段写错了。
    ...(page.desktop === undefined || page.desktop === null ? {} : { desktop: page.desktop }),
    ...(grid ? { grid } : {}),
    slots: alignSlots(page.slots, slotsOfGrid(grid || globalGrid))
  };
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

  const pages = v1
    ? [
        normalizePage({ id: 'home', name: '主界面', slots: v1.filter((slot) => !shared.some((item) => item.at === slot.at)) }, 0, grid),
        ...DEFAULT_PAGES.slice(1).map((page) => ({
          id: page.id,
          name: page.name,
          ...(page.desktop ? { desktop: page.desktop } : {}),
          ...(page.grid ? { grid: normalizePageGrid(page.grid, grid) } : {}),
          slots: alignSlots(null, slotsOfGrid(page.grid || grid))
        }))
      ]
    : Array.isArray(raw.pages) && raw.pages.length
      ? raw.pages.map((page, index) => normalizePage(page, index, grid))
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

// 校验一份 grid 的自洽性，返回它包含的区域名
function validateGrid(grid, where, errors) {
  const { columns = [], rows = [], areas = [] } = grid || {};
  if (!columns.length || !rows.length) errors.push(`${where} 的 columns / rows 不能为空`);
  if (areas.length !== rows.length) errors.push(`${where}.areas 行数(${areas.length})与 rows(${rows.length})不一致`);
  for (const [rowIndex, row] of areas.entries()) {
    if (row.length !== columns.length) {
      errors.push(`${where}.areas[${rowIndex}] 有 ${row.length} 列，应为 ${columns.length} 列`);
    }
    for (const token of row) {
      if (token !== '.' && !/^[a-z][a-z0-9]*$/.test(token)) errors.push(`${where}.areas[${rowIndex}] 出现非法单元名 "${token}"`);
    }
  }
  return areaNames(grid);
}

function validate(layout) {
  const errors = [];
  const globalNames = validateGrid(layout.grid, 'grid', errors);

  const seen = new Set();
  for (const slot of layout.shared || []) {
    if (!globalNames.has(slot.at)) errors.push(`常驻位置名 "${slot.at}" 没出现在 grid.areas 中`);
    if (seen.has(slot.at)) errors.push(`常驻位置 "${slot.at}" 重复声明`);
    seen.add(slot.at);
  }

  if (!layout.pages?.length) errors.push('pages 至少要有一个面板');
  const ids = new Set();
  const desktopOwners = new Map();
  for (const page of layout.pages || []) {
    if (!page.id) errors.push('面板缺少 id');
    else if (ids.has(page.id)) errors.push(`面板 id "${page.id}" 重复`);
    ids.add(page.id);

    // 面板绑的桌面：1 起（跟任务视图从左到右一致），一个桌面只能有一个面板。
    // 重复了两边都抢同一块地，切面板/切桌面会互相打乒乓。
    if (page.desktop !== undefined) {
      if (!Number.isInteger(page.desktop) || page.desktop < 1) {
        errors.push(`面板 "${page.id}" 的 desktop 要是不小于 1 的整数（第几个虚拟桌面），实际是 ${JSON.stringify(page.desktop)}`);
      } else if (desktopOwners.has(page.desktop)) {
        errors.push(`面板 "${page.id}" 和 "${desktopOwners.get(page.desktop)}" 绑了同一个虚拟桌面 ${page.desktop}`);
      } else desktopOwners.set(page.desktop, page.id);
    }

    // 面板自带的 grid 只负责重排可换格子：行列必须跟全局一模一样，常驻那几块必须还在。
    // 不满足就是改错了骨架——切页时顶栏高度/右列宽度会跳，桌宠也找不到落脚的格子。
    let names = globalNames;
    if (page.grid) {
      names = validateGrid(page.grid, `面板 "${page.id}" 的 grid`, errors);
      const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
      if (!same(page.grid.columns, layout.grid?.columns)) errors.push(`面板 "${page.id}" 的 grid.columns 与全局不一致`);
      if (!same(page.grid.rows, layout.grid?.rows)) errors.push(`面板 "${page.id}" 的 grid.rows 与全局不一致`);
      for (const at of seen) if (!names.has(at)) errors.push(`常驻位置 "${at}" 没出现在面板 "${page.id}" 的 grid.areas 中`);
    }

    const inPage = new Set();
    for (const slot of page.slots || []) {
      if (!names.has(slot.at)) errors.push(`面板 "${page.id}" 的位置名 "${slot.at}" 没出现在其 grid.areas 中`);
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

// 面板 → 虚拟桌面（0-based，内部 API 用的就是这个）。没绑返回 null，表示切面板不动桌面。
function desktopOfPage(layout, pageId) {
  const desktop = layout.pages.find((item) => item.id === pageId)?.desktop;
  return Number.isInteger(desktop) && desktop >= 1 ? desktop - 1 : null;
}

// 虚拟桌面（0-based）→ 面板 id。没有面板绑在这个桌面上时返回 null，主进程据此保持当前面板。
function pageOfDesktop(layout, index) {
  return layout.pages.find((item) => item.desktop === index + 1)?.id || null;
}

module.exports = {
  load,
  save,
  validate,
  normalize,
  effectiveSlots,
  desktopOfPage,
  pageOfDesktop,
  DEFAULT_LAYOUT,
  LAYOUT_FILE
};
