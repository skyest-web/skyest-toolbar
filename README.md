# 1920×540 副屏满屏工具栏

给三屏里的第三条屏（ASUS PA147，Windows 实际报 1920×550）做的独立 Electron 工具栏：无边框、精确铺满该屏、不参与其他屏幕的窗口管理。

运行时零第三方依赖，只用 Electron + Node 内置模块 + `nvidia-smi` + PowerShell 取数。

## 快速开始

```powershell
cd D:\GitProject\toolbar
npm install
npm start
```

开发调试（自动打开 DevTools）：`npm run dev`

只查看系统识别到的屏幕：`npm run displays`

没有本地音乐时先生成演示曲库：`npm run demo`，然后把 `toolbar.config.json` 的 `music.folder` 指向 `D:\GitProject\toolbar\samples\demo`。

## 界面分区

```
grid.areas：4 列 × 4 行（左列 330px · 中间两列各 1fr · 右列 400px）
          330px 左          中左 1fr            中右 1fr          400px 右
32px      topbar ───────────────── 整行合并（搜索栏就住在这里）─────────────────
176px     clock                   gauges ─────── 跨两列 ───────   workbench
1fr       player                  slot1（占位）   slot2（占位）     clipboard
78px      dock ───────────── 跨三列 ─────────                     clipboard（续）
```

左列是「时钟与主机信息」在上、「音乐播放器」在下；播放器落在 330px 窄列里会自动切成紧凑排布（控制键两行、曲库占满宽、歌词只留一行字幕）。中间下排的两格 `slot1` / `slot2` 现在是虚线占位，等以后放新组件；指标那一行是固定 176px，窗口再高也不会被拉伸。

- **顶栏**：常驻搜索栏（Everything 全盘文件名，Ctrl+F 聚焦，结果下拉挂在它下面）+ 定位信息 + 「组件」（组件与位置面板，Ctrl+L）+ 「设置」（Ctrl+,）+ 「退出」。
- **文件搜索**：搜索栏在顶栏中间，输入文件名片段即出结果，回车用默认程序打开，↑↓ 选择、Esc 收起、点外面收起。索引由项目自带的便携版 Everything 做（`vendor/everything/`，普通权限、不出网），查询跑在独立工作进程里。详见 [docs/everything-search.md](docs/everything-search.md)。
- **指标**：CPU、内存走 Node `os`；GPU 走 `nvidia-smi`（温度、占用、显存、功耗、风扇、核心频率）；网络速率与 Top 进程走 PowerShell `Get-NetAdapterStatistics` / `Get-Process`；磁盘走 `fs.statfs`。快慢两档轮询，避免每 1.5 秒起一次 PowerShell 进程。整块高度锁在 `grid.rows` 第二行（176px），`.gauge-row` 另有 `max-height` 兜底，换到更高的位置也只会留白、不会被拉长。
- **剪贴板历史**：只存在内存，退出即清空，密码类内容不会落盘。点击条目重新复制。
- **分类导航**：dock 按 `category` 聚成分类，每个分类平时是一条窄标签；点某个分类，它原地向右展宽铺开该分类的条目，其他分类同时收回（同 Element-UI `el-collapse` 的 `accordion`，方向从左到右），见下面「分类导航」。行尾的 ＋ 打开表单式管理面板，增删改入口和分类都不用手写 JSON。
- **音乐播放器**：扫描 `music.folder`（含子目录，最深 4 层）里的 mp3 / flac / m4a / wav / ogg / opus / wma，文件名按 `序号 - 歌手 - 曲名` 自动拆分；同名同目录的 `.lrc` 会同步滚动高亮；底部频谱用 WebAudio `AnalyserNode` 实时绘制。空格键播放 / 暂停；当前曲目、进度、音量、循环与随机方式记在 `state.json`。换曲库不用进设置：播放器标题栏右侧的 📁 会弹原生文件夹选择框，选完写回 `toolbar.config.json` 并立刻重扫。宽度 ≤420px 时（现在的左列）走 CSS 容器查询的紧凑版：控制键与音量分两行、曲库占满宽、歌词压成一行字幕、频谱降到 22px。

## 组件与位置

界面由两层拼成：**位置（slot）** 固定，**组件（component）** 可换。位置就是 `layout.json` 里 `grid.areas` 画出来的那 9 个格子；每个格子里放哪个组件、放不放，由 `slots` 决定。顶栏「组件」按钮（或 Ctrl+L、设置页里的入口）打开面板：一行一个位置，左边是位置名，中间下拉选组件，右边「显示」开关。

- 把某个位置换成另一个已经在别处的组件时，**两个位置的组件自动对调**，格子数量不变，不会出现同一个组件被放到两处。
- 取消「显示」→ 该位置在 `gridTemplateAreas` 里变成 `.`，区域留空，其他位置不动。
- 下拉里选「（空着不显示）」= 把这个位置清空，组件退回右侧「可用组件」池子。
- 点「保存并应用」写回 `layout.json` 并立刻重建界面，不用重启；「恢复默认」把 slots 还原成出厂配置。

```jsonc
{
  "grid": {
    "columns": ["330px", "minmax(0, 1fr)", "minmax(0, 1fr)", "400px"],   // CSS grid-template-columns
    "rows": ["32px", "176px", "minmax(150px, 1fr)", "78px"],             // 第二行是定值：指标卡的高度就锁在这里
    "areas": [                                                          // 每行是一个数组，长度必须等于列数
      ["topbar", "topbar", "topbar", "topbar"],
      ["clock", "gauges", "gauges", "workbench"],
      ["player", "slot1", "slot2", "clipboard"],
      ["dock", "dock", "dock", "clipboard"]
    ]
  },
  "slots": [
    { "at": "topbar", "label": "顶栏（整行）", "module": "topbar", "enabled": true },
    { "at": "clock", "label": "左上：时钟与主机信息", "module": "clock", "enabled": true },
    { "at": "player", "label": "左下：音乐播放器", "module": "player", "enabled": true }
    // gauges / workbench / slot1 / slot2 / clipboard / dock ...
  ]
}
```

- `at` 必须是 `areas` 里出现过的区域名，且不能重复；`areas` 里每个区域都得有一个 slot。校验不过会打印原因并退回默认布局，不会白屏。
- 区域名只允许 `/^[a-z][a-z0-9]*$/`：**不能带连字符**，所以占位格叫 `slot1` / `slot2` 而不是 `slot-a`。
- 想让某个位置跨行/跨列，就把它的名字在相邻格子里重复写（示例里 `gauges` 横跨两列、`clipboard` 竖跨两行）。
- `slot1` / `slot2` 现在挂的是内置的 `placeholder`（虚线框 + 位置名），想放真组件时在面板里把这一行的下拉换掉即可。
- 老版本的 `modules: [{id, name, enabled}]` 仍然能读：加载时自动按「id 既是位置又是组件」迁移成 `slots`，下次保存就变成新格式。
- 位置尺寸是固定的，把宽组件塞进窄格子（比如把指标卡放进左列）会挤成一列，属于预期行为——换完看一眼，不合适就换回来。跑 `npm run layout:appprobe` 会量一遍每个格子有没有被裁。

## 加一个新组件

组件是 drop-in 的，不需要改 `index.html`、不需要注册表、不需要构建步骤：

1. 往 `src/renderer/js/components/` 放一个 `.js`（文件名任意，建议小写短名）。
2. 文件末尾调一次 `TB.register()`：

```js
TB.myThing = {
  init(root) { root.innerHTML = ''; /* 建 DOM、挂事件 */ },
  update(state) { /* state 里有 config / tasks / notes / player / clipboard / fast / full / placement */ }
};

TB.register({
  id: 'mything',            // layout.json 的 slots.module 用它引用
  name: '我的组件',          // 「组件与位置」面板里显示的名字
  cls: 'area',              // 外层 <section> 的 class，样式写在 styles.css
  build: () => TB.util.el('div', { id: 'mything' }), // 返回自己的 DOM
  init: (node) => TB.myThing.init(node),
  update: (state) => TB.myThing.update(state)
});
```

3. 重启工具栏（`npm start`），它会自动出现在面板的「可用组件」里；挑个位置放下、保存即可。

启动时 `src/renderer/js/loader.js` 先问主进程要 `components/` 目录的文件清单，逐个 `<script>` 注入（CSP 是 `script-src 'self'`，同源文件允许），全部加载完才 `TB.app.boot()`。数据流靠 IPC：需要新能力就在 `src/preload/preload.js` 加一个方法、在 `src/main/main.js` 加一个 `ipcMain.handle`。


## 屏幕定位（多屏最关键的部分）

`toolbar.config.json` 的 `display` 段决定窗口铺到哪块屏，三种模式：

| mode | 行为 |
| --- | --- |
| `auto` | 在所有屏里挑与 `match.width × match.height` 最接近的**非主屏**（差值在 `tolerance` 内），命中多个时取分辨率最接近的 |
| `index` | 直接用 `screen.getAllDisplays()[index]`，序号见设置面板下拉或 `npm run displays` |
| `bounds` | 用 `display.bounds` 里的 `{x,y,width,height}` 硬定位 |

当前机器实测（`npm run displays`）：

```
#0 id=642213925  2561x1440 @ (-444,-1440)  scale=1.5x  Mi Monitor
#1 id=840064316  1707x1067 @ (0,0)         scale=1.5x  Sculptor   ← 主屏
#2 id=76616542   1920x550  @ (1707,0)      scale=1x    ASUS PA147 ← 工具栏屏
```

三个已经踩掉的坑，改代码时别退回去了：

1. **窗口尺寸不能在构造函数里给。** `new BrowserWindow({...display.bounds})` 时 Windows 会按窗口初始所在屏（主屏 1707）把 1920 截断，结果窗口只有主屏那么宽。现在的做法是先只给 `x/y`，创建完再 `win.setBounds(placement.bounds)`。
2. **这块屏的 DIP 和物理像素都是 1920×550（scale 1x），而主屏是 150% 缩放。** 用 PowerShell/WinForms 量屏幕会得到 2880×825 这种被系统 DPI 虚拟化过的数字，和 Electron 的坐标对不上。要核对真实画面请用 `npm run diag`（`tools/diagnose.js`，走 `desktopCapturer`，拿到的是各屏原生位图）。
3. **本地音频必须走自定义 `track://` 协议，而且要自己回 Range。** `file://` 直接喂给 `<audio>` 会被 Chromium 的跨源策略挡住；而用 `net.fetch(file://)` 转发时响应里常常没有 `Content-Length`，播放器就把 `duration` 报成 `Infinity`，进度条和总时长全废。现在 `src/main/main.js` 里用 `fs.createReadStream` 自己切分段并补 `Content-Length` / `Content-Range`。频谱还要求 `<audio>` 带 `crossOrigin="anonymous"` 且协议带 `Access-Control-Allow-Origin`，否则 `AnalyserNode` 取到的永远是 0（媒体被"污染"）。

## 配置项

功能参数在 `toolbar.config.json`，布局在 `layout.json`。「保存并应用」会写回对应文件并立刻生效：设置页只管 `toolbar.config.json`，位置由「组件与位置」面板写 `layout.json`，快捷方式面板写 `toolbar.config.json` 的 `dock` / `dockCategories`。设置页底部的「重载文件」会从磁盘重读配置。

```jsonc
{
  "display":   { "mode": "auto|index|bounds", "index": 2, "match": { "width": 1920, "height": 540, "tolerance": 80 }, "bounds": null },
  "window":    { "alwaysOnTop": false, "autoHideCursorMs": 5000 },
  "metrics":   { "pollMs": 1500, "slowPollMs": 3000, "historySize": 90 },
  "clipboard": { "enabled": true, "maxItems": 30, "pollMs": 800 },
  "theme":     { "accent": "#57b6ff" },
  "dockCategories": [ { "name": "系统", "icon": "⚙️" } ],
  "dock":      [ { "name": "Edge", "icon": "🌐", "category": "浏览器", "type": "path", "target": "C:\\...\\msedge.exe" } ],
  "music":     { "folder": "D:\\Music", "recursive": true, "volume": 0.7, "repeat": "all" }
}
```

`dock[].type`：`path`（`shell.openPath`，可执行文件 / 文件夹 / 文档 / `.lnk`）、`url`（`shell.openExternal`，支持 `https:`、`ms-settings:` 这类协议）、`cmd`（直接起进程）。`icon` 可以是 emoji，也可以是本地图片路径或 http 图标地址。右键点击条目可在资源管理器里定位目标。

这两个数组由 dock 行尾 ＋ 打开的「快捷方式」面板维护（设置页里也留了同一个入口），每次操作立刻写回 `toolbar.config.json`；下面的 JSON 只是数据结构参考，一般不用手改。

## 分类导航

底部 dock 不再平铺所有入口，而是按 `category` 分成分类，行为就是 Element-UI `el-collapse accordion` 转了 90°：每个分类平时是 84px 宽的窄条（图标在左、名称在右），点某个分类它原地向右展宽（`max-width` 过渡，最右 1200px 上限），该分类的条目在展宽区里从左到右排开（图标在上、名称在下，条目高度撑满整条 dock）；同一时刻只允许一个分类展开，其他分类同时收回窄条。再点一次同一个窄条、或按 Esc 收起。

- 分类顺序与图标取自 `dockCategories`；条目里出现但没在 `dockCategories` 声明的分类会带默认图标 📦 补到末尾，没写 `category` 的条目归入「未分类」。
- 维护入口和分类走面板（`src/renderer/js/dock-editor.js`），不再手写 JSON：左列已有入口（↑↓ 调顺序、编辑、删除），中列表单（名称 / 类型 / 目标 + 选文件·选文件夹 / 分类下拉 / 图标 + 选图片），右列分类（换图标、改名、↑↓ 排序、删除定义）。每点一次就写一次配置，没有"未保存"状态；分类改名会把它名下的条目一起带过去，删分类只删定义、条目退回「未分类」。
- 分类只有一个条目时也照常显示窄条，不做合并——保持位置稳定比省一次点击重要。
- 展宽发生在 dock 行内部，不是浮层，所以不会遮住其他模块，指标轮询和播放器照常运行。展开块是 `flex: 1 1 auto`，会吃掉 dock 行的剩余宽度（右侧不留空隙），但条目本身是固定尺寸 `flex: 0 0 80px`（80×行高）靠左排，不随宽度拉伸；条目多到放不下时展开区内部横向滚动（滚动条已隐藏，不会吃掉条目高度），展开的分类会自动 `scrollIntoView` 滚进 dock 的可视范围。
- 首次加载（以及分类构成变化后重建）默认展开第一个分类，对应 `el-collapse` 里 `activeName: '1'` 的效果；收起全部也是允许的终态。
- dock 行高由 `layout.json` 的 `grid.rows` 最后一行决定（默认 78px）。窄条和条目都是 `height: 100%`，所以行高调高，dock 会跟着一起长，不需要改 CSS。
- 重绘只在分类构成变化时发生（`dock.js` 里比对 JSON 签名）。展开/收起靠切 `.active` class，如果每次刷新配置都重建 DOM，宽度过渡会直接跳到终值、看不到动画。

待办、便签、播放器状态（曲目 / 进度 / 音量 / 循环 / 随机）存在 Electron 的 `userData/state.json`（`%APPDATA%\screen-toolbar\state.json`），和项目配置分开，方便单独备份或清空。

没有曲库时可以先跑 `npm run demo`，它会在 `samples/demo` 下合成三段带 `.lrc` 的演示音频；把 `music.folder` 指过去就能看到播放器完整链路，换成自己的文件夹即可。

## 开机自启

计划任务/启动目录都行，最省事的是往启动目录放一个快捷方式：

```powershell
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\toolbar.lnk")
$lnk.TargetPath = "D:\GitProject\toolbar\node_modules\electron\dist\electron.exe"
$lnk.Arguments = """D:\GitProject\toolbar"""
$lnk.WorkingDirectory = "D:\GitProject\toolbar"
$lnk.Save()
```

## 排查

- **`Cannot read properties of undefined (reading 'requestSingleInstanceLock')`**：说明当前 shell 里有 `ELECTRON_RUN_AS_NODE=1`（某些 CLI/IDE 会话会注入），Electron 被当成纯 Node 跑了。`Remove-Item Env:\ELECTRON_RUN_AS_NODE` 或换个普通终端窗口。
- **窗口铺错屏**：设置面板顶部会显示当前定位来源（`auto match #2 → ...`），改成「按屏幕序号」最直观。
- **GPU 卡片显示"无 N 卡"**：`nvidia-smi` 不在 PATH，或非 NVIDIA 显卡；此时其余指标不受影响。
- **网络卡片一直是 `--`**：PowerShell 的 `Get-NetAdapterStatistics` 被组策略禁用，把 `metrics.slowPollMs` 调大或改用手动采集。
- **播放器点了没声音**：看 DevTools 里 `<audio>` 的 `error`；`track://` 只允许读 `music.folder` 里扫到的文件，换文件夹用播放器上的 📁（或设置里的「浏览」），选完会自动重扫。
- **频谱一条线不动**：`AnalyserNode` 拿到的是全 0，通常是音频被跨源污染 —— 确认 `main.js` 的协议响应带了 `Access-Control-Allow-Origin`。
- **新放的组件在面板里选不到**：组件清单是启动时扫 `src/renderer/js/components/` 得到的，加完文件要重启一次；文件里有语法错误会导致该脚本加载失败，控制台会打 `[components] 加载失败：...`，其他组件照常加载。
- **某个位置空着**：多半是 `slots.module` 指向了一个不存在的组件（改名、删文件），`layout.json` 里把它换掉或取消「显示」即可；控制台有 `[layout] 位置 "xxx" 引用的组件 "yyy" 不存在`。
- **`npm run diag` 只截到壁纸**：Windows 的 DXGI 屏幕复制对某些副屏（尤其 USB 便携屏）会报 `Cannot initialize any DxgiOutputDuplicator instance`，此时 `desktopCapturer` 拿到的是没有窗口内容的桌面。要核对界面本身，用 DevTools 里 `capturePage` 或直接看那块屏。
- **顶栏没有搜索栏**：设置里「文件搜索（Everything）」的「启用」被关了（`search.enabled=false` 时整条搜索栏不渲染，Ctrl+F 跟着失效），或这台机器不是 Windows。徽标显示「未连接」是 Everything 没在跑，点同一张卡片里的「重连并拉起 Everything」。
- 主进程日志（目标屏、窗口尺寸）在终端里；渲染层日志需要 `npm run dev` 看 DevTools。

## 目录

```
layout.json        网格与 slots（位置 → 组件的映射，界面结构的唯一真相）
toolbar.config.json 功能参数
src/main/          主进程：窗口与屏幕定位、IPC、轮询、track:// 音频协议
  config.js        toolbar.config.json 读写与默认值合并
  layout.js        layout.json 读写 + slots/areas 校验 + v1 modules 自动迁移（不合法就退回默认）
  display.js       三种定位模式
  services/        metrics(CPU/GPU/网络/磁盘) · music(扫描 + .lrc 解析) · clipboard-history · store(待办便签播放状态) · launcher
                   everything(搜索：主进程排队) · everything-worker(工作进程里调阻塞的 SDK) · everything-sdk(koffi 声明，不依赖 Electron)
vendor/everything/ 便携版 Everything 客户端 + SDK DLL（ini/db 是运行时产物，不进 git）
src/preload/       contextBridge，暴露 window.deskToolbar
                   （注意：不能叫 toolbar，window.toolbar 是 Chromium 内置属性，绑定会失败）
src/renderer/      纯 DOM，无构建步骤
  js/registry.js   TB.components / TB.register —— 组件注册表
  js/loader.js     启动时按 components/ 目录动态注入组件脚本，再 TB.app.boot()
  js/components/   一个文件一个组件（drop-in，放进目录就能在面板里选到）
  js/app.js        外壳：按 slots 生成 grid-template-areas、重建 section、分发 update
  js/search.js     顶栏搜索栏 + 结果下拉（Everything）
  js/settings.js   设置面板      js/dock-editor.js   快捷方式面板
  js/layout-editor.js 组件与位置面板
tools/diagnose.js  打印各屏真实参数并抓取原生截屏
tools/everything-check.js / search-appprobe.js  搜索链路的无界面自检与 CDP 真机验证
tools/layout-appprobe.js  量一遍格子：音乐在时钟下方、占位两格、指标不拉伸、搜索栏常驻（--shot 存 samples/layout-after.png）
tools/make-demo-audio.js  合成 samples/demo 下的演示音频与歌词
```
