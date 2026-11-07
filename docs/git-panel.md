# git 状态（工作面板中间那一整块 gitzone）

工作面板（`work`，绑第 2 个虚拟桌面）左边一整块是项目列表（`projzone`，见 `docs/projects-panel.md`），中间那一整块是 `gitzone` 挂 `git`。**它不是一个仓库列表，是项目格的第二个视图**：左边点中哪一行，右边就只看那一个仓库——有什么还没交出去、四步能走哪几步。

三态各是的一句话：

| 左边点了什么 | 右边这一格 |
| --- | --- |
| 什么都没点（刚切过来） | 整格一句「点左边一个项目，这里就看它的仓库」，**不发 IPC、不起进程** |
| 一条真仓库 | 仓库块（分支 + `↑2 ~25 +55` 徽章、上游 / HEAD / 暂存一句话）+ 改动清单（自己滚）+ 四个动作 + 那句提交说明 |
| 一条非仓库文件夹 | 项目信息卡：该用的 IDE / 按哪条判的 / 上次动过 / 这个文件夹 / 来自根目录，底下再列 `repos.roots` 那几处 |

这一格是**项目格的第二个视图**，不是一个新列表：

- 同一批项目、同一套 id、同一个顺序基准——那一行是拿项目格选中那条去 `git status --porcelain=v2` 现读出来的，`id` 就是项目格那行的 `id`；
- 点一个改动文件，用哪个 IDE 是**项目格判的那一个**，这一格不另判一套；
- 只到 fetch/pull/commit/push 四步。**切分支、stash、丢弃改动、`--force`、`reset`、`clean` 一概不做**，代码里没有那条路径；
- 凭据不经手：走系统 git 和它自己的凭据助手，这一格不读不写任何 token。

## 1. 分工

| 位置 | 干什么 |
| --- | --- |
| `src/main/services/git.js:46` | `STATUS_ARGS`：`-c core.quotepath=false --no-optional-locks status --porcelain=v2 -z --branch`——`-z` 是为了路径里带空格和中文，`--no-optional-locks` 是为了不跟 IDE 抢索引锁 |
| `git.js:49` | `GIT_ENV`：`GIT_TERMINAL_PROMPT=0` + `LC_ALL=C`，任何一步要问口令就直接失败而不是挂着等输入 |
| `git.js:71` | `OPS`：四个动作各自的 argv 和超时（提交 20s / 网络 60s / 推送 120s） |
| `git.js:81` | `BANNED_ARGS`：`reset` `clean` `checkout` `stash` `push --force` 那一类——**在起进程之前**拦，不看 op 看 argv |
| `git.js:89` | `assertSafeArgs(argv)`：逐段比对，`-m` 后面那句提交说明跳过（否则说明里写了 `reset` 就被自己拦下） |
| `git.js:110` | `gate(kind, row, message)`：闸前拒的七种（游离 HEAD / 有冲突 / 说明空或超长 / 只有未跟踪 / 没上游 / 领先 0 / 尚无提交），每种一句话 |
| `git.js:145` | `confirmLines(op, row, message)`：确认条上那两三句话，已跟踪与未跟踪分开说 |
| `git.js:218` | `parsePorcelain(text)`：`-z` 记录流 → 行；`1`/`2`/`u`/`?` 四种记录各按自己的段数切（9 / 10+NUL 后跟来源 / 11 / 2），改名那条的 `from` 是**下一个 NUL 段**，不是按前缀猜 |
| `git.js:277` | `countFiles(row)`：`tracked` 是**几个文件**，不是 staged + unstaged（`MM` 那个文件同时占两边名额，加起来会多报一个） |
| `git.js:293` | `runGit()`：stdout 攒 Buffer 再整体 decode（分块 toString 会把中文路径切坏）、`MAX_OUTPUT=4MB` 截断、超时 kill 之后**等 resolve** |
| `git.js:376` | `WRITE_FAILS`：git 的英文原话 → 人话，逐条按 2.56 实测原话写；`redactPaths` 保证句子不漏盘符 |
| `git.js:467` | `projectRows()`：向项目格要那批行（`getProjects: () => projects`，`main.js:718`）——**每次现取**，不是构造时的快照 |
| `git.js:480` | `idle(need, focusId)`：没选中、以及选中项已经不在列表里，两种"这一格没得看"都从这里出，`rows` 恒为空 |
| `git.js:491` | `refresh(force, focusId)`：**只读 focusId 那一条**。缺 focusId 就 `idle('select')`，连 `git --version` 都不起；那一条 `!item.git` 也早退，非仓库不发起进程 |
| `git.js:562` | `one(exe, item)`：单个仓库的读；`git` 不在本机时整格只说一次（`notFound`） |
| `git.js:614` / `:622` / `:633` | `pick(id)` / `fileAt(id, index)` / `projectItem(id)`：把「行 id」翻回项目格那一条，两格对同一条项目的称呼一致 |
| `git.js:641` | `prepare(id, op, extra)`：**不发任何写命令**，只现读一遍状态、过闸、生成一次性 nonce 和那几句话。现读的那条行**不写回缓存**（写回会让点文件的序号错位） |
| `git.js:706` | `confirm(nonce)`：只认 nonce；对不上不吃 pending（否则老确认条会把刚点出来那条合法的一起吃掉）；用完即清 = 一次性 |
| `git.js:745` | `fileTarget(id, index)`：`(行 id, 第几条)` → 项目 id + 绝对路径，路径由主进程自己拼 |
| `src/main/services/projects.js:391` | `openFile(id, target)`：`insideDir()`（`:85`）在落 spawn 参数之前再核一遍路径还在不在那个项目目录里 |
| `src/main/main.js:489`–`:498` | 五条 IPC：`git:status(force, id)` / `git:prepare` / `git:confirm` / `git:cancel` / `git:openFile` |
| `src/preload/preload.js:122`–`:127` | `TB.api.git` 五条通道，一一对应 |
| `src/renderer/js/app.js:199` | `selectProject(item)`：选中态存在 `TB.app.state.project`（存整条行，不只 id），同时 `refresh('projects')` 和 `refresh('git')`；同一行重选返回 `false`、不重渲染 |
| `src/renderer/js/components/git.js:51` | `selected()`：这一格问「现在选的是谁」只问 `TB.app.state.project`，自己不留一份 |
| `git.js:85`–`:150` | `update()` / `render()` / `renderList()`：三态分派；挂着确认条时整格只渲染那一条（§6） |
| `git.js:152`–`:283` | `repoBlock()` 详情（头 + 清单 + 动作 + 说明框）、`fileList()`（序号就是数组下标）、`actions()` 四个动作、`messageBox()` 说明框常驻 |
| `git.js:286`–`:363` | `infoCard()` 非仓库那五句 + `rootsList()` 根目录清单——五句**逐字抄自 `TB.app.state.project`**，不另发 IPC；根目录抄 `TB.projects.data.roots` |
| `git.js:364`–`:440` | `confirmBar()`、`startAsk()` 那 5 秒倒计时、`stopAsk()`、`cancelAsk()`（**要重渲染**）、`confirmAsk()`（只递 nonce）、`openFile(id, index)` |
| `src/main/layout.js:56` / `:81`、`layout.json:182`–`:258` | 工作面板自带 grid：左列两行合成 `projzone`、中间第 2 列两行合成 `gitzone`，`modules: { projzone: 'projects', gitzone: 'git' }`（两份都要改，且必须逐字一样） |
| `src/renderer/styles.css:1040`–`:1470` | `.git-area` / `.gt-*` 那一段，§6 那几条排版规矩都在里面有注释 |
| `tools/git-check.js` / `tools/git-appprobe.js` | 离线自检 / 真机探针（`npm run git:check`、`git:appprobe`） |

## 2. 关联：id 是同一批，而且只跟着点走

两格的关联如果只做在「都列 D:\GitProject 下的文件夹」这一层，迟早会分叉：一边按 reflog 排、一边按分支排，或者一边把 `game/` 当项目、另一边当非仓库。所以这一格不自己扫盘，它**吃项目格那批行**：

- `Git` 的构造函数拿的是 `getProjects: () => projects`（`main.js:718`），每次刷新现取，项目格换了一批行，git 格跟着换；
- **联动只做在渲染层**：左边点一行 → `app.selectProject(item)` → `refresh('git')` → `TB.api.git.status(force, sel.id)`。id 直接沿用项目格那行的下标——`git:openFile(id, index)` 里那个 `id` 交给 `projects.openFile(hit.projectId, ...)` 用的还是同一个 id，两格对同一条项目的称呼一致；
- 服务那边 `rows` 最多一条，而且必须就是 focus 那一条（探针按 `rows.length === 1` 且 `rows[0].id === focusId` 钉）；
- 载荷契约 `cached,focus,focusId,git,need,rows,scannedAt`，`focus` 只有 `id,name,repo,root` 四键——**除 root 以外没有盘符路径**，也没有 git.exe / JetBrains 那类绝对路径；
- 非仓库那张卡要说的四句话（IDE、判据、多久没动、来源根）本来就写在项目格那行上，所以直接从 `TB.app.state.project` 抄，为它们再开一条 IPC 是重复；根目录清单抄 `TB.projects.data.roots`；
- 排序基准也一样（`touched` 倒序），切过去不用重新找那一行在哪儿；
- 根目录两格共用一份 `repos.roots`（配置化那一段见 `docs/projects-panel.md` §2.1）。

`git-check.js` 钉这条关联的方式是行为级的：把项目格的行改一条（多个/少个/换个顺序），再看 git 的 `payload()` 跟着变不变；以及 `fileTarget(id, index)` 递回的 `projectId` 必须就是那一条项目。

## 3. 读侧：porcelain v2 的四种记录，段数不一样

`--porcelain=v2 -z` 出来的是一条条以 NUL 分隔的记录，**每种记录的段数不同**，按列数硬切会切错：

| 记录 | 段数 | 要点 |
| --- | --- | --- |
| `1 <XY> …` 普通改动 | 9 | 路径是第 9 段（`cols[8]`），往前一段就切在路径中间 |
| `2 <XY> …` 改名/复制 | 10 + 一段 | 第 10 段之后**另起一条 NUL 段**才是来源路径，按 `^1 ` 前缀猜会多吐一条假改动 |
| `u <XY> …` 冲突 | 11 | 少切一段就会把 stage 的 hash 当路径显示出来 |
| `? <path>` 未跟踪 | 2 | 单独计数，见 §5 |

另外三条实测才知道的事：

- **路径列不能 split(' ')**：`columns(record, count)` 是按空格切够段数、剩下的整段当路径，所以 `src/我的 文件.js` 这种带空格的路径不会被切；
- **中文路径**：`core.quotepath=false` 关掉八进制转义，同时 `runGit` 必须把 stdout **攒成 Buffer 再整体 decode**——分块 `toString()` 拼接会在 UTF-8 多字节中间切开；
- **输出可能巨大**：`MAX_OUTPUT = 4MB` 截断，但跨过上限的那一块仍然收下（只看不收会让"一整块就超标"把整段输出扔了，那一行只能回一句"没读懂 git 的输出"，而真相是"太大了"）。

## 4. 写侧：两步，中间那个人是唯一的路

按钮点下去**只发 prepare**：

```
点「提交」 → prepare(id, 'commit', {message}) → 主进程现读状态 → 过闸 → 一次性 nonce + 那几句话
点「确认」 → confirm(nonce)                                      → 起 git 进程
```

- 渲染层在 confirm 这一步递不进任何东西：`TB.api.git.confirm(ask.nonce)` 只有一个参数（`git-check.js` 有一条正则钉它，多递一个参数就红）；所以「给他看的那句话」和「真跑的那条命令」不可能对不上；
- nonce 5 秒过期（`CONFIRM_TTL_MS`），过期自己作废并且**说一句**（"确认超时（5 秒），这一步没做"）——不然是他点了没反应；
- 一次性靠"用完即清"，而"清"只在 nonce 对上之后做。原来是无条件先清，实测出一个真故障：渲染层留着的老确认条对不上时，会把**刚点出来那条合法的**一起吃掉，用户点新条得到一句"没有待确认的操作"；
- **确认条挂着时换项目 = 取消**：`update()` 起手比 `ask.id` 和当前选中，不一样就 `cancelAsk()` 并给主进程发 cancel。这一格只演一个仓库，切走了还留着上一条的"待确认"会说谎；
- 参数级门禁 `assertSafeArgs` 不看 op 看 argv：就算 `OPS` 被人改成 `push -u --force`，起进程之前也会被拦下（变异测试里 #10/#11 就是靠这条变红的）；
- **推送是别人看得见的动作**：确认条上明写「这一步别人看得见」，按钮单独一色；探针里绝不点那一下（见 §8）。

## 5. 未跟踪的文件：单独数、单独说

`git commit -a` 只带走已跟踪文件的改动，未跟踪的一个都不带。所以：

- 状态徽章写 `~25 +56`，两个数分开；
- 确认条第一句是「提交 25 个已跟踪文件的改动（只 add 过的和改过的）」，第二句是「未跟踪的 53 个不会被带上，这一步没有 add」；
- 只有未跟踪、没有已跟踪改动时，`gate()` 在闸前就拒——否则 `commit -a` 会静默什么都不提交，还回一句"提交完了"。

`countFiles()` 里那个 `tracked` 也栽过一次：它原本等于 staged + unstaged，而一个 `MM` 状态的文件同时占两边名额，"提交带走几个"会多报一个。这句话是他按不按确认的依据，不能骗人。

## 6. 排版：572×402 一整块，竖向空间要给清单吃

`gitzone` 是工作面板自带 grid 里第 2 列的第 2+3 行（`src/main/layout.js:56` 的 `WORK_GRID`），和左列 `projzone` 同顶同底同高——本机量到 572×402。这一格从 330×176 放大过来以后，踩的坑换了方向：**不是装不下，而是太空**。

四条形状规矩：

1. **详情块吃满竖向**：`.gt-list > .gt-repo { flex: 1 1 auto }`。原来写 `0 1 auto`（只许被压、不许伸长），改动少的时候整块缩在上半截、下面空 228px、清单只剩两行。探针补了一条：详情块底边到格子底边的距离不许超过 20px。
2. **清单是这一格唯一该滚的部分**：`.gt-files { flex: 1 1 40px; overflow-y: auto }`，动作行和说明框 `flex: 0 0 auto` 永远不让位；`.gt-list` 自己 `overflow-y: auto`，内容真超了它滚，不靠 `.area` 裁。
3. **确认条挂出来时整格只渲染它**（`renderList()` 第一段），并且**站在这块的正中**（`.gt-ask { margin: auto 0 }`）——和默认态那一句同一个处理。贴顶挂会在下面留一大截空，看着像读到了但没东西。探针量上留白和下留白，差过 12px 就红；同时钉"挂出来时 `.gt-repo` / `.gt-file` / `.gt-op` 一个都不剩"。
4. **非仓库那张卡不许把路径列成清单**：五句 label 逐字是 `该用的 IDE / 按哪条判的 / 上次动过 / 这个文件夹 / 来自根目录`，值逐字等于 `TB.app.state.project` 的对应字段；底下 `rootsList()` 列 `repos.roots`，一处都没有就写一句空态。

三条踩过才知道的老坑，仍写在 `styles.css` 对应规则的注释里：

- **`.gt-list > * { flex: 0 0 auto }`**：列表是纵向 flex，默认 `flex-shrink: 1` 会把展开行整段压扁——详情框缩成 12px 的**空壳**，动作行画在壳外面。探针当时全绿（它只比"在不在格子矩形内"），是放大截图才看见边框里空无一物。后来给探针补了两条断言：动作行必须落在详情框矩形内、清单行高不许小于 15px。
- **`.gt-file { flex: 0 0 auto }`**：`overflow: hidden` 的 flex 子项，其自动最小尺寸是 **0**（规范如此）。80 条改动挤在 38px 的框里会一起缩成每条 2px 高——框子高度正常、DOM 全在、文字全在，画面上只剩两条灰线。这条同样是放大截图才发现的。
- **`.gt-msgbox { flex: 1 1 100% }`**：动作行是 `flex-wrap` 的横向 flex，说明框写成 `flex: 0 0 auto` 时它的 `width: 100%` 是对着**内容宽度**算的，整框只有 145px，placeholder 被裁掉半句。补了一条断言：拿一个隐藏 span 量 placeholder 的实际字宽，和 textarea 的可用内宽比。

字号那条老规矩：这一格凡是给人读的都在 0.87rem（13.05px，本机 `1rem = 15px`）以上——**越是决定按不按的字越不该小**（原来确认条那几句话 11.7px、"确认"按钮 12px）。探针在默认态、仓库态、非仓库态、确认条挂出来那一刻各量一次字号，而且量**字形自己的矩形**（`Range.getBoundingClientRect`）而不是容器——容器上写 `overflow:hidden` 会在 flex 行里把内容盒塌成 0，DOM 全绿而人看不清。

## 7. 兜底文案

| 情形 | 谁说的 | 画面 |
| --- | --- | --- |
| 什么都没选中 | 服务 `idle('select')` + 渲染层 `.gt-prompt` | 一句「点左边一个项目，这里就看它的仓库」，计数牌「未选项目」，**零 IPC、零进程** |
| 选中的那条不是仓库 | `refresh()` 里 `!item.git` 早退 + `infoCard()` | 项目信息卡五句 + 根目录清单，计数牌「非仓库」，不起任何进程 |
| 选中项已经不在项目列表里 | 服务 `need='stale'` → 渲染层清掉选中并重扫项目格 | 回到「点左边一个项目」，不演一个已经不在面板上的项目 |
| 本机没有 git | `noGitMessage()`，整格一句 | 「没找到 git…（认的是 PATH 里那几个常见位置）」，一条进程都不起 |
| 这个仓库读不到 | `one()` → 那一行 `error` | 详情顶上「读不到」红徽章 + 一句为什么 |
| 提交说明没写就点提交 | 渲染层 `prepareOp` | toast「先写一句提交说明 —— 这一步我不替你编」，**不发 IPC** |
| 只有未跟踪就提交 | `gate()` | 「只有未跟踪的文件，commit -a 带不走它们…」 |
| 分支没有上游就推送 | `gate()` / `opTitle` | 「这条分支没有上游分支，git push 不知道该推到哪儿（第一次推送请在 IDE 或命令行里做）」 |
| 领先 0 还推送 | `gate()` | 闸前拒，不白起一次进程 |
| 游离 HEAD / 有冲突 | `gate()` | 一句话说明为什么这一步先别做 |
| pull 走不齐（diverged） | `WRITE_FAILS` | 用实测原话翻译的那句，说「只走快进」和下一步 |
| push 被拒（non-fast-forward） | `WRITE_FAILS` | 「远端有你本地没有的提交，先拉取…」，不怂恿 force |
| 提交说明里有 hook 失败 | `WRITE_FAILS` | 保留 git 那句关键话，路径打码 |
| 任何一句里带盘符 | `redactPaths` | 换成相对说法（探针按 `[A-Za-z]:[\\/]` 扫过确认条和 toast） |
| 进程 8 秒不回话 | `runGit` 超时 | 「git 没回话（8 秒），这一步没做」，kill 之后仍 resolve |

## 8. 改完跑什么

```bash
npm run layout:check                       # 两份落位 + 工作面板那块自带 grid 还对得上
npm run git:check                          # 离线，不碰应用
npm run projects:check                     # 关联那条链的另一半
# 另一个终端：
unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
npm run git:appprobe -- 9223 --shot        # 存 samples/git-idle / -repo / -card / -confirm / -panel.png
```

改主进程或 preload 必须**重启应用**（探针起手先真调一次 `TB.api.git.status(false)`，回包里没有 `focusId` 就当场停，不让后面几十条断言一句句假红）。**别拿函数参数个数当新旧门**：`contextBridge` 把每个 API 重新包一层，到渲染层 `Function.length` 恒为 0，新主进程也会被它自己判成旧的——这一条是真机踩出来的，所以门改成看一次真调用的回包。

探针里写侧**全部干跑**：换掉的是渲染层那一侧的 `TB.api.git`（`deskToolbar` 是 contextBridge 造的、属性只读，Proxy 拦不住，所以浅拷一层键再只换 `git` 那一个命名空间），只记账不 spawn。真通道那一次只走到 `prepare`（它不起任何写进程）→ 看确认条那几句话 → 点「取消」，**永不点真「确认」**。跑前跑后各取一次那三个仓库的 `rev-parse HEAD` 和 reflog 顶端，逐字比对——这是"一个字节都没动过磁盘"的旁证。

"这一格不发没用的 IPC"在三处可量，靠的是给只读通道包一层记账（`TB.__statusLog`）：默认态空转 3 秒 0 条、点一次只 1 条且 `id` 就是点的那行、选中不变再空转 3 秒又是 0 条；点「刷新」那一次必须是 `force=true` 且带着选中的 id。收尾把 `TB.api` 的键集合还原、把选中态还回跑之前那一条、把面板切回他原来那一页。

探针自己也在这轮被修过四处，都是它自己的错而不是界面的错：

- **拿 `Function.length` 当新旧门**：见上面第二段。
- **一条几何断言写反**：把 `gitzone.y < gauges.bottom` 当成"没跨过 gauges 那一行"，而正确几何下 gitzone 的顶边本来就等于 gauges 的顶边。跨行要比**底边**：`here.bottom` 必须越过 `gauges.bottom`。
- **只量框不量内容**：清单框正常、里面的行 2px 会全绿（老坑）；反过来"竖向留白"以前没人管，放大截图才看见详情只占上半截、下面空 228px。现在两条都钉。
- **点 tab 有竞态**（`layout-appprobe`）：上一趟切换留下的外壳重建会把刚查到的 tab 节点换掉，点在已经脱离文档的旧节点上不报错但没作用，于是"切到 game 却读到 life"。现在点完读一次 `TB.app.state.page`，不对就再点一次。

变异测试：一次性跑器逐条把源码改坏再跑对应自检，**50 条全部被咬到**，`--only=组名` 可以只跑一组。这轮新加的四条各钉一件事：`countFiles` 把 tracked 改回 staged+unstaged → 确认条那句"提交带走 26 个"对不上真文件数；组件 `cancelAsk` 去掉 `this.renderList()` → 点了「取消」确认条还挂着；`WORK_GRID` 的 `modules` 把 projzone 换成 placeholder → 落位两份配置当场分叉；项目组件 `render()` 去掉 `markSelection()` → 重扫以后左边看不出选的是哪一行。

## 9. 已知边界

- **这一格一次只读一个仓库**：`refresh(force, focusId)` 只对选中的那一条起进程，没选中连 `git --version` 都不起。把整批项目逐个 `git status` 一遍再按分钟轮询会把磁盘点着，而且左边只关心一行。
- **20 秒缓存只在切到这一格和点「刷新」时作废**：切走再切回同一条项目不重读，要新的一律点「刷新」（那一次 `force=true`，探针专门钉它带 id 且强制）。
- **不做 add**：清单里点文件名是"用 IDE 打开它"，不是"暂存它"。要暂存去 IDE 或命令行。
- **不做切分支 / stash / 丢弃 / force**：这四类是不可逆或会覆盖的，超出了"看一眼有什么没交出去"的范围。
- **推送第一次要人工做**：新分支没有上游时 `git push` 不知道该推到哪儿，这一格拒绝并指路去命令行，不替他猜一个 `-u`。
- **探针换的是渲染层那一侧**：主进程 `confirm()` 真起 git 写进程那一路只由 `git-check.js` 用假 spawn 验（argv 逐字、超时、失败翻译），真机上从没真提交/真推送过。
- **未跟踪文件多时清单会截**（`MAX_FILES = 400`），截了就在清单下面写一句"改动太多，这里只显示前面一部分"。
