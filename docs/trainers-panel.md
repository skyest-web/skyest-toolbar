# 修改器列表（`trainers`：主进程服务 + 独立组件）

把 `H:\GAMES\FLiNGTrainers\GCM Trainers` 这类目录里的修改器扫成一格一格可点的按钮。路径可配置，改完保存即生效。

> 版式现状：游戏面板中间三格已合成一整块**游戏列表**，修改器现在挂在各自那款游戏那一行的下面（`[风灵]` / `小幸` 这种前缀抠成短标签），见 [game-list-panel.md](game-list-panel.md)。本文的纯修改器格子不再是默认版式的一部分，但**主进程服务和这个组件都还在用**（点标签启动走的就是这里的 `trainers.launch`），组件仍可以在「组件与位置」里单独挂一格。

## 1. 分工

| 位置 | 干什么 |
| --- | --- |
| `src/main/services/trainers.js` | 扫目录、把结果缓成 `id → {name, path}`、启动、在资源管理器里定位 |
| `src/main/services/spawn-result.js` | 把 `spawn` 的**两条**失败来路（同步抛 / 异步 `'error'`）收成一条 Promise，外加错误码→人话、盘符路径打码 |
| `src/main/main.js` | 四条 IPC：`trainers:list / launch / reveal / pickFolder` |
| `src/preload/preload.js` | `TB.api.trainers` 桥 |
| `src/renderer/js/components/trainers.js` | 标题栏 + 计数 + 「重扫」+ 过滤框 + 格子列表 |
| `src/renderer/js/settings.js` | 设置里的「修改器」卡片（文件夹 + 浏览…） |
| `tools/trainers-check.js` | 离线自检（临时目录 + 只记账的 spawn 替身，一个框都不弹） |
| `tools/trainers-appprobe.js` | 真机探针（CDP），含启动链路的干跑 |

## 2. 显示名怎么来的

目录里两种放法都有，规则按「哪个更像人话」选：

- **顶层的 `.exe`** → 用文件名去掉 `.exe`。例：`《Jump大乱斗》修改器.exe` → 《Jump大乱斗》修改器。
- **一层子目录里的 `.exe`** → 用**目录名**。FLiNG 那批的目录名才是游戏名（`[风灵]《侠客风云传》修改器\Tale of Wuxia v1.0.1.2-v1.0.2.9 Plus 62 Trainer.exe`），exe 文件名反而是版本号。目录里不止一个 exe 时才拼成 `目录名 · 文件名` 来区分。
- 卸载器和运行库安装器不算修改器：`unins* / vcredist* / dxsetup* / dotnetfx* / setup* / install*` 开头的直接跳过。
- 排序 `localeCompare(..., 'zh-CN')`，所以 `[风灵]…` 和 `《…》…` 会交错而不是按字节序挤成一坨。

`H:\GAMES\FLiNGTrainers\GCM Trainers` 实测 64 条（31 个顶层 exe + 33 个子目录各一个）。**只扫一层子目录**，所以「[小幸]《仙剑奇侠传四》修改器」那种把 exe 又塞进第二层解压目录的不会进列表——要它进就自己把 exe 往上挪一层，或者把这条规则改成递归（现在故意不递归：再深一层就会把运行库安装器、绿色包的杂项 exe 都吸进来）。

## 3. 边界

和文件搜索那条一样的纪律：

- **渲染层递不进路径**。启动/定位只认主进程这次扫出来的 `id`；列表过期就报「列表已过期，请点『重扫』」，不会去接一个路径。文件夹路径也只从 `config.trainers.folder` 读。
- 扫描是同步 `fs`，但只在缓存过期（60 秒）或显式刷新时跑；**切面板不重扫**。
- 启动不用 `shell.openPath`：那不给工作目录，很多 trainer 找不到自己旁边的 dll/配置就静默退出。这里用 `spawn(exe, [], { detached, cwd: 它自己那个目录 })`。
- **启动是异步的，而且把成败如实报回去**。`spawn` 失败有两条来路：CreateProcess 当场返回（同步抛）和子进程句柄建好之后才报的 `'error'` 事件——以前只写了 `try/catch`，后一条没人接，异常冒到主进程顶层，就是那个「A JavaScript error occurred in the main process」模态框（第一次真点《赛博朋克2077》修改器踩到）。现在两条都收进 `spawn-result.js` 的一条 Promise，`trainers.launch` 是 `async` 的，渲染层 await 它。
- **左键点被系统判为「要管理员」的 exe 会自动补发一次 UAC**。这种 exe 的清单写了 `requireAdministrator`，普通权限起不来，libuv 报的是 `EACCES`（本机 68 个 trainer 里 61 个带这个清单，所以不是罕见分支）。补发的是 `Start-Process -Verb RunAs`——弹窗仍由系统弹、仍由人点「是」，不是我们自己提权；提示条会说明「它要求管理员，普通权限点不开」。
- 右键 = 以管理员启动，同一条 `Start-Process -Verb RunAs`；路径进 PowerShell 前按单引号字符串转义（目录名里有中文、括号和空格）。这条**不 detach**，留着 stderr 和退出码，所以他点「否」时说的是「UAC 弹窗被取消，没有启动」，而不是报一个假的「已启动」。
- 启动失败的文案是翻译过的人话，而且洗掉盘符路径——行数据里不带路径，进提示条的那句话也不该带。
- Ctrl+左键 = 在资源管理器里定位（`shell.showItemInFolder`），用来确认到底是哪个文件。
- 3 秒内连点同一个只发一次，避免手抖起两个。
- 不出网，不写日志到磁盘，不碰注册表。

## 4. 配置段

`toolbar.config.json`：

```json
"trainers": { "folder": "H:\\GAMES\\FLiNGTrainers\\GCM Trainers" }
```

设置 → 「修改器」卡片 → 文件夹（可手填，也可「浏览…」弹原生选择框，选完直接写回配置文件）。**改完保存后格子上的计数会自己变**：组件发现 `config.trainers.folder` 和手上那份不一致就自动重扫，不用手动点。

新增顶层配置段的「记得两处」都做了：`src/main/config.js` 的 `DEFAULTS`（第 27 行）和 `save()` 的白名单（第 122 行）。少第二处，保存时这个键会被丢掉。

## 5. 自检与真机验证

```bash
# Git Bash，项目目录：服务层自检（临时目录里的假 exe，不起应用、不碰 H 盘）
node tools/trainers-check.js
```

它有两层：真 `spawn` 打在文本文件改名成的 `.exe` 上（必然失败，看的是"接住了、而且没冒到顶层"），以及**只记账的 spawn 替身按剧本喂事件**——于是这几条能离线断言而一个弹窗都不出现：普通权限点开只发一次 spawn 且 `cwd` 给的是 exe 旁边；异步 `'error'` = `EACCES` 时**恰好**补发一次 `powershell … -Verb RunAs`；那次退出码非零且 stderr 写「操作已被用户取消」要说成「UAC 弹窗被取消」；`ENOENT` 提示重扫但不去补发 UAC；所有失败文案里都不带盘符路径。替身缺一个事件、或者某条 `'error'` 没人接，自检自己会炸——脚本里那圈 `uncaughtException` 和 20 秒看门狗负责把"炸了/卡住了"都打成红字，而不是安静地退出 0。

真机（要先带调试端口起应用）：

```bash
# Git Bash，项目目录
unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
node tools/trainers-appprobe.js 9223 --shot   # 截图存 samples/trainers-game.png
node tools/layout-appprobe.js 9223            # 验四个面板的形状（游戏面板那页量的是合成后的 gamezone）
```

探针验的是：组件注册上了、**它自己把 `trainers` 临时挂到主界面一个空位上**（只改渲染层内存里那份 layout，不调 `layout:save`，验完还回去）、64 条真渲染成 64 个格子、计数牌写「共 64 个」、列表自己滚（`.tr-list` 是滚动容器，`#trainers` 内容不超格子高度，因为 `.area` 是 `overflow:hidden`，超了不报错只是看不见）、过滤命中与「没有匹配」文案、报错/空目录兜底文案、「重扫」的「扫描中…」反馈、设置卡片里的文件夹值。

**启动链路是干跑的**：探针真点 DOM、真走组件处理，但把 `TB.api.trainers` 换成只记账的替身，所以断言能对上 `launch(id,false) / reveal(id) / launch(id,true)`，而一个修改器都不会被真拉起来（跑完还会查一遍 `Get-Process | Where-Object Path -like 'H:\GAMES*'` 确认）。真启动请人工点一下。

## 6. 已知的坑

- **`TB.api` 不能拿 Proxy 劫持**。`window.deskToolbar` 是 contextBridge 造的，属性只读且不可配置，Proxy 的 `get` 返回别的东西会直接抛 `TypeError`。要替身就浅拷一份普通对象再换掉 `trainers` 那一层。
- **`button` 上别直接写 `overflow:hidden` + `white-space:nowrap`**：它在 grid 的 `auto` 行里会把内容盒塌成 0，行高只剩 padding + 边框（实测 10px），16px 高的字被裁到 2px——DOM 在、`scrollHeight` 正常、探针全绿，人却看不清。改成像 `.clip-item` 那样：行本身 `display:flex; align-items:center; min-height:26px`，文字交给单独的 `.tr-name` span 去做省略号。字号也定在 0.9rem（13.5px）：这块副屏 `devicePixelRatio=1`，再小就费眼。探针现在量的是**字形自己的矩形**（Range）在不在行里，不是格子的矩形。
- **格子高度只有 176px**。列表必须自己滚：`.tr-list { flex:1; min-height:0; overflow-y:auto }`，外层 `.trainers` 要是 `display:flex; flex-direction:column`。少了 `min-height:0`，内容会被 `.area` 的 `overflow:hidden` 静默裁掉。可读版每行 26px + 4px 间距，一屏约 3.6 行，64 条靠过滤框找人。
- **过滤词存在 JS 上**（`TB.trainers.filter`），不靠 input 的 value：切面板会整体重建 DOM（见 QODER.md「组件不能只在 DOM 里存在状态」）。
- **H 盘没挂**时格子显示「文件夹不存在或不可读（ENOENT）」而不是空白——空白会让人以为目录里没东西。
- 计数牌永远写总数，过滤后不改数字：否则他会以为目录里只剩这几个。
- 子目录里 exe 多于一个时显示名会带上文件名，看起来啰嗦，但这是唯一能把同目录两个版本区分开的办法。
