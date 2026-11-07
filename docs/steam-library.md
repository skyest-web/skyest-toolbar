# Steam 游戏列表（`steam`：主进程服务 + 独立组件）

把 `H:\GAMES\SteamLibrary\steamapps` 这类库里**已安装**的游戏列成一格一格可点的按钮，点一下通过 Steam 客户端启动。库路径可配置。

> 版式现状：游戏面板中间三格已合成一整块**游戏列表**（图标 + 游戏名 + 它的修改器），那份是 `games` 组件，见 [game-list-panel.md](game-list-panel.md)。本文的纯 Steam 格子不再是默认版式的一部分，但**主进程服务和这个组件都还在用**（`games` 的启动就调这里的 `steam.launch`），组件仍可以在「组件与位置」里单独挂一格。

## 1. 分工

| 位置 | 干什么 |
| --- | --- |
| `src/main/services/steam.js` | 读 `appmanifest_*.acf`、缓成 `id → {appid, name, dir}`、拼 `steam://rungameid/`、定位安装目录 |
| `src/main/main.js` | 四条 IPC：`steam:list / launch / reveal / pickFolder` |
| `src/preload/preload.js` | `TB.api.steam` 桥 |
| `src/renderer/js/components/steam.js` | 标题栏 + 计数 + 「重扫」+ 过滤框 + 游戏列表（名字 + 右侧「多久之前」） |
| `src/renderer/js/settings.js` | 设置里的「Steam」卡片（库文件夹 + 浏览…） |
| `tools/steam-check.js` / `tools/steam-appprobe.js` | 离线自检 / 真机探针（含启动链路的干跑） |

## 2. 数据来源：读清单，不翻 common 目录

`<库>/steamapps/appmanifest_<appid>.acf` 是 Steam 自己的 keyvalues 清单，一个已安装应用一份。我们用到的字段：

| 字段 | 用途 |
| --- | --- |
| `appid` | 拼 `steam://rungameid/<appid>`；清单里缺这个键就退回文件名里那个数字 |
| `name` | 显示名。空名字的条目不进列表 |
| `StateFlags` | **只认 `4`（装好了）**。`8` 是待下载、其他值是更新中/卸载残留，都不显示 |
| `installdir` | 只用来「在资源管理器里定位」，指向 `steamapps/common/<installdir>`；启动不碰它 |
| `LastPlayed` | 排序 + 右侧「多久之前」 |
| `SizeOnDisk` | 只写进悬停提示 |

不去 `common/` 里翻 exe：翻既慢又分不清游戏、演示版和工具，而且真正的启动权在 Steam 手里。

`Steamworks Common Redistributables`（228980）也占一份清单，但它不是游戏，连同 `directx / vcredist / dedicated server / tool sdk / soundtrack` 这类一起按名字挡掉——**宁可少挡也别误伤真游戏**，所以这份名单故意只列了明显的运行库/工具词。

`H:\GAMES\SteamLibrary\steamapps` 实测 **60 款已安装**：65 份清单里 61 份 `StateFlags=4`，其中一份是运行库；剩下 4 份是 `6`（更新中/待下载），不显示——装完会自己回来。这个数跟着客户端状态漂，别当常量写死进断言。填 `…\SteamLibrary` 或 `…\SteamLibrary\steamapps` 都认，后者会自动补一层 `steamapps`。

排序按 `LastPlayed` 倒序，从没玩过的按名字（`localeCompare(..., 'zh-CN')`）排在后面——开列表多半是为了接着上次那把。

## 3. 启动：一律交回 Steam

`shell.openExternal('steam://rungameid/<appid>')`。好处是启动选项、兼容性、云存档、在线状态、DLC 都按他在客户端里的设置走；Steam 没开时系统会先把客户端拉起来再起游戏。

**边界的说法要说准**：我们只保证「把这个 appid 交给了 Steam」，至于 Steam 有没有真的把游戏跑起来（要更新、需要序列号、离线模式冲突），这里看不到。所以 toast 写的是「已交给 Steam 启动」，不是「已启动」。

- 左键 = 交给 Steam 启动；过滤框里按 Enter = 启动当前第一条。
- Ctrl+左键 = 打开安装目录（`shell.openPath(steamapps/common/<installdir>)`），目录不存在会报「安装目录不存在」。
- 没有「以管理员启动」那档：提不提权是 Steam 客户端自己的事，协议里没有这个口子。
- 4 秒内连点同一款只发一次，避免手抖起两个。
- 不出网，不写日志到磁盘，不碰注册表（协议是系统里现成的 `steam://`，我们只是调用它）。

## 4. 边界纪律

和修改器、文件搜索那条一样：

- **渲染层递不进路径，也递不进 appid**。启动/定位只认主进程这次扫出来的 `id`；列表过期就报「列表已过期，请点『重扫』」。
- 给渲染层的每条只带 `{id, appid, name, played, size}`，**`dir` / `clientRoot` 留在主进程缓存里不跨 IPC**（探针有断言盯着这条）。剥字段收在 `publicItems()` 一个方法里，**新扫和 60 秒缓存命中那两条 `return` 都调它**——曾经只有新扫那条剥过，命中缓存时路径就跟着出去了，而且只在 60 秒内的第二次调用才犯，平时点重扫（间隔够久）根本测不到。
- 库路径只从 `config.steam.folder` 读；「浏览…」走原生选择框，选完直接写回配置文件。
- 读清单是同步 `fs`，但只在缓存过期（60 秒）或显式刷新时跑；**切面板不重读**。

## 5. 配置段

`toolbar.config.json`：

```json
"steam": { "folder": "H:\\GAMES\\SteamLibrary\\steamapps" }
```

设置 → 「Steam」卡片 → 库文件夹。**改完保存后格子会自己重读**：组件发现 `config.steam.folder` 和手上那份不一致就自动重扫，不用手动点。

新增顶层配置段的「记得两处」都做了：`src/main/config.js` 的 `DEFAULTS`（第 29 行）和 `save()` 的白名单（第 125 行）。少第二处，保存时这个键会被丢掉。

## 6. 自检与真机验证

```bash
# Git Bash，项目目录：服务层自检（临时目录里自己写的假 acf，不起应用、不碰 H 盘）
npm run steam:check
```

它验的是：`field()` 解析、只认 `StateFlags=4`、挡运行库、空名字跳过、`appid` 缺字段时退回文件名、按最近游玩排序、id 连续、**payload 里没有 `dir`/`clientRoot`/`path`（新扫和缓存命中两份都查，还断言第二份确实 `cached: true`，否则等于没验到那条分支）**、60 秒缓存与 `force`、未知 id / 路径当 id 都被挡、4 秒防抖、拼出来的地址确实是 `steam://rungameid/4115450`、`openExternal` 报错不把点击打成崩溃、三种配置错误文案。

`openExternal` / `openPath` 是构造函数上留的接缝：自检脚本注入一对只记账的函数，所以能看到"到底把哪个地址交给了系统"，又不会真的叫 Steam。

真机（要先带调试端口起应用）：

```bash
# Git Bash，项目目录
unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
npm run steam:appprobe -- 9223 --shot   # 截图存 samples/steam-game.png
node tools/layout-appprobe.js 9223      # 验四个面板的形状（游戏面板那页量的是合成后的 gamezone）
```

探针对着**真库**量：60 款真渲染成 60 格、两列、计数牌「共 60 款」、首格是 `Phantom Blade Zero · 今天`、列表自滚（148px 可视 / 896px 内容）、字形矩形整个待在行里（行 26px、字 18px、字号 13.5px）、**跨 IPC 的两条返回路各查一遍**（`list(true)` 后紧跟 `list(false)`，两份都不带 `dir`/`clientRoot`/`path` 且字段集相同）、过滤命中与「没有匹配的游戏」文案、报错/空库兜底文案、「重扫」的「重扫中…」反馈、设置卡片里的库路径。

探针不再依赖 layout.json 里有没有纯 Steam 格子：它自己把 `steam` 组件临时挂到主界面的一个空位上（只改渲染层内存里那份 layout，不调 `layout:save`），验完原样还回去，所以跑它不会脏你的工作区。

**启动链路是干跑的**：探针真点 DOM、真走组件处理，但把 `TB.api.steam` 换成只记账的替身，所以断言能对上 `launch(id) / reveal(id) / launch(id)`，而一款游戏都不会真的交给 Steam（跑完 `tasklist //FI "IMAGENAME eq steam.exe"` 查一遍，Steam 客户端确实没被拉起来）。真启动请人工点一下。

## 7. 已知的坑

- **`steam://` 协议得在系统里注册过**。这台机器上 `HKCU\Software\Classes\steam\shell\open\command` 和 `HKLM\SOFTWARE\Classes\...` 都在，值是 `"C:\Program Files (x86)\Steam\steam.exe" -- "%1"`。装了绿色版/便携版 Steam 的机器可能没注册，那时 `openExternal` 会返回 `false`，日志里留一行 `[steam] 系统没接 steam:// 协议`，界面上仍然显示「已交给 Steam」——这是这条链路唯一看不见的地方。
- **新装/卸载游戏不会自己出现在列表里**。清单是 Steam 写的，我们只在 60 秒缓存过期或点「重扫」时重读；改完库路径倒是会自动重扫。
- **非 Steam 来源的游戏不在这**。Epic、GOG、破解版、以及 Steam 里「已卸载但残留目录」的应用都不会出现（后者 `StateFlags` 不是 4）。家庭共享的游戏也不在本机清单里。
- **右侧「多久之前」是点开这格时算的**，不自己走秒。放着不动跨了天，它仍写「今天」，重扫或切面板才更新——为了这个再挂一个定时器不值得。
- **格子只有 572x217**，两列一屏约 5 行（10 款），60 款靠过滤框找人。列表必须自己滚：`.st-list { flex:1; min-height:0; overflow-y:auto }`，外层 `.steam` 是 `display:flex; flex-direction:column`；少了 `min-height:0`，内容会被 `.area` 的 `overflow:hidden` 静默裁掉。
- **行高不能靠 `button` 上的 `overflow:hidden`**（修改器那格踩过）：那样 grid 的 `auto` 行会把内容盒塌成 0，字被裁到只剩 2px。这里按同一套来——行是 `flex`，名字交给 `.st-name` 做省略号，右侧 `.st-ago` 固定不缩。
- **过滤词存在 JS 上**（`TB.steam.filter`），不靠 input 的 value：切面板会整体重建 DOM。
- **H 盘没挂**时格子显示「找不到 steamapps 目录（ENOENT）：…」而不是空白——空白会让人以为库里没游戏。
- 计数牌永远写总数，过滤后不改数字。
