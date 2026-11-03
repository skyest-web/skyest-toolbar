# 多面板（主界面 / 游戏 / 工作 / 生活）

一块 1920×550 的副屏要装下四种用法，靠的不是四个窗口，而是**同一副骨架 + 四套「格子里放什么」**。顶栏那排 tab（主界面 / 游戏面板 / 工作面板 / 生活面板）切的就是这个。

这一份讲机制和约定；每个组件本身怎么做，看它自己的文档（[ai-pet-panel.md](ai-pet-panel.md)、[everything-search.md](everything-search.md)、[voice-module.md](voice-module.md)、[dsh-panel.md](dsh-panel.md)）。

## 1. 三层模型

| 层 | 存哪 | 跨面板变不变 | 管什么 |
|---|---|---|---|
| `grid` | layout.json 顶层 | **不变**，全局一份 | 几行几列、每格多大、区域叫什么名 |
| `shared` | layout.json 顶层 | **不变**，只有一份 | 常驻位置放哪个组件：顶栏、右侧桌宠、底部快捷入口 |
| `pages[]` | layout.json 顶层 | 每页各一套 | 可换位置（`clock` / `gauges` / `workbench` / `player` / `slot1` / `slot2`）放哪个组件 |

**为什么 grid 不跟着面板变**：常驻那三块要「在哪个面板都在原地」，只有骨架不动才做得到；顺带 `dpi:measure` 那套按屏缩放率算尺寸的逻辑、以及所有容器查询的窄列变体都不用考虑第二套形状。代价是四个面板必须长成同一个格子图——想给某个面板换形状，得先把这条设计推翻。

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
    { "id": "game", "name": "游戏面板", "slots": [ ... ] },
    { "id": "work", "name": "工作面板", "slots": [ ... ] },
    { "id": "life", "name": "生活面板", "slots": [ ... ] }
  ]
}
```

- `pages[].id` 是稳定标识（tab 的 `data-page`、state.json 里记的就是它），`name` 只是显示用，随便改。
- 每个面板的 `slots` 必须**正好覆盖** grid 里那些非常驻区域：少一格、多一格、或者把 `topbar` 写进面板里，都会被 `validate()` 拒掉并整份退回默认布局（打印原因，不白屏）。
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
npm run layout:appprobe -- 9223 --shot   # 需先带 --remote-debugging-port=9223 起应用
```

它覆盖：四个 tab 的名字/顺序/高亮和配置一致；**逐个点 tab** 真能换页；常驻三格切页不许动；每页「配置里 enabled 的位置」和「DOM 上挂的组件」一一对上、且 DOM 不多挂；每格逐条量「内容高度 vs 位置高度」抓被 `overflow:hidden` 静默吃掉的溢出。每页存一张 `samples/layout-page-<id>.png`。

验完它会把当前面板切回原值（`activePage` 是要落盘的，别留在别的面板上）。
