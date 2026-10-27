# 政务微信（WXWorkLocal）消息监听模块 · 需求文档

状态：**待决策**（§2 的实测结论推翻了最初设想，请先读 §2 和 §12 再决定是否开工）
日期：2026-10-27
目标客户端：`C:\Program Files (x86)\WXWorkLocal\WXWorkLocal.exe`
　　文件版本 `3.4.0.2694`，产品名 **政务微信**，公司 `work_weixin`，Qt 5.15.18 桌面客户端（中石油内网私有化部署，非公有云企业微信）

---

## 1. 目标与非目标

**目标**
在工具栏里反映政务微信的消息活动，并提供一键把它的窗口唤到前台。

**非目标**
- 不做消息收发（不代替客户端操作）
- 不做历史消息存储、检索、导出
- 不做多用户/他人账号的监控 —— 只针对本机当前登录账号

---

## 2. 可行性实测（本文档的地基）

用 [tools/wx-uia-probe.ps1](file:///C:/SyncData/project/skyest-toolbar/tools/wx-uia-probe.ps1) 在本机实跑，四条路的结果：

| # | 设想路径 | 实测结果 | 结论 |
|---|---|---|---|
| 1 | Windows 通知中心（WinRT `UserNotificationListener`） | 静态成员是 `Current`（不是 `GetDefault`），类型可加载，但**未打包进程调用返回 null**，拿不到授权 | **不可用** |
| 2 | UI Automation 读控件树 | 客户端可见窗口 `中油即时通信`（class `Qt51518QWindowIcon`，1407x1200）在 UIA 里**只有它自己一个元素**：`RawViewWalker` 遍历 = 1，`FindAll(Descendants)` = **0** | **不可用** |
| 3 | MSAA / `oleacc.AccessibleObjectFromWindow` | 返回 `0x80004002` = **E_NOINTERFACE**，窗口根本不响应 `WM_GETOBJECT` | **不可用** |
| 3b | 用 `QT_ACCESSIBILITY=1` 重启客户端强制激活桥接 | 已实测：新 pid 13036 / 11:23:48 全新启动，`descendants` 仍为 **0**、MSAA 仍 `0x80004002`。DLL 扫描佐证：`Qt5Gui.dll` 有 320 处 `QAccessible` 符号，但 `IRawElementProviderSimple` = **0**（无 UIA 提供者） | **不可用，已排除** |
| 4 | 数据目录文件活动 | `%APPDATA%\Tencent\WXWorkLocal\` 下 `GYLog_Local`/`GYOssLog_Local`/`Log\wwmapp` 持续被写 | 可用，但只是"有动静"的脉冲，无内容 |
| 5 | **`PrintWindow` 抓窗口位图 + 系统 OCR** | `PrintWindow(PW_RENDERFULLCONTENT)` 返回 True，**不受遮挡**拿到完整清晰位图；`Windows.Media.Ocr` + `zh-Hans-CN` 语言包可用，单轮 190–460ms | **唯一可取内容的路，但精度不足**（见 §2b） |

### 2b. OCR 路线的实测精度（决定成败）

对会话列表区（470x700，1.5x 放大）识别，与截图逐字比对：

| 实际内容 | 识别结果 |
|---|---|
| 文件传输助手 | `文 件 传 输 助 手` ✅ |
| 一体化**合**规智能体运维沟通群 | `一 体 化 台 规 智 能 体…` ❌ |
| 【综**合**能源管控】平台建设群 | `〔 综 台 能 源 管 控 〕…` ❌ |
| 汪海洋: 我**在**前**楼**开会[汗] | `汪 海 洋 ： 我 三 前 嵝 开 会 [ 汗 ]` ❌ |
| 高产液低能**耗** | `高 产 液 低 能 牦` ❌ |

**字符级准确率约 80–85%**，且 Windows OCR 会在中文字间插空格（需后处理）。人名、"合/耗/楼"这类关键字会被替换成形近字 —— 能看懂大意，**不能当作可引用的原文**。

两个已验证的附带事实：
- **屏幕抓取（`CopyFromScreen`）不可用**：同区域抓到的是压在上面的其它窗口内容（实测混进了工具栏自己的文字）。必须用 `PrintWindow`。
- 客户端在会话列表上画了**斜向姓名+工号水印**（`李海丰 0040`），既干扰 OCR，也是单位防外传的明确信号 —— 见 §9.5。



---

## 3. 项目既有约束（照抄，不另起炉灶）

| 约束 | 出处 |
|---|---|
| 渲染进程 CSP 为 `default-src 'self'; connect-src 'self' track:`，**渲染进程发不出任何外部请求**，所有系统调用必须在主进程 | [src/renderer/index.html:6](file:///C:/SyncData/project/skyest-toolbar/src/renderer/index.html#L6) |
| 零第三方依赖，`devDependencies` 只有 electron | [package.json:15](file:///C:/SyncData/project/skyest-toolbar/package.json#L15) |
| 轮询型服务的现成模板：`constructor(opts)` + `start()/stop()` + `setInterval` + `listeners:Set` + 签名去重 | [src/main/services/clipboard-history.js:8](file:///C:/SyncData/project/skyest-toolbar/src/main/services/clipboard-history.js#L8) |
| 配置段要同时进 `DEFAULTS` **和** `save()` 白名单，否则保存时被静默丢弃 | [src/main/config.js:6](file:///C:/SyncData/project/skyest-toolbar/src/main/config.js#L6) |
| 服务装配与热重载入口 | [src/main/main.js:316](file:///C:/SyncData/project/skyest-toolbar/src/main/main.js#L316)（装配）、[src/main/main.js:290](file:///C:/SyncData/project/skyest-toolbar/src/main/main.js#L290)（`applyPolling`） |
| 组件放目录即自动注册，**改文件必须重启**（无热加载） | [src/renderer/js/components/](file:///C:/SyncData/project/skyest-toolbar/src/renderer/js/components) |
| 7 个栅格位置**当前已全部占满**，新增整块区域要动 `grid.areas` | [layout.json:37](file:///C:/SyncData/project/skyest-toolbar/layout.json#L37) |
| ⚠️ 任何组件 `update()` 抛异常会连带打断 `renderAll()` 里后面的组件（dock 空白事故的同类结构，见 §9.3） | [src/renderer/js/app.js:134](file:///C:/SyncData/project/skyest-toolbar/src/renderer/js/app.js#L134) |

---

## 4. 方案对比

### ✅ 推荐：方案 B —— 顶栏「活动脉冲」徽标 + 一键唤起

只做两件事，都不越界：
1. 监听 `%APPDATA%\Tencent\WXWorkLocal\` 的文件写入 → 去抖 → 判定"客户端刚有活动"，顶栏亮一个点，记录最近一次时间。
2. 点这个徽标 → 把政务微信窗口切到前台。

**理由**
- 只用 Node 内置能力（`node:fs` 的 `FSWatcher`）+ 一个 PowerShell `AppActivate` 调用，**不破零依赖**，不注入、不抓包、不解密。
- 政务微信升级、换版本不会崩（不依赖控件树）。
- 合规上它只是一个"这个应用刚刚活跃过"的指示灯，不触碰任何消息内容。
- 顶栏加徽标不动栅格布局（[topbar.js:8](file:///C:/SyncData/project/skyest-toolbar/src/renderer/js/topbar.js#L8) 的 `topbar-right` 现成插槽），避开 §3 里"7 个位置已满"的问题。

**代价 / 必须接受的局限**
- **没有正文、没有发件人、没有未读数。** 只有"有动静"和"上次动静是几点"。
- 有噪音：定时器心跳、日志滚动也会写文件 → 会误报。
- 有漏报：客户端不写这些目录时（如消息直接进内存/其它路径）脉冲不来。
- 唤起窗口需要起一次 PowerShell 进程（约 200–400ms，只在点击时）。

### ❌ 放弃项

**A. 官方服务端接口（自建应用 / 群机器人 webhook / 会话内容存档）**
唯一能拿到**完整正文**的路。放弃原因不是技术上不行，而是：需要单位管理员在政务微信管理端开通，且回调 URL 必须能被内网服务器访问到 —— 工具栏是 NAT 后面的桌面程序，webhook 打不进来，还得再搭一层中转服务。
**→ 不放弃，降级为 §10 的 M4，且以"你能申请到"为前提。**

**B′. 常驻 PowerShell 子进程做窗口快照轮询**
能补上"未读数/窗口标题变化"这类元信息。放弃原因：要常驻一个 `powershell.exe`（约 60MB）当 FFI 替身，Electron 33 内置 Node 20 没有 `node:ffi`，代价和收益不成比例。
**→ 留作 M3 可选增强，不做默认。**

**C. UIA / MSAA 读控件树**
§2 已实测证伪（0 个后代元素 + E_NOINTERFACE）。除非重启客户端并注入 `QT_ACCESSIBILITY=1`，而重启一个正在办公的企业 IM 不该由工具栏发起。

**D. TLS 中间人抓包**
政务版走内网自建服务器 + 证书校验，装根证书大概率解不开；性质上是绕过传输安全机制，单位终端合规红线。

**E. 注入进程读内存 / 解密本地会话库**
本地库为加密存储，密钥只在进程内存里，取密钥必然要 DLL 注入。这是终端 EDR 的典型告警特征，可能直接触发安全通报，且会导致客户端闪退。**无论什么需求都不做。**

---

## 5. 数据模型（方案 B）

新增配置段 `wxwork`，进 `DEFAULTS` **和** `save()` 白名单：

```jsonc
"wxwork": {
  "enabled": false,          // 默认关，用户显式开启
  "dataDir": "%APPDATA%/Tencent/WXWorkLocal",
  "debounceMs": 1500,        // 写入风暴压成一次脉冲
  "quietMs": 20000,          // 超过这个时间无写入 → 灰点
  "processName": "WXWorkLocal.exe"
}
```

主进程内存态（不落盘、不进 `store.js`，与剪贴板同级）：

```js
{ watching: true|false, lastPulseAt: 1730000000000, pulseCount: 12, clientRunning: true }
```

## 6. 主进程契约

`src/main/services/wxwork-watch.js`：

```js
class WxworkWatch {
  constructor({ dataDir, debounceMs, quietMs, processName, enabled })
  start() / stop()                       // 幂等，仿 clipboard-history.js:19
  onChange(cb)                           // 状态变化才推，带去抖
  snapshot()                             // 给 boot:get 用
  focusClient()                          // PowerShell AppActivate，返回 {ok,error}
}
```

- `fs.watch(dir, { recursive: true })` 失败（目录不存在/权限）→ `watching:false` + 一条可展示的 reason，**不抛异常**。
- 进程在不在，用 `tasklist` 缓存 5s，别每次脉冲都查。

## 7. IPC 设计

| 通道 | 方向 | 说明 |
|---|---|---|
| `boot:get` 返回值加 `wxwork` | 拉 | 初始快照 |
| `wxwork:state` | 推 | 状态变化（去抖后） |
| `wxwork:focus` | 请求 | 唤起窗口 |
| `wxwork:setEnabled` | 请求 | 设置里开关，即时生效不用重启 |

preload 挂 `TB.api.wxwork = { focus, setEnabled, onState }`。

## 8. UI 设计

**不新增栅格块。** 在顶栏 `topbar-right` 的 `placement-label` 左边插一个徽标：

```
[ ● 政务微信 10:41 ]   1536x960 @(-2204,-1335)   组件  设置  退出
```

- 灰点 = 无活动或客户端没跑；蓝点 = `quietMs` 内有活动；点击 → 唤起窗口 + toast 结果。
- 悬停 `title` 显示 `最近活动 10:41:07 · 今日 12 次 · 监听中`。
- 文案诚实：叫**「活动」**，不叫「新消息」，不暗示未读。
- 全程 `textContent`，不拼 HTML。

## 9. 安全与合规

1. 只读文件**元信息**（存在性/修改时间），**绝不读文件内容**，日志里也不出现路径以外的信息。
2. 不做注入、不装证书、不抓包、不碰 `%APPDATA%` 下的会话库（§4 E）。
3. §9.3 结构性防护：新组件的 `update()` 内部 `try/catch` 自封闭，避免一个组件异常把 dock 之类排在其后的组件带空（本会话刚踩过）。
4. 默认关闭（`enabled:false`），需要用户在设置里显式打开 —— 避免"默默被记录"的观感。

## 10. 里程碑

| | 内容 | 验收 |
|---|---|---|
| M0 | **决策**：正文 vs 脉冲（§12 Q1） | 你确认方案 B 的局限可接受 |
| M1 | `WxworkWatch` + 配置段 + IPC + preload | 单测：造写入 → 去抖后只推一次；目录不存在 → `watching:false` 不抛 |
| M2 | 顶栏徽标 + 设置卡片 | 真机截图：发一条消息后点亮、`quietMs` 后转灰 |
| M3（可选） | 点击唤起窗口 | 客户端切到前台 |
| M4（需管理员） | 接政务微信开放接口取正文 | 依赖外部授权，暂不排期 |

## 11. 明确不做

消息正文、发件人、未读数、历史留存、关键词告警、自动回复、任何进程注入或流量拦截。

## 12. 待你确认

1. **【决定性的那条】你要的是"提醒有消息"还是"看到消息内容"？** 内容层面在这台机器上客户端侧无解（§2 实测），只能走 M4 的管理员授权接口。若你要的是内容，方案 B 就不该开工，我们直接讨论怎么申请自建应用。
2. 顶栏徽标这个位置接受吗？（备选：占用 `dock` 通栏一格，或把 `workbench` 待办便签的位置让出来 —— 它现在正是空着的）
3. 能接受误报（心跳写盘也亮）和漏报吗？不能的话，本方案没有更优解。
4. M3 的唤起要起一次 PowerShell 进程，接受吗？
5. 单位对"在本机监听这个客户端的活动"有没有明文规定？这条我不知道，得你判断。
