# 项目列表（工作面板左边那一整块 projzone）

工作面板（`work`，绑第 2 个虚拟桌面）左边一整块是 `projzone`，挂 `projects`：把设置里「仓库根目录」那一栏列的每个根（默认就一个 `D:\GitProject`）底下的**顶层文件夹**逐个列出来，一行一个项目，左边名字、中间该用哪个 IDE、右边「多久没动过」。三种手势各管一件事——**左键选中、双击交给 IDE、Ctrl+左键打开文件夹**。中间那一整块 `gitzone` 是它的第二个视图（见 [docs/git-panel.md](git-panel.md)）：左边点中哪一行，右边就看那一个仓库；点的是非仓库文件夹，右边出项目信息卡。其余两格（`gauges` 剩下的那一半 / `slot2`）和 `workbench`、`dock` 那些照旧，别的面板一格没动。

这一格只做「列出来 + 选中 + 交出去」：

- **只读**——不写任何项目文件，不改项目里的任何东西，不建索引。它唯一的配置项是那几个根目录（`repos.roots`，2026-11 从写死改成可配，理由见 §2.1），除此之外这一格没别的输入框；
- **只取顶层**，不往下钻。`D:\GitProject\webstorm\` 里那些子项目不在这一格出现，要看得进 IDE；
- **只负责把路径递到 IDE 门口**。开起来之后 IDE 里问什么（信任弹窗、索引、插件）一概不管，也不探 IDE 的窗口；
- **左键那一下不发 IPC**。选中只是 `TB.app.selectProject(item)`——把整条行存进 `TB.app.state.project` 并让右边那格重读一次；一次点击就起一个 IDE 进程是这格改手势之前的样子，点错了还得自己关，而「看这个仓库」才是更高频的动作。

## 1. 分工

| 位置 | 干什么 |
| --- | --- |
| `src/main/services/projects.js:26` | `DEFAULT_ROOT = 'D:\\GitProject'`（**只在 `repos.roots` 整段不存在时兜底**）、`CACHE_TTL_MS=60000`、`GUARD_MS=4000`（防抖）、`SKIP_DIR_RE=/^[.$]/`（点开头的目录和 `$RECYCLE.BIN` 都不当项目） |
| `projects.js:60` | `normalizeRoots()`：配置里那串根目录去空行、去重（Windows 路径不分大小写）、保持写的顺序 |
| `projects.js:49` | `defaultIdeRoots()`：`C:/D: 的 Program Files\JetBrains`（往下 2 层）+ `%LOCALAPPDATA%\JetBrains\Toolbox\apps`（往下 3 层），每条是 `{dir, depth}` |
| `projects.js:102` | `findBinDir(root, exe, depth)`：往下走找 `bin/<产品>64.exe`，Program Files 那种两层和 Toolbox 那种四层都认 |
| `projects.js:135` | `RULES`：五条判 IDE 的规则，**按顺序**第一条命中就定 |
| `projects.js:162` | `pickIde()`：名单一律小写后逐条试，返回 `{ide, why}`，`why` 就是悬浮说明里那句「按这条判的」 |
| `projects.js:180` | `reflogTime()`：按 fd 从尾部读 `.git/logs/HEAD` 最后 4KB，取**最后一行**的秒级时间戳 |
| `projects.js:208` | `inspect(root, name)`：一个项目目录 → `{root, name, path, ide, why, touched, touchedBy, empty, git}`（`root` 是这次扫它时用的那个根，git 格非仓库那张卡拿它说「来自根目录」） |
| `projects.js:247` | 构造函数两条根目录来路：`getRoots`（生产——每次扫现读一遍 config）/ `roots`（自检——静态数组）；`:244` 那条注释区分「整段没给」和「给了但一行都没有」 |
| `projects.js:264` | `resolveRoots()`：现读的值 → 洗一遍 → 数组；写成一根字符串也认；只有整段没给才回 `DEFAULT_ROOT` |
| `projects.js:288` | `scan()`：逐根扫 + 同目录去重、`roots` 变了作废 60 秒缓存、单根读不到进 `warnings`、按 `touched` 倒序、在这里盖 `ideLabel`/`ideReady`（exe 只进 `this.exes`，不进行数据） |
| `projects.js:339` | `readRoot(root, found, seen)`：四种「读不到」的文案各一句，成功时把该根下的项目 push 进 `found` |
| `projects.js:373` / `:408` | `launch(id)` / `reveal(id)`：只认 id，路径从这次缓存里取 |
| `src/main/config.js:38` / `:159` | `DEFAULTS.repos = { roots: ['D:\\GitProject'] }` 和 `save()` 白名单里的 `repos: config.repos`——**新增顶层配置段必须同时改这两处** |
| `src/main/main.js:480`–`:482` | 三条 IPC：`projects:list` / `projects:launch` / `projects:reveal` |
| `main.js:505` | `repos:pickFolder`：开系统目录框把选中的路径**还给设置卡片**，不在这一步落盘 |
| `main.js:714` | `projects = new Projects({ getRoots: () => config.repos?.roots })`——传的是取值函数，不是当时的数组快照 |
| `src/preload/preload.js:111`–`:114` | `TB.api.projects` = `list` / `launch` / `reveal`；`:130` 起是 `TB.api.repos.pickFolder` |
| `src/renderer/js/settings.js:4` | `uniqueRoots()`：和主进程 `normalizeRoots` 同一条规矩，这边只洗输入框那一栏 |
| `settings.js:155`–`:169` / `:713` | 「仓库根目录」那张卡片：textarea（`value` 要赋值，`setAttribute` 填不进）+ 浏览按钮、保存时 `config.repos = { roots: uniqueRoots(...).slice(0, 12) }` |
| `src/renderer/js/components/projects.js:16` | `TB.projects`：头部（`项目` + 计数 + 重扫）+ `.pj-list` |
| `components/projects.js:44` | `load(force)`：拿回列表后先核对选中项还在不在（`:56`–`:57`），不在就 `TB.app.selectProject(null)`——否则中间那格还在演一个已经不在这个面板上的项目 |
| `components/projects.js:73` | `markSelection()`：只翻 `.sel` class，不重建列表（重建会把滚动位置洗掉）；`render()`（`:79`）重建完补一次，`renderList()`（`:88`）填完行也补一次 |
| `components/projects.js:118` | `row(item)`：三段一行 + 悬浮说明；`onclick`（`:141`）里 `ctrlKey/metaKey` 分岔走 `reveal`，否则 `TB.app.selectProject(item)`；`ondblclick`（`:148`）走 `launch` |
| `src/main/layout.js:56` / `:81` | 工作面板自带 `WORK_GRID`（左列两行 `projzone`、第 2 列两行 `gitzone`）与 `modules: { projzone: 'projects', gitzone: 'git' }`；`layout.json:207`–`:234` 是磁盘那份 |
| `src/renderer/styles.css:908`–`:1032` | `.projects-area` / `.pj-*`（`.pj-item.sel` 在 `:1015`）/ `.pj-warn` 那段；`:2744` 是 `.repos-roots` |
| `tools/projects-check.js` / `tools/projects-appprobe.js` | 离线自检 / 真机探针（`npm run projects:check`、`projects:appprobe`） |

## 2. 落位：工作面板自带一份 grid，左列两行合成 projzone

这一格不再占单格。工作面板带了自己的 `grid`（`src/main/layout.js:56` 的 `WORK_GRID`）：左列第 2、3 行（原来 `clock` 在上、`player` 在下）合成一整块 `projzone` 放项目列表，第 2 列那两行（`gauges` 的左半 + `slot1`）合成 `gitzone` 放 git；`gauges` 因此只占第 3 列第 2 行。本机量到 `projzone` 330×402、`gitzone` 572×402，两格同顶同底。

和相册/邮箱/游戏列表那几块一样，落位要改两处且必须**逐字一致**：磁盘上的 `layout.json:182`–`:258`（那一页的 `grid` + 五条 `slots`，权威）和 `layout.js:81` 的 `modules: { projzone: 'projects', gitzone: 'git' }`（兜底）。**只改磁盘那份咬不住**：`layoutStore.load()` 校验不过就整份退回 `DEFAULT_LAYOUT`，所以自检两份都钉。`projects-check.js` 最后一段钉这两份，并反向钉「没顺手改别人」：主界面/生活/游戏三块面板一格没动，工作面板除 `projzone` / `gitzone` 之外那三格（`gauges` / `workbench` / `slot2`）还是 `placeholder`，`work.desktop` 还是 2。`validate()` 那三条硬规矩（行列数等于全局、常驻位仍在 `areas` 里、`slots` 只引用本页 `areas` 里的名字）一条都没碰——旧的 `clock` / `player` / `slot1` 必须一并从工作面板的 `slots` 里删掉，留着会让整份退回默认。

### 2.1 根目录这一栏：从写死到 `repos.roots`

原来这一格把根目录写死在服务里，理由是「他点名的范围就是 `D:\GitProject` 那一层，写死比给一个没人改的输入框干净」。这条在 git 格定下来做「项目格的第二个视图」时站不住了：**两格必须看同一批项目**（同一批行、同一套 id、同一个排序基准），而 git 格那张非仓库信息卡还要说清这一条是从哪个根扫出来的。所以根目录从代码里那行常数搬进了配置，两格共用同一份 `repos.roots`；`config.js:38` 的默认值就一条 `D:\GitProject`，什么都不调时画面和写死时代一样。

搬这一趟有四处各管一段，规矩都钉在自检里：

- **主进程每次扫之前现读一遍**（`resolveRoots()`，`projects.js:264`）。构造函数攥的必须是**取值函数**（`getRoots: () => config.repos?.roots`，`main.js:714`）而不是当时那份数组——`config:save` / `config:reload` 只把主进程那个 config 对象整个换掉，**不重建服务**，拷快照等于没配置项。代价是 60 秒缓存得自己判过期，于是 `scan()` 里加了 `stale`：这批根和上次那批不一样就作废缓存（比对按小写来，同一条路径他写大写小写算同一个根）。这两条凑齐，「保存并应用」才做到既不用重启应用、也不用再点一次「重扫」。
- **两处洗法是同一条规矩**：主进程 `normalizeRoots()`（`:60`）和设置卡片 `uniqueRoots()`（`settings.js:4`）都是去空行、按小写去重、保持写的顺序。留两份而不是让渲染层去够主进程，是因为洗一行字符串不值得跨一次进程。离线自检直接 require 主进程那份验行为；渲染层那份在 node 里跑不起来（它属于浏览器那一侧），只能由 appprobe 走真卡片时顺带验到——这是那条「变异 13 不红」的来由。
- **上限 12 条**（`settings.js:713` 的 `.slice(0, 12)`），超出静默截断：这栏是给人手写路径的，超过一屏就没人数得清列表里那几行是从哪个根来的，而「保存并应用」没有报错的落点，多一行提示只会变成又一句没人读的字。
- **浏览按钮不落盘**（`main.js:505`）：`repos:pickFolder` 只把选中的路径还给 textarea，落盘等「保存并应用」一起写。半条配置先进磁盘是这类对话框最经典的坑。

一个根读不到不掀整张表：那句进 `warnings`，渲染层单独占一行说清是哪一路（见 §7）。**每个根都读不到**才当错误报，因为那时候确实没东西可列。整栏清空则照实说「没有配置仓库根目录（repos.roots 是空的）」，不偷偷替他回扫 `D:\GitProject`——`DEFAULT_ROOT` 只在 `repos` 这段整个不存在时才轮到（构造函数 `:244` 那条注释就是在区分这两种「没给」）。

新增顶层配置段的老规矩这里踩过一次：**`config.js` 的 `DEFAULTS` 和 `save()` 的白名单必须同时改**（`:38` 与 `:159`）。只改 `DEFAULTS` 的话「保存并应用」会把整段 `repos` 抹掉，而抹掉之后 `load()` 又拿 `DEFAULTS` 兜回来，画面看着一切正常——只有那栏里手写的路径全没了。光看源码看不出这种错，所以 `projects-check.js` 第 11 段在临时目录里真跑一次 `save()` → `load()` 往返。

## 3. IDE 怎么判：五条按序命中

`RULES`（`projects.js:135`）从上往下第一条命中就定，命中那条的 `why` 原样进悬浮说明——判错了他能立刻看出是哪条规则看走眼：

| 序 | 判据 | 定给 |
| --- | --- | --- |
| 1 | `.idea/` 里有 `dataSources.xml` 或 `dataSources` | DataGrip |
| 2 | `.iml` 是 `PYTHON_MODULE`，或顶层有 `requirements.txt` / `pyproject.toml` / `setup.py` / `Pipfile` / 任何 `.py` | PyCharm |
| 3 | `.iml` 是 `WEB_MODULE`，或顶层有 `package.json` / `tsconfig.json` | WebStorm |
| 4 | 文件夹名本身就是某个 IDE 的产品名 | 那个 IDE |
| 5 | 都不像 | 默认 WebStorm（`FALLBACK_IDE`） |

两条顺序是**特意**排的，`projects-check.js` 第一段就钉它们：

- **第 1 条抢在第 2 条前面**：他那个 `datagrip` 项目里既建了数据库单子又留了 `PYTHON_MODULE` 的 `.iml`（顺手写过脚本）。按内容判的话这条会被第 2 条抢走，点下去开成 PyCharm，数据库单子看不见；
- **内容判据（2、3）排在目录名（4）前面**：`DataGrip/` 这个文件夹里有 `main.py`，它就是该用 PyCharm；反过来 `pycharm/` 是个空文件夹，只能靠第 4 条的名字规则认。

## 4. 「上次动过」为什么不是目录 mtime

一行右边那个「2 天前」来自 `reflogTime()`（`projects.js:180`），读 `.git/logs/HEAD` 尾部**最后一行**的时间戳；没有 git 记录（没仓库、`.git` 是 worktree/submodule 那个指针文件、logs 空或解析不出）才退回目录自身 mtime，`touchedBy` 记下用的是哪种，悬浮说明里直说「git 里最后一次提交/切分支」还是「目录自身的修改时间」。

退回 mtime 是必要的，但单独用它不成立：**改源码文件不会动所在目录的 mtime**，只有增删/重命名顶层条目才会。真机上三种样子都出现过：`game` 没有 git 记录，只能退回目录时间（13 天前，那确实是最后一次动顶层文件的时间）；`artcraft` 两边都是 9 天前，看不出区别；而天天在改的 `toolbar`，只要这一周没往顶层加过文件，目录时间就会停在几周前，reflog 里却前天还有提交——只看 mtime 就会把这种项目排到最后。反过来，今天往顶层新建了两个文件，`toolbar` 的目录时间立刻变成「今天」，哪怕一次提交都没做——这也是为什么悬浮说明里要写清用的是哪一种。读尾部 4KB 而不是整条 reflog，是因为长仓库那条文件能到几 MB，而我们要的只是最后一行。

排序是 `touched` 倒序，同一时间戳再按名字（`localeCompare` 走 `zh-CN`）——开这一格是为了「接着上次那个项目干」，最近动过的必须在最上面。

## 5. 三种手势与启动边界

手势是这轮的改动点之一（原来左键直接开 IDE）：**左键 = 选中这一行，双击 = 交给 IDE，Ctrl+左键 = 打开那个文件夹**。

- **左键不发 IPC**：只调 `TB.app.selectProject(item)`（`src/renderer/js/app.js:199`），把整条行（不只 id）存进 `TB.app.state.project`，然后 `refresh('projects')` + `refresh('git')`。同一条重选返回 `false`、不重渲染——这一句同时兜住了双击前的那两次 click，所以这里不需要防抖，也不会出现「选中动画闪两下才开 IDE」；
- **选中态存在 app 那边，不存在这一格**：`markSelection()` 只按 `TB.app.state.project?.id` 翻 `.sel` class。所以重扫（`load()`，`:44`）之后、或切走再切回这一页组件被重建之后，都得补一次高亮：`render()` 与 `renderList()` 各调一次，行是新 DOM、选中是旧状态，少一句就出现「中间那格还演着同一个项目，左边看不出选的是哪一行」；
- **重扫以后选中项不在列表里就清掉**（`load()` 里比 `id` **和** `path`）：项目被删或根目录换了，右边那格不能继续演一个已经不在面板上的项目；服务那边读到 `need='stale'` 也会同样处理，两条来路都通；
- 悬浮说明（`row()` 的 `title`）把三种手势各写一句，非仓库那条另加一句「左键点它，右边那一格说它的情况」。

`launch(id)`（`projects.js:373`）的链条是：`id` → 这次缓存里的行 → `this.exes.get(item.ide)` → `spawnResult(spawn, exe, [item.path])`。

- **渲染层只递 id**。`projects:launch` 的入参是行号，路径来自主进程自己的缓存；`projects-check.js` 有一条专门拿路径当 id 递进去，断言它不会被当成路径用；
- **行数据里没有 exe 路径**（只有 `ide` 这个产品 id 和 `ideLabel` 这个人话名），离线自检和真机探针各钉一遍（探针连 `JetBrains` 这个字样都不许出现在行里）；
- 4 秒内点同一条只发一次（`GUARD_MS`），第二次给「刚刚已经把这个项目交给 IDE 了，等它开起来」；列表换过一轮、id 对不上给「列表已过期，点『重扫』」；
- 本机没装那个 IDE：`本机没找到 PyCharm 的启动器（认的是 JetBrains 目录下的 pycharm64.exe）`——句子只到文件名，**不带盘符路径**（`explainSpawnError` 那套打码规矩， trainers/steam 同一款）；
- `spawn` 的两条失败来路（同步 throw 和异步 `'error'` 事件，EACCES 那种）都接住，不会留下一个没回音的点击；
- `reveal(id)` 走 `shell.openPath(item.path)`，目录已经不在了说「项目目录已经不在了：<名字>」。

**探针里这三条链都是干跑的**：换掉的是渲染层那一侧的 `TB.api.projects`，只记账不 spawn，跑前跑后各数一遍 `tasklist` 里三个 JetBrains 启动器的进程数（现在这台是 0/0/0，跑完还是 0/0/0）。真开 IDE 只能人工点一次。左键那一段更省：它连一次 IPC 都不该发，探针给只读通道包了记账（发了几条、id 对不对），再核 `.sel` 只落在点的那一行上。

## 6. 几个不写下来会重踩的坑

- **Windows 目录名大小写不敏感**：`D:\GitProject\pycharm` 和 `PyCharm` 是同一个文件夹。离线自检的 fixture 因此不能用大小写区分项目，踩过一次是「空的那个 `PyCharm` 捡到了 `pycharm` 的 `package.json`，被判成 WebStorm」；
- **判据一律小写**（`pickIde` 里 `toLowerCase()`，`.py` 那条另外带 `/i`）：`Package.JSON`、`Main.PY`、`PYPROJECT.TOML`、`WEBSTORM` 都得认，大小写敏感就是看菜下饭。fixture 里 `UpperPkg` / `UpperPy` 两个专门钉这件事——注意**只比 `ide` 抓不到**：`Package.JSON` 认不出也会落到默认的 WebStorm，所以断言里还核对了 `why` 那句是谁判的；
- **IDE 发现不能扫 `%LOCALAPPDATA%\JetBrains\`**：那底下是各 IDE 的配置/索引缓存，几万层目录。Toolbox 的真安装在它下面的 `apps/<产品>/ch-0/<版本>/bin`，所以只把 `apps` 列进候选并给深度 3；Program Files 那种是 `<安装目录>\bin`，深度 2。这就是 `{dir, depth}` 成对的来由；
- **`bin/` 里有诱饵**：`findBinDir` 要的是「这一层 `bin` 里真有那个 exe」，不是「找到了一个叫 bin 的目录」。自检里专门放了一个空的 `bin` 子目录当诱饵。

## 7. 兜底文案

| 情形 | 谁说的 | 画面 |
| --- | --- | --- |
| 所有根都读不到（相对路径 / 不存在 / 是文件 / 没权限） | `readRoot()` 四条各一句，`scan()` 用 `；` 串起来 | 计数牌「未就绪」+ 那句原样写在格子里 |
| 多个根里只有一路读不到 | `scan()` → `warnings`，渲染层 | 列表照常，上面多一条 `.pj-warn`「有一个根目录没读到：…」 |
| `repos.roots` 整栏空着 | `scan()` | 「没有配置仓库根目录（repos.roots 是空的）」——不兜回 `D:\GitProject` |
| 根在但底下没顶层文件夹 | 渲染层 | `「<这几个根，顿号连>」下没有项目文件夹` |
| 主进程那条 IPC 挂了 | 渲染层 `load()` 的 catch | 「主进程没响应：…」 |
| id 对不上（列表已过期） | `launch()` / `reveal()` | toast「打开失败：列表已过期，点『重扫』」 |
| 那个 IDE 本机没装 | `launch()` | 行上 IDE 标签变警告色（`.pj-ide.missing`），照样写名字——只留个 ✗ 看不出点下去会怎样 |
| 时间戳两种来源都落空 | `when()` | 右边写「没记录」，不硬编「今天」 |
| 重扫以后选中那条不在列表里 | 渲染层 `load()` → `TB.app.selectProject(null)` | 高亮清掉，右边那格回到「点左边一个项目」——不留着演一个已经不在面板上的项目 |
| 双击之前的那两次 click | `app.selectProject()` 里同一条返回 `false` | 不重渲染，不会出现「选中动画闪两下才开 IDE」，也不用另加防抖 |

## 8. 改完跑什么

```bash
npm run layout:check                       # 落位两份配置还对得上
npm run projects:check                     # 离线，不碰应用
# 另一个终端：
unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
npm run projects:appprobe -- 9223 --shot   # 存 samples/projects-panel.png
```

`projects:appprobe` 起手先看 `TB.api.projects` 在不在——不在说明跑的是改动之前的旧主进程，直接停（改主进程/preload 必须重启应用，光 reload 渲染层不够；只改渲染层可以 `location.reload()` 再跑）。它还会先查返回的列表里有没有 `roots` 数组：没有说明跑的是改动之前的旧主进程（旧版只回一个字符串根），当场停而不是让后面的断言一句句假红。格子找的是 `data-slot="projzone"`（**不是** `player` 了），并且顺带钉工作面板的格子清单是 `projzone,gitzone,gauges,workbench,slot2` 这五格、别的面板一格没动（home 的 `player` 还是音乐、life 的 `slot1` 还是音乐）；几何那一段在 `layout-appprobe` 里量。截图那张是**真目录**：6 个项目、三个 IDE 都认到了，`toolbar / WebStorm / 2 天前` 在第一行。工作面板绑桌面 2，点那一页 tab 会把虚拟桌面跳过去，所以探针在点之前先记下他原来在哪一页，收尾切回去（切完再读一次 `TB.app.state.page` 确认，别把桌面丢在第二个上；tab 节点会被上一趟切换留下的外壳重建换掉，所以点完要复查、不对就再点一次）。

判绿之前先做变异（QODER.md 那条老规矩）：

- **离线自检（项目格那一轮）**：`RULES` 里 datagrip 与 pycharm 调换、排序改成正序、`touched` 只看目录 mtime、把 `ideExe` 塞进行数据、名字规则提到内容规则前面、落位两份配置里把 `projzone` 改回 `placeholder`（`layout.json` 那份和 `layout.js` 的 `modules` 各改一次，都要红）、preload 通道改成 `projects:open`、`ideReady` 写死 `true`、`pickIde` 里 `ctx.top` 不做小写、`hasPy` 那条丢了 `/i`——每条都出 ✗，还原后回绿。后两条是补出来的缺口：原来 fixture 全用小写文件名，把归一化删掉照样绿；而且**只看 `ide` 也看不出来**——`Package.JSON` 认不出照样落到默认的 WebStorm，所以那一条断言的是 `why` 那句「是谁判的」。
- **这轮手势与高亮补的两条**：① `render()` 里去掉 `markSelection()` → 自检报「重建列表以后没补高亮」，真机上表现是点一次「重扫」左边就看不出选的是哪一行，而中间那格还在演同一个项目；② 把左键的 `TB.app.selectProject(item)` 改回 `this.launch(item)` → 探针一次报六条红（IPC 条数、`.sel`、git 格跟着换、双击那一段全乱），因为整条联动链是从左键那一下起的。
- **离线自检（roots 配置化这一轮 13 条）**：`normalizeRoots` 丢去重 / 丢空行 / 丢 trim、`resolveRoots` 不兜 `DEFAULT_ROOT`、`scan()` 去掉 `stale` 判定、`stale` 比对改成大小写敏感、单根读不到被升级成整格错误、`readRoot` 不拦相对路径、行数据里不带 `root`、`save()` 白名单删掉 `repos`、`DEFAULTS` 删掉 `repos`、preload 删掉 `pickFolder`、settings 保存不写 `config.repos`——12 条出 ✗。**第 13 条是故意不红的**：把 `settings.js` 里的 `uniqueRoots()` 调用改成直接用 `split('\n')`，离线自检只报「这函数还定义着」，因为那段代码属于浏览器那一侧，node 里 require 不动它。这条缺口由 appprobe 走真卡片补了一半（真改一次 roots 再改回来），另一半——重复行与空行的清洗——仍只由主进程那份 `normalizeRoots` 保证。
- **真机探针**：改 `styles.css` 后让渲染层重载再跑。`.pj-item` 字号降到 0.72rem（10.8px）出「行字号低于 13px 的可读下限」；`.pj-list` 的 `overflow-y` 改成 `hidden` 出「列表不是自己滚的」。第三条变异是 `.pj-item` 加 `overflow:hidden`（相册/修改器那两格的旧教训），**探针没报红**——量过几何才知道这里它确实无害：`.pj-item` 是纵向 flex 里的 stretch 项，不是横向 flex 里那个会被塌掉内容盒的项，加与不加每一行的矩形完全一样（名字 170px、IDE 标签、时间三段都在行内）。那条规矩写在 `styles.css:904`–`:906` 的注释里，不靠探针兜。
- **roots 往返那段是这一轮新加的，也是最该当心的一段**：它真点设置面板那张卡片、把 `toolbar.config.json` 里的 `repos.roots` 换成临时目录（里面放一个 `ProbePkg/package.json`），等项目格只剩 `ProbePkg` 一行，再换回原来那批根并核对。因为「保存并应用」重写的是**整份**配置而不止这一栏，探针必须先把这个文件逐字快照下来、收尾按字节还原（`process.on('exit')` 也挂一份，中途抛错也还原）。第一版没做这件事，跑完把 `display.index` 和 `alwaysOnTop` 一起写坏了——**那是真副作用，不是断言写错**。还原后还要比对除 `repos` 之外没别的一段被动过。
- 探针自己也在那轮被修过两处：① 「右侧两段挤出行外」原来拿**首行**的矩形去比每一行，纵向必然越界，于是 6 行里固定报 5 行——改成每一行跟自己比；② 「收尾切回原页面」原来在点完 tab 之后才问当前页，只能问出 `work`，改成点之前先记。两处都是假红/假绿，不是界面问题。

## 9. 已知边界

- **探针换的是渲染层那一侧**。主进程的 `scan()`/`launch()` 没被真调用过（除了取列表那一次真 IPC），所以判序、只认 id、防抖、spawn 两条失败来路、那几句「读不到」的文案只由 `projects-check.js` 钉（它不启应用，直接 require 服务，spawn/openPath 都是构造函数上留的接缝）。
- **根目录填错不在输入时拦**。卡片那一栏保存时只洗空行和重复，路径写得对不对要到扫的那一刻才由 `readRoot()` 说；这也是 `warnings` 不掀整张表的理由——一批根里错一条，其余的还是能看。
- **IDE 只认 JetBrains 那一套启动器形状**（`<安装>/bin/<产品>64.exe <项目路径>`）。VS Code / Cursor 那种要走别的机制，不在这一格；认不到启动器时行上是警告色 + 一句人话，不会静默点了没反应。
- **认不出类型就默认 WebStorm**，不是弹窗问一句。`why` 里那句「认不出工程类型，走默认 IDE」就是给人核对用的。
- **这一格自己不算 git 状态**：行上只有 `git` 这个布尔值（这个文件夹是不是仓库），用来决定右边那格出详情还是出信息卡。改动清单、分支、领先多少、提交推送都在**右边那一格**（`docs/git-panel.md`）；「在 IDE 里跑起来」「最近提交说明」仍然一概不做。
- **空文件夹也列出来**（悬浮说明里补一句「这是个空文件夹」）：`pycharm/`、`webstorm/` 这种是各 IDE 的默认项目位置，藏起来反而让人以为扫描坏了。
