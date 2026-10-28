# 项目记忆（跟仓库走，换机器不用重讲）

这份文件是给 AI 助手和新同事读的，不是给人看的说明书。README 讲「怎么用」，`docs/` 讲「每个模块怎么做」，这里只写**不看就会做错**的约定。

## 文档索引

| 主题 | 文件 |
|---|---|
| 整体布局与快速开始 | [README.md](README.md) |
| AI 对话 + 桌宠（含手势表） | [docs/ai-pet-panel.md](docs/ai-pet-panel.md) |
| 语音链路（ASR/TTS） | [docs/voice-module.md](docs/voice-module.md) |
| DeepSeek Harness（dsh）窗口 | [docs/dsh-panel.md](docs/dsh-panel.md) |
| Everything 全盘文件搜索 | [docs/everything-search.md](docs/everything-search.md) |
| 企业微信通知组件 | [docs/wxwork-notify-module.md](docs/wxwork-notify-module.md) |

## 硬纪律（违反等于回归失败）

- **DeepSeek 密钥**只存在于 `ai-key.bin`（Electron `safeStorage` / Windows DPAPI，落在 userData，不在仓库）和主进程内存。不进 config、不进 `state.json`、不进 git、不进日志、**不跨 IPC 回传**。子进程要用的走环境变量注入（见 `src/main/services/dsh.js`）。探针脚本只准打印长度或 `sk-…xxxx` 这类 hint。
- **遥测默认关**：dsh 官方默认 `DSH_TELEMETRY_MODE=FEEDBACK_ONLY`（会往 deepseeksvc.com 发会话日志），本项目置 `off`。新增任何第三方组件都按「默认不外发」处理。
- **所有出网留在主进程**：渲染层 CSP 是 `connect-src 'self' track:`，页面里 fetch 不到外部，别指望渲染层直连。
- **主进程不接渲染层给的文件路径**：要打开一个东西，走「我们刚返回的那批结果」+ id/序号（见 `search:open` 的 `(listId, index)`），别开一条"传路径我帮你 openPath"的 IPC。

## 改完必须跑的验证

| 改动面 | 命令（Git Bash，项目目录） |
|---|---|
| 主进程 AI/流式 | `npm run test:ai`（零依赖 mock，55 项；L 段是工具调用那圈） |
| dsh 子进程 | `npm run dsh:check` |
| 界面/手势/dsh 窗口 | 带 `--remote-debugging-port=9223` 起应用，再 `node tools/dsh-appprobe.js 9223 --shot` 或 `node tools/voice-appprobe.js 9223 --shot` |
| 布局（`layout.json` / grid / 组件与位置） | `npm run layout:appprobe -- 9223 --shot`（等价 `node tools/layout-appprobe.js 9223 --shot`）：逐格量「内容高度 vs 位置高度」，抓底部被 `.area{overflow:hidden}` 裁掉的那类溢出；截图落 `samples/layout-after.png` |
| Everything 搜索 | `npm run everything:check`（无界面，含 size/时间数值抽查）+ 带调试端口起应用后 `npm run search:appprobe -- --shot`（顶栏搜索栏常驻、下拉锚定、Ctrl+F/Esc、越界序号被拒、`search.enabled` 关掉后整条栏消失并能恢复，都在这条里） |
| 宠物调本机工具（`search_files`） | `npm run agent:appprobe -- --shot`（真发一次 DeepSeek 请求：开关生效、`ai:tool` 提示行、回答里的路径本机真存在、工具轮次不落盘、退出时把配置恢复原值）；`--check` 只看前置不动配置 |
| AI 面板几何（气泡/浮层会不会被裁、被盖） | `npm run ai:appprobe -- 9223 --reload --shot [--height 420]`：四种状态（都收起/打字浮层/完整对话/两个都开）各量一遍，断言气泡挂在 body 上、还在窗口里、贴着宠物头顶，外加「宠物头顶不被格子上沿裁」「打字浮层不盖面板里任何东西」「聊天列表自己被压住」；末尾还验气泡的「读完三秒收起」（借 `TB.voice.setSpeaking` 模拟朗读中/结束）；`--reload` 改完渲染层不用重启应用 |
| 窗口尺寸/加屏换机器 | `npm run dpi:measure`：把「请求宽高 → 实际宽高」在三块屏上各量一遍。系数不再是 `(目标÷当前)` 这个规律时，`dsh-window.js` 的 `restoreBounds()` 要跟着改 |

真机验证的规矩：**别用假数据自证**，CDP 驱动真实运行的应用；起应用前 `unset ELECTRON_RUN_AS_NODE`；这仓库有单实例锁，附着前确认没连到上一份旧实例。

## 已知的坑

- `src/main/config.js` 新增顶层配置段，必须**同时**改 `DEFAULTS` 和 `save()` 里的 `ordered` 白名单，否则设置一保存整段消失。
- Electron 33 自带的 Node（20.18）跑不了 dsh 那个全 ESM 的 CLI，会静默退 0、零输出；dsh 用 PATH 上的系统 node 起。
- `.ps1` 一律 **ASCII-only**（Windows PowerShell 5.1 读无 BOM 的 UTF-8 会解析炸），中文另存 UTF-8 数据文件；别在 bash 里内联 `powershell -Command`。
- 桌宠手势：**双击 = dsh 窗口**，打字入口在 AI 头部的「打字」按钮（历史上双击曾是打字、再往前是跳设置，别按旧文档改回去）。
- 副屏窗口尺寸只能在 `setBounds` 里落定，构造函数里传 width/height 会被主屏截断（`createWindow` 有注释）。
- 窗口尺寸的**单位会跨屏变**：`实际 = 请求 × (目标屏缩放率 ÷ 窗口当前所在屏缩放率)`（`npm run dpi:measure` 实测，同屏 1:1）。所以记尺寸要**存物理像素**（`getBounds` 的宽高乘所在屏 `scaleFactor`），恢复时**先 `setPosition` 再 `setSize`**（位置对了系数就是 1），别照抄 DIP 存回去——另一台上每重启大一圈（1180→1770→2656），这台 1.5x 主屏上每启动小一圈（1180→787→528），同一个方程的两边。见 `dsh-window.js` 的 `persistBounds()` / `restoreBounds()`。
- dsh 把带 token 的访问地址打进 stdout，而 `lastError` 是输出尾段截的——不打码就会跟着 `dsh:status` 进渲染层（`dsh.js` 的 `redact()` 负责这件事，别把它当装饰删掉）。
- 重启开发实例做验证：用 CDP 跑 `TB.api.app.quit()`（渲染层还在时），别 `taskkill` 不带 `/F`——那只关工具栏窗口；dsh 窗口是另一个顶层窗口，`window-all-closed` 不触发，应用会留在没窗口的状态，而 dsh 子进程也不会被收。
- **类字段别和方法同名**：JS 里 `this.status = {...}` 会把自己原型上的 `status()` 盖掉，第一次调用就在事件回调里抛未捕获异常。`EverythingSearch` 踩过一次（`this.state` 才是状态字段）。
- **应用"起来了却没反应"先怀疑主进程弹了错误框**：症状是进程在、`MainWindowTitle=Error`、CDP 的 `/json/list` 挂住、`run.log` 干干净净。栈只在那个模态框里，读它：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/main-error-dialog.ps1`。
- **koffi 的 out 参数不能传 JS 数组**（不报错但永远读不回值，表现是数值字段静默归零），要 `koffi.alloc(type,1)` + `koffi.decode(ptr,type)`；所以搜索结果的 size/修改时间是自检脚本的必查项。见 `everything-sdk.js` 的 `readOut()`。
- **grid 区域名不许带连字符**：`layout.js` 的校验用 `/^[a-z][a-z0-9]*$/`（CSS grid-template-areas 的 token 规则），`slot-1` 会整份布局被打回默认。占位格叫 `slot1` / `slot2`。
- **一个组件挂两个位置时，只有最后一个位置拿得到刷新**：`buildShell()` 用 `this.nodes[slot.module]` 做键，`placeholder` 占两格没问题（它没有 `update`），但以后往两格里放**有 update 的**组件必须先改这个键控方式。
- **窄列变体走 CSS 容器查询**，不是媒体查询：`.area` 上 `container-type: inline-size` + `container-name`，`@container clock (max-width: 380px)` / `@container player (max-width: 420px)`。格子宽度来自固定的 grid 轨道，所以容器查询是可靠的；窗口宽度变化不影响判断。加了新变体就要在 `layout-appprobe` 里断言容器查询真的生效（像 `playerContainer` / `chipsPerRow` 那样）。
- **`config.search.enabled` 由 `topbar.js` 的 `build()` 消费**（关掉时整条搜索栏不渲染，Ctrl+F 跟着失效），不是渲染层面板里的开关——别把它改回只写不读。
- **`contextFor()` 会自己把当前这句补成最后一条 user**：`send()` 必须先取上下文、再 `this.messages.push(...)`。反过来就是每个请求把用户那句话发两遍（`ai-mock-test` 的 L15 守着）。
- **工具轮次只活在 `send()` 的局部数组里**：带 `tool_calls` 的 assistant 和 `role:'tool'` 都不进 `this.messages`，搜索结果里那些绝对路径就是这么挡在 `state.json` 之外的。别"顺手"把它们并入历史。
- **`deepseek-reasoner` 不支持 function calling**（带 `tools` 会被 400），`availableTools()` 里那句模型判断是守门，不是冗余。
- **CDP 探针里 `await TB.ai.submit()` 等于等整轮请求跑完**（`invoke('ai:send')` 到流结束才 resolve），要采流式期间才存在的 DOM 就得起一个不 await 的 submit、把结果挂在 `window` 上再轮询。
- **验工具链的问题必须问一个历史里没出现、也猜不出来的文件**：模型会照上一轮的回答把路径编出来，看着全对其实根本没点工具（`agent-appprobe` 靠随机两层目录名逼它）。
- **要越出自己格子的 UI 一律挂 `document.body` + `position:fixed`**：`.area{overflow:hidden}` 会把越界的部分**静默**吃掉（矮屏上宠物气泡就是这么被切掉的，DOM 在、量得到、就是看不见）。跟搜索下拉同一个套路：JS 按锚点矩形写 `top/left`，并在 `resize` / `scroll` / 相关开合处重贴；`z-index` 压在 modal(50) 之下（气泡用 40），别盖住设置面板。
- **Electron 的 CDP 没有 Browser 域**（`Browser.getWindowBounds/setWindowBounds` 报 wasn't found），改不了真窗口；量矮屏用 `Emulation.setDeviceMetricsOverride`。两个坑：① 它**不发 resize**、而且第一次覆盖常常只改 `innerHeight` 不重排 grid，要补发 `resize` 再把样式判脏重测，否则量到的是过渡态；② 覆盖**清不掉**——`clearDeviceMetricsOverride`、把宽高设成 0、`Page.reload` 三种办法实测全部无效（`innerHeight` 一直停在覆盖值），只能把覆盖重新设回 `outerWidth/outerHeight`（outer 不受覆盖影响，拿它当窗口真尺寸），要彻底还原得重启应用。见 `tools/ai-appprobe.js` 的 `restoreViewport()`。
- **`<details>` 里的列表不能靠 flex 压住**：非 summary 的子节点被塞进浏览器匿名插槽盒子，那个盒子按内容算高度，于是 `.ai-list` 的 `flex:1 / min-height:0 / overflow:auto` 全都不生效（实测撑到 3181px、`clientHeight == scrollHeight`，压根没有滚动条，底部整截被 `.area{overflow:hidden}` 裁掉）。这份 Electron 是 Chrome 130，`CSS.supports('selector(::details-content)')` 为 false，也改不了那个盒子。所以「完整对话」的开合是 `div.ai-history` + `.open` 类（`TB.ai.setHistory()`），收起时列表 `display:none`。

## 换到新机器要做什么

```bash
npm install          # dsh 现在在 dependencies，会一起装（约 250 个包）
npm run voice:install # 语音模型不在 git 里（models/ 被 ignore）
npm start
```

然后：设置里重填 DeepSeek 密钥（旧密钥不跟仓库走）；`toolbar.config.json` 里 `music.folder`、`display` 定位按新机器的屏幕改；dsh 窗口要求机器上有系统 node；端口 3080 被占就改 `dsh.port`。

Everything 搜索不用装东西（便携版和 DLL 都在 `vendor/` 里跟着 git 走），第一次查询时会自动把客户端拉起来建索引；`Everything.ini` / `Everything.db` 是运行时产物，不进 git。普通权限扫不到受保护目录，要全盘就手动装一次服务（`docs/everything-search.md` 第 3 节）。

## dsh 是外部可升级件

版本留 caret（`^0.2.1-rc.x`），随时可升可回滚；**每次升完必跑**上面那两条 dsh 验证。要定制它的界面/功能，按抗升级程度优先走 `--patch` 配置叠加 → 写 dsh 插件 → 我们侧 `insertCSS`，fork 上游是最后手段（详见 docs/dsh-panel.md 第 5、7 节）。
