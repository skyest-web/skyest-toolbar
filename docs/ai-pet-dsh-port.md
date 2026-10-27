# AI 宠物 · 移植 dsh-pet 素材层

来源：`PC2005-cloud/dsh-pet` v0.3.8，本机已装好，路径
`C:\Users\skyes\.dsh\profiles\desktop\node_modules\dsh-pet\`（GitHub 直连被网络挡了，但这份是 Harness 插件装下来的，直接读本地即可）。
许可证 **MIT**（Copyright (c) 2026 PC2005-cloud），移植合法；仓库里保留 `LICENSE` 副本 + 来源注明。

## 1. 它是什么 / 我们要哪一块

dsh-pet 是「全屏透明置顶窗 + 一只会自己走动、被拖拽、随机整活的蓝毛小女仆」。三层：

| 层 | 位置 | 移植？ |
|---|---|---|
| 桌面行为：多屏 DPI、贴边、拖拽抛掷物理、随机游走、朝向镜像、置顶看门狗、托盘 | `runtime/electron-helper/main.js` 1237 行 + `constants.js` 几何表 | ❌ 我们是固定面板，不是桌面宠物 |
| 宿主联动：Cordis/IPC 取 Harness 工作状态、余额、碎碎念 | `src/host/**`（TypeScript，依赖 `@deepseek-ai/*` peer） | ❌ 我们的状态来自自己的 DeepSeek 流 |
| **精灵播放：两条 `<video>` 交叉淡入淡出 + 加权随机动画链** | `sprite.js:492-591,667-759`、`shared-core.js:21-75`、`index.html:43-55` | ✅ 这才是「活起来」的那部分 |

结论：**只借它的播放器和素材，不借它的窗口**。我们的 SVG 猫是静态贴图换表情，观感差在这一层——它靠 106 段带 alpha 的 VP9 webm，每段约 10 秒真人级动作。

## 2. 播放器（要抄的核心，很小）

- 两个 `<video muted playsinline autoplay>` 叠在一个盒子里，`opacity:0; transition:opacity .18s`，前台那条加 `.is-front`（`index.html:43-55`）。
- `switchTo()`：把新 src 设到**后台**那条 → 等 `loadeddata` → 交换 `.is-front` → `old.pause()`（`sprite.js:492-585`）。没有 canvas、没有 `globalAlpha`，透明全靠 webm 自带 alpha 通道（已验：`待机呼吸休闲.webm` 头是 `V_VP9`、`ALPHA_MODE=1`）。
- 事件驱动，不用定时器：`el.onended = handleEnded` → 按 `animationWeights`（idle 10 / turn 5 / move 5 / 分类 80）抽下一段；loop 片段永不 `ended`，所以「播一次」的片段负责推进链条（`sprite.js:667-759`）。
- `pick(pool, excludeCurrent)` 避免连抽同一段（`shared-core.js:21-25`）。

去掉全部 `petBridge` / `reportPlayback` / `markPoseDirty` / `scaleX(-1)` 之后，这个模块大约 120 行。

## 3. 接到我们已有的情绪协议上

M1 已经能稳定产出 `[开心] [平静] [好奇] [困] [生气] [难过]`，正好一一对上它的 `workStatus` 六档形状。**情绪标签不改协议，只换渲染后端**：`TB.pet` 从「SVG 换 class」变成「按 mood 抽一段 clip」。

| mood | 候选 clip（档内随机，播一次后回待机链） |
|---|---|
| happy 开心 | 点击回应-开心跃动 / 点击回应-元气挥手 |
| calm 平静 | 待机呼吸休闲（loop） |
| curious 好奇 | 东张西望 / 工作状态-思考冒泡 |
| sleepy 困 | 哈欠连天 / 原地小憩沉眠 / 打瞌睡被惊醒 |
| angry 生气 | 点击回应-傲娇生气 / 玩游戏气急败坏 |
| sad 难过 | 工作状态-垂头叹气冒汗 |
| error | 被吓一跳 |
| talking（流式中） | 工作状态-忙碌点按（loop，首字到达后停） |

素材落盘：`src/renderer/assets/pet/*.webm`。全量 106 段 51.8 MB 不收；上表这 20 段（7.9 MB）是扩池候选，
**首发只装 8 段 / 3.1 MB**（见 §7、§8）。CSP 不用动：`default-src 'self'` 已覆盖 `media-src`，相对路径同源即可。

## 4. 保留退路

`config.ai.persona` 加第三个值：`'video'`（新默认）| `'pet'`（现在的 SVG 猫）| `'plain'`（纯文本）。
换后端 = 换 `TB.pet` 的实现，`ai.js` 组件里 `setPet(mood, talk)` 调用点一行不改。SVG 那套不删，它顺带是 `motion:'off'` 和低配机型的兜底。

## 5. 风险

| 风险 | 应对 |
|---|---|
| **常驻视频解码比 SVG 更吃 CPU/GPU**。§11b 实测 SVG 版宠物常驻 ≈19% 单核；VP9 alpha 视频要额外做 alpha 混合 | 上线前用同一把尺子量（§11b 方法）。超 30% 单核就把「随机整活链」关掉，只留待机 loop + 换表情那一段；仍超就 `motion:'off'` 时 `video.pause()` |
| 面板尺寸只有 150×155，人物 462px 的素材缩到三分之一可能糊 | 先截一张真机图验收；糊了就放大 `.ai-pet` 到 200px 或改成 `object-fit:contain` 顶对齐 |
| clip 里人物位置不居中/带地面阴影，小盒子里会被裁 | 每段素材逐一过一遍，不合格的直接从 20 段清单里剔 |
| 仓库体积 +8 MB | 可接受；不做 git-lfs |
| 上游改名/新增 clip | 素材一次性拷进本仓库，不做运行时引用 `~/.dsh` |

## 6. 落地顺序

1. 拷 20 段 webm + `LICENSE`，写来源注明。
2. `src/renderer/js/pet-video.js`：双 video 交叉淡入淡出 + mood→clip 表 + `playOnce`/回待机链，约 120 行。
3. `ai.js` 按 `persona` 选后端；`config.js` 默认值加 `'video'`。
4. 量 CPU（§11b 方法），决定是否砍随机链。
5. 真机截图验收 6 个表情 + 说话态。
6. M3 设置卡片：persona 三档 + motion。

## 7. 已拍板（2026-10-27）

1. 形象：**换成蓝毛小女仆**，不与 SVG 猫并存为默认。`config.ai.persona` 默认改成 `'video'`；`'pet'`（SVG 猫）与 `'plain'` 两个后端代码都还留着，改配置即可回退。
2. 素材：**先装 8 段**（待机 + 6 表情 + 说话态），共 **3.1 MB**，落在 `src/renderer/assets/pet/`。§3 表里那 20 段是扩池候选，没装。
3. 随机整活链：**不做**。理由见 §5 第一行——实测常驻视频已经比 SVG 贵一倍，再挂随机链不值。

## 8. 落地结果

情绪→片段映射（一次性播放，播完自动回待机循环）：

| mood | clip |
|---|---|
| calm | `待机呼吸休闲.webm`（loop） |
| happy | `点击回应-开心跃动.webm` |
| curious | `东张西望.webm` |
| sleepy | `哈欠连天.webm` |
| angry | `点击回应-傲娇生气.webm` |
| sad | `工作状态-垂头叹气冒汗.webm` |
| error | `被吓一跳.webm` |
| 流式说话中 | `工作状态-忙碌点按.webm`（loop，首字后仍持续到回合结束） |

播放器：`src/renderer/js/pet-video.js`，118 行，零依赖。素材是 640×360 舞台、人物只占中间 240×285，
所以用 `object-fit: cover` 把两侧透明区裁掉，盒子给到 190×190 才能得到约 150px 高的人物（见 `styles.css` 的 `.ai-pet.pet-video-host`）。

**CPU 实测**（4 个 electron 进程合计，`Win32_PerfFormattedData_PerfProc_Process` 6 次采样均值）：

| 状态 | 单核占比 |
|---|---|
| `motion:'off'`（视频暂停，只剩时钟/指标） | avg 2.7%，max 8% |
| 待机视频循环 | avg 23%，max 42%（换表情那一瞬） |

即常驻视频比暂停多吃约 **20 个百分点单核 ≈ 18 核机器的 1.1%**，是 §11b SVG 猫（~19%）的同一量级、略高。
在 §5 定的 30% 线以内，可以常驻。`motion:'off'` 依然是唯一真省的档位。

踩过的两个坑：
1. `build()` 里 `this.bubble = <div>` 覆盖了同名方法 `bubble()`，`render()` 后半段静默抛错、`update()` 的 catch 把表情按回 calm——排查全靠 CDP 直接读 DOM，别猜截图。
2. 表情片段播完后**不能按 mood 反查下一段**（会拿到刚播完那段、被去重挡掉，宠物定格在最后一帧）。`onended` 一律回待机，换表情只由 `apply()` 触发。

## 9. M3 补记（同日）

- 设置卡片三项：**宠物形象**（video/pet/plain）、**情绪标签**（emotion）、**宠物动画**（full/calm/off）。保存后 `applyConfigResult → buildShell` 会重建组件，所以换形象即时生效、不用重启；两个后端之间来回切都验过。
- 点宠物 = 从 `点击回应-*` 5 段里随机播一条（为此多拷了 3 段，素材共 12 个文件 / 4.4 MB），不请求 API；双击 = 打开设置并滚到本卡片（`TB.settings.open('ai')`，卡片靠 `data-card="ai"` 定位）。
- 单击延后 260ms 给双击让位；流式回复中点击不响应（§7 约定，别和「停止」抢注意力）。
- `motion:'off'` 在视频后端 = `pause()` 全部 video，实测从 23% 降到 3%，是三档里唯一真省的一档。
