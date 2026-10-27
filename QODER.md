# 项目记忆（跟仓库走，换机器不用重讲）

这份文件是给 AI 助手和新同事读的，不是给人看的说明书。README 讲「怎么用」，`docs/` 讲「每个模块怎么做」，这里只写**不看就会做错**的约定。

## 文档索引

| 主题 | 文件 |
|---|---|
| 整体布局与快速开始 | [README.md](README.md) |
| AI 对话 + 桌宠（含手势表） | [docs/ai-pet-panel.md](docs/ai-pet-panel.md) |
| 语音链路（ASR/TTS） | [docs/voice-module.md](docs/voice-module.md) |
| DeepSeek Harness（dsh）面板 | [docs/dsh-panel.md](docs/dsh-panel.md) |
| 企业微信通知组件 | [docs/wxwork-notify-module.md](docs/wxwork-notify-module.md) |

## 硬纪律（违反等于回归失败）

- **DeepSeek 密钥**只存在于 `ai-key.bin`（Electron `safeStorage` / Windows DPAPI，落在 userData，不在仓库）和主进程内存。不进 config、不进 `state.json`、不进 git、不进日志、**不跨 IPC 回传**。子进程要用的走环境变量注入（见 `src/main/services/dsh.js`）。探针脚本只准打印长度或 `sk-…xxxx` 这类 hint。
- **遥测默认关**：dsh 官方默认 `DSH_TELEMETRY_MODE=FEEDBACK_ONLY`（会往 deepseeksvc.com 发会话日志），本项目置 `off`。新增任何第三方组件都按「默认不外发」处理。
- **所有出网留在主进程**：渲染层 CSP 是 `connect-src 'self' track:`，页面里 fetch 不到外部，别指望渲染层直连。

## 改完必须跑的验证

| 改动面 | 命令（Git Bash，项目目录） |
|---|---|
| 主进程 AI/流式 | `npm run test:ai`（零依赖 mock，37 项） |
| dsh 子进程 | `npm run dsh:check` |
| 界面/手势/内嵌视图 | 带 `--remote-debugging-port=9223` 起应用，再 `node tools/dsh-appprobe.js 9223 --shot` 或 `node tools/voice-appprobe.js 9223 --shot` |

真机验证的规矩：**别用假数据自证**，CDP 驱动真实运行的应用；起应用前 `unset ELECTRON_RUN_AS_NODE`；这仓库有单实例锁，附着前确认没连到上一份旧实例。

## 已知的坑

- `src/main/config.js` 新增顶层配置段，必须**同时**改 `DEFAULTS` 和 `save()` 里的 `ordered` 白名单，否则设置一保存整段消失。
- Electron 33 自带的 Node（20.18）跑不了 dsh 那个全 ESM 的 CLI，会静默退 0、零输出；dsh 用 PATH 上的系统 node 起。
- `.ps1` 一律 **ASCII-only**（Windows PowerShell 5.1 读无 BOM 的 UTF-8 会解析炸），中文另存 UTF-8 数据文件；别在 bash 里内联 `powershell -Command`。
- 桌宠手势：**双击 = dsh 面板**，打字入口在 AI 头部的「打字」按钮（历史上双击曾是打字、再往前是跳设置，别按旧文档改回去）。
- 副屏窗口尺寸只能在 `setBounds` 里落定，构造函数里传 width/height 会被主屏截断（`createWindow` 有注释）。

## 换到新机器要做什么

```bash
npm install          # dsh 现在在 dependencies，会一起装（约 250 个包）
npm run voice:install # 语音模型不在 git 里（models/ 被 ignore）
npm start
```

然后：设置里重填 DeepSeek 密钥（旧密钥不跟仓库走）；`toolbar.config.json` 里 `music.folder`、`display` 定位按新机器的屏幕改；dsh 面板要求机器上有系统 node；端口 3080 被占就改 `dsh.port`。

## dsh 是外部可升级件

版本留 caret（`^0.2.1-rc.x`），随时可升可回滚；**每次升完必跑**上面那两条 dsh 验证。要定制它的界面/功能，按抗升级程度优先走 `--patch` 配置叠加 → 写 dsh 插件 → 我们侧 `insertCSS`，fork 上游是最后手段（详见 docs/dsh-panel.md 第 5、7 节）。
