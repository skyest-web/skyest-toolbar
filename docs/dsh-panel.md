# DeepSeek Harness（dsh）窗口

把官方开源的 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（命令 `dsh`，包名 `@deepseek-ai/dsh`）的 Web UI 装进一个**独立的系统窗口**里。
**不是**我们自写的 function-calling 循环——那套 M0–M2 已经整体删除，宠物对话继续走 `src/main/services/ai.js` 的直连流；这块窗口是给 dsh 自己的会话界面用的。

> 最早它是「贴在工具栏窗口里的一块 `WebContentsView`」。那条路出不了工具栏所在的那块屏——子视图被裁在父窗口的矩形里，拖不动也分不出去。要能挪到别的屏幕上用，只能升成真窗口。

## 1. 分工：渲染层只管开合，主进程管窗口和内容

```
双击宠物 / 头部「Harness」按钮
   └─ TB.dsh.open()                     src/renderer/js/dsh.js
        └─ IPC dsh:show → DshWindow.show()   src/main/services/dsh-window.js
             ├─ DshHost.start()         src/main/services/dsh.js
             │    ├─ spawn(node dsh/lib/bin.js --profile web --no-open --port 3080)
             │    ├─ 从 stdout 认那条 http://127.0.0.1:<port>/?token=…
             │    └─ 拿到 token 才算 ready
             ├─ new BrowserWindow({ frame: 默认 })   ← 原生标题栏
             └─ new WebContentsView → win.contentView.addChildView → loadURL(带 token 的完整地址)
```

**token 不过 IPC。** 带 token 的完整地址只存在于主进程（`DshHost.url`）；`dsh:status` 只回 `{ running, ready, port, installed, workspace, lastError, visible }`。
dsh 的鉴权就是这一条 URL：访问它 → `303` + `set-cookie: dsh-auth-…`（HttpOnly，30 天），之后没有 token 也能用；没有这条 cookie 的一切请求都是 `401`。
注意 `lastError`：它是子进程输出尾段截的，而 dsh 会把那条 `dsh web: http://127.0.0.1:<port>/?token=…` 打进 stdout——曾经就这样跟着状态回到渲染层（实测 `npm run dsh:check` 之外，在应用里杀掉 dsh 进程立刻能看见）。现在 `src/main/services/dsh.js` 的 `redact()` 在把它并进 tail 之前就把 token 换成 `…`，取地址走的是未打码的原始 stdout，不受影响。

### 为什么用原生标题栏，不自绘一条

`frame: false` + 自己画拖拽条要额外一个 HTML/CSS/JS 壳、一套 IPC、还得自己处理最大化遮任务栏和跨屏吸附。原生标题栏把这些全交给 Windows：拖动、Win+方向键贴边分屏、最小化到任务栏、混排 DPI 下的正确缩放——这些正是「拖到别的屏幕去用」真正需要的。代价就是那条 32px 标题条跟工具栏风格不搭，而里面装的本来就是 dsh 自己的页面，本来也不是我们的视觉。

连带的好处：窗口本体不需要加载任何页面（`WebContentsView` 铺满整块客户区），所以没有「壳页面」这一层。

### 位置与跨屏

- 窗口移动/缩放时把位置写进 `state.json` 的 `dshWindow`；下次开回上次的屏幕和尺寸。
  **宽高存的是物理像素，恢复时先摆位置再改尺寸。** 单位规律（`npm run dpi:measure` 在三块屏上实测）：同屏给多少读回多少；跨屏时 `实际 = 请求 × (目标屏缩放率 ÷ 窗口当前所在屏缩放率)`。所以存 DIP 早晚要漂——另一台机器上实测每重启大一圈（1180→1770→2656），这台 1.5x 主屏上实测每启动小一圈（1180→787→528），是同一个方程正负两边的解。`persistBounds()` 乘 `getDisplayMatching(bounds).scaleFactor` 存物理尺寸，`restoreBounds()` 先 `setPosition(x,y)` 让窗口落到目标屏上（此时换算系数变成 1），再 `setSize(物理 ÷ 目标屏缩放率)`；坐标本来就同单位，照存。
  实测：连开两轮重启恢复存回 1772→1773（±1 取整）；手工把它挪到 1x 副屏存 900x450，回来仍是 900x450。
- 最大化/最小化态下不写——那时 `getBounds()` 给的是外扩后的矩形，存下来下次开就"越界"了。
- 开窗口前校验记忆位置还和某块屏有 ≥120px 重叠，屏幕被拔掉或分辨率变了就回落到系统默认位置。
- 页面里 CSS 像素和物理像素是不是 1:1，取决于窗口落在那块屏上（工具栏这页在这台机器上 dpr 报 1.5、CSS 1708 = 物理 2562；另一台上 dpr 2 而 CSS 1536 = 物理 1536）。截图/取坐标时按窗口自己的 `scaleFactor` 换算，别照抄另一台的数；内容本身不需要我们做跨屏换算，要小心的只有上面那条窗口尺寸。
- 点 × 只是 `hide()`：子进程和已加载的页面都留着，下次开是秒显而不是重走一遍换 cookie。所以窗口关了以后**再双击宠物是把它要回来**（跨屏时一时找不到窗口就用这条），不是重新拉起。

## 2. 配置段

`toolbar.config.json` 顶层 `dsh`（默认值在 `src/main/config.js` 的 `DEFAULTS`，文件里不写也会合并出来）：

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 关掉后 `dsh:show` 直接报错，不拉子进程 |
| `workspace` | `dsh-workspace` | **dsh 的 sandbox 根**（= 子进程 cwd，相对路径按项目根解析）。这个目录等于交给它写，已进 `.gitignore` |
| `port` | `3080` | dsh web 的监听端口；和别处抢端口就改这里 |
| `startupTimeoutMs` | `120000` | 等它打印访问地址的上限。首次装载插件很慢 |
| `telemetry` | `false` | dsh 官方默认 `DSH_TELEMETRY_MODE=FEEDBACK_ONLY`，会往 `dsh-otel-collector.deepseeksvc.com` 发会话日志；这里默认置 `off` |

DeepSeek 密钥沿用原来的纪律：只从 `ai-key.bin`（safeStorage/DPAPI）解出来，经 `env.DEEPSEEK_API_KEY` 注给子进程——不进 config、不进 state.json、不进 git、不进日志、不跨 IPC 回传。dsh 那边对应的配置键是 `apiKeyEnv`。

## 3. 手势

| 操作 | 行为 |
|---|---|
| 双击宠物 | 打开（或唤回）Harness 窗口 |
| 头部「Harness」按钮 | 同一条路径；按钮文案跟着状态走：`Harness · 启动中…` / `Harness · :3080` / `Harness · 未安装` |
| 窗口自己的 × | 收起（子进程**不**退，下次开秒显）。窗口能最小化、能拖到别的屏、能 Win+方向键贴边 |
| 单击宠物 | 浮出输入条（打字 or 点麦克风，由他自己选），**不再直接开麦**；录音中再单击=停麦 |
| 右键宠物 | 还是打断朗读/流式，没变 |
| 打字输入 | 头部的「打字」按钮 |

工具栏这边不再有遮罩面板，所以「点外面收起」「Esc 关闭」那两条已经随面板一起删掉了。

## 4. 生命周期与坑

- **懒启动**：只有第一次开窗口才 spawn。`DshHost.start()` 用同一个 in-flight promise 去重，连点不会开出两个服务。实测冷启动 2.9s（自检脚本）/ 3.3s（应用里），窗口收起后再开 250ms 左右——因为只藏窗口、不退进程。
- **用系统 node，不用 Electron 自带的 Node**：`process.execPath` 在打包/`electron .` 下是 `electron.exe`，而 Electron 33 内置的那份 Node（20.18.3）跑 dsh 这个全 ESM 的 CLI 会**静默退 0、一行输出都没有**（实测；`ELECTRON_RUN_AS_NODE=1` 也一样）。所以 `resolveRuntime()` 在 `PATH` 上找 `node.exe`，状态里以 `runtime` 报出来。纯 Node 环境（跑自检脚本时）就直接用 `process.execPath`。
- **端口占用 / 已有实例**：手动跑过 `npx @deepseek-ai/dsh web` 的话，开窗口这条路会被端口冲突拖慢——先关掉手工实例，或改 `dsh.port`。
- **回收**：`before-quit` 里 `DshWindow.destroy()`（先置 `quitting`，让 × 那条「只藏不销」的拦截让路）→ `DshHost.stop()`；Windows 上用 `taskkill /T /F` 按进程树收，dsh 自己拉的工作子进程不会留下占着端口的孤儿。
- **打包**：`@deepseek-ai/dsh` 在 **dependencies**（不是 devDependencies），所以 `npm run package`（`tools/package.js`，`prune: true` 会剪掉 devDependencies）出的成品**带着 dsh**，双击宠物在成品里也能开窗口。两个前提：目标机器上要有系统 node（见上），以及产物会大几百 MB。

- **dsh 的 web profile 里 `tool-bash` / `tool-pwsh` / `tool-fs` 等默认 `disabled: true`**（证据：`samples/dsh-profile-web.txt`，是 `dsh --profile web --dump-config` 的产物）。想让它真动手，得在 dsh 自己的 profile 里开，不在本项目范围。
- **npm 拦了 install-scripts**：装 dsh 时 `koffi` / `node-pty` 的编译脚本被 npm 跳过了（`npm warn install-scripts`）。web profile 不需要它们，实测照跑；哪天要开终端类工具再 `npm install-scripts approve`。

## 5. 升级与回滚

dsh 的版本号故意留成 caret（`^0.2.1-rc.2`）——它是迭代很快的开发者预览版，你要能随时跟上新版。代价是 `npm install` 别的包时也可能顺带升它，所以：

```bash
# Git Bash，项目目录
npm ls @deepseek-ai/dsh                       # 现在装的是哪一版
npm install @deepseek-ai/dsh@latest           # 升到最新
npm install @deepseek-ai/dsh@0.2.1-rc.2       # 出问题时回滚到这一版（写死版本号即可）
```

工具栏头部的「Harness」按钮文案带端口（`Harness · :3080`），它在就说明子进程活着，升级前后看一眼就知道换没换成；dsh 页面自己的版本显示归它管。
**每次升完必跑**这两条，绿了才算升成功：

```bash
npm run dsh:check
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223   # 另开一个 shell
node tools/dsh-appprobe.js 9223
```

升级后常见的两种裂法：它自己的 profile 结构变了（`dsh --profile web --dump-config` 重导一份对比），或它换了 CLI 参数（`DshHost.spawnOnce()` 里那条 `args`）。

## 6. 自检与真机验证

```bash
# Git Bash，项目目录
npm run dsh:check                       # 不开界面：拉得起 / 拿得到 token / 退得干净
# 真机（CDP）：先带调试端口起应用，再跑探针
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
node tools/dsh-appprobe.js 9223 --shot  # 接线 + token 不外泄 + 收起不退进程 + 位置记忆落盘，并出两张图
npm run dpi:measure                     # 只在改了窗口尺寸存取、或加/换了屏之后跑：把「请求宽高→实际宽高」每块屏量一遍
```

尺寸不漂怎么验（不用截图）：`dsh-appprobe` 每轮末尾打印的「落盘位置」就是 `state.json` 里的 `dshWindow`（物理像素）。连开带重启跑三轮，这个数应当只在 ±2 内晃；改成手工把它摆到别的缩放率的屏上（直接编辑 `state.json` 的 x/y 再重启应用），存回来仍应等于你给的那个数。这台机器实测：默认尺寸两轮 1772→1773；挪到 1x 副屏给 900x450，回来还是 900x450。

`dsh-appprobe --shot` 产出：`samples/dsh-frame.png`（工具栏这页）。dsh 那页**目前截不到**——它是独立窗口里的 `WebContentsView`，CDP 对它 `Page.captureScreenshot` 两种 `fromSurface` 都会超时（探针把这种情况打印成一行提示，不算失败）。要留跨屏的视觉证据，就用 `tools/grab-region.ps1` 按物理矩形抓屏，或直接看屏幕。

跨屏本身怎么验（不需要截图）：从 dsh 那页读 `window.screenX/screenY/devicePixelRatio`，再和 `TB.app.state.displays` 对——落在那块屏的 DIP 坐标上、dpr 等于那块屏的缩放率，就说明窗口真的在别的屏上。这台机器实测：记到 `x=-600, y=-1400` 时 dpr=1.5（屏幕 #1），CSS 宽高 1756×1133。

探针全程不打印 token，只打印它的长度；`dsh:status` 里出现的 `token=` 只可能是主进程 `redact()` 留下的 `token=…`，判定按「等号后还有 6 个以上非空白字符」才算泄。

## 7. 要改它的界面/功能，走哪条路

dsh 是 Cordis 驱动的「一切皆插件」，那套 Web 界面本身就是约 30 个具名插件槽拼起来的（`ui-theme`、`ui-layout`、`ui-sidebar`、`ui-sidebar-files`、`ui-chat`、`ui-brand-official`、`ui-settings-*`……，见 `samples/dsh-profile-web.txt`），并且自带 `dsh-hmr`（热更新）和 `dsh-plugin-manager`。按改动深度排，越靠前越抗升级：

| 路线 | 能改什么 | 升级后 |
|---|---|---|
| `--patch x.yml` 配置叠加（可重复传） | 按 `id` 关掉/换掉某个 `ui-*` 槽、开被禁的工具、改主题与侧栏 | 一般照用 |
| 写自己的 dsh 插件包 | 新面板、新工具、新交互 | 官方扩展面，不冲突 |
| 我们侧 `view.webContents.insertCSS/insertJS` | 换配色、藏掉不想要的区块 | 只改皮，改不了行为 |
| fork 上游自己构建 | 什么都能改 | 预览版迭代快，会持续痛 |

`--patch` 目前还没接进 `DshHost.spawnOnce()` 的参数里（一条 `dsh.patch: []` 配置项的事），要用之前先说一声。
