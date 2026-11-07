# 本地视频（生活面板 slot2）

他点名要的两格：`slot1` 放**原有的**音乐播放器，`slot2` 新做一个视频格子。左边那一整块 `leftzone` 还是邮箱，中间 `gauges` 和底部 `dock`/`clipboard` 一个像素都没动。

这一格只做「看本地文件」：

- **只读**——扫文件夹、列出来、点一行播；不转码、不改名、不删、不写任何文件（除了 `state.json` 里那条「看到哪儿」）；
- **源只能是本地文件夹**，配置里那个路径是唯一入口。渲染层递进 `video:scan` 的字符串只影响「这一次扫哪儿」，不改变任何写侧行为；
- **没有设置卡片**。文件夹就在格子里点「选文件夹」选（和音乐播放器那一格的 📁 同一个套路），别在 `settings.js` 里再造一份入口——两处入口迟早对不上。

## 1. 分工

| 位置 | 干什么 |
| --- | --- |
| `src/main/services/video.js` | `VIDEO_EXT`（`:11`，只收 Chromium 解得了的容器）、`MIME`（`:14`）、`titleFromBase()`（`:27` 剥集数前缀）、`walk()`（`:32` 递归 + 深度 <4 + 跳过 `node_modules` 之类）、`scan()`（`:70` 四种「没东西」的文案） |
| `src/main/config.js:28` | `video: { folder:'', recursive:true }`；`:149` 是 `save()` 白名单里那一条——**少了它「保存并应用」会把整段抹掉** |
| `src/main/main.js:89` | `mediaMime()`：`track://` 那条 handler 现在音频视频共用，先查音频表再查视频表 |
| `src/main/main.js:369/375/474` | 三条 IPC：`video:scan`（顺带把每条 clip 的 `url` 拼成 `track://play/…`）、`video:pickFolder`（原生选目录后**由主进程**写回配置）、`video:save`（写 `state.json`） |
| `src/main/main.js:296` | `boot:get` 带上 `video: store.get('video')`，开机就能回到上次那条 |
| `src/main/services/store.js:4` | `EMPTY` 里的 `video: null` |
| `src/preload/preload.js:65` | `TB.api.video` = `scan` / `pickFolder` / `save` |
| `src/renderer/js/components/video.js` | 头部（计数 / 定位 / 选文件夹）+ 舞台（`<video>`）+ 右侧清单列；`<video>` 只建一次 |
| `src/renderer/js/app.js:4` / `:90` | `state.video` 与 `applyPayload` 里那一行 |
| `src/renderer/js/pet-video.js` 之外无 | 这一格和宠物没有耦合：播不播视频都不动画面、不念话 |
| `src/main/layout.js:64` | 生活面板 `modules: { leftzone:'mail', slot1:'player', slot2:'video' }` |
| `src/renderer/styles.css:2534` | `.video-area` / `.vd-*` 那段，含 `@container video (max-width:420px)` 的窄列变体 |
| `tools/video-check.js` / `tools/video-appprobe.js` | 离线自检 / 真机探针 |

## 2. 骨架：只换两格挂什么

生活面板的 `LIFE_GRID` 用的是全局骨架（`layout.js:40`），四行里第 3 行就是这两格：

```jsonc
"areas": [
  ["topbar",   "topbar",   "topbar",   "topbar"],
  ["leftzone", "gauges",   "gauges",   "workbench"],
  ["leftzone", "slot1",    "slot2",    "clipboard"],   // ← 音乐在左、视频在右，同一行
  ["dock",     "dock",     "dock",     "clipboard"]
]
```

所以**没有新位置名**要起（`slot1`/`slot2` 早就在全局骨架里），`validate()` 那三条硬规矩一条都没碰。落位要改两处，且必须一致：仓库里的 `layout.json`（磁盘上那份才是权威）和 `layout.js` 的 `DEFAULT_PAGES`（兜底）。`video-check.js` 第五段就是拿来钉这两份的。

## 3. 为什么只收这五个扩展名

`MIME` 表与 `VIDEO_EXT` 一一对上，靠的是 Electron 自带的 ffmpeg：

| 收 | MIME | 为什么 |
| --- | --- | --- |
| `.mp4` `.m4v` | `video/mp4` | H.264 + AAC，最稳 |
| `.mov` | `video/quicktime` | 同一套解码器 |
| `.webm` | `video/webm` | VP8/VP9/AV1（仓库自带的宠物片段就是这一类，探针拿它当片源） |
| `.mkv` | `video/x-matroska` | 容器认，里面是 H.264 才放得动 |
| `.avi` `.flv` `.wmv` | — | **故意不收**：Chromium 解不了，扫进来只是给他一个能点、点了黑屏的行 |

认不出来的扩展名 `mimeFor()` 回 `application/octet-stream`，Chromium 当下载处理——宁可"看起来不该播"，不要黑屏骗人。这条表由 `video-check.js` 钉住：`VIDEO_EXT` 与 `MIME` 的键集**双向相等**，加一类必须同时加两处。

## 4. 播放走的是音频那条 `track://`

`file://` 直连媒体元素会被跨源策略挡住，所以主进程注册了 `track` 特权方案（`standard/secure/stream/supportFetchAPI/corsEnabled`），音频一直用它，视频跟着共用同一个 handler（`main.js:93` 的 `registerTrackProtocol`）。关键是**分段响应是手写的**：

- 无 `Range` → `200` + `Content-Length: 整条大小`；
- 有 `Range` → `206` + `Content-Length: 这一段` + `Content-Range: bytes a-b/size`；
- 越界 → `416` + `Content-Range: bytes */size`。

为什么要自己写：`net.fetch` 走 `file://` 时常把 `Content-Length` 漏掉，Chromium 拿不到长度就把 `duration` 报成 `Infinity`——进度条和总时长整个废掉。现在 `<video>` 拿到的是有长度的分段响应，`duration` 是有限数，`video-appprobe` 的真播那一段就是钉这件事（顺带 `fetch` 一次带 `Range: bytes=0-1023` 的请求，断言 `206` / 实到 1024B / `content-type: video/webm`）。

CSP 一个字都没改：`media-src 'self' track:` 和 `connect-src 'self' track:`（`src/renderer/index.html:5-8`）本来就覆盖音频，视频是同一条协议。也**没有开 `webviewTag`**——不嵌网页视频，就没有远程内容的攻击面。

## 5. 「上次看到哪儿」进 state.json，不进 toolbar.config.json

| 东西 | 落点 | 为什么 |
| --- | --- | --- |
| 文件夹路径、`recursive` | `toolbar.config.json` 的 `video` 段 | 这是配置，跟 git 走 |
| `{clipId, position, volume, muted}` | `state.json` 的 `video`（userData，不在仓库） | 这是"看到哪儿"，跟着人变，不该把工作区弄脏 |

`clipId` 是**小写全路径**，换文件夹后按 id 找回上次那条；找到了只定位到那一秒、**不自动开播**（开机就自己放视频比放音乐更容易吵到人），并弹一条「上次看到 mm:ss，已回到那一处」。

写盘由 `persist()` 去抖 600ms：`pause`/`ended`/`seeked`/`volumechange` 各必记一次，播放中的 `timeupdate`（约 250ms 一次）只每 5 秒放行一次。`video-appprobe` 播 0.7 秒后断言写盘次数 `≥1` 且 `≤3`。

## 6. 切面板不重建 `<video>`

`buildShell()` 每次换页都整体重建 DOM（QODER.md「切面板 = 整体重建」那条），所以组件状态全在 `TB.video` 这个对象上，`<video>` 元素也只 `createElement` 一次：`ensureEl()` 发现它已经在新的 `.vd-stage` 里就不动，否则挪过去。探针验的是——给元素挂一个 `__probe` 标记，切到主界面再切回来，标记还在、`src` 没变、`currentTime` 没回 0、当前行还高亮，而且**一次 `video:scan` 都没多**（`update()` 里「文件夹没变就别扫」那句）。

同理：空格键只给音乐播放器（`app.js` 里那条没动）。视频用原生控制条，不抢全局按键。

## 7. 四种「没东西可播」说得开吗

| 情形 | 谁说的 | 画面 |
| --- | --- | --- |
| 没选文件夹 | 渲染层（`rescan()` 直接不发 IPC） | 计数牌「没设置文件夹」+ 说明行「点右上「选文件夹」…」+ 列表里「还没选视频文件夹」 |
| 没设置视频文件夹 | `scan()` 第一条 | 上面那格不会出现，因为渲染层压根不调它 |
| 文件夹不存在 / 不是文件夹 | `scan()` 返回 `error` | 计数牌「没扫到」+ 列表里那句原样写出来 + toast |
| 里面没有可播的格式 | `scan()` 第四条 | 同上，句子不同 |

前两条容易混，所以 `video-check.js` 第一段就断言这四句**互不相同**、且各自只在对应输入下出现。

## 8. 改完跑什么

```bash
npm run video:check                        # 离线，不碰应用
# 另一个终端：
unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
npm run video:appprobe -- 9223 --shot      # 改了渲染层代码加 --reload，不用重启应用
```

`video:appprobe` 起手先看 `TB.api.video` 在不在——不在说明跑的是旧主进程，直接停（否则下面全是假绿）。片源用仓库自带的 `src/renderer/assets/pet`，不依赖他机器上有没有视频文件夹；跑完恢复真 API、他原来的文件夹、`state.json` 里原来的那条、以及原来的面板。截图两张：`samples/video-panel.png`（真扫 + 真播）、`samples/video-rows.png`（替身 25 行的几何）。

判绿之前先做一次变异（QODER.md 那条老规矩）：`VIDEO_EXT` 加 `.avi`、删一条 `MIME`、剥集数那行改成 `base.trim()`、`layout.json` 的 slot2 改回 `placeholder`、`config.js` 白名单删 `video:`、`mediaMime` 改回 `music.mimeFor`、preload 通道名改掉——每条都必须出 ✗。

## 9. 已知边界

- **探针换的是渲染层那一侧**。`TB.api.video` 换成记账替身之后，主进程没被真调用过，所以 `scan()` 里字段形状、`walk()` 的排序、四种文案的正确性只由 `video:check.js` 钉——它不启应用、直接 require 服务。
- **解码能力 = Electron 自带 ffmpeg 的能力**，不是"文件能不能播"的保证。`.mp4` 里塞 HEVC 照样黑屏，那时 `<video>` 会发 `error`，格子里写「播不了：…（容器或编码 Electron 解不了，换 mp4 / webm 试试）」并弹 toast。这条只能人工踩，探针造不出一个"合法容器 + 解不了的编码"的文件。
- **`limit` 默认 400、深度上限 4 层、跳过 `node_modules`/`.git`/`$recycle.bin`**。整个盘当文件夹会慢，也会一次刷出几百行——他真要那么大范围，就该按子目录选。
- **没做字幕、播放列表、倍速、记忆每条形进度以外的东西**。原生控制条给的就这些。
