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

多会话/会话标题、markdown 与代码高亮、图片/文件输入、联网搜索、语音输入、把剪贴板内容一键丢给 AI、token 用量与费用统计、非 DeepSeek 的任何后端、全局快捷键唤起浮层、模型输出写进便签/待办。

工具调用原本也在这条里，2026-10-28 补了一个刻意最小的版本，见 §13。

## 12. 需要你拍板

1. **模型默认值**：`deepseek-chat`（V3，快）还是 `deepseek-reasoner`（R1，带思考过程但慢）？我倾向默认 `deepseek-chat`，reasoner 作为下拉可选项。
2. **历史是否跨重启保留**：`persistHistory` 我默认给了 `true`。但剪贴板那套的设计哲学是「敏感内容不落盘」，对话历史里很可能有从别处复制来的私密信息 —— 要不要默认 `false`（只内存，退出即清）？
3. **上下文条数**：默认带最近 12 条（约 6 轮）。够不够，还是给到 20 条？
4. **密钥谁来填**：需要你提供一个 DeepSeek 的 `sk-` key（platform.deepseek.com 上建，账户要有余额）。我不会代你去注册或索取，也不会把它写进任何会提交的文件。
5. **落点确认**：一期就按 §8 放到 `workbench`、与待办/便签对调，可以吗？还是你想先放到别的位置试试？
6. **`Ctrl+,` 守卫**：§10-M3 那条输入框快捷键冲突修复，算本模块范围内一起做，还是你想单独提？

## 13. 补充（2026-10-28）：只读本机文件索引的工具调用

宠物现在能回答「X 在哪」了，走的是 DeepSeek 的 function calling，工具只有一个，而且只读。

- **开关**：`ai.agentTools.enabled`，默认 `false`。开着它 = 同意把命中的文件名和路径作为模型输入发到 DeepSeek，所以不默认开。还要 `search.enabled` 也为开、模型是 `deepseek-chat`（reasoner 不支持 function calling，挂上去会被 400），三者缺一则这轮请求不带 `tools`。工具清单每轮现取，改设置即时生效。
- **工具定义**：`src/main/services/ai-tools.js` 的 `searchFilesTool()`，直接调主进程里的 `EverythingSearch.search()`（同进程，不走 IPC）。最多回 12 条、结果整段截到 3000 字。**`search:open` 不给模型**：那条是 `(listId, 序号)` 定位，参数能被它自己拼出来就等于让它替你双击文件。要加工件照 `searchFilesTool` 的 `{name, schema, run}` 形状加，`ai.js` 的循环不用动。
- **循环**：`ai.js` 的 `send()` 外面套一层，`streamOnce()` 收 `delta.tool_calls`（arguments 是分片来的，按 `index` 拼回完整 JSON 才能 `parse`），`runTools()` 执行后把结果作为 `role:'tool'` 回传再走一轮。`MAX_TOOL_ROUNDS = 2` 是硬闸：第三轮不再带 `tools`，逼它用文字收尾；服务端行为异常（没给工具还吐 `tool_calls`）也停在这儿，不会死循环。
- **不落盘**：带 `tool_calls` 的 assistant 和 `role:'tool'` 那些轮次只活在本次 `send()` 的局部数组里，不写进 `this.messages`，所以绝对路径进不了 `userData/state.json`。落盘的只有用户那句话和最终回答（回答里模型自己会引用路径，那是给你看的）。
- **界面**：主进程每执行一次工具发一条 `ai:tool`，渲染层攒在 `state.ai.stream.tools` 里，画在宠物上方那行小字（「查了本机文件索引「x」 → 3 条」）。它跟着 `stream` 一起消失，不进对话历史。
- **验收**：`npm run test:ai` 的 L 段（分片拼回、`role:'tool'` 回传、轮次上限、不落盘、reasoner 不挂工具、不接工具时请求体和以前逐字节一样）；真机整链 `npm run agent:appprobe -- --shot`（会发一次真实请求，细节见该文件头注释）。

## 14. 补充（2026-10-28）：气泡是浮在 body 上的，不留在格子里

矮屏（视口 ≤450px 那档）上「它在说什么」那块会被切掉：气泡原来在 `.ai-stage` 里，宠物头顶到格子上沿放不下它，越出的部分被 `.area{overflow:hidden}` **静默**吃掉——DOM 在、`getBoundingClientRect` 也量得到，就是看不见。

- **锚点**：贴在宠物头顶居中 8px；`ai:tool` 那行（工具痕迹）露出来时改贴在它上面。宽度跟着格子走（`格子宽 - 20`，夹在 180~420px）。
- **越界处理**：顶边放不下就**压缩气泡高度**（`max-height` 收到头顶余量，最少留 56px）并让文本滚到最新那句，不往窗口顶边硬贴——硬贴会盖住宠物和面板按钮，单击浮出输入条、双击 Harness 全跟着废。
- **不吃点击**：`.ai-bubble{pointer-events:none}`。要看全文有「完整对话」，气泡只负责"正在说什么"。
- **重贴时机**：`resize`、页面/列表 `scroll`（矮屏 grid 会溢出，focus 输入框就能把页面滚 53px，fixed 的气泡不跟着走就会盖到宠物头上）、`完整对话` 展开收起、打字浮层开合。`openCompose()` 里是**先 focus 再贴**，顺序反了量到的就是滚动前的位置。
- **层级**：`z-index:40`，在 modal(50)、搜索面板(60)、toast(80) 之下。
- **验收**：`npm run ai:appprobe -- 9223 --reload --shot`（原生）和 `--height 420`（矮屏）两档都跑，断言气泡 `parentElement===BODY`、整块还在窗口里、底边贴着宠物头顶；截图落 `samples/ai-{closed,compose,history,both}.png`。


## 15. 补充（2026-10-28）：矮屏不裁宠物、浮层腾地方、气泡说完三秒收

§14 把气泡捞出来了，剩下三件同源的矮屏账（都在 420 高那档复现，视口 ≤450px）：

- **舞台的让位顺序**：`你：xxx` 和工具痕迹那两行先让 → 宠物盒子再让（190px 最低缩到 78px）→ **没有"裁头顶"这个选项**。靠 `.ai-ask` / `.ai-tool` / `.ai-pet` 都改成 `flex: 0 1 auto` + `min-height`（宠物 78px，两行小字 0）；原来宠物是 `flex: 0 0 auto`，格子不够高就由 `.area` 拿 `overflow:hidden` 削它头顶（实测少 5~14px）。
- **打字浮层不压宠物脚**：浮层还是绝对定位在面板底部，但展开时给面板挂 `.compose-open`，用 `padding-bottom: calc(var(--compose-h) + 12px)` 把底部那条带腾出来；`--compose-h` 由 `openCompose()` 量浮层实际高度写死进去（录音按钮在不在会影响它，所以不写常量）。实测：550 高的屏宠物 188→130，420 高的屏宠物缩到 78，头顶不裁、脚也不盖。
- **「完整对话」不再是 `<details>`**：浏览器把非 `<summary>` 的子节点塞进匿名插槽盒子，那个盒子按内容算高度，`.ai-list` 的 `flex:1 / min-height:0 / overflow:auto` 一条都不生效（实测列表 3181px 高、没有滚动条，底部被格子裁掉）。换成 `div.ai-history` + `.open` 类，开合走 `TB.ai.setHistory(open)`（顺手重贴气泡），收起时 `.ai-list{display:none}` 免得它把父盒撑开。`.ai-history` 自己 `overflow:hidden`：极矮屏（420 高 + 打字 + 展开）分给列表 0 像素时，只剩标题行，不会有一截透明列表漏到输入框上。
- **气泡说完三秒收起**：`render()` 里给每轮回复记一个 key（消息条数 + 末条长度），`!streaming && !TB.voice.speaking` 才起 3s 表；朗读一开始就把表撤掉，`voice.setSpeaking(false)` 那次渲染重新起表——所以是「**语音回答完**三秒」，不是「回复出来三秒」。右键打断、`plain` 形象、首次渲染（历史里那条旧回复）都不会闪一下。要再看就发消息，下一轮自然又叫回来。
- **验收**：`npm run ai:appprobe -- 9223 --reload --shot`（原生 550）与 `--height 420`（矮屏）两档，四种状态各量一遍；断言里新增了「宠物头顶裁切=0」「打字浮层不盖 pet/stage/history/list/bubble」「列表被容器压住（或明确是被裁的）」，末尾还跑一遍自动收起（借 `TB.voice.setSpeaking` 模拟朗读中与朗读结束）。`--height` 跑完的视口覆盖清不掉（实测 clear / 归零 / reload 三种都无效），探针会把尺寸设回窗口原大小并提示：要彻底还原就重启应用。
