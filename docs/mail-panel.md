# 邮箱（生活面板左侧那一整块）

生活面板原来左边是两格（上时钟、下音乐播放器），现在**合成一格 `leftzone`**，里面挂 `mail` 组件：163 邮箱收件箱的**只读**列表——发件人、主题、时间，未读的在行首点一个点。中间三格（指标 / slot1 / slot2）**一个像素都没动**，还是全局骨架那样子。

这一格只负责「看一眼」：

- **不标已读、不移动、不删除、不下正文**——点了只弹提示条。他能看到「还没处理过」这件事，前提就是这个组件不改服务器状态；
- **要回信只能走行底的「网页邮箱」**，那个地址由主进程从配置里取，渲染层连字符串都递不进去；
- **出网只发生在主进程**（渲染层 CSP 是 `connect-src 'self'`，它自己抓不到外部）。

它也会自己开口：主进程按 `pollMs` 轮询，按 uid 认出「这一轮新到的」，让宠物做一个一次性动作 + 念一句固定模板——见 §7。

## 1. 分工

| 位置 | 干什么 |
| --- | --- |
| `src/main/services/mail.js` | IMAP 只读拉头部（`imapflow`）、尾部窗口、60 秒缓存、连接复用、错误翻译、授权码落盘（`MailAuth`）；**看护轮询**（`:300` `sync()`）与**新邮件判定**（`:278` `noteNew()`） |
| `src/main/config.js` | `mail` 段的默认值（`:88`）与 `save()` 的白名单 |
| `src/main/main.js:426` | 五条 IPC：`mail:status` / `mail:list` / `mail:openWebmail` / `mail:setAuth` / `mail:clearAuth`；`:609` 建服务（把 `win.webContents.send` 注成 `onEvent`）、`:615` 开机起看护轮询、`:535` 保存后重排、`:644` 退出时 `dispose()` |
| `src/preload/preload.js:89` | `TB.api.mail` 桥，含 `onUpdated` / `onNew` 两条推送 |
| `src/renderer/js/components/mail.js` | 头部（计数 / 只看未读 / 刷新）+ 列表 + 页脚（账号 / 网页邮箱）；**只重画，不计时** |
| `src/renderer/js/app.js:259` | `notifyMail()`：新邮件 → 宠物做动作 + 念一句固定模板（一次都不问模型） |
| `src/renderer/js/components/ai.js` | `poke()`：只让宠物动一下的口子（`persona: 'plain'` 时返回 false，调用方退化成提示条） |
| `src/renderer/js/settings.js:417` | 「邮箱（163 · IMAP 只读）」卡片：配置项 + 授权码即时保存 + 连接状态 + 立刻拉一次 |
| `src/main/layout.js` | `LIFE_GRID`（左列两行合成 `leftzone`）+ 生活面板 `modules: { leftzone: 'mail' }` |
| `src/renderer/styles.css` | `.mail` / `.ml-*` 那段 |
| `tools/mail-check.js` / `tools/mail-appprobe.js` | 离线自检 / 真机探针（IMAP 全程换成只记账的替身） |

## 2. 骨架：只给生活面板换左列的形状

面板自带 `grid` 的三条硬规矩（列/行必须与全局逐字相同、常驻格不能消失、`slots` 只能引用本页出现过的名字）见 docs/game-list-panel.md §2 和 QODER.md。生活面板这一份只动左列：

```jsonc
"areas": [
  ["topbar",   "topbar",   "topbar",   "topbar"],
  ["leftzone", "gauges",   "gauges",   "workbench"],   // ← 左列第 2 行
  ["leftzone", "slot1",    "slot2",    "clipboard"],   // ← 左列第 3 行，和上面合成一整块
  ["dock",     "dock",     "dock",     "clipboard"]
]
```

`leftzone` 占满第 1 列的第 2、3 行（本机实测 330×402），中间 `gauges`/`slot1`/`slot2` 与全局骨架逐字相同。`layout.json` 里生活面板的 `slots` 只剩 5 条，**旧的 `clock`/`player` 必须一并删掉**——留着会让整份文件退回默认。

## 3. 拉哪几封：尾部窗口 + 整箱未读数

- 序列号（seq）是到达顺序，所以窗口是 `total-N+1 : *`，`N = config.mail.maxMessages`，**硬上限 200**（配置里填 5000 也会被夹回 200，免得把整本收件箱拖下来）；
- 未读数走 `SEARCH UNSEEN`，口径是**整个收件箱**，不是「这一窗里有几条没读」——他会分开问这两个数；
- 列表按日期**最新的在前**；
- 60 秒内的重复读取直接用缓存（`force` 绕过）；同一时刻只允许一条 IMAP 会话在飞；
- **连接复用**：一台机器反复重连 163 会被限流，所以客户端连着不放，出错才丢（`dropClient()`），换授权码也立刻丢一次，免得下一条还用旧凭据。

`fetch` 回的那条消息里，**发件人／主题／日期全在 `msg.envelope` 下面**（imapflow 把 ENVELOPE 整个收成一个对象），平铺在 `msg` 上的只有 `seq`/`uid`/`flags`/`size`。`envelope.date` 能解析时是 `Date`，服务器写的日期串认不出来时是**原样字符串**；`envelope.subject`/`envelope.from` 遇到 NIL 就**根本没有这个键**。`rowOf()` 按这三条读，`flags` 是 `Set`。

## 4. 授权码：只进 DPAPI，只出 hint

`MailAuth` 把授权码加密写进 `userData/mail-auth.bin`（和 AI 那把 DeepSeek 密钥同一套 safeStorage/DPAPI，但文件名、校验规则、提示语各走各的，没有改动已经跑通的那套）。三条规矩：

1. **不进 `toolbar.config.json`、不进 `state.json`、不进日志、不跨 IPC 回传**。`mail:status` 里的 `auth` 只有 `{ set, hint, encrypted }`，`hint` 是「16 位 · 尾 qz」这种形状；设置里那个输入框是 `type=password`，保存后立刻清空，永不回显；
2. 校验 `/^[A-Za-z0-9]{8,64}$/`：163 给的是 16 位连续小写字母，带空格／太短／空串一律拒收，**`safeStorage` 不可用时直接拒存**，绝不退化成明文落盘；
3. 授权码由**他自己**在 设置 → 邮箱 → 授权码 里填。任何情况下都不碰、不索要、不代填、不落盘。

错误文案统一过一遍 `errorText()`：先把授权码从消息里替掉（imapflow 有可能把命令原文带进 `message`），再把四类情况翻成人话——`Unsafe Login` → 去网页设置里开 IMAP；`EAUTH` → 授权码不对；`ENOTFOUND` → 这台机器连不上；连不上/超时/目录打不开 → 说清是哪一段。拉取失败时**旧列表保留**，并补一句「下面是 X月X日 拉到的旧结果」。

## 5. 163 特有的那道门槛：IMAP ID

163 收不到 `IMAP ID` 命令就回 `[ALERT] Unsafe Login`，看着像授权码错了，其实是没报身份。`imapflow` 会在登录前后各补发一次 ID，内容来自连接参数里的 `clientInfo` —— **别把它删了**，删了这一格就永远连不上。`logger: false` 也是有意写的：开了会把带账号的调试信息刷进 `run.log`。

## 6. 配置段（`toolbar.config.json` 的 `mail`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后那一格直接报「邮箱在设置里被关了」，轮询也停 |
| `account` | `''` | 完整地址 `abc@163.com`；没填就不握手 |
| `host` / `port` / `secure` | `imap.163.com` / `993` / `true` | 换服务商只改这三项；空值兜回默认 |
| `mailbox` | `INBOX` | 空白兜回 `INBOX` |
| `maxMessages` | `20` | 尾部窗口，夹在 1–200 |
| `pollMs` | `120000` | 主进程看护轮询的间隔；夹一个 **30 秒下限**，填 0 只认手动刷新（也就没有提醒） |
| `notify` | `true` | 关掉后不再发 `mail:new`：列表照常刷新，但宠物不动、不念 |
| `notifyVoice` | `true` | 只关声音：动作照做、提示条照弹 |
| `timeoutMs` | `20000` | 握手 + 取头部整趟时限，下限 3000 |
| `webmail` | `https://mail.163.com` | 只从配置取，且必须像 URL 才交给系统浏览器 |

## 7. 新邮件提醒：宠物动一下 + 念一句，一次都不问模型

**轮询在主进程，不在那一格里。** 原来 `components/mail.js` 自己 `setInterval(pollMs)`：停在别的面板时组件根本没被 init，就没有轮询，也就永远不会有提醒；切回来还容易叠一条。现在渲染层一条邮箱定时器都不许开（`mail:appprobe` §7 数的是 0 条），计时的是 `Mail.sync()` 那唯一一条，间隔 `Math.max(30000, pollMs)`。开机 `main.js:615` 起一次，设置里「保存并应用」走 `applyPolling()` → `mail.sync()`（`:535`）重排，**改间隔不用重启应用**。

**新邮件按 uid 认，不按时间。** `noteNew()` 把这一轮最大的 uid 跟基线比，比基线大的算新到的；uid 整体变小（换了目录 / 邮箱被重建）时只重打基线、不播报。**第一次成功拉取也只打基线**——否则开机那一下会把几十条未读一起念出来。判定完发两条事件：`mail:updated`（让开着的那一格重画）和 `mail:new`（`{ count, unseen, total, name, at }`，**没有主题、没有正文、没有授权码**）。`notify: false` 时只发前者。

**响起来是什么样**（`app.js:259` `notifyMail()`）：

| 情况 | 结果 |
| --- | --- |
| 1 封且发件人是个短名字 | 宠物做一个一次性动作 + 念「邮箱来了新邮件，来自张三」+ 提示条 |
| 1 封但发件人只有地址、或名字超 12 字 | 只报条数——地址念出来就是「no reply at c m b …」那种灾难 |
| N 封（N>1） | 念「邮箱来了 N 封新邮件」，不念名字 |
| `notifyVoice: false` | 照样做动作，只是不出声 |
| 正在念 AI 回复（`TB.voice.speaking`） | 不插嘴，动作也不做 |
| `persona: 'plain'`（没挂宠物） | `poke()` 返回 false，退化成提示条 |

文案是**固定模板**：`notifyMail` 只调 `TB.ai.poke()`（本地播一段宠物片段）和 `TB.voice.speak()`（本地/在线 TTS，念的是拼出来的字符串），一句都不走 `ai.send` / `ai.retry`——探针拿记账替身把这条钉住了。`ai.keyStatus()` 会被 `refresh('ai')` 读到，那是一次本地「密钥存没存」查询，不联网、不烧 token，所以不算走了 DeepSeek。

## 8. 改完跑什么

```bash
npm run mail:check                     # 离线：假 ImapFlow + 假 DPAPI，不碰网络、不碰真邮箱
npm run mail:appprobe -- 9223 --shot   # 真机：需先带 --remote-debugging-port=9223 起应用
npm run mail:appprobe -- 9223 --reload # 改完渲染层代码/样式后：先 Page.reload 再量，不用重启应用
npm run mail:appprobe -- 9223 --watch  # 收尾后再等 200 秒，看主进程真的推一条 mail:updated 过来
```

`mail:check` 用 `Module._load` 把 `electron` 换成一份假的（普通 node 里 `require('electron')` 只是个路径字符串，`safeStorage` 是 undefined，DPAPI 那段就验不到）；假 safeStorage 是「魔数头 + 异或」，只验「文件里没有明文、能原样读回来」，不验真加密强度。它覆盖：三种「还没配好」的说法、尾部窗口与空箱、**ENVELOPE 的字段读法**（`msg.envelope.{date,subject,from}` 的 Date/字符串/NIL 三种样子，外加「装的这一版 imapflow 确实还写成 `map.envelope = parseEnvelope(...)`」这条对着库源码的契约断言）、200 上限、缓存与连接复用、并发只一条会话、未读按整箱、最新在前、授权码不出现在行数据/错误文案/status、四类错误、拒存明文、换码丢连接、老配置没有 `mail` 段也按默认跑、**新邮件只看 uid 增量**（开机第一轮与 uid 变小那一次都不播报、同一批不重复报、`notify: false` 只发 updated）、**看护定时器只剩主进程那一条**（30 秒下限、`sync()` 调两次还是只活 1 条、到点真的去 fetch、`pollMs=0` 或关掉邮箱不起、`dispose()` 会停）。

假客户端的**形状照库写，不照实现写**——`tools/mail-check.js` 的 `message()` 产的就是 `envelope` 嵌套的那一份。

`mail-appprobe` 全程把 `TB.api.mail` 换成只记账的替身（`contextBridge` 的对象劫持不了，得浅拷一层换键——见 QODER.md），所以**一个 IMAP 包都不发**；他还没填授权码时，探针连真服务那一步都不会握手。提醒那一段只换 `TB.api.voice.speak` 和 `TB.api.ai.*`：前者让 TTS 停在「合成失败」，后者逐个函数记账。它验：点 tab 后 `leftzone` 挂 `mail` 且旧格子无残留、兜底文案、列表几何（头部/自滚列表/页脚三段不越格子、长主题被省略号截断、字形矩形用 Range 量、`overflow-anchor: none`）、四种时间写法、三个按钮各走各的 IPC 且一次都没调写侧、失败留旧结果、**渲染层一条邮箱定时器都不开 + `onUpdated` 只绑一次 + 一条推送只取数一次**、**来了新邮件宠物做一次性动作（且口型片段排队不掐它）、文案按封数走、`ai.send`/`ai.retry` 一次都没被调用**、设置卡片字段齐全（含「新邮件提醒 / 语音提示」两个勾选框）且密码框不回显。截图两张：`samples/mail-panel-fallback.png`（**真服务的当前状态**——没配好时是兜底文案，配好了就是真邮箱的头几行，所以它是唯一一张真数据的图）、`samples/mail-panel-rows.png`（**替身数据**，不是真邮箱）。

`--watch` 那一段等的是**真推送**：替身 handler 是探针自己按次数调的，验不到 `push()` 的窗口引用和 preload 的通道名。它绑一条真 `onUpdated` + 一条真 `onNew`，等看护轮询推来 `mail:updated`（本机实测 12:40:58 到 1 条），`mail:new` 期望 0 条——没有新邮件时本来就不该响。至于「真来了一封会念什么」，只能等他真收到一封：探针不替他发信，也不假装收到。

## 9. 踩过的坑

- **喂假数据要连 `status()` 一起喂**：页脚的账号、轮询间隔都来自 `status()`，只换 `list()` 的话量到的还是真配置（探针一度把页脚读成「没填账号」）。
- **列表每次整块重建，所以要关滚动锚定**：`.ml-list` 上 `overflow-anchor: none`，否则重绘会把列表弹到底部（和 games 那一格同一个道理）。
- **轮询别挂在面板组件上**：`armTimer` 那一套已经删掉了。组件 `setInterval` 有两个死法——停在别的面板时组件没 init，永远发现不了新邮件；切回来又叠一条，163 那边直接限流。现在定时器只有主进程 `Mail.sync()` 一条，组件只认 `onUpdated` 推送，且用 `bound` 守卫保证切几次面板都只绑一次。
- **一次性动作会被循环片段掐掉**：`pet-video.apply()` 原来无脑切目标片段，于是提醒里 `speak()` 触发的 `refresh('ai')` 在动作开始的同一帧把口型片段压了上来——「做个动作 + 念一句」实际只剩念。现在 apply 遇到正在播的一次性片段就**只改状态、不抢画面**，片段播完由 `ended` 按当下的 `talk` 回到口型/待机（不存「排队的目标」：动作期间换了表情，存下来的目标就成了过期状态）。证伪过：把那条判断拆掉，探针立刻报 `3 封新邮件宠物没动作：{"current":"工作状态-忙碌点按","loop":true}`。
- **同一个 `src` 再赋一次值不重载**：Chrome 只在属性值真的变了才重跑加载算法，而后台那条 video 常常停在上一遍的最后一帧——`play()` 一调就 `ended`，宠物看着像没反应。片段是随机抽的、两条 video 来回换，撞上就中招，所以同值时要手动 `load()` 倒回开头。
- **读宠物状态要在 `notifyMail()` 返回那一刻读**：回应片段只有零点几秒，探针原来等 120ms 再取快照，连着跑几条必有一条量到「上一轮的尾巴」（当时误报成「关掉语音把动作也关了」）。改成同步读 `current/loop/once/pending`，还要跟本轮开始前的快照比——不比就会把在飞的旧片段当成本轮的动作。
- **切面板会被桌面回推打断**：点 tab 顺带切 Windows 虚拟桌面，主进程再把桌面那页推回来（`layout.onSync`），这一推可能比 500ms 慢，撞进推送窗口就把面板重建走、`mail.root` 脱离文档，`load()` 的守卫照样直接返回——「取数 0 次」量的就不是要验的东西。所以推送前先等 `state.page === 'life' && root.isConnected` 稳住。
- **换替身要放开 `bound`**：开机时组件已经用真 API 绑过一条 `onUpdated`，`bound` 守卫会挡住第二次绑定，装上替身后手动 `TB.mail.bound = false` 才测得到「只绑一次」。真那条监听解不掉，但主进程 120 秒才推一次，几百毫秒的窗口撞不上。
- **主题字号别低于 13px**：这一格 330px 宽、离手一臂远，`.ml-subject` 从 0.75rem 提到 0.85rem 才过探针那条线。
- **假数据照实现写，bug 就能全绿着上线**：`rowOf()` 一开始按平铺的 `msg.from`/`msg.subject` 读，而 imapflow 把它们收在 `msg.envelope` 里——66 封真邮件全成了「未知发件人 /（无主题）」。当时的假客户端照抄了这个读法，于是 `mail:check` 一路 ✓，探针又只换渲染层那一侧（IPC 之上），**两层假数据都不经过真正的解析**。修完的自检现在能抓到它：把 `rowOf` 改回平铺跑一次，报 5 项，第一条就是 `{"name":"未知发件人","subject":"（无主题）","date":0}`。规矩：写替身时照**库的返回**（这里直接读 `node_modules/imapflow/dist/cjs/tools.js` 里 `map.envelope = parseEnvelope(...)` 那几行），别照自己刚写的代码。
- **NIL 不是空串**：`envelope.subject`/`from` 缺字段时键根本不存在，`envelope.date` 解析失败时是字符串而不是 `Date`——兜底文案和排序都靠这三条判断，别写 `msg.subject.length`。
