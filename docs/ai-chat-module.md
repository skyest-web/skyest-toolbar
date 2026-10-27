# AI 对话模块 需求文档（一期）

状态：**待确认**，未开始编码。
已拍板的三条：常驻对话面板 / 只接 DeepSeek 官方 API / 密钥用 safeStorage 加密存。

---

## 1. 目标

在工具栏里加一个可放到任意格子的「AI 对话」组件：输入框 + 多轮历史 + 流式输出，走 DeepSeek 官方 `chat/completions`。请求全部在主进程发起，密钥不落明文。

不做的事见 §11。

## 2. 现状约束（已核对代码，实现时必须绕开）

| 约束 | 位置 | 影响 |
| --- | --- | --- |
| CSP `connect-src 'self' track:` | [src/renderer/index.html:7](../src/renderer/index.html) | 渲染层**不能**直接 fetch https。AI 请求必须放主进程。CSP 不用改（改了反而扩大攻击面）。 |
| `config.save()` 按固定白名单重写顶层键 | [src/main/config.js:52](../src/main/config.js) | 新增 `ai` 段**必须同时加进 `DEFAULTS` 和 `save()` 的 `ordered`**，否则设置页一保存就把整段 `ai` 静默删掉。 |
| `Store` 的 `EMPTY` 只有 `tasks/notes/player` | [src/main/services/store.js:4](../src/main/services/store.js) | 对话历史要在这里加默认键，否则首次 `get('aiChat')` 返回 `undefined`。 |
| 组件清单启动时扫目录 | [src/main/main.js:19](../src/main/main.js) | 新增 `ai.js` 后**必须重启一次**才会出现在「可用组件」里。 |
| 全局空格键 = 播放/暂停 | [src/renderer/js/app.js:139](../src/renderer/js/app.js) | 已用 `event.target === document.body` 兜住，输入框里打字不会误触。 |
| 全局 `Ctrl+,` / `Ctrl+L` | [src/renderer/js/app.js:131](../src/renderer/js/app.js) | 输入框里按这两个组合键会弹面板。**一期修掉**：加 `event.target.closest('input,textarea,select')` 守卫。 |
| 7 个 area 全部已占用 | [layout.json:14](../layout.json) | 见 §8 落点方案。 |
| 本机国际链路实测 ~40KB/s | 本次会话 | DeepSeek 是国内服务不受影响，但超时阈值要给宽，且必须能取消。 |

## 3. 数据模型

### 3.1 `toolbar.config.json` 新增 `ai` 段

```jsonc
{
  "ai": {
    "model": "deepseek-chat",      // deepseek-chat | deepseek-reasoner
    "systemPrompt": "你是常驻桌面工具栏里的助手，回答尽量简短。",
    "temperature": 0.6,            // 0–2
    "maxTokens": 1024,             // 1–8192
    "contextMessages": 12,         // 带最近几条做上下文，2–40
    "timeoutMs": 60000,            // 整请求上限
    "firstByteTimeoutMs": 15000,   // 首个 delta 之前的等待上限
    "persistHistory": true         // 是否写 state.json
  }
}
```

**注意：这里没有 `apiKey`。** 密钥不进 config 文件，见 §3.3。

### 3.2 `userData/state.json` 新增 `aiChat`

```jsonc
{
  "aiChat": [
    { "role": "user", "content": "…", "at": 1730000000000 },
    { "role": "assistant", "content": "…", "at": 1730000003000, "reasoning": "…", "ms": 3000 }
  ]
}
```

- 单会话，一期不做多会话。
- 上限 `maxHistory = 200` 条，超出从最旧裁掉。
- 单条 `content` 上限 8000 字符，超出截断并在 UI 提示。
- `reasoning` 只在 `deepseek-reasoner` 下有值。
- 写盘复用现有 `store.scheduleFlush()` 的 400ms 合并写，不新增节流。

### 3.3 密钥：`userData/ai-key.bin`

- 用 `safeStorage.encryptString(apiKey)` 后写二进制文件；读时 `decryptString`。
- 前置判断 `safeStorage.isEncryptionAvailable()`（必须在 `app.whenReady()` 之后调用）。不可用时**拒绝保存并明确报错**，不静默退回明文。
- 内存里只保留解密后的字符串，`config` 对象、日志、IPC 返回值里都**不带**密钥。
- 对外只暴露状态：`{ set: true, hint: "sk-…3f2a" }`（首 4 + 末 4）。
- 删除：设置页「清除密钥」直接删文件 + 清内存。

## 4. 后端契约（DeepSeek 官方）

- `POST https://api.deepseek.com/chat/completions`
- Header：`Authorization: Bearer <key>`、`Content-Type: application/json`、`Accept: text/event-stream`
- Body：`{ model, messages, stream: true, temperature, max_tokens, stream_options: { include_usage: true } }`
- 响应是 SSE：逐行 `data: {json}`，终止于 `data: [DONE]`。
  - 增量文本在 `choices[0].delta.content`；`deepseek-reasoner` 另有 `choices[0].delta.reasoning_content`。
  - **必须自己处理跨 chunk 的半行**：维护一个 buffer，按 `\n` 切，最后一段留在 buffer 里等下一个 chunk。
  - usage 在 `[DONE]` 前的最后一个 chunk（`choices` 为空数组），要单独判空，别当错误。
- 错误分类（UI 要能区分，不能只报「失败」）：
  | HTTP | 含义 | 提示文案 |
  | --- | --- | --- |
  | 401 | key 无效/被删 | 密钥无效，去设置里重新填 |
  | 402 | 余额不足 | DeepSeek 账户余额不足 |
  | 429 | 并发/速率限制 | 请求太频繁，稍等再试（建议自动重试 1 次，退避 2s） |
  | 500/502/503 | 服务端 | DeepSeek 服务异常，可点重试 |
  | — | 网络/超时/abort | 超时或已取消 |
  - 错误响应体只取 `error.message` 并截断到 200 字符，**不回显任何请求头**。

## 5. 进程划分与 IPC

```
渲染层 ai.js  ──invoke ai:send──►  主进程 services/ai.js  ──fetch──►  DeepSeek
      ▲                                   │
      └──event ai:delta / ai:done / ai:error ◄（webContents.send）
```

`src/preload/preload.js` 新增：

```js
ai: {
  send: (text) => invoke('ai:send', text),          // → { requestId }
  abort: () => invoke('ai:abort'),                   // 取消当前请求
  clear: () => invoke('ai:clear'),                   // 清空历史
  setKey: (key) => invoke('ai:key:set', key),        // → { ok, hint } | { ok:false, error }
  clearKey: () => invoke('ai:key:clear'),
  keyStatus: () => invoke('ai:key:status'),          // → { set, hint }
  onDelta: (h) => on('ai:delta', h),                 // payload { requestId, text, reasoning }
  onDone: (h) => on('ai:done', h),                   // payload { requestId, usage, ms }
  onError: (h) => on('ai:error', h)                  // payload { requestId, kind, message }
}
```

设计约束：
- **只传文本，不传 messages 数组**。历史由主进程持有（`store`），渲染层只发当前输入 —— 避免渲染层伪造上下文、也少一份状态真相。
- 同一时刻只允许 1 个未完成请求；`ai:send` 时若已有在途请求，先 `abort` 再发。
- `requestId` 用于丢弃 abort 之后才到达的迟到 delta。
- `boot:get` 返回值加 `ai: { history, keyStatus, config }`，`app.js` 的 `state` 加 `aiHistory`。
- delta 推送**不做合并节流**（逐 token 推），但渲染层用 `requestAnimationFrame` 合帧写 DOM，避免 960 高屏上频繁重排。

## 6. 渲染层组件 `src/renderer/js/components/ai.js`

```
┌ AI 对话            deepseek-chat ●流式中  ⟳清空 ┐
│ 用户：…                                          │
│ AI：…（逐字出现）                                 │
│ ── 思考过程（reasoner 时折叠显示）──              │
│ ┌──────────────────────────────┐ ┌───┐           │
│ │ 输入，Enter 发送 Shift+Enter 换行 │ │停止│           │
│ └──────────────────────────────┘ └───┘           │
└──────────────────────────────────────────────────┘
```

- 注册：`TB.register({ id: 'ai', name: 'AI 对话', cls: 'area ai', build, init, update })`。
- **所有模型输出只用 `textContent` 追加，禁止 `innerHTML`**（防 XSS / 防模型吐出标签打乱界面）。一期不渲染 markdown，只保留换行（`white-space: pre-wrap`）；代码块用等宽底色区分留到二期。
- 流式：delta 累到最后一个 assistant 气泡；`update(state)` 只负责非流式部分（模型名、密钥状态、历史整体重绘），避免和 delta 通道打架。
- 滚动：贴底时自动跟随；用户手动上滚（`scrollTop + clientHeight < scrollHeight - 40`）后停止跟随，显示「↓ 回到底部」。
- 空态：未配密钥时输入框禁用 + 提示「在设置里填 DeepSeek 密钥」，并给一个直达设置页的按钮。
- 错误气泡带「重试」按钮（重发上一条 user 消息）。
- 高度自适应：格子最小 118px 时只显示输入框 + 最新一条，靠 `overflow` 滚动，不撑破 grid。

## 7. 设置页

在 `src/renderer/js/settings.js` 加一张 `card('AI')`：密钥（password 输入 + 保存/清除 + 当前状态 hint）、模型下拉、system prompt 文本域、temperature / maxTokens / contextMessages 数字框、`persistHistory` 开关。走现有「保存并应用」的 `config:save` 通道，不新增保存路径。

## 8. 布局落点（推荐 + 放弃项）

**推荐：一期不改 `grid`，AI 进组件池，由你在「组件与位置」面板里放到 `workbench`（中部右上，与待办/便签自动对调）。**

理由：
1. 这套界面的设计前提就是「位置固定、组件可换」，用现成机制零风险，不碰 `DEFAULT_LAYOUT`、不碰校验逻辑。
2. `workbench` 在 1536×960 上约 400×300，够看 2–3 条消息 + 输入框，是右侧竖条之外最适合对话的格子。
3. 想临时换回去只要 Ctrl+L 换一下，不用回滚代码。

放弃的选项：
- **新增 `ai` area**：要同时改 `layout.json` 的 `areas`、`DEFAULT_LAYOUT.slots`、并保证「每个 area 都有 slot」校验通过；1536×960 上再切一行会把指标卡挤到不可读。等一期跑通、确认你真的常驻用它，再单独做这次布局改动更划算。
- **顶栏浮层**：你已经明确选了常驻面板，不重复做。
- **替换 `clipboard`**：剪贴板历史是内存态、重启即空，换掉它等于永久失去这个功能。

## 9. 安全

- 密钥只存在于 `ai-key.bin`（DPAPI 加密）和主进程内存；不进 `toolbar.config.json`、不进 `state.json`、不进 git、不进日志、不跨 IPC 回传渲染层。
- 渲染层输入长度上限（8000 字符）+ 单请求并发上限（1），防误操作刷爆账户。
- 模型输出一律 `textContent`。
- `ai:send` 只接受字符串，主进程做类型校验；不接受渲染层传入的 URL / model 名（model 只从 config 读，且白名单二选一），避免把主进程变成任意 HTTP 代理 —— 这是本设计里最关键的一条。
- system prompt 允许用户自定义，属于用户自己的信任域，文档里记一笔。

## 10. 里程碑

| | 内容 | 验收 |
| --- | --- | --- |
| **M1** | `services/ai.js` + 密钥存取 + IPC 通道 + `config.js` 白名单加 `ai` | 临时脚本调用能拿到流式结果；`ai:key:set` 后 `ai-key.bin` 存在且 `file` 里看不到明文；401/429/超时三类错误各自返回正确 `kind` |
| **M2** | `components/ai.js` 流式渲染 + 历史持久化 | 重启后历史还在；边生成边出字；停止按钮 1s 内断流；上滚不被拽回底部 |
| **M3** | 设置页 AI 卡片 + 修 `Ctrl+,`/`Ctrl+L` 输入框守卫 | 不重启即可换 key/模型；在输入框里按 Ctrl+, 不弹面板 |
| **M4** | 重试按钮、错误文案、reasoner 思考过程折叠、回到底部按钮 | 断网/错 key/余额不足三种情况提示可区分且可自助恢复 |

每个里程碑结束都跑一次 `npm run dev` 看 DevTools 控制台，确认没有 `[components] 加载失败`。

## 11. 一期不做

多会话/会话标题、markdown 与代码高亮、图片/文件输入、工具调用与联网搜索、语音输入、把剪贴板内容一键丢给 AI、token 用量与费用统计、非 DeepSeek 的任何后端、全局快捷键唤起浮层、模型输出写进便签/待办。

## 12. 需要你拍板

1. **模型默认值**：`deepseek-chat`（V3，快）还是 `deepseek-reasoner`（R1，带思考过程但慢）？我倾向默认 `deepseek-chat`，reasoner 作为下拉可选项。
2. **历史是否跨重启保留**：`persistHistory` 我默认给了 `true`。但剪贴板那套的设计哲学是「敏感内容不落盘」，对话历史里很可能有从别处复制来的私密信息 —— 要不要默认 `false`（只内存，退出即清）？
3. **上下文条数**：默认带最近 12 条（约 6 轮）。够不够，还是给到 20 条？
4. **密钥谁来填**：需要你提供一个 DeepSeek 的 `sk-` key（platform.deepseek.com 上建，账户要有余额）。我不会代你去注册或索取，也不会把它写进任何会提交的文件。
5. **落点确认**：一期就按 §8 放到 `workbench`、与待办/便签对调，可以吗？还是你想先放到别的位置试试？
6. **`Ctrl+,` 守卫**：§10-M3 那条输入框快捷键冲突修复，算本模块范围内一起做，还是你想单独提？
