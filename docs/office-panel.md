# 办公文档（工作面板 officezone）

他点名的第 3 块：「工作面板 gauges slot2 个合并到一起，显示办公内容 word excel ppt 等，`D:\OneDrive\办公` 这是文件夹指向」。
于是工作面板那一列从上到下变成三块——`projzone`（项目）、`gitzone`（git）、`officezone`（办公文档），`workbench`/`clipboard`/`topbar`/`dock` 一格没动。

这一格只做「列出来 + 交出去」：

- **只读**——扫文件夹、按最近改动排、点开交给系统默认程序；不转码、不改名、不删、不写任何文件（除了 `toolbar.config.json` 里那一条文件夹路径）；
- **不猜哪该软件该起来**：走 `shell.openPath()`，Word / Excel / WPS / 阅读器由系统的扩展名关联决定，代码里不出现 `WINWORD`、`EXCEL.EXE` 这种名字；
- **不出网**：这一格一条网络请求都没有，CSP、`track://`、凭据都不沾。

## 1. 分工

| 位置 | 干什么 |
| --- | --- |
| `src/main/services/office.js:27` | `KIND`：四类各收哪几个扩展名（唯一一处清单）；`:35` 反查表 `EXT_TO_KIND`；`:44` `readableDir()`；`:52` `walk()`（递归 + 深度 <4 + 跳过目录 + 锁文件闸）；`:112` `scan()`（六句「没东西可看」）；`:149` `pick(id)` |
| `src/main/services/office.js:19-25` | `CACHE_TTL_MS=60000`、`DOUBLE_CLICK_GUARD_MS=3000`、`MAX_DEPTH=4`、`DEFAULT_LIMIT=300`、`SKIP_DIRS`、`LOCK_RE = /^~[$]/` |
| `src/main/config.js:41` | `office: { folder: 'D:\\OneDrive\\办公', recursive: true, limit: 300 }`；`:163` 是 `save()` 白名单里那一条——**少了它「保存并应用」会把整段抹掉** |
| `src/main/main.js:742` | `office = new Office({ getConfig: () => config })`——服务只从配置读文件夹，渲染层递不进来路径 |
| `src/main/main.js:519-530` | 四条 IPC：`office:scan(force)`、`office:open(id)`、`office:reveal(id)`、`office:pickFolder`（原生选目录后**由主进程**写回配置） |
| `src/preload/preload.js:137` | `TB.api.office` = `scan` / `open` / `reveal` / `pickFolder`。**没有 `save`**：这一格不记「上次打开哪份」 |
| `src/renderer/js/components/office.js` | 头部（标题 / 计数 / 四类 chips / 重扫）+ 一列清单；`row()` 里那句 `lastClick` 是双击的第二发 click 闸门 |
| `src/renderer/js/settings.js:174` / `:669` / `:740` | `officeFolder` 输入框 + 「浏览…」按钮、「办公文档」卡片、保存补丁 `config.office = { ...config.office, folder: … }`（只改 folder，`recursive` / `limit` 不该被重置） |
| `src/main/layout.js:19` / `:58` / `:83` | 位置名 `officezone`、`WORK_GRID` 第 3 列两行都写它、work 页 `modules: { …, officezone: 'office' }` |
| `layout.json:209/215/240` | 磁盘上那份 work 页——和 `DEFAULT_PAGES` 必须逐字一样 |
| `src/renderer/styles.css:1037` | `.office-area` / `.of-*` 那段（`#office` 在 `.area` 里吃满 572×402） |
| `tools/office-check.js` / `tools/office-appprobe.js` | 离线自检 / 真机探针 |

## 2. 骨架：第 3 列两格并成一整块

工作面板用的是自己那份 `WORK_GRID`（行列和全局骨架逐字相同，只是 `areas` 不同）：

```jsonc
"areas": [
  ["topbar",   "topbar",   "topbar",   "topbar"],
  ["projzone", "gitzone",  "officezone", "workbench"],   // ← 第 3 列从这行起
  ["projzone", "gitzone",  "officezone", "clipboard"],   // ← 一直到第 3 行底
  ["dock",     "dock",     "dock",      "clipboard"]
]
```

第 2、3 两列都是 `minmax(0, 1fr)`，所以 `officezone` 和 `gitzone` **等宽**（真机量到 572×402，左边缘 930 = gitzone 右边缘 921 + 9px 列间距），三块同顶同底。原来合掉的 `gauges`（第 2 行跨中列那半）和 `slot2`（第 3 行中列右格）在 work 页**不许再出现**，`validate()` 才过。

落位改两处且必须逐字一致：仓库里的 `layout.json`（磁盘那份才是权威）和 `layout.js` 的 `DEFAULT_PAGES`（兜底）。`layoutStore.load()` 校验不过会**整份退回默认**，所以写坏了磁盘那份、画面却"看起来对"是这里最阴的一种错——`office-check.js` 第 5 段就是拿来钉这两份的。

`slotsOfGrid` 是行优先去重，所以工作面板的格子清单变成 `projzone,gitzone,officezone,workbench` 四格，设置里「模块与位置」那 19 个可选位置多了 `officezone`、少了 work 页的两个旧名字。

## 3. 收哪四类，为什么

| 类别 | 牌子 | 收 | 为什么这几条 |
| --- | --- | --- | --- |
| `word` | 文档 | `.doc` `.docx` `.docm` | docm 带宏，但它是 Word 能开的东西——这一格只读，宏不宏由系统关联决定 |
| `sheet` | 表格 | `.xls` `.xlsx` `.xlsm` `.csv` | csv 是他在 OneDrive 里真会有的那类纯文本表；不收 `.xlsb`（少见，默认程序不一定关联） |
| `slides` | 演示 | `.ppt` `.pptx` `.pptm` | 同上，新旧都收 |
| `pdf` | PDF | `.pdf` | 单列一类，不塞进「文档」：他要找的是「发出去的那份 PDF」 |

`odt` / `md` / `txt` / 图片 / 音视频**故意不收**——列出来只会稀释这份清单。`office-check` 第二段钉的是**双向相等**：`KIND` 里每个扩展名都进得了 `EXT_TO_KIND`，且四类并集恰好等于扫描器认的集合，加一类必须同时改一处（`KIND`）而不是在 `walk()` 里再加一个分支。

还有两个闸门：

- `LOCK_RE = /^~[$]/` 挡住 Office 的锁文件（打开 docx 时同目录会冒一个 `~$xxx.docx`，162 字节）。它不是一类文档，是"这份正被人编辑"的副作用，列出来只会多一条点得开、开了报错的行；
- `SKIP_DIRS` 里的 `.onedrive` / `OneDataCache` 是 OneDrive 自己的缓存目录，里面全是占位副本——指向 OneDrive 子目录时不把整份缓存当文档扫出来。

## 4. 打开只认 id，不认路径

QODER.md 那条「主进程不接渲染层给的文件路径」在这一格是硬线：

- 渲染层递来的 id 必须命中 `this.byKey`（`pick()`，`:149`，键是**小写全路径**，换大小写仍认得上次那条）；
- 没命中一律拒绝并回一句「列表已过期，请点「重扫」」，**一个进程都不起**；命中了才用**缓存里那份 path** 去 `shell.openPath`。
- 所以哪怕探针把 `D:\Windows\System32\x.docx` 当 id 递进去，也只是「列表外」被拒；这一条在 `office-check` 第 4 段用替身 `openPath` 数调用次数钉死（0 次）。

行数据里带 `path`，但它**只出不进**——用来写悬浮提示（他在递归子目录里得知道那份表在哪个文件夹）。失败句子一律过 `redactPaths` 打码，系统原话里的盘符不会弹给他看。

`DOUBLE_CLICK_GUARD_MS = 3000` 是同一条的重复打开闸门：3 秒内第二次点同一份只回一句「刚刚已经点开过同一个，等它起来」，不起第二个 Word。

## 5. 六种「没东西可看」各说一句

| 情形 | 谁说的 | 画面 |
| --- | --- | --- |
| 没配置文件夹 | `scan()` 第一条 | 计数牌「未就绪」+ 格子里「还没配置办公文档文件夹（设置 → 办公文档 → 文件夹）」 |
| 写了相对路径 | `scan()` 第二条 | 「文件夹路径要写绝对路径：办公\子目录」 |
| 文件夹不存在 | `scan()` 第三条 | 「文件夹不存在或不可读（ENOENT）」 |
| 那是个文件 | `scan()` 第四条 | 「所选路径不是文件夹」 |
| 读不动（权限） | `scan()` 第五条 | 「没有读取权限」 |
| 里面没有这四类 | `scan()` 第六条 | 计数牌「0 份」（这一条带 `empty`）+「该文件夹里没有 Word / Excel / PPT / PDF 文件」 |
| 列表已过期 | `open()` / `reveal()` | toast 一句「列表已过期，请点「重扫」」 |

**「没有读取权限」必须排在 `walk()` 之前**：`walk()` 里读不到的子目录是静悄悄跳过的，把这条判断放到它后面，权限问题会被说成「里面没有 Word 文件」——那是会把人引到设置里去翻的错误方向。`office-check` 第 1 段用替身 `fs.readdirSync` 抛 `EACCES` 钉住这一条。

前五条是「压根没扫成」，第六条是「扫成了、里面就是没有」——这两件事在协议上得分开，不然计数牌会把一个正常空文件夹报成故障。所以 `scan()` 只在第六条那条 return 上带 `empty: !found.length`，其余五条不带；渲染层按 `error && !empty` 才写「未就绪」，空文件夹写「0 份」。`office-check` 六条都钉：没扫成那五条各自判 `empty` **不为真**，第六条必须为真（没权限那档在 Windows 上造不出真目录，所以和文案一起走替身 `readdirSync`）。

`D:\OneDrive\办公` 现在是空目录，所以这格的默认画面就是第六条那句加一块「0 份」。真机探针因此分两步：先**真扫**（回来的条数和 DOM 行数必须一致，且这一档的计数牌必须是「0 份」而不是「未就绪」），再用替身 40 行演「有文档时长什么样」。

## 6. 手势：一次单击就交出去，第二发 click 自己咽掉

| 手势 | 做什么 | 为什么这样定 |
| --- | --- | --- |
| 左键 | `office.open(id)` | 这一格旁边没有第二格要喂，「选中」没有第二个用途；点开一份文档正是他扫这个文件夹的目的 |
| Ctrl/Cmd + 左键 | `office.reveal(id)` | 想找的是那份文件本身，不是它的内容——直接在资源管理器里选中 |
| 点四类 chips | 本地过滤，**一条 IPC 都不发** | 筛选是显示的事；重扫由「重扫」按钮管 |
| 点「重扫」 | `scan(true)` | 刚存了新文件、或改了设置里的文件夹之后用 |

代价是一次单击就拉起 Word/Excel，而浏览器在双击时一定先送两发 `click`。所以 `row()` 里那句 `lastClick` 把 500ms 内同一条的第二发咽掉——不然主进程那 3 秒防抖会把「刚刚已经点开过同一个」当失败每次弹回来，双击一次反而每次都被警告一句。探针干跑验的正是「连点两次只发 1 次 `open`」。

有 `error` 时列表只留那句提示、一行文档都不渲染，计数牌跟着那句走：没扫成写「未就绪」，扫成了但里面没有写「0 份」（这一条是探针抓到过、再钉进 `office-check` 的：牌子按 `items.length` 写「6 份」而画面只有一句提示，自相矛盾；反过来把空文件夹一律写成「未就绪」，等于给他一个假故障——真机就踩过这个，`D:\OneDrive\办公` 空着的那几轮牌子一直亮「未就绪」）。

## 7. 排版规矩（572×402）

`.area` 是 `overflow:hidden`，内容超了不报错、只是看不见——所以竖向吃满交给 `.of-list` 自己滚（`styles.css:1084`，`flex:1 1 auto` + `min-height:0` + `overflow-y:auto` + `overflow-anchor:none`），`.of-list > *` 一律 `flex:0 0 auto` 不许被压扁。少了这两条，列表会被压成十几 px 的空壳，DOM 全在、探针全绿，人却看不清（git 那一格踩过，规矩抄到这里）。

- 截断交给 `.of-name` / `.of-dir` 自己写省略号，`.of-item` **不写** `overflow:hidden`：写了父级裁切，行内容盒在横向 flex 里会塌成 0；
- 行字号 14px（≥13px 这条是这屏 dpr=1 的下限），四类牌子四种颜色（`accent` / `ok` / `warn` / `error`），牌子只写「文档 / 表格 / 演示 / PDF」四个词；
- 每行右侧两列是所在子目录和 `TB.util.ago(mtime)`：递归扫的时候「在哪一层」比文件大小有用，大小放悬浮提示里；
- 40 行时列表内容 1157px、可视 364px，也就是他自己滚——这一格没做「限制显示行数」，`limit: 300` 是主进程那侧的闸。

## 8. 改完跑什么

```bash
npm run office:check                       # 离线，不碰应用
# 另一个终端：
unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
npm run office:appprobe -- 9223 --shot     # 改了渲染层代码加 --reload，不用重启应用
```

`office:appprobe` 起手先看 `TB.api.office` 在不在——不在说明跑的是旧主进程，直接停（否则下面全是假绿）。截图两张：`samples/office-panel.png`（真扫那一批，现在就是空文件夹那句）、`samples/office-rows.png`（替身 40 行的几何）。跑完恢复真 API、他原来的面板。

这一轮踩到五条**探针自己的**坑，都改在探针里而不是改应用去迁就：

1. 替身只能换 `TB.api` 这个键本身。`window.deskToolbar` 由 contextBridge 造，属性只读且不可配置，`TB.api.office = 替身` **静默失败**（渲染层不是严格模式）——「切筛选 0 次 IPC」那种断言会恒真。现在照 `projects-appprobe` 的办法浅拷一层再换，并先自问一句「替身换上去了吗」，没换上直接报假绿。另外别拿 `TB.api.office.scan.length` 当真假的标志：跨过 contextBridge 的函数是包过的代理，形参个数会变 0。
2. 滚动容器里的行不能拿视口矩形和格子比：第 13 行以后本来就该在画面外等滚动。改成「横向不出格 + 纵向落在列表的滚动内容里」。
3. 布局探针里「紧贴」不等于「右边缘 = 左边缘」：列与列之间隔着 9px 列间距，尺子要从左边那对（`projzone`→`gitzone`）量出来再用。
4. 换替身时浅拷的**来源**和收尾的**还原目标**都得写 `window.deskToolbar`，不能写 `TB.api`：上一趟探针留下的替身此刻就挂在 `TB.api` 上，拿它当「真 API」还回去，这一趟收尾会绿、下一趟起手却站在替身身上跑（假绿）。探针起手先自问一句 `TB.api !== window.deskToolbar`，脏了就当场指回去并打印出来。
5. **`--reload` 只换渲染层，改了主进程必须重启应用**，而这一条探针本来看不出来：那句 `want` 是照着主进程回来的 `empty` 现算的，旧主进程不回 `empty`，`want` 就跟着算成「未就绪」——**旧进程照样能骗绿**（真踩过：截图里牌子明明写着「未就绪」，命令行打的却是 ✓）。现在 `empty` 位兼任新旧主进程的门：「该文件夹里没有 …」这句只和 `empty` 一起来，句子到了、位没到，就直接判不绿并写明「重启应用再跑」。这条闸门验过是活的——把 `empty: !found.length` 删掉重启，探针出 ✗。

判绿之前先做一次变异（QODER.md 那条老规矩），55 条都必须出 ✗：`KIND` 加 `.odt`、去掉 `.csv`、`LOCK_RE` 改成 `/^~/`、`readableDir` 那句挪到 `walk()` 之后、`byKey` 的键改成原样大小写、`open()` 改成直接吃路径参数、`config.js` 白名单删 `office:`、`WORK_GRID` 第 3 列第 3 行改回 `slot2`、`layout.json` 那份单独改、preload 通道名改掉、组件里把 `item.path` 递进 `open()`、`.of-list` 的 `min-height:0` 删掉，以及这一轮新加的五条（三类改坏）：`empty: !found.length` 整位删掉、给「没配置」和「读不动」那两条也补上 `empty`、组件那句退回 `error ? '未就绪'`（含丢掉 `!this.data?.empty` 和把它取反）。

## 9. 已知边界

- **`office:check` 才是服务语义的守门人**：探针把渲染层那侧的 IPC 换成记账替身后，主进程没被真调用过，所以六句文案、排序、深度、缓存、只认 id 这些只由离线自检钉——它不启应用，直接 require 服务。
- **能不能打开 = 他机器上的扩展名关联**。`.docm` 被组策略挡住、`.ppt` 只有阅读器关联这类事，`shell.openPath` 只会回一句系统原话（打过码），这一格不重试、也不换程序去试。
- **`limit` 默认 300、深度上限 4 层、跳过 `.git` / `node_modules` / OneDrive 缓存**。把整个 OneDrive 当文件夹会慢，也会一次刷出几百行——真要那么大范围就该按子目录选。
- **没有「上次打开哪份」**：文档不像音乐视频有进度可言，所以 `preload` 里没有 `office.save`，`state.json` 里也不新增段落。
- **没做新建、重命名、删除、批量打包**，也没做「按类别分屏」。要动文件他自己在资源管理器里动，这一格只负责把他带到那一份面前。
