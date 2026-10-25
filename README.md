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
┌──────────┬───────────────────────────────────────┬──────────────┐
│  顶栏    │  定位信息 · 设置 · 退出（跨整屏）                       │
├──────────┼─────────────────┬─────────────────────┼──────────────┤
│          │ CPU GPU 内存 网络 磁盘（含曲线）        │  待办 / 便签 │
│ 时钟     ├─────────────────┴─────────────────────┼──────────────┤
│ 主机信息 │  音乐播放器（列表 · 歌词 · 频谱）        │  剪贴板历史  │
├─────────────────────────────────────────────────┴──────────────┤
│  分类导航 dock（横向手风琴：点分类 → 向右展宽）                  │
└─────────────────────────────────────────────────────────────────┘
```

- **指标**：CPU、内存走 Node `os`；GPU 走 `nvidia-smi`（温度、占用、显存、功耗、风扇、核心频率）；网络速率与 Top 进程走 PowerShell `Get-NetAdapterStatistics` / `Get-Process`；磁盘走 `fs.statfs`。快慢两档轮询，避免每 1.5 秒起一次 PowerShell 进程。
- **剪贴板历史**：只存在内存，退出即清空，密码类内容不会落盘。点击条目重新复制。
- **分类导航**：dock 按 `category` 聚成分类，每个分类平时是一条窄标签；点某个分类，它原地向右展宽铺开该分类的条目，其他分类同时收回（同 Element-UI `el-collapse` 的 `accordion`，方向从左到右），见下面「分类导航」。
- **音乐播放器**：扫描 `music.folder`（含子目录，最深 4 层）里的 mp3 / flac / m4a / wav / ogg / opus / wma，文件名按 `序号 - 歌手 - 曲名` 自动拆分；同名同目录的 `.lrc` 会同步滚动高亮；底部频谱用 WebAudio `AnalyserNode` 实时绘制。空格键播放 / 暂停；当前曲目、进度、音量、循环与随机方式记在 `state.json`。换曲库不用进设置：播放器标题栏右侧的 📁 会弹原生文件夹选择框，选完写回 `toolbar.config.json` 并立刻重扫。

## 用 layout.json 改布局

界面长什么样完全由 `layout.json` 决定，渲染层读它生成 DOM，设置页的「模块开关」列表也是从 `modules` 自动生成的。

```jsonc
{
  "grid": {
    "columns": ["330px", "minmax(0, 1fr)", "400px"],   // CSS grid-template-columns
    "rows": ["32px", "minmax(118px, 0.82fr)", "minmax(150px, 1.18fr)", "78px"],
    "areas": [                                          // 每行是一个数组，长度必须等于列数
      ["topbar", "topbar", "topbar"],
      ["clock", "gauges", "workbench"],
      ["clock", "player", "clipboard"],
      ["dock", "dock", "clipboard"]
    ]
  },
  "modules": [
    { "id": "topbar", "name": "顶栏（设置与退出）", "enabled": true },
    { "id": "clock", "name": "时钟与主机信息", "enabled": true }
    // gauges / workbench / player / clipboard / dock ...
  ]
}
```

- 改完点设置里的「保存并应用」，或直接改文件后「重载文件」→ 重启工具栏。
- 关掉某个模块（`enabled: false`）时，它在 `areas` 里占的格子会变成 `.`，那块区域留空。
- `areas` 行数要和 `rows` 一致、每行元素数要和 `columns` 一致，名字必须在 `modules` 里声明过；校验不过会打印原因并退回默认布局，不会白屏。
- 想让某个模块跨行/跨列，就把它的名字在相邻格子里重复写（示例里 `clock` 占了三行）。
- 新增模块需要先在 `src/renderer/js/app.js` 的 `REGISTRY` 里注册 id，否则区域会留空并在控制台提示。

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

功能参数在 `toolbar.config.json`，布局在 `layout.json`。改完点设置里的「重载文件」或直接重启即可生效；在设置面板里改，保存会分别写回这两个文件。

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

## 分类导航

底部 dock 不再平铺所有入口，而是按 `category` 分成分类，行为就是 Element-UI `el-collapse accordion` 转了 90°：每个分类平时是 84px 宽的窄条（图标在左、名称在右），点某个分类它原地向右展宽（`max-width` 过渡，最右 1200px 上限），该分类的条目在展宽区里从左到右排开（图标在上、名称在下，条目高度撑满整条 dock）；同一时刻只允许一个分类展开，其他分类同时收回窄条。再点一次同一个窄条、或按 Esc 收起。

- 分类顺序与图标取自 `dockCategories`；条目里出现但没在 `dockCategories` 声明的分类会带默认图标 📦 补到末尾，没写 `category` 的条目归入「未分类」。
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
- 主进程日志（目标屏、窗口尺寸）在终端里；渲染层日志需要 `npm run dev` 看 DevTools。

## 目录

```
layout.json        网格与模块开关（界面结构的唯一真相）
toolbar.config.json 功能参数
src/main/          主进程：窗口与屏幕定位、IPC、轮询、track:// 音频协议
  config.js        toolbar.config.json 读写与默认值合并
  layout.js        layout.json 读写 + 结构校验（不合法就退回默认）
  display.js       三种定位模式
  services/        metrics(CPU/GPU/网络/磁盘) · music(扫描 + .lrc 解析) · clipboard-history · store(待办便签播放状态) · launcher
src/preload/       contextBridge，暴露 window.deskToolbar
                   （注意：不能叫 toolbar，window.toolbar 是 Chromium 内置属性，绑定会失败）
src/renderer/      纯 DOM，无构建步骤；js/ 下每个文件一个界面模块，app.js 里的 REGISTRY 把模块 id 接到 DOM
tools/diagnose.js  打印各屏真实参数并抓取原生截屏
tools/make-demo-audio.js  合成 samples/demo 下的演示音频与歌词
```
