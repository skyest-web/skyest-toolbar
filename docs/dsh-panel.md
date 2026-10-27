# DeepSeek Harness（dsh）面板

把官方开源的 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（命令 `dsh`，包名 `@deepseek-ai/dsh`）的 Web UI 内嵌进工具栏窗口。
**不是**我们自写的 function-calling 循环——那套 M0–M2 已经整体删除，宠物对话继续走 `src/main/services/ai.js` 的直连流；这块面板是给 dsh 自己的会话界面用的。

## 1. 分工：渲染层画框，主进程塞内容

```
双击宠物 / 头部「Harness」按钮
   └─ TB.dsh.open()                     src/renderer/js/dsh.js
        ├─ 量 .dsh-body 的矩形 → IPC dsh:show
        └─ DshPanel.show()              src/main/services/dsh-panel.js
             ├─ DshHost.start()         src/main/services/dsh.js
             │    ├─ spawn(node dsh/lib/bin.js --profile web --no-open --port 3080)
             │    ├─ 从 stdout 认那条 http://127.0.0.1:<port>/?token=…
             │    └─ 拿到 token 才算 ready
             └─ new WebContentsView → win.contentView.addChildView → loadURL(带 token 的完整地址)
```

**token 不过 IPC。** 带 token 的完整地址只存在于主进程（`DshHost.url`）；`dsh:status` 只回 `{ running, ready, port, installed, workspace, lastError }`。
dsh 的鉴权就是这一条 URL：访问它 → `303` + `set-cookie: dsh-auth-…`（HttpOnly，30 天），之后没有 token 也能用；没有这条 cookie 的一切请求都是 `401`。

窗口是无边框的，页面 CSS 像素和 `view.setBounds()` 的 DIP 是同一套坐标，所以渲染层 `getBoundingClientRect()` 报上来的矩形可以直接当视图位置用。

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
| 双击宠物 | 打开 Harness 面板 |
| 头部「Harness」按钮 | 开/关面板（和双击宠物同一条路径） |
| 面板右上 ×、点面板外 | 关闭（子进程**不**退，下次开秒显）。Esc 只在焦点回到工具栏页面时管用——面板打开后焦点在 dsh 那块视图里 |
| 单击宠物 | 还是开麦说话，没变 |
| 右键宠物 | 还是打断朗读/流式，没变 |
| 打字输入 | 原来占着「双击」，现在搬到头部的「打字」按钮 |

## 4. 生命周期与坑

- **懒启动**：只有第一次开面板才 spawn。`DshHost.start()` 用同一个 in-flight promise 去重，连点不会开出两个服务。实测冷启动 2.9s（自检脚本）/ 3.3s（应用里），面板收起后再开 250ms 左右——因为只撤视图、不退进程。
- **用系统 node，不用 Electron 自带的 Node**：`process.execPath` 在打包/`electron .` 下是 `electron.exe`，而 Electron 33 内置的那份 Node（20.18.3）跑 dsh 这个全 ESM 的 CLI 会**静默退 0、一行输出都没有**（实测；`ELECTRON_RUN_AS_NODE=1` 也一样）。所以 `resolveRuntime()` 在 `PATH` 上找 `node.exe`，状态里以 `runtime` 报出来。纯 Node 环境（跑自检脚本时）就直接用 `process.execPath`。
- **端口占用 / 已有实例**：手动跑过 `npx @deepseek-ai/dsh web` 的话，面板这条路会被端口冲突拖慢——先关掉手工实例，或改 `dsh.port`。
- **回收**：`before-quit` 里 `DshPanel.destroy()` → `DshHost.stop()`；Windows 上用 `taskkill /T /F` 按进程树收，dsh 自己拉的工作子进程不会留下占着端口的孤儿。
- **打包**：`@deepseek-ai/dsh` 在 **dependencies**（不是 devDependencies），所以 `npm run package`（`tools/package.js`，`prune: true` 会剪掉 devDependencies）出的成品**带着 dsh**，双击宠物在成品里也能开面板。两个前提：目标机器上要有系统 node（见上），以及产物会大几百 MB。

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

面板右上角的徽标一直显示当前版本号（`v0.2.1-rc.2 · 运行中 :3080`），升级前后看一眼就知道换没换成。
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
node tools/dsh-appprobe.js 9223 --shot  # 接线 + token 不外泄 + 收起不退进程，并出三张图
```

`dsh-appprobe --shot` 产出：`samples/dsh-frame.png`（我们这页的面板框）、`samples/dsh-view.png`（dsh 视图自己）、`samples/dsh-composite.png`（真实屏幕抓屏，证明视图正好盖在框的内区上）。
抓屏用 `tools/grab-region.ps1`（ASCII-only，且自己声明 DPI-aware）：Electron 报的是 DIP，抓屏要物理像素，所以原点按主屏缩放率换算、尺寸按本屏缩放率算——他这台机器主屏 1.5x、工具栏屏 1x，不换算就会偏 853px。

探针全程不打印 token，只打印它的长度；`dsh:status` 的返回里也没有 token 字段。

## 7. 要改它的界面/功能，走哪条路

dsh 是 Cordis 驱动的「一切皆插件」，那套 Web 界面本身就是约 30 个具名插件槽拼起来的（`ui-theme`、`ui-layout`、`ui-sidebar`、`ui-sidebar-files`、`ui-chat`、`ui-brand-official`、`ui-settings-*`……，见 `samples/dsh-profile-web.txt`），并且自带 `dsh-hmr`（热更新）和 `dsh-plugin-manager`。按改动深度排，越靠前越抗升级：

| 路线 | 能改什么 | 升级后 |
|---|---|---|
| `--patch x.yml` 配置叠加（可重复传） | 按 `id` 关掉/换掉某个 `ui-*` 槽、开被禁的工具、改主题与侧栏 | 一般照用 |
| 写自己的 dsh 插件包 | 新面板、新工具、新交互 | 官方扩展面，不冲突 |
| 我们侧 `view.webContents.insertCSS/insertJS` | 换配色、藏掉不想要的区块 | 只改皮，改不了行为 |
| fork 上游自己构建 | 什么都能改 | 预览版迭代快，会持续痛 |

`--patch` 目前还没接进 `DshHost.spawnOnce()` 的参数里（一条 `dsh.patch: []` 配置项的事），要用之前先说一声。
