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
32px      topbar ──────── 整行合并（面板 tab 与搜索栏住在这里）────────────────
176px     clock                   gauges ─────── 跨两列 ───────   workbench
1fr       player                  slot1（占位）   slot2（占位）     clipboard
78px      dock ───────────── 跨三列 ─────────                     clipboard（续）
```

左列是「时钟与主机信息」在上、「音乐播放器」在下；播放器落在 330px 窄列里会自动切成紧凑排布（控制键两行、曲库占满宽、歌词只留一行字幕）。中间下排的两格 `slot1` / `slot2` 每个面板自己配：主界面的 `slot1` 是「待办与便签」，生活面板的这两格分别是**音乐播放器**和**本地视频**，其余还挂着虚线占位等以后放新组件；指标那一行是固定 176px，窗口再高也不会被拉伸。

格子图默认四个面板共用一张，但**面板可以自带一份 grid 覆盖**——游戏面板把中间 2×2 合成一整块 `gamezone` 放游戏列表，生活面板把左列两行合成 `leftzone` 放邮箱，工作面板把左列两行合成 `projzone`（项目列表）、中间第 2 列两行合成 `gitzone`（git 状态）、第 3 列两行合成 `officezone`（办公文档）。顶栏、右侧桌宠、底部快捷入口照样跨面板常驻，行列宽一律没变，变的只是区域怎么合并。主界面那页形状没动；工作面板现在只剩四格（`projzone` / `gitzone` / `officezone` / `workbench`），最后那格 `workbench` 挂剪贴板历史。机制见 [docs/page-panels.md](docs/page-panels.md)。

- **顶栏**：面板 tab + 常驻搜索栏（Everything 全盘文件名，Ctrl+F 聚焦，结果下拉挂在它下面）+ 定位信息 + 「组件」（组件与位置面板，Ctrl+L）+ 「设置」（Ctrl+,）+ 「退出」。
- **文件搜索**：搜索栏在顶栏中间，输入文件名片段即出结果，回车用默认程序打开，↑↓ 选择、Esc 收起、点外面收起。索引由项目自带的便携版 Everything 做（`vendor/everything/`，普通权限、不出网），查询跑在独立工作进程里。详见 [docs/everything-search.md](docs/everything-search.md)。
- **指标**：CPU、内存走 Node `os`；GPU 走 `nvidia-smi`（温度、占用、显存、功耗、风扇、核心频率）；网络速率与 Top 进程走 PowerShell `Get-NetAdapterStatistics` / `Get-Process`；磁盘走 `fs.statfs`。快慢两档轮询，避免每 1.5 秒起一次 PowerShell 进程。整块高度锁在 `grid.rows` 第二行（176px），`.gauge-row` 另有 `max-height` 兜底，换到更高的位置也只会留白、不会被拉长。
- **剪贴板历史**（工作面板右上 `workbench`）：只存在内存，退出即清空，密码类内容不会落盘。点击条目重新复制。格子只有 176px 高，列表自己纵向滚、行不被压扁（`.clip-list > *` 关掉 flex 压缩）、往头部插新条时不拽滚动位置（`overflow-anchor:none`）。
- **分类导航**：dock 按 `category` 聚成分类，每个分类平时是一条窄标签；点某个分类，它原地向右展宽铺开该分类的条目，其他分类同时收回（同 Element-UI `el-collapse` 的 `accordion`，方向从左到右），见下面「分类导航」。行尾的 ＋ 打开表单式管理面板，增删改入口和分类都不用手写 JSON。
- **音乐播放器**：扫描 `music.folder`（含子目录，最深 4 层）里的 mp3 / flac / m4a / wav / ogg / opus / wma，文件名按 `序号 - 歌手 - 曲名` 自动拆分；同名同目录的 `.lrc` 会同步滚动高亮；底部频谱用 WebAudio `AnalyserNode` 实时绘制。空格键播放 / 暂停；当前曲目、进度、音量、循环与随机方式记在 `state.json`。换曲库不用进设置：播放器标题栏右侧的 📁 会弹原生文件夹选择框，选完写回 `toolbar.config.json` 并立刻重扫。宽度 ≤420px 时（现在的左列）走 CSS 容器查询的紧凑版：控制键与音量分两行、曲库占满宽、歌词压成一行字幕、频谱降到 22px。
- **本地视频**（生活面板 `slot2`，`slot1` 还是上面那个音乐播放器）：扫 `video.folder` 那个目录（含子目录，最深 4 层、上限 400 条），只收 Chromium 真解得了的容器 **mp4 / m4v / mov / webm / mkv**（`.avi` `.flv` 收了也只能给他一个黑屏，所以不收），文件名前那段「01 - 」集数会剥掉，按标题排好放在右侧清单列；左边是 `<video>` 加原生控制条（播放、进度、音量、画中画、全屏都是 Chromium 给的）。点一行播一条，「上次哪条、看到第几秒、音量」记在 `state.json`，换文件夹走格子标题栏的「选文件夹」（原生选目录框 → 写回 `toolbar.config.json` → 立刻重扫）；「定位」在资源管理器里选中当前这个文件。播放走和音乐同一条 `track://` 自定义协议，那份**手写的分段响应**是必须的——缺 `Content-Length` 时 Chromium 把时长报成 `Infinity`，进度条整个废掉。切面板不会打断正在播的那条（`<video>` 元素只建一次，换页只是把它挪进新的格子），空格键仍只归音乐播放器。机制、扩展名表与验证见 [docs/video-panel.md](docs/video-panel.md)。
- **B 站**（同一格头部多出来的第二档 `本地 / B站`）：切到 B 站就把画面格收起、清单吃掉整格，列的是**稍后再看 / 观看历史 / 我的收藏**这三张单子（收藏先列夹子、点进去才是里面的视频）。**播放交给浏览器**：点一行只是把那条 `bvid` 递回主进程，由系统默认浏览器（他的是 Edge）打开，进度、弹幕、播放器都是 B 站自己的——这一格不内嵌网页（`webviewTag` 一直关着）、不拉流（拉流要 WBI 签名，风控一验就 403，而且进度不落他账号）。行是「封面块 + 标题 + UP · 时长 · 看到 m:ss」，`↗` 表示交给浏览器、`▸` 表示点进去还有一层。登录 cookie（SESSDATA）由他自己在设置里的 Bilibili 卡片填：`type=password` 且永不回填，**只加密存在本机 userData 的 `bili-auth.bin`（Windows DPAPI）**，不进 `toolbar.config.json`、不进 `state.json`、不进日志、不跟仓库走，界面上能看到的最多只是「26 位 · 尾 ef」这种形状描述；那张卡片还有个「测一下」按钮，粘整串 cookie 也只取 SESSDATA 那一段。清单一次最多列 30 行、60 秒内不重问，「刷新」强制重问；三张单子各自的字段读法、六种错误码翻成人话（没登录 / 风控 / 要验证 / 超时…）都在主进程 `services/bili.js` 里，出网只有 `api.bilibili.com` 一个主机。停在哪一档、看哪张单子记在 `state.json`。机制、凭据纪律与验证见 [docs/bilibili-panel.md](docs/bilibili-panel.md)。
- **本地相册**（生活面板 `gauges` 那一整条，1152×176）：扫 `photos.folder`（含子目录，最深 4 层、上限 400 条）里的 **jpg / jpeg / png / webp / avif / gif / bmp**，按修改时间从新到旧排成一排缩略图（176×124，超出宽度自己横向滚）。点一张在**整窗**上开大图浮层，`←`/`→` 翻页（第一张按 `←` 绕到最后一张）、Esc 或点暗色背景关闭（点浮层上的 ‹ › 按钮不会误关），底部一行写「文件名 · 今天 14:35 · 大小 · 3/31」这类「第几张 / 共几张」，悬浮缩略图能看到完整路径；「定位」在资源管理器里选中当前这张。图片直接走 `file:///`——CSP 的 `img-src` 本来就放 `file:`，`<img>` 不受跨源策略限制，所以这一格**不用** `track://`，也**没有** `state.json`（照片不需要「上次第几张」）。`.heic` 不收（Chromium 要装 HEVC 扩展才解得动，Windows 那次性付费），`.svg`/`.tiff` 同理。切面板时浮层会收起，但节点挂 `document.body`、只建一次，切回来不会重扫；关掉大图就摘掉 `src`，不把解码后的位图留在内存里。机制、扩展名表与验证见 [docs/photos-panel.md](docs/photos-panel.md)。
- **项目列表**（工作面板左边那一整块 `projzone`，330×402，原来上下两格合成）：把仓库根目录（默认就一个 `D:\GitProject`）底下的**顶层文件夹**一个列一行——左边项目名、中间该用哪个 IDE、右边「多久没动过」，最近动过的排最上面（这一格开进来基本是为了接着上次那个项目干）。**用哪个 IDE 按项目里的标记文件判**，五条规则按序命中第一条就定：`.idea` 里有 `dataSources` → DataGrip；`.iml` 是 `PYTHON_MODULE` 或有 `requirements.txt`/`pyproject.toml`/`.py` → PyCharm；`.iml` 是 `WEB_MODULE` 或有 `package.json`/`tsconfig.json` → WebStorm；文件夹名本身就是某个 IDE 名 → 那个 IDE；都不像 → 默认 WebStorm。命中哪条会写在悬浮说明里，判错了能立刻看出是哪条看走眼。「多久没动过」读的是 `.git/logs/HEAD` 最后一行的时间戳（**改源码不会动目录 mtime**，只看 mtime 会把天天在动的项目排到最后），没有 git 记录才退回目录修改时间。**三种手势**：左键 = 选中这一行（中间那格 git 跟着换到这个仓库，左键本身不发 IPC）、双击 = 把项目路径交给对应 IDE 的启动器（`<安装>/bin/<产品>64.exe <项目路径>`，Program Files 两层和 Toolbox 四层都认）、Ctrl+左键 = 打开那个文件夹；只保证「路径递到了 IDE 门口」，IDE 里问什么一概不管。这一格的**根目录是可配的**：设置里「仓库根目录」那一栏，一行一个路径（默认 `D:\GitProject`），项目格和 git 格共用这一份。改完点「保存并应用」就生效，不用重启应用、也不用再点一次「重扫」（主进程每次扫之前现读配置，发现这批根和上次那批不一样就作废那条 60 秒缓存）。多个根里有一路读不到只在那一行下面单独提示一句，不掀整张表；重复行、空行、大小写不同的同一条路径都会自动并掉。行数据里没有任何 exe 路径，渲染层只能递 id。机制、判序、边界与验证见 [docs/projects-panel.md](docs/projects-panel.md)。
- **git 状态**（工作面板中间那一整块 `gitzone`，572×402，原 `slot1` + `gauges` 的左半合成）：**项目格的第二个视图**——同一批项目、同一套 id、同一个排序，只是问的问题换成「这里有什么还没交出去」。左边点中哪一行，右边就只看**那一个**仓库：徽章是「分支 + `↑2` 领先 + `~25` 改动 + `+56` 未跟踪」，下面是改动清单和四个动作（抓取 / 拉取 / 提交 / 推送）。没点左边时整格只有一句「点左边一个项目，这里就看它的仓库」，**不发 IPC、不起 git 进程**；点的是非仓库文件夹，出一张项目信息卡（该用哪个 IDE / 按哪条规则判的 / 多久没动过 + 来源 / 这个文件夹 / 来自哪个根，底下列 `repos.roots` 那几处）。写侧走两步：按钮只发 prepare，主进程现读一遍状态、过闸、给一个一次性 nonce 和那两三句说明，点「确认」才起 git 进程——确认那一步渲染层递不进任何参数，所以「给他看的话」和「真跑的命令」对不上这件事不可能发生。`git commit -a` 带不走未跟踪文件，所以已跟踪与未跟踪两个数分开写、只有未跟踪时直接在闸前拒掉。切分支 / stash / 丢弃改动 / `--force` 一概不做，而且拦在起进程之前（逐段比对 argv，不看调用方声明了什么 op）。凭据不经手：走系统 git 和它自己的凭据助手。清单里点文件名 = 用项目格判的那个 IDE 打开它，不是暂存它。机制、七种「闸前拒」与验证见 [docs/git-panel.md](docs/git-panel.md)。
- **办公文档**（工作面板第 3 列那一整块 `officezone`，572×402，原 `gauges` 的右半 + `slot2` 合成）：把 `office.folder`（默认 `D:\OneDrive\办公`，可配）里的 **Word / Excel / PPT / PDF** 扫成一列，一行是「类型牌子 + 文件名 + 所在子文件夹 + 多久没改」，最近改动的排最上面。上面一排**类型牌子**（全部 / 文档 / 表格 / 演示 / PDF）过滤，切换**不发 IPC**（只在已经扫出来的那批里挑）；「重扫」强制绕过那条 60 秒缓存。左键 = 交给**系统默认程序**打开（`shell.openPath`，Word 装没装、关联给谁都不归这一格管），Ctrl+左键 = 在资源管理器里选中它。只读，不转码、不改名、不删；行数据里没有任何绝对路径，渲染层只能递这次扫出来的 id（= 小写全路径），把路径直接递进 `open()` 会被拒。`~$xxx.docx` 这种 Word 正开着时的锁文件、`.onedrive` / `OneDataCache` 这类同步缓存目录都挡在门外；文件夹读不动时说的是「没有读取权限」，不是「这里没有文件」；里面确实没有这四类时计数牌写「0 份」，「未就绪」只留给真没扫成的那五种。机制、四类单子与验证见 [docs/office-panel.md](docs/office-panel.md)。
- **游戏列表**（游戏面板中间那一整块）：**两列并排**的已安装 Steam 游戏（一行两款，读序是「第 1 条左、第 2 条右、第 3 条回到左列」），每格里**左边 32×32 图标、右上游戏名（带「多久之前玩过」）、右下这款游戏的修改器标签**。点行**通过 Steam 客户端启动**（`steam://rungameid/<appid>`，启动选项、云存档、DLC 都按客户端设置走），Ctrl+左键打开安装目录；点标签启动修改器，右键以管理员启动（走系统 UAC；这类 exe 的清单写了 `requireAdministrator`，普通权限点会被系统拒，本机 68 个里有 61 个——所以左键被拒时会自动照这个意图补发一次 UAC，弹窗仍由系统弹、由你点「是」）。两边的对应关系靠一张**内置别名表**（`src/main/services/game-alias.js`，按这台机器上的实际名字手写），对不上 Steam 的修改器一个都不显示；图标是 Steam 自己缓存的那张本地图（`<客户端根>/appcache/librarycache/<appid>/`），不外网抓图。上面一个过滤框（回车启动第一条）、右上「重扫」，计数牌写「共 60 款 · 32 款有修改器 · 图标 60」。启动只认两个服务各自这次扫出来的 id，渲染层递不进可执行路径。机制、别名规则、图标来源与验证见 [docs/game-list-panel.md](docs/game-list-panel.md)。
- **修改器列表**（独立组件，默认版式里已并入上面那块，还可以在「组件与位置」里单独挂一格）：把 `trainers.folder` 目录里的修改器扫成一格一格，点一下启动，右键以管理员启动，Ctrl+左键在资源管理器里定位，上面一个过滤框、回车启动第一条、右上「重扫」。显示名优先用目录名（`[风灵]《侠客风云传》修改器` 这种目录，exe 文件名只是版本号），卸载器和运行库安装器会跳过；本机那个目录实测 64 条（数字跟着目录走，点「重扫」就是最新）。路径在设置「修改器」卡片里改（可手填、可「浏览…」），保存后格子自己重扫。机制、命名规则和验证见 [docs/trainers-panel.md](docs/trainers-panel.md)。
- **Steam 游戏列表**（独立组件，同上）：读 `steam.folder` 里的 `appmanifest_*.acf`，把已安装的游戏列成一格一格，最近玩过的排前面并标「今天 / 19 天前」；点一下通过 Steam 客户端启动，Ctrl+左键打开安装目录。库路径在设置「Steam」卡片里改（填 `SteamLibrary` 或它的 `steamapps` 都认）。注意边界：只保证「把 appid 交给了 Steam」，游戏到底起没起这里看不到；Epic/GOG 和已卸载残留不在列表里。机制、字段规则与验证见 [docs/steam-library.md](docs/steam-library.md)。
- **桌宠对话**：右列那只小女仆是 DeepSeek 对话（`deepseek-chat` / `deepseek-reasoner`，密钥只活在主进程内存与 `ai-key.bin`）。设置「AI 对话」卡片里可以开「查本机文件」：开着时它能按文件名查本机 Everything 索引来回答「X 在哪」，只读、打不开文件，命中的名字和路径会作为输入发到 DeepSeek，工具那几轮原始结果不落盘（默认关；要模型是 `deepseek-chat`，reasoner 不支持工具）。详见 [docs/ai-chat-module.md](docs/ai-chat-module.md) §13。

## 组件与位置

界面由三层拼成：**骨架（grid）** 固定，**位置（slot）** 分常驻和可换，**组件（component）** 可换。骨架就是 `layout.json` 里 `grid.areas` 画出来的那 9 个格子，主界面吃这一张；其余三个面板各带一份**合并过的**（游戏 `gamezone`、生活 `leftzone`、工作 `projzone` + `gitzone` + `officezone`），但行列数必须和全局一致、常驻位置一个不许少，否则校验拒绝。顶栏、右侧桌宠、底部快捷入口是**常驻位置**（`shared`），在哪个面板都在原地；剩下的可换位置（主界面是 `clock` / `gauges` / `workbench` / `player` / `slot1` / `slot2`，工作面板是 `projzone` / `gitzone` / `officezone` / `workbench`，游戏面板是 `clock` / `gamezone` / `workbench` / `player`）每个面板各配一套（`pages[]`）。顶栏那排 tab 切面板，「组件」按钮（或 Ctrl+L、设置页里的入口）打开配置面板：顶部先选**要编辑哪个面板**，下面一行一个位置，左边是位置名，中间下拉选组件，右边「显示」开关。机制与约定见 [docs/page-panels.md](docs/page-panels.md)。

- 把某个位置换成另一个已经在别处的组件时，**两个位置的组件自动对调**，格子数量不变，不会出现同一个组件在同一画面里被放到两处。选「空白占位」不对调（它就是「清空」的意思）。
- 取消「显示」→ 该位置在 `gridTemplateAreas` 里变成 `.`，区域留空，其他位置不动。
- 下拉里选「（空着不显示）」= 把这个位置清空，组件退回右侧「可用组件」池子。
- 点「保存并应用」写回 `layout.json` 并立刻重建界面，不用重启；「恢复默认」把当前编辑的那个面板连同常驻位置还原成出厂配置。
- **当前在哪个面板不写进 `layout.json`**（那文件跟着 git 走），它存 `state.json` 的 `activePage`，重启后回到你上次待着的面板。

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
  "shared": [                                                           // 常驻：所有面板共用，切页不动
    { "at": "topbar", "label": "顶栏（整行）", "module": "topbar", "enabled": true },
    { "at": "clipboard", "label": "右侧竖条", "module": "ai", "enabled": true },
    { "at": "dock", "label": "底部通栏", "module": "dock", "enabled": true }
  ],
  "pages": [                                                            // 每个面板一套可换位置
    {
      "id": "home", "name": "主界面",
      "slots": [
        { "at": "clock", "label": "左上：时钟与主机信息", "module": "clock", "enabled": true },
        { "at": "player", "label": "左下：音乐播放器", "module": "player", "enabled": true }
        // gauges / workbench / slot1 / slot2 ...
      ]
    },
    { "id": "game", "name": "游戏面板", "grid": { "areas": [ /* 中间 2×2 全是 gamezone */ ] }, "slots": [ /* 跟着变成 4 格 */ ] },
    { "id": "work", "name": "工作面板", "desktop": 2, "grid": { "areas": [ /* 左列两行 projzone，第 2 列两行 gitzone，第 3 列两行 officezone */ ] },
      "slots": [ { "at": "projzone", "module": "projects", "enabled": true }, { "at": "gitzone", "module": "git", "enabled": true }, { "at": "officezone", "module": "office", "enabled": true }, { "at": "workbench", "module": "clipboard", "enabled": true } ] },
    { "id": "life", "name": "生活面板", "slots": [ /* ... */ ] }
  ]
}
```

- `at` 必须是 `areas` 里出现过的区域名，且不能重复；`areas` 里每个区域都得有 slot——要么在 `shared` 里，要么在每个面板的 `slots` 里，两边不能重复声明。校验不过会打印原因并退回默认布局，不会白屏。
- 区域名只允许 `/^[a-z][a-z0-9]*$/`：**不能带连字符**，所以占位格叫 `slot1` / `slot2` 而不是 `slot-a`。
- 想让某个位置跨行/跨列，就把它的名字在相邻格子里重复写（示例里 `gauges` 横跨两列、`clipboard` 竖跨两行）。
- `slot1` / `slot2` 现在挂的是内置的 `placeholder`（虚线框 + 位置名），想放真组件时在面板里把这一行的下拉换掉即可。
- 老文件仍然能读：只有一份顶层 `slots` 的 v1、以及更早的 `modules: [{id, name, enabled}]`，加载时自动迁移——常驻那三格（按原值，你换过的组件不会被出厂默认盖掉）进 `shared`，其余归进「主界面」，另外三个面板补成空白占位，下次保存就落成 v2。
- 位置尺寸是固定的，把宽组件塞进窄格子（比如把指标卡放进左列）会挤成一列，属于预期行为——换完看一眼，不合适就换回来。跑 `npm run layout:appprobe` 会四个面板各量一遍每个格子有没有被裁。

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

### 虚拟桌面：切了桌面看不到工具栏

窗口只属于「创建它时活动的那个桌面」，而微软没给「让窗口常驻所有桌面」的对外 API。实测 `IVirtualDesktopManager.MoveWindowToDesktop` 挪别的进程的窗口返回 `E_ACCESSDENIED`，所以跟随只能靠**重建**：PowerShell 助手每 800ms 只读问一次「工具栏在当前桌面上吗」，主进程收到 `off` 就销毁并重建窗口（新窗口天然落在当前桌面）。代价是约 0.3 秒的重载闪动和一次被打断的流式回复；面板、对话历史、剪贴板、播放器进度都在主进程侧，重建后原样回来。开关在设置「屏幕目标」卡片的**跟随虚拟桌面**（`window.followVirtualDesktop`，默认开）。机制、事件协议和验证命令见 [docs/virtual-desktop-follow.md](docs/virtual-desktop-follow.md)。

## 配置项

功能参数在 `toolbar.config.json`，布局在 `layout.json`。「保存并应用」会写回对应文件并立刻生效：设置页只管 `toolbar.config.json`，位置由「组件与位置」面板写 `layout.json`，快捷方式面板写 `toolbar.config.json` 的 `dock` / `dockCategories`。设置页底部的「重载文件」会从磁盘重读配置。

```jsonc
{
  "display":   { "mode": "auto|index|bounds", "index": 2, "match": { "width": 1920, "height": 540, "tolerance": 80 }, "bounds": null },
  "window":    { "alwaysOnTop": false, "autoHideCursorMs": 5000, "followVirtualDesktop": true },
  "metrics":   { "pollMs": 1500, "slowPollMs": 3000, "historySize": 90 },
  "clipboard": { "enabled": true, "maxItems": 30, "pollMs": 800 },
  "theme":     { "accent": "#57b6ff" },
  "dockCategories": [ { "name": "系统", "icon": "⚙️" } ],
  "dock":      [ { "name": "Edge", "icon": "🌐", "category": "浏览器", "type": "path", "target": "C:\\...\\msedge.exe" } ],
  "music":     { "folder": "D:\\Music", "recursive": true, "volume": 0.7, "repeat": "all" },
  "video":     { "folder": "D:\\Videos", "recursive": true },
  "photos":    { "folder": "D:\\Pictures", "recursive": true, "limit": 400 },
  "trainers":  { "folder": "H:\\GAMES\\FLiNGTrainers\\GCM Trainers" },
  "steam":     { "folder": "H:\\GAMES\\SteamLibrary\\steamapps" },
  "repos":     { "roots": ["D:\\GitProject"] },
  "office":    { "folder": "D:\\OneDrive\\办公", "recursive": true, "limit": 300 }
}
```

`repos.roots` 是「仓库根目录」那一栏，一行一个路径（最多 12 条，重复行、空行、大小写不同的同一条会并掉），项目格和 git 格共用这一份；浏览按钮选中的路径只回到输入框，落盘等「保存并应用」。

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
- **宠物不查本机文件**：三个条件缺一个就不挂工具——设置里「查本机文件」没开（`ai.agentTools.enabled`）、「文件搜索」被关了（`search.enabled`）、模型不是 `deepseek-chat`（reasoner 不支持 function calling）。都开着但它还是不查，多半是这个问题历史里答过，它照抄上一轮；换个没问过的文件名即可。
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
tools/layout-appprobe.js  四个面板各量一遍格子：合并出来的 projzone/gitzone/officezone/leftzone/gamezone 矩形等于哪几格拼起来、旧位置没留下、指标不拉伸、搜索栏常驻（--shot 存 samples/layout-page-<id>.png）
tools/projects-check.js / projects-appprobe.js  项目格：判序与只认 id 的离线自检 / 真机跑三种手势（左键选中、双击、Ctrl+左键）并核对 roots 往返
tools/git-check.js / git-appprobe.js  git 格：porcelain v2 解析与闸前拒的离线自检 / 真机跑三态 + 写侧干跑（永不点真「确认」，前后比对 HEAD 与 reflog）
tools/make-demo-audio.js  合成 samples/demo 下的演示音频与歌词
```
