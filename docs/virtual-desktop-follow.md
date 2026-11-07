# 工具栏跟随虚拟桌面 + 面板与桌面双向绑定

## 1. 问题出在哪

Windows 10/11 的虚拟桌面是**按窗口归属**工作的：一个窗口在「创建它时活动的那个桌面」上诞生，之后就一直钉在那儿。你在桌面 1 启动工具栏，切到桌面 2，桌面 2 上看不到它——不是被隐藏，是它压根不属于这个桌面。

微软没有给「让窗口在所有桌面上都可见」的对外 API（那是 Explorer 自己给任务栏、壁纸用的内部接口），能用的公开接口只有 `IVirtualDesktopManager` 三个方法：

| 方法 | 我们这边的实测结果（Win11 26300） |
| --- | --- |
| `IsWindowOnCurrentVirtualDesktop` | 跨进程读**可用**，返回 S_OK |
| `GetWindowDesktopId` | 跨进程读可用，但工具栏窗口拿回来的是**空 GUID**（普通前台窗口是真实 GUID） |
| `MoveWindowToDesktop` | 挪**别的进程**的窗口 → `0x80070005 E_ACCESSDENIED`；挪本进程自己的窗口 → S_OK |

`MoveWindowToDesktop` 只认窗口所属进程，而 Electron 没把这个能力暴露出来。所以「把已经存在的窗口搬到当前桌面」这条路在这台机器上走不通，剩下的唯一干净办法就是微软文档自己给的替代方案：**重建窗口**——新窗口天然落在当前活动桌面上。

## 2. 方案：只读探测放助手，动手放主进程

```
tools/vdesktop-watch.ps1  ──每 800ms 一次 COM 读──►  stdout 一行事件
        ▲                                            │
        │ 只读：窗口在不在当前桌面 / 活动桌面是第几个   ├─ off ──► recreateWindow()
        │                                            └─ desk|N ─► onDesktopIndex() ─► 换面板
                                                     ▲
        tools/vdesktop-switch.ps1 -Index N ◄─────────┘（点页签时的一次性子进程，切桌面）
        （内部 COM：IVirtualDesktopManagerInternal）
```

- **助手脚本只做读**：`tools/vdesktop-watch.ps1` 常驻，每 800ms 调一次 `IsWindowOnCurrentVirtualDesktop`。它不改任何东西，也不出网。
- **共享的 COM/P-Invoke 声明**在 `tools/vdesktop-native.ps1`，check 和 watch 两个脚本 dot-source 同一份——COM 接口声明这种脆弱代码只留一处。
- **判断和重建在主进程**：`src/main/services/vdesktop-follow.js` 解析助手的 stdout，收到 `off` 就回调 `main.js` 的 `recreateWindow()`：销毁旧窗口、原样再走一遍 `createWindow()`。
- **窗口归属**：助手启动时拿到主进程递来的 HWND（`win.getNativeWindowHandle()`）。重建之后 HWND 变了，助手发现句柄失效就按窗口标题重新解析一次，并把新句柄 latch 住（`hwnd|<新值>` 那行日志）。

助手为什么用 PowerShell 而不是主进程里的 FFI：`koffi` 在这台机器上是能用的（Everything 搜索就靠它加载 `Everything64.dll`），但它擅长的是 C 导出函数；`IVirtualDesktopManager` 是 COM 接口，用 koffi 得自己 `CoCreateInstance` 再手搭 vtable 偏移，脆且没法独立验证。PowerShell + C# 的 `[ComImport]` 声明是现成的，还能脱离应用单独跑自检（`tools/vdesktop-check.ps1`）。代价是一个常驻 powershell.exe（几十 MB 内存）。

## 3. 事件协议与代价

助手输出的每一行是 `状态|详情`：

| 行 | 含义 | 主进程动作 |
| --- | --- | --- |
| `start\|hwnd=... interval=...` | 握手 | 记日志 |
| `on\|<hwnd>` | 工具栏在当前桌面 | 无 |
| `off\|<hwnd>` | 不在当前桌面 | 重建窗口 |
| `hwnd\|<hwnd>` | 句柄变了（重建过） | 记日志 |
| `gone\|0` | 一个工具栏窗口都没有 | 忽略（正在重建） |
| `desk\|N count=C` | 活动桌面变成第 N 个（0-based，任务视图从左到右，共 C 个） | 见 §5：反查绑在这个桌面上的面板 |
| `err\|hr=XXXXXXXX` | 本轮 COM 读失败 | 忽略，等下一轮 |
| `fatal\|...` | `IVirtualDesktopManager` 起不来 | 停止跟随，本次运行不再重试 |

事件**只在状态变化时**发一次，所以切一次桌面最多触发一次重建。主进程另外还有一道 5 秒冷却（`recreateWindow` 里），防止万一重建后仍判定为 off 变成无限重启循环。

实测代价：

- 一次约 **200–400ms** 的重载闪动（窗口销毁 → 新窗口 `ready-to-show`）。
- **正在流式返回的回复会被打断**：那几毫秒里推过来的 chunk 因为窗口已销毁而丢掉。
- 不丢的东西：当前面板（`state.json` 的 `activePage`）、AI 对话历史、剪贴板历史、播放器进度、配置——都在主进程内存或 userData 里，新窗口 `boot:get` 原样拿回来。
- 设置面板如果正好开着，会被这次重载关掉。

## 4. 开关

`toolbar.config.json`：

```jsonc
{ "window": { "followVirtualDesktop": true } }   // 默认 true
```

设置面板「屏幕目标」卡片里的**跟随虚拟桌面**勾选框，改动「保存并应用」立刻生效（`applyPolling()` 会调 `vdesktopFollow.sync()`：关掉就收掉助手进程，打开就重新拉起）。

关掉它，行为回到「窗口钉在第一次创建它的那个桌面上」，面板也不再动桌面。

## 5. 面板 ↔ 桌面双向绑定

页签顺序就是他点名的那四个：**主界面 / 生活面板 / 工作面板 / 游戏面板**。后三个各绑一个虚拟桌面，`layout.json` 里多了一个字段（1 起，跟任务视图从左到右一致）：

```jsonc
{ "pages": [
  { "id": "home", "name": "主界面" },                       // 不写 desktop = 切过去不动桌面
  { "id": "life", "name": "生活面板", "desktop": 1 },
  { "id": "work", "name": "工作面板", "desktop": 2 },
  { "id": "game", "name": "游戏面板", "desktop": 3 }
] }
```

- **正向**：点页签 → `page:set` → `syncDesktopForPage()` → 一次性子进程 `tools/vdesktop-switch.ps1 -Index N`（0-based）把活动桌面切过去。已经是那个桌面时脚本自己报 `noop`，不重复触发桌面切换动画。
- **反向**：他自己按 **Win + Ctrl + ←/→** 切桌面 → 助手的 `desk|N` 事件 → `pageOfDesktop(layout, N)` 反查绑了那个桌面的面板 → 主进程写好 `activePage` 并 `push('page:sync')`，渲染层 `applyPageFromDesktop()` 只重建外壳，**不再回走 `page:set`**（那就等于把桌面又切回去）。
- **主界面不绑**：切到它时桌面原地不动（他选的）。
- **桌面不够就不切**：只有 2 个桌面时点「游戏面板」（第 3 个）报 `range|count=2 want=2`，什么都不做——**绝不替他创建桌面**（他选的）。
- **防打乒乓**：`pendingDesktop` 记号 + 「`page:set` 只在真的换了面板时才动桌面」两道闸。记号 8 秒超时作废，防止一次失败的切换把后面所有合法切换吃掉。
- **一个桌面只能有一个面板**：`validate()` 会拒掉重复绑定和 `desktop: 0` / `"first"` / `1.5` 这类写法（退回默认布局并在控制台列出错误，不静悄悄丢掉）。

### 为什么切桌面只能用没文档的接口

公开的 `IVirtualDesktopManager` 只有读的能力（§1 那张表），`SwitchDesktop` 在没文档的 `IVirtualDesktopManagerInternal` 上。GUID 和 vtable 顺序是 Win11 24H2 的那一套，声明在 `tools/vdesktop-native.ps1` 的第二个编译单元里：

| 接口 / 服务 | GUID |
| --- | --- |
| `CLSID_ImmersiveShell`（拿 `IServiceProvider10` 的壳） | `C2F03A33-21F5-47FA-B4BB-156362A2F239` |
| `CLSID_VirtualDesktopManagerInternal` | `C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B` |
| `IID_IVirtualDesktopManagerInternal` | `53F5CA0B-158F-4124-900C-057158060B27` |
| `IID_IVirtualDesktop` | `3F07F4BE-B107-441A-AF0F-39D82529072C` |
| `IID_IObjectArray` | `92CA9DCD-5622-4BBA-A805-5E9F541BD8C9` |
| `IID_IServiceProvider10` | `6D5140C1-7436-11CE-8034-00AA006009FA` |

`IVirtualDesktopManagerInternal` 的方法**声明顺序就是契约**（IUnknown 之后数）：3 `GetCount`、4 `MoveViewToDesktop`、5 `CanViewMoveDesktops`、6 `GetCurrentDesktop`、7 `GetDesktops`、8 `GetAdjacentDesktop`、**9 `SwitchDesktop`**。只声明真要调的前几个，且全部 `[PreserveSig]`——猜错位时表现是 HRESULT 非零，不是托管异常。

接这条路之前的门槛（已经在 26300 上过）：`-List` 里内部接口认出来的当前桌面 GUID，必须等于公开接口对前台窗口报的那个，也就是输出里的 `cross=match`。对不上就说明这台 build 上 GUID/槽位不对，那不接，面板绑定也就不会上。

## 6. 实测：这台机器上工具栏本来就跟着桌面走

文档开头「窗口钉在创建它的桌面上」是 Windows 的一般规则，但**这个窗口在 26300 上不属于任何一个桌面**：`GetWindowDesktopId` 给它回的是**空 GUID**（普通前台窗口回真实 GUID），`IsWindowOnCurrentVirtualDesktop` 对四个桌面逐个切过去都回 `on`。空归属就是「所有桌面都可见」那一类（和任务栏、壁纸同路），推测和 `skipTaskbar` + 无边框 + 不抢焦点的窗口样式有关。

实际后果，两次真机探针（`npm run desktop:appprobe`）跑下来 `重建窗口` 触发 **0 次**：

- 切面板 / 切桌面都**没有** §3 说的 0.3 秒闪动，也没有打断流式回复。
- 重建那条路留着当保底：万一以后某个 Windows 更新给窗口挂上了桌面归属，助手会开始报 `off`，主进程照旧重建。
- 也就是说 §3 那几行代价目前是「理论上界」，不是他天天看到的现象。

## 7. 验证

### 7.1 只读自检：这套 COM 在这台 build 上到底对不对

不依赖应用是否在跑，四条都能独立退出码判定：

```powershell
# PowerShell / Git Bash 都行
powershell -NoProfile -ExecutionPolicy Bypass -File tools/vdesktop-check.ps1           # 逐窗口打印 hr 和桌面 GUID
powershell -NoProfile -ExecutionPolicy Bypass -File tools/vdesktop-check.ps1 -Poll     # 跑助手用的那一次只读
powershell -NoProfile -ExecutionPolicy Bypass -File tools/vdesktop-check.ps1 -SelfTest # 本进程窗口能否被挪走（结论：能）
powershell -NoProfile -ExecutionPolicy Bypass -File tools/vdesktop-check.ps1 -List     # 内部接口：列出全部桌面
powershell -NoProfile -ExecutionPolicy Bypass -File tools/vdesktop-check.ps1 -Current  # 内部接口：活动桌面是第几个
```

`-List` 是§5 那道门槛，输出里的 `cross=match` 才算数（真实跑出来的一例，本机 5 个桌面）：

```
count=5 list=5 current=0 currentId=53e9e66d-... cross=match
desk|0|53e9e66d-...|current
desk|1|b7c1f2d4-...|
...
```

`count`（slot 3 `GetCount`）和 `list`（`GetDesktops` 回来的 `IObjectArray` 长度）必须相等，`currentId` 必须和公开接口对前台窗口报的 GUID 一致。对不上就是 GUID / vtable 槽位在这台 build 上变了形，切桌面那条路不接。

`-Current` 输出 `index=0 count=5 desktop=<guid>`，也是探针每步结束后做独立复核用的那一句。

### 7.2 切桌面本身

```powershell
# Git Bash / PowerShell 都行。0-based：-Index 2 = 任务视图从左数第 3 个
powershell -NoProfile -ExecutionPolicy Bypass -File tools/vdesktop-switch.ps1 -Index 2   # → ok|index=2 count=5 ... 退出码 0
powershell -NoProfile -ExecutionPolicy Bypass -File tools/vdesktop-switch.ps1 -Index 2   # 再跑一次 → noop|index=2 退出码 0
```

退出码：0 切成功或本来就在；1 内部接口起不来；2 HRESULT 非零或 `-Index` 超出桌面数。生产代码走的就是这个脚本（`syncDesktopForPage()` 的一次性子进程），所以这两条命令验的正是应用真正那条路。

### 7.3 面板 ↔ 桌面双向绑定（跑真应用）

```bash
# Git Bash，项目目录
unset ELECTRON_RUN_AS_NODE
nohup ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223 > /tmp/toolbar.log 2>&1 &
```

```bash
npm run layout:check       # 默认绑定 home:- life:1 work:2 game:3、换算、重复绑定/非法值都拦得住
npm run desktop:appprobe   # CDP 驱动真应用，全绿即通过
```

`desktop:appprobe` 断言的是这几件事，按顺序：

1. 页签顺序 = 「主界面,生活面板,工作面板,游戏面板」，主/渲染两侧读到的 `desktop` 绑定一致。
2. 点「游戏面板」→ 活动桌面变成第 3 个（`desk|2`），面板确实是 game。
3. 点「主界面」→ 桌面**原地不动**（还是第 3 个）。
4. 从外部切到第 2 个桌面（探针直接调 `-Index 1`，模拟他按 Win+Ctrl+←/→）→ 面板反过变成「工作面板」。
5. 之后 2.5 秒静置观察：面板和桌面都不再自己动，`pendingDesktop` 归 `null` —— 这一条专门验 §5 的防打乒乓。
6. 结束把桌面还原成开跑时那一个，不给他的工作现场留尾巴。

探针只轮询应用自己的 `vdesk:status`（走 CDP），每个阶段结束才起一次独立的 powershell 读实况——从控制台常驻轮询会把前台窗口拽回控制台所在的桌面，把被测系统自己扰动掉。

### 7.4 不动真实桌面手势，也能验到两条路径

系统级快捷键（Win+Ctrl+←/→）探针按不了，所以助手留了两个「假装」开关，从主进程注入环境变量（`src/main/services/vdesktop-follow.js`），让主进程那半边单独可验：

```bash
# Git Bash，项目目录
unset ELECTRON_RUN_AS_NODE
# TB_VDESK_PRETEND=8     → 起应用后第 8 秒报一次 off（验重建路径）
# TB_VDESK_PRETEND_DESK=2 → 第 5 秒起持续报「第 3 个桌面是活动桌面」（验桌面→面板那半边）
TB_VDESK_PRETEND=8 TB_VDESK_PRETEND_DESK=2 \
  ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223 2>&1 | tee /tmp/vdesk.log
```

前者日志里按顺序看到（真实跑出来的一例）：

```
[vdesk] 看护已启动（hwnd=590962）
[vdesk] start|hwnd=590962 title=Toolbar interval=800 pretend=True
[vdesk] off|590962 pretend=1
[vdesk] 工具栏不在当前桌面，重建窗口以跟随（590962 pretend=1）
[toolbar] 目标屏: display #2 {"x":1707,"y":0,"width":1920,"height":550} scale= 1   ← 第二次，重建后
[toolbar] 窗口 {...} 页面 {"dpr":1,"css":[1920,550]}
```

后者多出来的是这两行，加上界面自己翻到「游戏面板」（右上会浮一条「桌面 3/5 → 「游戏面板」」的提示）：

```
[vdesk] desk|2 count=5
[vdesk] 当前桌面：第 3 个（共 5 个）
```

注意 `pretend=desk` 只改助手**报告**的活动桌面，真桌面一个都不切——所以它验的是「反查面板 + 换页 + 不回走 `page:set`」这半边，切桌面那半边还得靠 §7.2 和 §7.3。

真实桌面切换的最终确认（这一条只能他眼睛看）：应用照常起（不带任何 `TB_VDESK_PRETEND`），按 **Win + Ctrl + ←/→** 在几个桌面之间来回切，工具栏应该每块桌面上都在，面板则跟着 §5 的绑定翻到对应那一页。

退出步骤：`Ctrl+C` 结束 tee（前台跑的话），或在工具栏右上点「退出」；助手进程由主进程在 `before-quit` 里收掉，不会留孤儿 powershell.exe。

## 8. 已知边界

- **只跟工具栏主窗口**。dsh 窗口（标题 `DeepSeek Harness`）是另一个顶层窗口，不跟随；它本来就是为了拖到别的屏/桌面用的。
- **标题匹配是兜底**。助手优先用 HWND，只有句柄失效时才按窗口标题找：先要**完全等于** `Toolbar`，找不到再退化成「包含 Toolbar」。所以别在渲染层改 `document.title`，改了跟随会在重建后失灵。
- **切桌面那一刻如果正在重建**，事件会被 5 秒冷却吃掉一次，下一次切换桌面时窗口就正常跟随。
- 助手进程意外退出会每 5 秒重拉，最多 5 次；之后本次运行不再跟随（日志里有 `[vdesk] 助手连续退出...`），重启应用恢复。
- **切桌面用的是没文档的接口**（§5）。Windows 大版本更新可能改掉 GUID 或 vtable 顺序，那时的表现是 `-List` 的 `cross=match` 对不上、`switchTo` 回 `failed|hr=...`（退出码 2），面板切换本身照旧能用，只是桌面不动——不会误伤，日志里看得见。
- **桌面数不够时绑定是空的**：绑了 `desktop: 3` 但只有 2 个桌面，点「游戏面板」停在原地（`range|count=2 want=2`）。要他新建桌面才有；工具栏绝不替他建。
- **`desk` 事件靠 800ms 轮询**，不是通知。切桌面到面板翻过去最多晚 0.8 秒。
- **一次只允许一个面板绑同一个桌面**（`validate()` 拦）；写重复了整个 `layout.json` 会退回默认布局，控制台列出错误。
