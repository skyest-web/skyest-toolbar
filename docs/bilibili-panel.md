# B 站（生活面板 slot2 的第二档）

他的原话是「视频我要和 bilibili 关联起来」。两条 AskUserQuestion 定下来的形状：**播放交给 Edge**（不内嵌、不拉流），**关联的是稍后再看 + 我的收藏 + 观看历史**这三张单子。所以这一格是「本地文件夹」旁边多出来的一个档位，不是一个浏览器。

- 头部那一排 `本地 / B站` 是同一格里的两档，切档只换中间那块怎么渲染，`slot1` 音乐、`leftzone` 邮箱、`gauges`、`dock` 一个像素都没动；
- **这一格不出网渲染**：`connect-src 'self' track:`（`src/renderer/index.html:7`）一个字没改，`webviewTag` 仍然是关的。所有 B 站请求都在主进程 `services/bili.js` 里发；
- **SESSDATA 只走 DPAPI**，规则和他那张邮箱授权码一模一样（见 `docs/mail-panel.md`），下面第 3 节钉死。

## 1. 分工

| 位置 | 干什么 |
| --- | --- |
| `src/main/services/bili.js:31-36` | `AUTH_FILE='bili-auth.bin'`、`CACHE_TTL_MS=60000`、`API_HOST='api.bilibili.com'`（唯一出网主机）、`SECTIONS` 白名单、`MAX_ITEMS=30` |
| `src/main/services/bili.js:76-142` | `class BiliAuth`：DPAPI 读 `:100` / 写 `:122`、可用性 `:85`、**没有 safeStorage 就拒存** `:116` |
| `src/main/services/bili.js:145` | `httpJson()`：整个模块唯一发请求的地方 |
| `src/main/services/bili.js:184-191` | `translate()`：六种错误码翻成人话 |
| `src/main/services/bili.js:193-241` | `clock()`（`m:ss` / `h:mm:ss`）、`coverUrl()`（http→https `:205`）、`videoRow()`、`folderRow()` |
| `src/main/services/bili.js:331-379` | `list()`：60 秒缓存与 `force` 绕开 `:336`，三张单子各自的字段读法 `:353/:360/:368`，夹子里的清单 `:376` |
| `src/main/services/bili.js:384-416` | `open()`：`byId()` 只认这次发出去的行 id，`external()` 那道 https 形状兜底 `:399` |
| `src/main/main.js:485-490` | 六条 IPC：`bili:status/list/open/setAuth/clearAuth/check` |
| `src/preload/preload.js:81-88` | `TB.api.bili` 六个方法，转发不做任何加工 |
| `src/renderer/js/components/video.js:52-57/117-127` | `B站` 那颗 seg 按钮、`setSource()`（切档先把 `<video>` 停下 `:121`） |
| `src/renderer/js/components/video.js:239-305` | `loadBili()` / `setSection()` / `backToFolders()` / `clickBili()` |
| `src/renderer/js/components/video.js:430-508` | 页签行 + 返回钮、清单、一行（封面块 + 标题 + meta + `▸`/`↗`）、没 cookie 那句带「去设置填 →」 |
| `src/renderer/js/settings.js:433-524` | Bilibili 卡片：`type:'password'` 且永不回填 `:441-447`、`setAuth` `:452`、`check` `:460/:497`、`clearAuth` `:468` |
| `src/renderer/styles.css:2690-2830` | `#video.is-bili`、`.bl-tabs/.bl-item/.bl-cover/.bl-title/.bl-meta/.bl-mark` |
| `tools/bili-check.js` / `tools/bili-appprobe.js` | 离线自检（假 transport）/ 真机探针（假 IPC） |

**没有 `bili` 这个配置段**：`config.js:28` 只有 `video`（文件夹 + 递归），B 站的「停在哪一档、看哪张单子」属于运行时状态，进 `state.json`。两处入口迟早对不上，所以设置里那张卡片只有 cookie 和「测一下」，没有第二个清单入口。

## 2. 为什么不内嵌、不拉流

| 想过 | 为什么没做 |
| --- | --- |
| `webviewTag` / `<iframe>` 嵌播放页 | `webviewTag` 关着是刻意的（QODER.md「不嵌网页视频，就没有远程内容的攻击面」）；嵌进来还得处理它的 CSP、登录态、快捷键 |
| 拉流自己播 | 播放地址要 WBI 签名 + `Client Hints`，风控一验就 403；就算拿到了也只是把 B 站的 DRM 前置工作重做一遍，且**进度不落他账号** |
| 只做「稍后再看」 | 他点名要三张单子，收藏那层还得先列夹子再下钻——这一层是清单，不是播放器 |

交给 `shell.openExternal` 之后，播放器、进度、弹幕、登录态全在他自己的 Edge 里，这一格只负责「让他看见有什么」。点行的 toast 说的是「已交给浏览器打开「标题」」，不是「正在播放」。

## 3. SESSDATA 的纪律（和邮箱授权码同一套）

| 位置 | 允许出现什么 |
| --- | --- |
| `userData/bili-auth.bin` | DPAPI（`safeStorage.encryptString`）密文，只有他本人这台 Windows 账号解得开 |
| 主进程内存 | 明文，只在拼 `Cookie:` 请求头那一站停留 |
| 跨 IPC 的 `status` | **只有** `{ set, hint, encrypted, logged, mid, uname }`，`hint` 是「26 位 · 尾 ef」这种形状描述 |
| `toolbar.config.json` / `state.json` / 日志 / 行数据 | 什么都没有。`bili-check.js` 直接对这四个落点做「搜不到 SESSDATA」的断言 |
| 渲染层 DOM / 组件内存 | 搜不到（探针的替身故意在 `status` 里多塞一个 `sess` 字段，真渲染层不认这个键，最后一组就是在验这件事） |

三条容易忘的：**没有 safeStorage 就拒存**（`:116`，宁可报错也不落明文）；**粘整串 cookie 只取 SESSDATA**（`extractSessdata()` `:53`，其它键一律不要）；**换 cookie / 清 cookie / 点「测一下」立刻 `flush()`**（`:420`，缓存里那些带标题的观看记录不能跨账号）。

填 cookie 由他自己在设置里做，探针和文档都不碰真值。

## 4. 三张单子的读法

`data.list` / `data` 是数组 / 收藏夹子再套一层 `medias`——三种形状不一样，所以 `list()` 分三段读，`bili-check.js` 用假 transport 各钉一条。另外几条写死的规矩：

- **30 行上限**（`MAX_ITEMS`），但 `total` 报真值，说明行写「这里列 30 / 共 137」；
- **60 秒缓存**，同档 + 同夹子命中就一次都不出网；「刷新」带 `force` 绕缓存；**失败不缓存**，否则一次风控就把格子钉死成错误文案；每档各一条缓存（夹子下钻那条按 `fav:<fid>` 分键）；
- `section` 和 `folderId` 都走白名单：渲染层递来一个不认识的 section 或夹子 id，主进程归零并落到返回值里，渲染层跟着返回值走（`loadBili()` 里那句 `Number(res.folderId) || 0`），不自己记一套；
- **空单子不算错误**：「稍后再看里还没有东西」和「还没填 cookie」是两句话，`-101` 和「这夹子是空的」也不是一句话。

## 5. 一行长什么样

`封面块(68x42) + 标题（超长省略号）+ UP · 时长 · 看到 m:ss + ↗/▸`

| 细节 | 为什么 |
| --- | --- |
| `seenAt` 为空就不写「看到 …」 | 硬编一个 `看到 0:00` 等于告诉他「这条你看过」 |
| 时长用 `clock()`：`1:13` / `1:01:40` | 和本地那一档的说明行同一个读法，两档并排看着不打架 |
| 没有封面也留那块深色 | 行高一致，一列扫下来才是一条直线 |
| 封面挂了只摘 `<img>`，块子留着 | CDN 要 `Referer` 时整行看着像报错，最难查；`img-src` 本来就放了 `https:`，那一行 CSP 没动 |
| `↗` = 交给浏览器，`▸` = 点进去还有一层 | 两种「点它会发生什么」得看着就不一样 |
| 「← 收藏夹列表」贴在页签行右边缘 | 页签在左、退路在右，拇指不用找 |

切到 B 站那一档时 `.vd-stage` 收起、清单吃掉整格宽（`styles.css:2690`）。**注意状态类挂在 `#video` 这一层**（组件的 `root`），不是 `section.video-area`——挂错的地方选择器一条都不命中，画面格还在那儿挡着。

## 6. 档位与页签记在 state.json

`snapshot()`（`video.js:513`）必须同时带 `source` 和 `section`：`store.set('video', …)` 是**整块替换**，漏一个下次开机就回到默认值。探针的断言就是「写盘那串的键集是这六个」。开机那一趟只认第一次（`update()` 里 `restored` 那个闸），之后他自己点的档位不能被下一次 `config.save` 抹回磁盘上的旧值。

## 7. 改完跑什么

```bash
npm run bili:check                         # 离线，假 transport，不碰应用也不出网
# 另一个终端：
unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
npm run bili:appprobe -- 9223 --shot       # 改了渲染层代码加 --reload
```

`bili:appprobe` 起手先看 `TB.api.bili` 在不在——不在说明跑的是旧主进程，直接停（否则下面全是假绿）。它**一趟都不出网**：`TB.api.bili` 整个换成页内替身，`video.scan` 透明记账（清单要真数据），`video.save` **只记不落盘**。截图两张：`samples/bili-panel.png`（稍后再看四行）、`samples/bili-fav.png`（夹子下钻那层）。

探针自己的三条纪律，都是踩过之后补上的：

1. **按住桌面那条入口**：他会用 Win+Ctrl+←/→ 切桌面，桌面反过来驱动面板（`app.js` 的 `layout.onSync`）。探针跑在这一格里时它一插进来，后面每组量的都是别的格子——所以跑期间把 `applyPageFromDesktop` 按住，收尾还回去，并把按住了几次打出来。
2. **崩了也要收尾**：正常路径和 `catch` 都调同一个 `restoreAll()`（拆替身、回到他原来那一档和面板）。
3. **崩在半路就别信上一趟**：进程被 pipe 掐掉时连 `catch` 都来不及跑，页内替身会留在应用里，而「他原来停在哪一档」会把它点歪的档位当成原状写回磁盘，越还越歪。所以起手先查 `window.__biliDry`，脏了先重载一次页面（替身跟着页面一起没，档位回到 `state.json` 里他真存下的那一档），再量。`orig.saved` 也一律问组件（`TB.video.snapshot()`），不问 `TB.app.state.video` 那个推送缓存。

变异做过四条，每条都必须出 ✗：删 `setSource()` 里那句 `pause()`（背后还在放声音）、封面 `error` 不摘 `<img>`、`section` 从 `snapshot()` 里漏掉、返回钮那段 `if (this.bili.folder)` 改成永假。回归跑 `video:appprobe`、`photos:appprobe`、`layout:appprobe`、`video:check`——本地那一档被 B 站档挤坏过，这三条现在都绿。

## 8. 已知边界

- **没有用真 cookie 跑过**。探针全在页内替身上，真网络那一侧只由 `bili-check.js` 的假 transport 钉字段读法和错误码。他第一次填 SESSDATA 时如果撞上风控（`-352`/`-412`）或验证码，格子里说的是人话，但解法只能去浏览器里过一次——这条探针造不出来。
- **「看到 mm:ss」是 B 站给的**，不是本地播放器记的；他没在 Edge 里看完过的那条就是空。
- **清单是快照**，60 秒内他在手机上收了新视频这一格不会自己动，要按「刷新」。没做轮询：这一格是「想起来看什么」，不是消息提醒。
- **只有这三张单子**。搜索、UP 主投稿、弹幕、排行榜、充电、直播都没做——他点名的是「关联」，不是把 B 站搬进工具栏。
- **封面走 `https:` 直连**，CSP 允许，但 B 站 CDN 对无 `Referer` 的请求可能回 403；那时那块就是深色空位（第 5 节那条），不报错也不重试。
