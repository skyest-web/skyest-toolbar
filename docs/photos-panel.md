# 本地相册（生活面板 gauges 那一整条）

生活面板中间那一格音乐、右边那一格视频之后，剩下的「中部上」整条 `gauges`（第 2 行中间两列合成，1920 屏上约 1152×176）现在挂相册。左边整块还是邮箱，`slot1` 还是**原有的**音乐播放器，`slot2` 还是视频，底部 `dock`/`clipboard` 一个像素没动。

这一格只做「看本地照片」：

- **只读**——扫文件夹、排出来、点开看；不转码、不改名、不删、不写任何文件。这一格**连 `state.json` 都不写**：视频要记「看到第几秒」，照片墙关掉就是关掉，没有「上次第几张」这回事；
- **源只能是本地文件夹**，配置里那个路径是唯一入口。渲染层递给 `photos:scan` 的字符串只影响「这一次扫哪儿」，不改变任何写侧行为；
- **没有设置卡片**。文件夹就在格子里点「选文件夹」（和音乐/视频那两格同一个套路），不在 `settings.js` 里再造第二个入口。

## 1. 分工

| 位置 | 干什么 |
| --- | --- |
| `src/main/services/photos.js` | `PHOTO_EXT`（`:14`，只收 Chromium 解得动的位图）、`SKIP_DIRS`（`:15`）、`fileUrl()`（`:20` 自己拼百分号编码）、`walk()`（`:33` 递归 + 深度 <4 + 跳过目录）、`scan()`（`:74` 四种「没东西可看」的文案 + 按 mtime 倒序） |
| `src/main/config.js:31` | `photos: { folder:'', recursive:true, limit:400 }`；`:153` 是 `save()` 白名单里那一条——**少了它「保存并应用」会把整段抹掉** |
| `src/main/main.js:13` | `require('./services/photos')` |
| `src/main/main.js:390` / `:395` | 两条 IPC：`photos:scan`（组件传空时兜回 `config.photos.folder`）、`photos:pickFolder`（原生选目录后**由主进程**写回配置）。**没有 `photos:save`**——上面说了，这格不记进度 |
| `src/preload/preload.js:73` | `TB.api.photos` = `scan` / `pickFolder`，只有这两条 |
| `src/renderer/js/components/photos.js` | `TB.photos`（`:14`）：头部（计数 / 定位 / 选文件夹）+ `.ph-strip` 一整排缩略图 + `ensureOverlay()`（`:57`，body 上那条浮层只建一次）+ `bind()`（`:72`，键盘只绑一次） |
| `src/renderer/js/util.js:77` | `TB.util.date()`：今天/昨天带时分、本年「M月D日」、跨年才带年份。和视频那格的 `ago()` 不同——照片要看的是「哪天拍的」 |
| `src/main/layout.js:64` | 生活面板 `modules: { leftzone:'mail', gauges:'photos', slot1:'player', slot2:'video' }` |
| `src/renderer/styles.css:2710` | `.photos-area` / `.ph-*` 那段，含 `@container photos (max-width:760px)` 的窄条变体 |
| `tools/photos-check.js` / `tools/photos-appprobe.js` | 离线自检 / 真机探针 |

## 2. 落位：只换一格挂什么

`LIFE_GRID`（`layout.js:40`）里 `gauges` 占第 2 行中间两列，`slot1`/`slot2` 占第 3 行：

```jsonc
"areas": [
  ["topbar",   "topbar",   "topbar",   "topbar"],
  ["leftzone", "gauges",   "gauges",   "workbench"],   // ← 这一整条现在是相册
  ["leftzone", "slot1",    "slot2",    "clipboard"],
  ["dock",     "dock",     "dock",     "clipboard"]
]
```

没有新位置名要起，`validate()` 三条硬规矩一条都没碰。落位仍要改两处且必须一致：磁盘上的 `layout.json`（才是权威）和 `layout.js` 的 `DEFAULT_PAGES`（兜底）。`photos-check.js` 第五段钉这两份，并且反向钉「没顺手改别人」：主界面 `gauges` 还是系统指标、工作面板那格还是空着、游戏面板压根没有 `gauges`。

## 3. 图片走 `file:///`，不走 `track://`

这是这一格和视频那格唯一实质区别：

| | 视频 `slot2` | 相册 `gauges` |
| --- | --- | --- |
| 元素 | `<video>`（媒体元素） | `<img>` |
| 协议 | `track://play/<encodeURIComponent(path)>` | `file:///D:/...` 直接给 |
| 为什么 | 媒体元素受跨源策略限制，且要分段响应才有 `duration` | `<img>` 不受那条限制，游戏列表图标一直是 `file://` |
| CSP | `media-src 'self' track:`、`connect-src 'self' track:` | `img-src 'self' file: data: https:` |

**CSP 一个字都没改**——`img-src` 里本来就放着 `file:`。`photos-check.js` 第六段把这条钉住了：谁哪天收紧成 `'self'`，这一格立刻整片空白，让它先红在自检里。

地址也不能交给 `new URL()` 拼：它把 `#` 当锚点、`?` 当查询串，`D:\2024 #1.png` 到了 `<img>` 只剩 `D:/2024 `；落单的 `%` 它还不补全。所以 `fileUrl()` 按 `/` 拆开逐段 `encodeURIComponent`，再把盘符那个 `%3A` 换回冒号（`file:///D%3A/` 是开不出来的）。UNC（`\\z4s\photo\x.png`，他那台极空间挂载后的形状）单独走一支：主机名要待在 host 位。

## 4. 收哪些格式，为什么少了两个常见扩展名

| 收 | 为什么 |
| --- | --- |
| `.jpg` `.jpeg` `.png` `.webp` `.avif` `.gif` `.bmp` | Electron 自带的 ffmpeg/图像解码器认得，`<img>` 直接解 |
| `.heic` | **故意不收**：iPhone 默认的直出格式，Chromium 解不了，收进来就是一张破图。他真要看得先转成 jpg（或从 iPhone 拷贝时选「转换格式」） |
| `.svg` | **故意不收**：矢量图不是照片，混进照片墙只会显得奇怪 |
| `.tiff` `.raw` | 同 `.heic`，解不了 |

`photos-check.js` 前两段就是钉这件事：白名单**双向相等**，且 `.heic`/`.svg`/`.tiff` 各有一条单独的反向断言——将来有人觉得「顺手加一下」就会撞上来。

## 5. 排序与范围

- **按 `mtime` 倒序**（`:85`）：照片墙要的是「最近拍的在最前面」，同一秒内再按路径，保证顺序稳定；
- `title` **不剥前缀**：`IMG_20240601_101233` 这种相机名本身就是他认得的东西，和视频那格剥集数（`01 - 第一集` → `第一集`）是反过来的决定；
- `limit` 默认 400、深度上限 4 层、跳过 `node_modules` / `.git` / `$Recycle.Bin` / `System Volume Information`（大小写都算）；整个盘当文件夹会慢，也会一次刷出几百张——范围真要那么大，就该按子目录选。

## 6. 浮层挂 body，不挂格子里

`.area` 有 `overflow:hidden`，越出格子的部分会被**静默**吃掉（DOM 在、量得到、就是看不见）。所以那条盖满整窗的大图必须 `position:fixed` + 挂 `document.body`（QODER.md 里那条通用规矩，弹窗和气泡已经用过两次）。

- **z-index 45**：在面板之上、设置弹窗（50）之下——开着照片点齿轮仍能打开设置；toast 是 80，报错永远看得见；
- **只建一次**（`ensureOverlay()`）：`init()` 每次切面板都跑，重建 `<img>` 会让大图重新解码，翻页就闪一下；
- **键盘只绑一次**（`bind()` + `this.bound`）：绑两遍就是一按 ← 翻两张；输入框里的方向键是编辑行为（顶栏搜索栏在同一层），处理器里先 `closest('input, textarea, select')` 让开；
- **关掉就摘 `src`**：留一张全屏位图在内存里没道理；
- **点暗色背景关，但点说明条上的按钮不关**：判定只看 `event.target === el || event.target === stage`，所以点‹/›/× 不会顺手把整个浮层带走。
- **高亮圈只在浮层真开着的时候上**：`close()` 里**故意**保留 `opened`（「定位」要在关掉之后还能找回最后看过那张），所以 `renderStrip()` 上的标记分两套——`showing = !this.el?.hidden` 时给 `open`（亮圈），关掉后只给 `active`（细边）。照着 `index === this.opened` 无条件上圈，症状是 Esc 之后整条里还亮着一张，看着像浮层没关干净；探针断言「Esc 后 `open` 标记 0 张」。

`Esc` / `←` / `→` 三个键都是现成的：`app.js` 的 `bindKeys()` 只占了 Ctrl+, / Ctrl+L / Ctrl+F 和空格，没有冲突。

## 7. 四种「没东西可看」说得开吗

| 情形 | 谁说的 | 画面 |
| --- | --- | --- |
| 没选文件夹 | 渲染层（`rescan()` 不发 IPC） | 计数牌「没设置文件夹」+ 整条里「还没选照片文件夹」；**不弹 toast**（开机就弹一句"你没配"是吵人） |
| 未设置照片文件夹 | `scan()` 第一条 | 上面那格不会出现，因为渲染层压根不调它 |
| 文件夹不存在 / 那是个文件 | `scan()` 第二、三条 | 计数牌「没扫到」+ 那句原样写出来 + toast |
| 里面没有能显示的图 | `scan()` 第四条 | 同上，句子不同 |

## 8. 改完跑什么

```bash
npm run photos:check                       # 离线，不碰应用
# 另一个终端：
unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
npm run photos:appprobe -- 9223 --shot     # 改了渲染层代码加 --reload，不用重启应用
```

`photos:appprobe` 起手先看 `TB.api.photos` 在不在——不在说明跑的是旧主进程，直接停（否则下面全是假绿）。图源用仓库自带的 `samples/`（全是 png，混在日志、音频、json 旁边，正好当过滤器的靶子；张数不写死，自检和探针都现读目录再和扫描结果比，`--shot` 自己也会往里加两张，所以别指望某个固定数字），不依赖他机器上有没有照片文件夹；跑完恢复真 API、他原来的文件夹和原来的面板。截图两张：`samples/photos-panel.png`（真扫的一排缩略图）、`samples/photos-lightbox.png`（浮层开着的大图）。

`photos-lightbox.png` 看着像「截图里套着一张旧截图」，这是**图源决定的，不是 bug**：`samples/` 里全是历次验证留下的界面截图，所以大图位上放的必然又是某张界面截图（探针会跳过它自己那两张输出，避免套到上一次截图的截图上去，见 `SHOTS` 那段）。看浮层本身只看那一圈暗 scrim、顶上一行「文件名 · 今天 hh:mm · 大小 · 3/31」和右上角的 ‹ › ×；中间那块内容是照片，不是当下这一帧的界面。

判绿之前先做变异（QODER.md 那条老规矩）：本轮 47 条变异逐条改坏真实文件——四种文案各改一句、白名单塞 `.heic`/`.svg`、`fileUrl` 换成不编码或把盘符编成 `%3A`、UNC 取错段、深度 `<4` 改 `<9`、跳过表删一条、排序改成按路径、剥掉相机名、`mtime` 改成毫秒、`limit` 改小、删掉 `url` 字段、落位两处各改一处 / 顺手改主界面、中间那块合并、handler 与 preload 通道改名、冒出 `photos:save`、config 两处删段、CSP 删 `file:`、组件改成 `loading="lazy"` 或改走 `track://`、注册 id 与容器 id 改掉、`.ph-strip` 的三条、`.ph-thumb` 定高、`.ph-view` 的 fixed / `[hidden]` / z-index、`.ph-full` 的 max-height / object-fit——47/47 都出 ✗，还原后自检全绿。

真机探针这轮也过了一次变异：把 `step()` 里那句 `scrollIntoView(...)` 摘掉，`--reload` 重跑，必须出两条 ✗（「连按 20 次 → 后当前那张不在可视区里」和「翻到第 20 张整条没往右滚」）——实测确实两条都红，还原后回绿。**这条同时是一次设计纠正**：原来那版探针是 `document.querySelectorAll('.ph-item')[19].click()`，也就是直接点一个在可视区外的节点。程序化点击不需要滚动，`scrollIntoView` 又只写在 `step()` 里，于是它永远测不到「翻过去的那张看不看得见」这件事；改成「点第 0 张（就在可视区里）→ 按 20 次 `→`」才是他会走的那条路。同理，第一条对齐断言原来要求 `gauges` 的左右边缘都等于 `slot2`，可 `gauges` 是第 2 行**中间两列合成的一整条**，右边对齐、左边越过 `slot2` 才对——那条断言把「一整条」当成「一格」，实测报的是 349~1501 vs 930~1501，假红。

## 9. 已知边界

- **探针换的是渲染层那一侧**。`TB.api.photos` 换成记账替身后主进程没被真调用，所以 `scan()` 的字段形状、排序、四种文案只由 `photos:check.js` 钉（它不启应用、直接 require 服务）；探针这边只保证「真 IPC + 真 `file://` 真的读到了文件并且解码成功」。
- **`.heic` 只能靠他先转格式**。浏览器解不了，这一格不收；哪天真要支持，得引入转换步骤，不是改一行白名单。
- **EXIF 方向不自己解析**：Chromium 默认 `image-orientation: from-image`，竖拍照片会自己转正（`.ph-full` 里显式写了这一行，是为了让这个决定留在纸上而不是藏在默认值里）。极端的「旋转 180°」标签历史上有过解码不一致，踩到了再补。
- **不做幻灯片播放、收藏、删除、人脸/地点分组**。这一格只到「一排缩略图 + 点开看」，多了就不是一格能装的事。
