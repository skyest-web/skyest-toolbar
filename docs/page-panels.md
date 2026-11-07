# 多面板（主界面 / 游戏 / 工作 / 生活）

一块 1920×550 的副屏要装下四种用法，靠的不是四个窗口，而是**同一副骨架 + 四套「格子里放什么」**。顶栏那排 tab（主界面 / 游戏面板 / 工作面板 / 生活面板）切的就是这个。

这一份讲机制和约定；每个组件本身怎么做，看它自己的文档（[ai-pet-panel.md](ai-pet-panel.md)、[everything-search.md](everything-search.md)、[voice-module.md](voice-module.md)、[dsh-panel.md](dsh-panel.md)）。

## 1. 三层模型

| 层 | 存哪 | 跨面板变不变 | 管什么 |
|---|---|---|---|
| `grid` | layout.json 顶层（面板可选自带一份覆盖） | 行列与常驻位置**不变**，只有区域合并跟着面板走 | 几行几列、每格多大、区域叫什么名 |
| `shared` | layout.json 顶层 | **不变**，只有一份 | 常驻位置放哪个组件：顶栏、右侧桌宠、底部快捷入口 |
| `pages[]` | layout.json 顶层 | 每页各一套 | 这一页的可换位置（主界面是全局骨架的 `clock` / `gauges` / `workbench` / `player` / `slot1` / `slot2`；生活面板是 `leftzone` + 中间那几格；工作面板是 `projzone` / `gitzone` / `gauges` / `workbench` / `slot2`；游戏面板是 `clock` / `gamezone` / `workbench` / `player`）放哪个组件 |

**为什么 `grid` 默认只有一份**：常驻那三块要「在哪个面板都在原地」，只有骨架不动才做得到；顺带 `dpi:measure` 那套按屏缩放率算尺寸的逻辑、以及所有容器查询的窄列变体都不用考虑第二套形状。

**后来加的那层例外**：面板可以自带一份 `grid` 覆盖全局的。现在用它的有三块——游戏面板把中间 2×2 合成 `gamezone` 放游戏列表（见 [game-list-panel.md](game-list-panel.md)）、生活面板把左列两行合成 `leftzone` 放邮箱（`LIFE_GRID`，`layout.js:42`）、工作面板把左列两行合成 `projzone` 放项目、第 2 列两行合成 `gitzone` 放 git 状态（`WORK_GRID`，`layout.js:56`，见 [projects-panel.md](projects-panel.md) / [git-panel.md](git-panel.md)）。例外被三条规矩框住，`validate()` 逐条拒：① 列数、行数必须等于全局；② `shared` 里那几个常驻位置必须出现在这一页的 `areas` 里；③ 这一页的 `slots` 只能引用自己 `areas` 里的名字（还留着旧的 `slot1` 直接报错）。这样「常驻块在原地」和「容器查询的窄列」都不用感知第二套形状——列宽和行数根本没变，变的只是区域怎么合并。没带 `grid` 的面板照旧吃全局那份。

**自带 grid 的那一块必须同时改两份**：磁盘上的 `layout.json` 是权威，`layout.js` 的 `DEFAULT_PAGES`（`grid` + `modules`）是兜底，两份逐字一样。而且 `layoutStore.load()` 校验不过会**整份退回默认布局**——只改磁盘那份、改出个校验不过的形状，画面看起来「什么都没变」，实际是被静默回滚了。

**为什么 `shared` 单独一层而不是每页各写一遍**：写一遍意味着改一处要改四处，且四份一旦漂移就没有「常驻」可言了。校验器直接拒绝面板里出现常驻位置名。

## 2. layout.json 的形状

```jsonc
{
  "grid": { "columns": [...], "rows": [...], "areas": [[...]] },
  "shared": [
    { "at": "topbar",    "label": "顶栏（整行）", "module": "topbar", "enabled": true },
    { "at": "clipboard", "label": "右侧竖条",     "module": "ai",     "enabled": true },
    { "at": "dock",      "label": "底部通栏",     "module": "dock",   "enabled": true }
  ],
  "pages": [
    { "id": "home", "name": "主界面", "slots": [ { "at": "clock", "module": "clock", "enabled": true }, ... ] },
    { "id": "game", "name": "游戏面板",
      "grid": { "columns": [...], "rows": [...], "areas": [["topbar","topbar","topbar","topbar"], ["clock","gamezone","gamezone","workbench"], ["player","gamezone","gamezone","clipboard"], ["dock","dock","dock","clipboard"]] },
      "slots": [ ... ] },
    { "id": "work", "name": "工作面板", "desktop": 2,
      "grid": { "columns": [...], "rows": [...], "areas": [["topbar","topbar","topbar","topbar"], ["projzone","gitzone","gauges","workbench"], ["projzone","gitzone","slot2","clipboard"], ["dock","dock","dock","clipboard"]] },
      "slots": [ { "at": "projzone", "module": "projects" }, { "at": "gitzone", "module": "git" }, ... ] },
    { "id": "life", "name": "生活面板", "slots": [ ... ] }
  ]
}
```

- `pages[].grid` **可选**：写了就用它画这一页（行列数必须和全局一致、常驻位置都在 `areas` 里），没写就吃全局那份。
- `pages[].id` 是稳定标识（tab 的 `data-page`、state.json 里记的就是它），`name` 只是显示用，随便改。
- 每个面板的 `slots` 必须**正好覆盖**它自己那份 grid（没带就用全局）里的非常驻区域：少一格、多一格、或者把 `topbar` 写进面板里，都会被 `validate()` 拒掉并整份退回默认布局（打印原因，不白屏）。
- 区域名仍然只允许 `/^[a-z][a-z0-9]*$/`，**不能带连字符**。

## 3. 当前面板存哪：state.json，不是 layout.json

`layout.json` 跟着 git 走，切面板是运行时行为——存它里面等于每次点击都脏一次工作区。所以当前面板 id 走 [src/main/services/store.js](../src/main/services/store.js) 的 `activePage`，落在 userData 的 `state.json`。

链路：渲染层 `TB.app.setPage(id)` → `TB.api.layout.setPage` → `ipcMain('page:set')`。**主进程只认 layout 里真的存在的 id**，陌生 id 直接忽略并返回 `{ok:false}`——不然旧 state.json 里存着一个已被删掉的面板，下次启动就会空一半。

## 4. 切面板时发生了什么

`setPage()` 只改 `state.page` 然后 `buildShell()` 整体重建外壳（[src/renderer/js/app.js](../src/renderer/js/app.js)）。重建是既有路径——存布局、存配置本来就走它，所以组件早就被要求能扛住 DOM 消失：

- **音乐不会断**：`<audio>` 挂在 `<body>` 上，不在格子里（[components/player.js](../src/renderer/js/components/player.js) 的 `ensureAudio()`）。
- **搜索栏不丢字**：`topbar.init()` 每次调 `TB.search.attachBar()` 重新认领新节点，关键词从 `TB.search.query` 还原。
- **桌宠对话不丢**：历史在 `TB.app.state.ai`，重建后从 state 重画。
- **快捷入口不空白**：`dock.init()` 里把 `signature` 置 null，否则缓存命中、列表一直空。
- **项目格的选中态不丢**：选中的是哪条项目在 `TB.app.state.project`（存整条行，见 [git-panel.md](git-panel.md) §2），不在那一行的 DOM 上；重建以后 `render()` 补一次 `.sel`，中间那格也还演同一个项目。

新增组件时这条同样适用：**组件自己不能持有「只有 DOM 里才有」的状态**，要放 `TB.app.state` 或主进程。

## 5. 填内容：在「组件与位置」里按面板配

顶栏「组件」（Ctrl+L）打开面板，顶部一排页签选**要编辑哪个面板**，然后：

| 卡片 | 改了什么 |
|---|---|
| 本面板位置 | 只有当前这个面板的格子 |
| 常驻位置 | 所有面板共用，改一处四处都变 |
| 可用组件 | 当前画面上没被用到的组件 |

- 换组件时两个位置**自动对调**，格子数量不变。
- **选「空白占位」不对调**：它是「清空」的意思，跟它对调会把别的格子无辜卷走一个组件。
- 同一个组件可以出现在不同面板（同一时刻只有一页在渲染），但**在同一面板 + 常驻这个范围内不能重复**——一个组件挂两个位置时只有最后一个拿得到刷新。
- 面板数量与名字是固定的四个；要加第五个，改 [src/main/layout.js](../src/main/layout.js) 的 `DEFAULT_PAGES`，或直接在 layout.json 的 `pages` 里加一段（校验只要求 id 唯一、位置覆盖齐全）。

## 6. v1 老文件怎么升上来

v1 是顶层一份 `slots`（更早是 `modules`）。`normalize()` 在加载时自动迁移，不用手工转换：

1. 常驻那三格从 v1 的 slots 里**按原值**抽进 `shared`——用户把右侧竖条换成过别的组件，不会被出厂默认盖掉；
2. 其余格子整体归进「主界面」；
3. 另外三个面板补成全是 `placeholder` 的空白页；
4. 下次在面板里点保存，文件就落成 v2 形状。

## 7. 改完跑什么

```bash
npm run layout:check                       # 离线：normalize / validate / effectiveSlots，不碰应用
npm run layout:appprobe -- 9223 --shot     # 真机：需先带 --remote-debugging-port=9223 起应用
```

`layout:check` 盯规则本身：三份自带 grid 各自的写法与格子清单（游戏 `clock,gamezone,workbench,player`、生活 `leftzone,gauges,workbench,slot1,slot2`、工作 `projzone,gitzone,gauges,workbench,slot2`）、合并的那一大块要铺满对应的行×列、工作面板的 `gauges` 不许还占着第 2 列、其余区域逐字等于全局（「中间那块没变动」是可量的）、行列数不一致 / 丢常驻位置 / 引用自己 grid 里没有的位置名都要报错、`normalize()` 幂等、v1 老文件还能升级。

`layout:appprobe` 先回到主界面量「全局那份骨架」的形状，再**逐个点 tab**：四个 tab 的名字/顺序/高亮和配置一致；常驻三格切页不许动；每页「配置里 enabled 的位置」和「DOM 上挂的组件」一一对上、且 DOM 不多挂；自带 grid 的面板那份 `areas` 必须真挂到外壳上。三块面板各拿主界面那次测量当尺子重算合并（探针里不写死像素）：`gamezone` = 中间两列 + 列间距 × 中间两行 + 行间距、`leftzone` = 左列两格通高、`projzone` = 左列两格通高、`gitzone` 从 `gauges` 的左上角起笔、宽等于 `slot1`、高和左列那块一样（左右两块必须同顶同底），并且旧位置（`slot1` / `clock` / `player`）在合并掉它的那一页**查不到**。每格逐条量「内容高度 vs 位置高度」抓被 `overflow:hidden` 静默吃掉的溢出。每页存一张 `samples/layout-page-<id>.png`。

点 tab 这一步有个自己的坑：上一趟切换留下的外壳重建会把刚查到的节点换掉，点在已经脱离文档的旧节点上不报错但没作用，于是出现「切到 game 却读到 life」。所以现在点完读一次 `TB.app.state.page`，不对就再点一次（`clickTab()`）。

验完它会把当前面板切回原值（`activePage` 是要落盘的，别留在别的面板上）。
