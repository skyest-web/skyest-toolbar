// 布局（layout.json）的离线自检：不起应用，只喂 normalize / validate / effectiveSlots。
//
// 它盯的是「本面板自带骨架」这一层最容易悄悄坏掉的规矩：
// 1) 游戏面板那份 grid 必须把中间两列 × 中间两行合成一整块 gamezone，格子清单跟着变成 4 个；
// 2) 自带 grid 的面板行列数必须和全局一致，而且常驻位置（顶栏/右侧竖条/底部通栏）一个都不能少，
//    少了切过去就"顶栏没了"；
// 3) normalize 要能补齐只写 areas 的 grid、要幂等、要把老 v1 文件（顶层 slots、没有 pages）吃掉；
// 4) 引用的位置名不在自己 grid 里（比如还留着旧的 slot1）必须报错，而不是渲染出一块空白；
// 5) 磁盘上那份 layout.json 现读现验（手工改歪时 load() 会整份退回默认，画面「看起来什么都没变」）。
//
// 用法（Git Bash）: node tools/layout-check.js
const { normalize, validate, DEFAULT_LAYOUT, effectiveSlots, desktopOfPage, pageOfDesktop } = require('../src/main/layout');

const failures = [];
const expect = (label, cond) => {
  if (!cond) failures.push(label);
};
const slotNames = (page) => page.slots.map((slot) => slot.at).join(',');
const errorsMention = (errors, text) => errors.some((line) => line.includes(text));

// ---------- 默认版式自己得先站得住 ----------
expect('默认版式过不了校验', validate(structuredClone(DEFAULT_LAYOUT)).length === 0);
expect('默认版式该有 4 个面板', DEFAULT_LAYOUT.pages.length === 4);
// 页签顺序是他点名的：主界面 → 生活 → 工作 → 游戏（生活/工作/游戏 依次绑虚拟桌面 1/2/3）
expect(`默认页签顺序是 "${DEFAULT_LAYOUT.pages.map((page) => page.id).join(',')}"`, DEFAULT_LAYOUT.pages.map((page) => page.id).join(',') === 'home,life,work,game');

// ---------- 游戏面板自带的那份 grid ----------
const game = DEFAULT_LAYOUT.pages.find((page) => page.id === 'game');
expect('游戏面板没带自己的 grid', Boolean(game.grid));
// 常驻那三块（topbar/clipboard/dock）之外，本页位置该是 clock/gamezone/workbench/player 四个不重复的名字
const ownNames = new Set(game.grid.areas.flat().filter((token) => !['topbar', 'clipboard', 'dock'].includes(token)));
expect(`游戏面板 grid 里的本页位置有 ${ownNames.size} 个（该是 4 个）`, ownNames.size === 4);
expect(`游戏面板的格子清单是 "${slotNames(game)}"`, slotNames(game) === 'clock,gamezone,workbench,player');
expect('游戏面板 gamezone 该挂 games', game.slots.find((slot) => slot.at === 'gamezone').module === 'games');
expect('游戏面板每个格子都该有中文名（设置里那排下拉要显示它）', game.slots.every((slot) => slot.label));
// 中间那一大块：第 2、3 行的第 2、3 列全是 gamezone，这就是「三格合成一个」在 areas 里的写法
const middle = game.grid.areas.slice(1, 3).map((row) => row.slice(1, 3).join(' '));
expect(`gamezone 该铺满中间 2×2，实际是 ${JSON.stringify(middle)}`, middle.every((row) => row === 'gamezone gamezone'));

// ---------- 生活面板自带的那份 grid：左列两格合成一块装邮箱 ----------
const life = DEFAULT_LAYOUT.pages.find((page) => page.id === 'life');
expect('生活面板没带自己的 grid', Boolean(life.grid));
const lifeNames = new Set(life.grid.areas.flat().filter((token) => !['topbar', 'clipboard', 'dock'].includes(token)));
expect(`生活面板 grid 里的本页位置有 ${lifeNames.size} 个（该是 5 个）`, lifeNames.size === 5);
expect(`生活面板的格子清单是 "${slotNames(life)}"`, slotNames(life) === 'leftzone,gauges,workbench,slot1,slot2');
expect('生活面板 leftzone 该挂 mail', life.slots.find((slot) => slot.at === 'leftzone').module === 'mail');
expect('生活面板每个格子都该有中文名', life.slots.every((slot) => slot.label));
// 左列那一大块：第 2、3 行的第 1 列全是 leftzone，这就是「clock+player 合成一格」在 areas 里的写法
const left = life.grid.areas.slice(1, 3).map((row) => row[0]);
expect(`leftzone 该铺满左列两行，实际是 ${JSON.stringify(left)}`, left.every((token) => token === 'leftzone'));
// 他要的「中间不要变动」：中间那块必须和全局骨架逐字一样，别顺手把三格也合了
const lifeMiddle = life.grid.areas.slice(1, 3).map((row) => row.slice(1, 3).join(' '));
const baseMiddle = DEFAULT_LAYOUT.grid.areas.slice(1, 3).map((row) => row.slice(1, 3).join(' '));
expect(`生活面板中间三格被改动了：${JSON.stringify(lifeMiddle)} ≠ ${JSON.stringify(baseMiddle)}`, JSON.stringify(lifeMiddle) === JSON.stringify(baseMiddle));

// ---------- 工作面板自带的那份 grid：左列合成 projzone，中间两列各合成 gitzone / officezone ----------
const work = DEFAULT_LAYOUT.pages.find((page) => page.id === 'work');
expect('工作面板没带自己的 grid', Boolean(work.grid));
const workNames = new Set(work.grid.areas.flat().filter((token) => !['topbar', 'clipboard', 'dock'].includes(token)));
expect(`工作面板 grid 里的本页位置有 ${workNames.size} 个（该是 4 个）`, workNames.size === 4);
expect(`工作面板的格子清单是 "${slotNames(work)}"`, slotNames(work) === 'projzone,gitzone,officezone,workbench');
expect('工作面板 projzone 该挂 projects', work.slots.find((slot) => slot.at === 'projzone').module === 'projects');
expect('工作面板 gitzone 该挂 git', work.slots.find((slot) => slot.at === 'gitzone').module === 'git');
expect('工作面板 officezone 该挂 office', work.slots.find((slot) => slot.at === 'officezone').module === 'office');
expect(`工作面板 workbench 该挂 clipboard（剪贴板历史），实际是 "${work.slots.find((slot) => slot.at === 'workbench').module}"`,
  work.slots.find((slot) => slot.at === 'workbench').module === 'clipboard');
expect('工作面板每个格子都该有中文名', work.slots.every((slot) => slot.label));
// 左边那一大块：第 2、3 行的第 1 列全是 projzone（原 clock + player）
const workLeft = work.grid.areas.slice(1, 3).map((row) => row[0]);
expect(`projzone 该铺满左列两行，实际是 ${JSON.stringify(workLeft)}`, workLeft.every((token) => token === 'projzone'));
// 中间那一大块：第 2、3 行的第 2 列全是 gitzone——这就是「slot1 + gauges 的左半」合成一格的写法
const workMid = work.grid.areas.slice(1, 3).map((row) => row[1]);
expect(`gitzone 该铺满第 2 列两行，实际是 ${JSON.stringify(workMid)}`, workMid.every((token) => token === 'gitzone'));
// 第 3 列同理：gauges 的右半 + slot2 合成一整块 officezone，两行都得是它，不能再被行高切成上下两截
const workOffice = work.grid.areas.slice(1, 3).map((row) => row[2]);
expect(`officezone 该铺满第 3 列两行，实际是 ${JSON.stringify(workOffice)}`, workOffice.every((token) => token === 'officezone'));
// 第 4 列（workbench / clipboard）必须和全局逐字一样，常驻位不能被合掉
const workRight = work.grid.areas.slice(1, 3).map((row) => row[3]);
const baseRight = DEFAULT_LAYOUT.grid.areas.slice(1, 3).map((row) => row[3]);
expect(`工作面板第 4 列被改动了：${JSON.stringify(workRight)} ≠ ${JSON.stringify(baseRight)}`, JSON.stringify(workRight) === JSON.stringify(baseRight));

// ---------- 磁盘上那份 layout.json（跟着 git 走的那份才是权威） ----------
// 上面各段喂的都是 DEFAULT_LAYOUT 这个内存对象；真正的风险是有人手工编辑磁盘那份、
// 把 areas 和 slots 写歪了。load() 校验不过会**整份退回默认布局**，症状是「改了个合并格，
// 画面看起来什么都没变」——所以这里必须现读现验一遍，光验内存那份是自证。
const fs = require('node:fs');
const path = require('node:path');
const layoutStore = require('../src/main/layout');
const APP_ROOT = path.resolve(__dirname, '..');
expect('仓库里根本没有 layout.json（落位全靠它）', fs.existsSync(path.join(APP_ROOT, 'layout.json')));
const disk = layoutStore.load(APP_ROOT);
expect(`磁盘那份读进来过不了校验：${layoutStore.validate(structuredClone(disk)).join(' / ')}`, layoutStore.validate(structuredClone(disk)).length === 0);
const diskWork = disk.pages.find((page) => page.id === 'work');
expect(`磁盘那份工作面板格子清单是 "${diskWork.slots.map((slot) => slot.at).join(',')}"，应为 projzone,gitzone,officezone,workbench`,
  diskWork.slots.map((slot) => slot.at).join(',') === 'projzone,gitzone,officezone,workbench');
expect(`磁盘那份 officezone 没挂 office：${diskWork.slots.find((slot) => slot.at === 'officezone')?.module}`,
  diskWork.slots.find((slot) => slot.at === 'officezone')?.module === 'office');
expect(`磁盘那份 workbench 没挂 clipboard：${diskWork.slots.find((slot) => slot.at === 'workbench')?.module}`,
  diskWork.slots.find((slot) => slot.at === 'workbench')?.module === 'clipboard');
const diskOffice = diskWork.grid.areas.slice(1, 3).map((row) => row[2]);
expect(`磁盘那份的第 3 列两行不是同一块：${JSON.stringify(diskOffice)}（areas 写歪一格，validate 就该拒，而不是静默退回默认）`,
  diskOffice.every((token) => token === 'officezone'));
// 合掉的格子不许在 areas 里露面：露面了 slots 就少一格，load() 会整份退回默认
expect(`磁盘那份工作面板的 areas 里还留着被合掉的位置：${JSON.stringify(diskWork.grid.areas.flat())}`,
  !['slot1', 'slot2', 'gauges', 'clock', 'player'].some((token) => diskWork.grid.areas.flat().includes(token)));

// ---------- 没自带 grid 的面板仍跟全局骨架走 ----------
for (const page of DEFAULT_LAYOUT.pages.filter((item) => !item.grid)) {
  expect(`面板 "${page.id}" 不该自带 grid，且仍是 6 个可换位置`, page.slots.length === 6);
}
expect(`自带 grid 的面板不止 life、work、game 这三个（实际是 ${DEFAULT_LAYOUT.pages.filter((item) => item.grid).map((item) => item.id).join(',')}）`,
  DEFAULT_LAYOUT.pages.filter((item) => item.grid).map((item) => item.id).join(',') === 'life,work,game');

// ---------- normalize：只写 areas 也补齐行列，空面板填占位 ----------
const raw = {
  grid: DEFAULT_LAYOUT.grid,
  shared: DEFAULT_LAYOUT.shared,
  pages: [
    { id: 'home', name: '主界面', slots: DEFAULT_LAYOUT.pages[0].slots },
    { id: 'game', name: '游戏面板', grid: { areas: game.grid.areas } },
    { id: 'work', name: '工作面板' }
  ]
};
const n = normalize(raw);
expect('normalize 把面板自带的 grid 弄丢了', Boolean(n.pages[1].grid) && n.pages[1].grid.columns.length === 4);
expect('normalize 没给自带 grid 补上行（只写了 areas）', n.pages[1].grid.rows.length === 4);
expect('normalize 没把行列数从全局继承过来（rows 该是补出来的，不是顶层的）', n.pages[1].rows === undefined);
expect('normalize 没给空面板填占位格子', n.pages[2].slots.every((slot) => slot.module === 'placeholder' || slot.module === ''));
expect(`normalize 给游戏面板生成的格子清单是 "${slotNames(n.pages[1])}"`, slotNames(n.pages[1]) === 'clock,gamezone,workbench,player');
expect('normalize 的结果过不了校验', validate(n).length === 0);
expect('normalize 不幂等（第二次跑改了结果，写盘会来回漂）', JSON.stringify(normalize(n)) === JSON.stringify(n));

// ---------- validate：三种该拒绝的写法 ----------
const badColumns = structuredClone(n);
badColumns.pages[1].grid.columns = ['1px'];
expect('面板自带 grid 的列数和全局不一致却没报错', errorsMention(validate(badColumns), 'columns 与全局不一致'));

const badShared = structuredClone(n);
badShared.pages[1].grid.areas = [
  ['topbar', 'topbar', 'topbar', 'topbar'],
  ['clock', 'gamezone', 'gamezone', 'workbench'],
  ['player', 'gamezone', 'gamezone', 'workbench2'],
  ['dock', 'dock', 'dock', 'dock']
];
const sharedErrors = validate(badShared);
expect('面板自带 grid 少了常驻位置 clipboard 却没报错', errorsMention(sharedErrors, '常驻位置 "clipboard" 没出现在面板 "game"'));
expect('格子引用了 grid 里没有的位置名却没报错', errorsMention(sharedErrors, 'workbench2'));

const badStale = structuredClone(n);
badStale.pages[1].slots.push({ at: 'slot1', label: '旧格子', module: 'steam', enabled: true });
expect('游戏面板还留着旧的 slot1 位置却没报错', errorsMention(validate(badStale), '位置名 "slot1" 没出现在其 grid.areas 中'));

// ---------- effectiveSlots：常驻 3 块 + 本页格子 ----------
expect(`游戏面板该有 7 个位置（3 常驻 + 4 本页），实际 ${effectiveSlots(n, 'game').length}`, effectiveSlots(n, 'game').length === 7);
expect(`主界面该有 9 个位置（3 常驻 + 6 本页），实际 ${effectiveSlots(n, 'home').length}`, effectiveSlots(n, 'home').length === 9);

// ---------- 老版式（v1：顶层 slots、没有 pages）还得吃得下 ----------
const v1 = {
  slots: [
    { at: 'topbar', module: 'topbar' },
    { at: 'clock', module: 'clock' },
    { at: 'gauges', module: 'gauges' },
    { at: 'workbench', module: 'workbench' },
    { at: 'player', module: 'player' },
    { at: 'clipboard', module: 'ai' },
    { at: 'dock', module: 'dock' }
  ]
};
const old = normalize(v1);
expect(`v1 升级后主界面格子清单是 "${slotNames(old.pages[0])}"`, slotNames(old.pages[0]) === 'clock,gauges,workbench,player,slot1,slot2');
expect('v1 升级把用户选的组件弄丢了（gauges 该还是 gauges）', old.pages[0].slots.find((slot) => slot.at === 'gauges').module === 'gauges');
expect('v1 升级后游戏面板没带上自带 grid', Boolean(old.pages.find((page) => page.id === 'game').grid));
expect(`v1 升级后的页签顺序是 "${old.pages.map((page) => page.id).join(',')}"`, old.pages.map((page) => page.id).join(',') === 'home,life,work,game');
expect('v1 升级结果过不了校验', validate(old).length === 0);
expect('v1 升级把用户在 clipboard 上选的 ai 弄丢了', old.shared.find((slot) => slot.at === 'clipboard').module === 'ai');

// ---------- 面板 ↔ 虚拟桌面：绑哪一块、怎么反查 ----------
expect(`默认绑定是 "${DEFAULT_LAYOUT.pages.map((page) => `${page.id}:${page.desktop || '-'}`).join(' ')}"`,
  DEFAULT_LAYOUT.pages.map((page) => `${page.id}:${page.desktop || '-'}`).join(' ') === 'home:- life:1 work:2 game:3');
// 给主进程用的两个换算：layout.json 写的是「第几个桌面」（1 起），内部 API 要 0-based
expect('life 该换算成桌面 0（0-based）', desktopOfPage(DEFAULT_LAYOUT, 'life') === 0);
expect('game 该换算成桌面 2（0-based）', desktopOfPage(DEFAULT_LAYOUT, 'game') === 2);
expect('home 没绑桌面，切过去不该动桌面', desktopOfPage(DEFAULT_LAYOUT, 'home') === null);
expect('未知面板 id 换算成 null 而不是崩', desktopOfPage(DEFAULT_LAYOUT, 'nope') === null);
expect(`桌面 1 该反查到 work，实际 ${pageOfDesktop(DEFAULT_LAYOUT, 1)}`, pageOfDesktop(DEFAULT_LAYOUT, 1) === 'work');
expect('没有面板绑的桌面该反查回 null（切到那儿保持当前面板）', pageOfDesktop(DEFAULT_LAYOUT, 9) === null);

// normalize 要把 desktop 带过去：丢了就等于「切面板不动桌面」，而且没有任何提示
const withDesktop = normalize(structuredClone(DEFAULT_LAYOUT));
expect('normalize 把面板绑的桌面弄丢了', withDesktop.pages.find((page) => page.id === 'life').desktop === 1);
expect('normalize 不该给没绑桌面的面板造出一个 desktop', withDesktop.pages.find((page) => page.id === 'home').desktop === undefined);
expect('normalize 后仍过不了校验（说明 desktop 的写法自己不自洽）', validate(withDesktop).length === 0);
expect('normalize 不幂等（desktop 那条来回漂）', JSON.stringify(normalize(withDesktop)) === JSON.stringify(withDesktop));

const noDesktop = normalize({ grid: DEFAULT_LAYOUT.grid, shared: DEFAULT_LAYOUT.shared, pages: [{ id: 'x', name: '无绑面板' }] });
expect(`没写 desktop 的面板被造出了值：${JSON.stringify(noDesktop.pages[0].desktop)}`, noDesktop.pages[0].desktop === undefined);

// 手写错的 desktop 必须报错（退回默认布局是响亮的，静悄悄丢掉是查不出来的）
const dupDesktop = structuredClone(withDesktop);
dupDesktop.pages.find((page) => page.id === 'game').desktop = 1;
expect('两个面板绑同一个桌面却没报错', errorsMention(validate(dupDesktop), '绑了同一个虚拟桌面 1'));

const zeroDesktop = structuredClone(withDesktop);
zeroDesktop.pages.find((page) => page.id === 'work').desktop = 0;
expect('desktop 写 0 却没报错', errorsMention(validate(zeroDesktop), '面板 "work" 的 desktop 要是不小于 1 的整数'));

const textDesktop = structuredClone(withDesktop);
textDesktop.pages.find((page) => page.id === 'work').desktop = 'first';
expect('desktop 写成字符串却没报错', errorsMention(validate(textDesktop), '"first"'));

if (failures.length) {
  for (const line of failures) console.log(`✗ ${line}`);
  process.exitCode = 1;
  return;
}
console.log(`✓ 布局自检全绿：游戏面板自带 grid（中间 2×2 合成 gamezone、4 个位置）、生活面板自带 grid（左列 2 行合成 leftzone 挂 mail、中间三格与全局逐字一样）、工作面板自带 grid（左列 projzone / 中列 gitzone / 第 3 列 officezone 各吃两行，4 个位置）、磁盘那份 layout.json 现读现过校验（工作面板四格、第 3 列两行同一块、合掉的位置没在 areas 里露面）、其余面板仍用全局骨架、行列不一致/丢常驻位/残留旧位置名都能报错、normalize 幂等、v1 老文件吃得下`);
