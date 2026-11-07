# 游戏列表（游戏面板中间那一整块）

游戏面板原来中间是三格（指标 / Steam 游戏 / 修改器），现在**合成一格**，里面是**两列并排**的 Steam 游戏列表。每一格里：

- **左边**：32×32 的游戏图标（Steam 自己缓存的那张本地图）；
- **右上**：游戏名 + 右侧「多久之前玩过」——**点这一行**通过 Steam 客户端启动，Ctrl+左键打开安装目录；
- **右下**：这款游戏的修改器标签——**点标签**启动修改器，右键以管理员启动（走系统 UAC）。标签只在这款游戏有对应修改器时才出现，对不上的一个都不显示。

本机实测：60 款已安装游戏、64 个修改器 → **32 款挂着 40 个标签**，图标 60/60 都有。（这几个数字跟着他机器上的库和目录走，点「重扫」就是最新，别当常量写进代码。）

## 1. 分工

| 位置 | 干什么 |
| --- | --- |
| `src/main/layout.js` | 「本面板自带 grid」这一层：游戏面板的 `grid.areas` 把中间 2×2 合成 `gamezone` |
| `src/main/services/game-alias.js` | 别名表：一款游戏的中文名/英文 Steam 名 ↔ 修改器名字里的写法，`canon()` 归一化 + 最长键优先 |
| `src/main/services/library.js` | 把 Steam 库 + 修改器目录 + 别名表 + 本地图标缓存拼成渲染层要的那一份**行数据** |
| `src/main/main.js` | 一条 IPC：`library:list`（`steam:*` / `trainers:*` 原样保留，启动仍走它们自己） |
| `src/preload/preload.js` | `TB.api.library` 桥 |
| `src/renderer/js/components/games.js` | 标题栏 + 计数 + 「重扫」+ 过滤框 + 列表（图标 / 名字 / 标签） |
| `src/renderer/styles.css` | `/* ---------- games */` 那段 |
| `tools/games-check.js` / `tools/games-appprobe.js` | 离线自检 / 真机探针（启动链路干跑） |

`steam.js`、`trainers.js` 两个服务和它们的独立组件都还在：这一格只是把两份结果**拼成行**，启动、定位、防抖、只认 id 那些规矩一个都没绕过去。

## 2. 骨架：只给游戏面板换形状

`layout.json` 里 `grid` 本来只有全局一份，四个面板共用。现在**面板可以自带一份 `grid` 覆盖**：

```jsonc
"pages": [{
  "id": "game", "name": "游戏面板",
  "grid": {
    "columns": ["330px", "minmax(0, 1fr)", "minmax(0, 1fr)", "400px"],  // 必须和全局一致
    "rows":    ["32px", "176px", "minmax(150px, 1fr)", "78px"],
    "areas": [
      ["topbar", "topbar",  "topbar",  "topbar"],
      ["clock",  "gamezone","gamezone","workbench"],   // ← 中间 2×2 全是 gamezone
      ["player", "gamezone","gamezone","clipboard"],
      ["dock",   "dock",    "dock",    "clipboard"]
    ]
  },
  "slots": [ ... clock / gamezone(games) / workbench / player 四个 ... ]
}]
```

- 行列数必须等于全局，`topbar` / `clipboard` / `dock` 三个常驻位置必须在每页都出现——`validate()` 直接拒绝，切过去不会「顶栏没了」。
- 没带 `grid` 的面板照旧吃全局那份，所以主界面/工作/生活三页的形状一个字节都没动。
- 渲染层读的是 `TB.app.activeGrid()`（`activePage()?.grid || layout.grid`），设置里那句「位置固定」会跟着标出「（本面板自带骨架）」。
- 实测 `gamezone` 是 1152×402，正好等于主界面中间三格（gauges 1152×176 + slot1 572×217 + slot2 572×217 + 两个 9px 间距）拼起来的矩形。
- **列表自己是两列**（`.gz-list`：`grid-template-columns: repeat(2, minmax(0, 1fr))` + `align-content: start`，整块仍旧纵向滚）：60 款从 60 行变 30 行，内容高度 3111px → 1436px，一屏能看 14 款左右。三条要注意：
  - 读序是「第 1 条左、第 2 条右、第 3 条回到左列第二行」，所以**不能**写 `grid-auto-flow: column`——那样看上去也是两列，但变成先填满左列，「过滤框回车启动第一条」和 Ctrl+左键定位就落在眼睛看不到的对应关系上。
  - 用 `minmax(0, 1fr)` 而不是 steam 那格的 `auto-fill`：`gamezone` 的宽度是骨架里写死的，列数就该钉在 2，别跟着窗口抖。`minmax(0,…)` 的 0 是必须的，否则长游戏名会把列撑出格子。
  - 「没有匹配的游戏」那句提示横跨两列（`.gz-list > .muted { grid-column: 1 / -1 }`），不然它只占左列半宽，看着像少了半句。
- 游戏面板另外三格（`clock` 左上 / `workbench` 右上 / `player` 左下）**默认是空的**，和工作、生活两页一样——合并只动了中间那三格，别的页、别的格一个字节都没改。想让这一页也有时钟和音乐，在「组件与位置」里给这三格挑组件，保存才写 `layout.json`。

## 3. 对应关系：内置别名表，不做手动绑定

修改器文件名和 Steam 游戏名是两套写法：`[风灵]《侠客风云传》修改器` 对 `侠客风云传(Tale of Wuxia)`，《黑神话：悟空》修改器 对 `Black Myth: Wukong`。所以 `game-alias.js` 里逐款写死：

```js
{ steam: '古剑奇谭三(Gujian3)', keys: ['古剑奇谭三', '古剑奇谭3'] }
```

- `canon()`：NFKC → 小写 → 去掉 `[…]【…】(…)（…)` 这类**成对的括号组**（厂商前缀 `[风灵]`、平台后缀 `（XGP版）` 都是噪声，整组删掉）→ 只留 `[0-9a-z\u4e00-\u9fff]`。`《》` 不在删除的组里，只是作为标点被剥掉，里面的字还留着。
- **修改器 → 归属**：在它的名字里找所有能匹配上的键，**取最长的那个**（`仙剑奇侠传五前传` 赢过 `仙剑奇侠传五`）。所以一款游戏的键要写成能区分代数的样子：`古墓丽影9` / `古墓丽影崛起` / `古墓丽影暗影` 各归各，不靠上下文猜。
- **游戏 → 条目**：`canon(steam 名)` 精确等于表里某条的 `canon(steam)` 才算登记。一个键可以服务多款游戏，反过来一款游戏也可以有三个键（`Devil May Cry HD Collection` 收了鬼泣 1/2/3 三份修改器，列表里就是一行三个标签）。
- 表里登记了、这台机器上没装 → 不显示；装了、表里没有 → 只有游戏名，没有标签。**没有「未对应」分组**，这是定过的口径。

代价要说清楚：**这张表是手写的，跟着他机器上的实际名字走**。Steam 改了显示名、或者他换了一批修改器包，对应关系就会漂。漂了的症状是计数牌上「N 款有修改器」变小——`npm run games:check` 会验表自身的碰撞，`npm run games:appprobe` 会报真实数字。

## 4. 图标：Steam 自己缓存的那张 32×32

`<客户端根>/appcache/librarycache/<appid>/<40位十六进制哈希>.jpg` 就是 32×32 方图。那个哈希是 CDN 文件名的 sha1，**猜不出来，只能列目录**取里面唯一那张 `.jpg`。

客户端根从清单的 `LauncherPath` 里取（`path.dirname`），不是从库路径推——他有 9 份清单的 `LauncherPath` 指向 `C:\Program Files\Steam`（那个目录不存在），`Steam#appCacheDirs()` 会把不存在的根过滤掉，最后只剩 `C:\Program Files (x86)\Steam\appcache\librarycache` 一个根，实测 60/60 全覆盖。

路径由主进程给到渲染层，按桌宠图标同一个做法拼 `file:///`（CSP 里已经放了 `file:`，不外网抓图）。图没缓存上就退回一个同尺寸的透明占位，行高不跟着跳。

## 5. 启动：还是那两条老路，id 只认缓存

| 手势 | 走哪条 IPC | 之后 |
| --- | --- | --- |
| 点行（名字那块） | `steam.launch(id)` | `steam://rungameid/<appid>` 交给 Steam |
| Ctrl+点行 | `steam.reveal(id)` | 资源管理器打开 `steamapps/common/<installdir>` |
| 点标签 | `trainers.launch(id, false)` | `spawn` 那个 exe；被系统判为「要管理员」（EACCES）就自动补发一次 `Start-Process -Verb RunAs` |
| 右键标签 | `trainers.launch(id, true)` | 直接走 `Start-Process -Verb RunAs`（UAC） |
| 过滤框回车 | `steam.launch(visible()[0].id)` | 同第一行 |

补发 UAC 不是我们自己提权：弹窗还是系统弹的，点「否」就什么都不发生，提示条会说「UAC 弹窗被取消，没有启动」。这台机器 68 个 trainer exe 里 61 个的清单带 `requireAdministrator`（扫二进制里的 `requestedExecutionLevel` 数的），所以左键点标签经常要走这条兜底——不加它就会弹一个「spawn … EACCES」的主进程错误框。

`id` 分别是 Steam / 修改器两个服务**自己那批缓存的序号**，行数据里除了 `icon`（图片路径，渲染层只能拿去拼 `file://`）没有任何可执行路径，主进程也不接受渲染层递进来的路径。标签的 `onclick` 里 `stopPropagation()`，点标签不会顺带把游戏也起一遍。

## 6. 三个踩过的坑

**滚动锚定**：`.gz-list` 刚进来会自己跳到 `scrollTop 2666`。原因是 60 张 `file://` 图异步落地，Chromium 把「最后发生尺寸变化的那个」当成锚点往上顶。修法：`overflow-anchor: none` + 图标不写 `loading="lazy"`。探针里两条都卡着（`anchor === 'none'`、刚进来 `scrollTop <= 2`）。

**文字被行高裁掉**：这是这个仓库的老教训——`button` 上写 `overflow:hidden` 会在 CSS grid 的自动行里把内容盒塌成 0，DOM 全在、探针全绿、人看不清。所以 `.gz-item` 是 flex 行、不写 `overflow:hidden`，截断交给 `.gz-name` 自己；探针用 `document.createRange().selectNodeContents()` 量字形矩形，要求上留 ≥0、下留 ≥1px、行高 ≥40px、名字 ≥13px、标签 ≥13px（`.gz-chip` 从 0.82rem 提到 0.88rem 就是因为卡在 12.3px）。

**spawn 的失败有两条来路**：`try/catch` 只挡住同步那半，`ENOENT`/`EACCES` 这类是子进程句柄建好之后才以 `'error'` 事件报出来的。没人听那个事件，异常就冒到主进程顶层，Electron 弹一个模态错误框（第一次真点《赛博朋克2077》修改器就是这个）。两条都收进 `src/main/services/spawn-result.js` 的那一条 Promise，服务层 `await` 它；文案一律翻成人话并洗掉盘符路径。见 docs/trainers-panel.md。

## 7. 改完跑什么

```bash
npm run layout:check          # 离线：自带 grid 的校验规则、normalize 幂等、v1 老文件迁移
npm run games:check           # 离线：临时目录里的假 acf + 假修改器 exe，别名/图标/标签文案/行数据形状
npm run games:appprobe -- 9223 --shot   # 真机：需先带 --remote-debugging-port=9223 起应用
```

`games-appprobe` 覆盖：`gamezone` 挂的是 `games` 且旧三格不在；60 行真渲染、40 个标签真挂在对的行下面；图标 60 张 `naturalWidth>0` 且是 32×32；几何是「图标在左、名字在上、标签在下」并且都没被 `.area{overflow:hidden}` 裁；**两列那四条**（`grid-template-columns` 量出来正好 2 列、第 2 条在第 1 条右边的同一行、第 3 条回到左列下一行、列表横向溢出 0px 且没有任何一行越过可视宽度）；过滤只剩两条时它们必须并排在同一行；无匹配的提示语横跨两列；过滤/无匹配/报错/空库四种文案；重扫反馈；**启动链路干跑**（换掉 `TB.api.steam` / `TB.api.trainers` 两层，五次点击的调用序列逐条比对）；设置里的「（本面板自带骨架）」。跑完把当前面板切回原值，`layout.json` 一个字节都不动。

真启动那一下还是得人工点一次：探针只保证「id 交对了」。
