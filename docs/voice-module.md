# 宠物语音模块 实现文档

状态：**代码已接完，链路自测全绿**（模型走 hf-mirror 装好，见 §7；音色与试听见 §9）。
需求来源：本会话方案「宠物语音模块（ASR + TTS 本地部署）」，保底 = TTS 双引擎。

---

## 1. 目标

给 AI 伙伴加一对耳朵和一张嘴：**说话 → 识别出最终文本直接问 AI（可关成草稿）→ 走现有 DeepSeek 链 → 回复逐句朗读，宠物口型跟着真实发声走**。LLM 后端不换，语音只负责"听"和"说"。

## 2. 选型与理由

| 环节 | 选择 | 为什么 |
| --- | --- | --- |
| LLM | 不动，继续 DeepSeek SSE（[src/main/services/ai.js](../src/main/services/ai.js)） | 唯一零改动的环节；`ENDPOINT` 已可参数化，将来切本地 Ollama 只改一处 |
| ASR | sherpa-onnx `OnlineRecognizer` + `streaming-zipformer-zh-int8-2025-06-30`（126MB） | 流式出字，识别结果能实时进输入框；int8 CPU 推理，**不碰 GPU**（目标机是集显，且要和 3090 上的 Ollama 抢的是 CPU 不是显存） |
| TTS 在线（默认主路） | `node-edge-tts`（微软 edge 音色，默认「晓伊」+3Hz） | 音质明显更像人、也快得多（一句 18 字 1.1–1.5s）；宠物本来就要联网问 DeepSeek，多这一个域名不额外增加依赖 |
| TTS 离线（兜底/纯离线） | sherpa-onnx `OfflineTts` + `kokoro-int8-multi-lang-v1_1`（140MB，103 个 sid） | 完全不出网、CPU 超实时、模型小好分发；断网或 edge 限流时自动顶上，把 `ttsEngine` 设成 `kokoro` 就锁死离线 |
| 运行形态 | Electron `utilityProcess` 子进程 | 原生模块加载失败/崩溃不带走主进程 |

排除项：whisper.cpp / llama.cpp 路线（要拉 C++ 工具链编译，对一个工具栏项目不值）；`edge-tts`、`edge-tts-node` 两个 npm 包（前者发布的是裸 `.ts` 无法 require，后者停在 2024-11、缺 Sec-MS-GEC 令牌，实测握手 **403**）。

## 3. 实现中撞到的五条约束（改这块代码必须知道）

| 约束 | 位置 | 影响 |
| --- | --- | --- |
| `utilityProcess.fork` **不能**带 `ELECTRON_RUN_AS_NODE=1` | [src/main/services/voice.js:44](../src/main/services/voice.js) | 实测子进程 `code 9` 反复退出。它本身就是 Node 环境，这个变量会让 Electron 引导失败。 |
| CSP `media-src 'self' track:` | [src/renderer/index.html:7](../src/renderer/index.html) | 播放**不能**用 `blob:` + `<audio>`。改走 WebAudio `decodeAudioData`，不受 media-src 管，且不需要放宽 CSP。 |
| `config.save()` 按白名单重写顶层键 | [src/main/config.js:66](../src/main/config.js) | 新增 `voice` 段同时加进了 `DEFAULTS` 和 `ordered`，否则设置页一保存就静默删段。 |
| 麦克风按钮不能用 🎤 表情 | [src/renderer/js/voice.js:70](../src/renderer/js/voice.js) | Windows 下渲染成灰色斜杠，且表情不吃 `currentColor`，禁用态/录音态分不出来。改成内联 SVG。 |
| Electron 里 sherpa 的**外部缓冲**一律被禁 | [src/main/services/voice-worker.js:230](../src/main/services/voice-worker.js)、[tools/voice-selftest.js:15](../tools/voice-selftest.js) | `sherpa.readWave()` 和 `OfflineTts.generate()` 默认把 C++ 内存包成 external ArrayBuffer，Electron（含 `ELECTRON_RUN_AS_NODE` 模式）直接抛 `External buffers are not allowed`。TTS 必须传 `enableExternalBuffer: false` 让它拷一份；自测自己解 PCM16 WAV。`LinearResampler` 不受影响（实测正常）。 |

## 4. 链路

```
点浮层里的麦克风（单击宠物只浮出输入条，不开麦）
  renderer getUserMedia(48k mono) ──每 100ms Float32──▶ main voice.js ──▶ worker
                                                                    │ LinearResampler 48k→16k
                                                                    │ OnlineRecognizer 流式解码
  输入框 ◀── voice:asr {text, final} ◀───────────────────────────────┘
    │ autoSend=true（默认）：final 一到就 submit
    │ autoSend=false：文字停在输入框，改完自己按回车
    ▼
  现有 ai.send() → DeepSeek SSE → 情绪前缀由 emotion.js 剥离
    │
    ▼ ai:done
  renderer 分句 ──voice:speak(句)──▶ worker：edge-tts 优先，断网/失败 → 离线 Kokoro
    │
    ▼ 回传 wav / mp3 字节
  decodeAudioData → BufferSource 播放；播放期间 TB.voice.speaking=true → ai.setPet(mood, talk)
```

关键取舍：
- **说完即发送**：`voice.autoSend`（默认开）让松手→出字→回答一气呵成，不用回头按回车；识别错、或想先改字的场景把它关掉，行为退回"识别当草稿"。实时 partial 始终只写进输入框、不提交，所以提交只发生在 final 这一次。
- **真口型**：`talk` 从"流式布尔"升级为"TTS 是否在播"（[src/renderer/js/components/ai.js:175](../src/renderer/js/components/ai.js)）。没装模型时自动退回老行为，不会变成哑巴动画。
- **分句合成**：攒到句末标点就发一句，首声延迟从"整段回复"压到"第一句 + 一次合成"。
- **中断**：`generation` 计数，再点麦克风或右键按钮立刻停嘴，过期回调直接丢弃。

## 5. 文件清单

新增
- [src/main/services/voice.js](../src/main/services/voice.js) — 子进程编排：`sync()` 按配置增量重启、崩溃重启上限 2 次、请求超时
- [src/main/services/voice-worker.js](../src/main/services/voice-worker.js) — ASR/TTS 实际执行，模型文件名按语义优先级扫描目录（int8/fp16/分片换版本不用改代码）
- [src/renderer/js/voice.js](../src/renderer/js/voice.js) — 录音、播放、分句、按钮态
- [tools/install-voice.js](../tools/install-voice.js) — 下载模型 + sha256 记入 `models/manifest.json`，之后按 manifest 校验
- [tools/voice-selftest.js](../tools/voice-selftest.js) — 不依赖麦克风和密钥的 worker 级自测
- [tools/voice-appprobe.js](../tools/voice-appprobe.js) — 附着到真实运行的工具栏（CDP），把测试音频冒充麦克风走一遍 renderer→preload→main→worker，再验 TTS 解码播放、自动发送接线、设置面板字段齐全
- [tools/voice-tryout.js](../tools/voice-tryout.js) — 同一句话批量合成候选音色（edge 各音色×各音高、离线各 sid）到 `samples/voice-tryout/`，并给离线样本估中位基频用于排序

改动
- [src/main/main.js](../src/main/main.js) — `voice:*` IPC、`boot:get` 带语音状态、`before-quit` 收子进程
- [src/preload/preload.js](../src/preload/preload.js) — `voice` 桥
- [src/renderer/js/components/ai.js](../src/renderer/js/components/ai.js) — 暴露 `compose`（打字/录音时浮出的对话条，原来是常驻 `.ai-foot`）供插麦克风按钮、`talking` 改读发声状态、单击宠物=浮出这条（不开麦；录音中再单击=停麦）
- [src/renderer/js/settings.js](../src/renderer/js/settings.js) — 「语音」卡片：总开关、引擎、在线音色、音高、离线 sid、语速、自动朗读、说完即发送、试听、模型状态。「试听」把面板上**还没保存**的值当临时覆盖传下去，改一项立刻听
- [src/main/config.js](../src/main/config.js)、[src/renderer/styles.css](../src/renderer/styles.css)、[src/renderer/index.html](../src/renderer/index.html)、[package.json](../package.json)

## 6. 配置

```jsonc
{
  "voice": {
    "enabled": true,                   // 总开关，关掉不 fork 子进程
    "ttsEngine": "auto",               // auto(在线优先，断网退离线) | kokoro(纯离线) | edge(纯在线)
    "ttsVoice": "zh-CN-XiaoyiNeural", // 在线音色：晓伊(少女/最甜)、晓晓(温暖)、云夏(男童)…
    "ttsPitch": "+3Hz",               // 只作用于在线：-4Hz 更低沉 … +9Hz 很嗲
    "ttsSpeed": 1.0,                   // 0.6–1.6；在线折算成 rate 百分数(0.9→-10%)，离线是 Kokoro 倍速
    "ttsSid": 3,                       // 离线 Kokoro 说话人编号，0–102；实测 3 基频最高(≈273Hz)
    "autoSpeak": true,                 // 回复完成即朗读
    "autoSend": true                   // 松手出最终文本即问 AI；关掉则文字停在输入框
  }
}
```

## 7. 安装与验证

```bash
npm run voice:install     # 下 ~330MB 模型到 models/（已 gitignore）
npm run voice:selftest    # 喂模型自带 test_wavs，验 ASR 出字 + 两种 TTS 出声
npm start
```

安装器默认 `--source auto`：先走作者 csukuangfj 在 HuggingFace 上的同名镜像（本机实测 hf-mirror ~610KB/s，205MB 约 6 分钟），失败再回退 GitHub release 压缩包（实测只有 ~31KB/s，140MB 要 76 分钟）。`--source github` 可强制只用官方 release；两条路都做 sha256（压缩包整包、镜像逐文件）并写进 `models/manifest.json`，之后按清单复核。`--force` 重装。

自测通过标准：ASR 出多次 `partial`（证明真流式）+ 最终文本与 wav 内容一致；`samples/voice-selftest-*.{wav,mp3}` 可播放。

本机（Ryzen/酷睿级 CPU、`numThreads: 2`、全 CPU 推理）实测：

| 环节 | 结果 |
| --- | --- |
| 流式 ASR（5.61s 测试音频） | 14 次增量 + 最终文本全对，识别为「对我做了介绍哈那么我想说的是呢大家如果对我的研究感兴趣呢」 |
| 离线 Kokoro | 11 字 / 2.19s 音频耗时 2.6s，约 1.2× 实时；18 字整句 5.7–6.3s（`numThreads: 2`） |
| 在线 edge-tts | 9 字 1.4s 返回 13KB MP3；同一句 18 字 1.1–1.5s 返回 30KB —— 比离线还快，这是把 auto 改成在线优先的第二个理由 |

完整链路（含 IPC 与渲染层）另有一条 CDP 路：

```bash
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223   # Git Bash
node tools/voice-appprobe.js 9223 [--with-ai] [--shot]                    # 另开一个 Git Bash
```

appprobe 把 `test_wavs/0.wav` 冒充 16k 麦克风灌进去，检查 worker 状态、partial 条数、final 文本、识别结果进输入框的接线，以及合成→解码→播放→`speaking`→宠物口型。因为「说完即发送」默认开着、伪造的 final 会真发一条 AI 消息（花钱、进历史），脚本期间会临时关掉它，只把 `TB.ai.submit` 打桩来验接线，跑完在 `finally` 里还原。本机实测返回：

```json
{"autoSendDefaultConfig":true,"workerRunning":true,"asrOk":true,"ttsOk":true,
 "micButton":true,"micDisabled":false,
 "asrPartials":51,"asrFinal":"对我做了介绍哈那么我想说的是呢大家如果对我的研究感兴趣呢",
 "draftInInput":"接线检查","draftMarked":true,"draftRestored":true,
 "autoSendSubmits":"说完即发送","autoSendOffKeepsDraft":"留给手改","autoSendOffFocused":true,
 "ttsInvokeOk":true,"ttsEngine":"edge","ttsFormat":"mp3","ttsBytes":11232,
 "audioCtxState":"running","ttsDurationMs":1872,
 "speakingDuring":true,"petTalkingDuring":true,"speakingAfter":false,"petTalkingAfter":false,"speakSpanMs":4385,
 "aiKeySet":true,"autoSpeakConfig":true,"ttsReady":true,
 "autoSpeakSpeaking":true,"autoSpeakPetTalk":true,"autoSpeakFinished":true,
 "voiceCardFields":["启用语音","模型状态","朗读引擎","在线音色","音高","离线音色 (sid)","语速","自动朗读回复","说完即发送","试听"],
 "configVoiceKeys":["autoSend","autoSpeak","enabled","ttsEngine","ttsPitch","ttsSid","ttsSpeed","ttsVoice"],
 "composeOpenAtStart":false,"micInCompose":true,"composeOpens":true,"composeFocusesInput":true,
 "staysOpenWhileRecording":true,"staysOpenWithDraft":true,"composeClosesWhenEmpty":true,
 "tapGone":true,"clickOpensCompose":true,"clickOpensComposeWithoutVoice":true,"clickStartsRecording":false,
 "dblclickKeepsComposeClosed":true,"rightClickNoThrow":true,"composeClosedAtEnd":true}
```

`autoSendSubmits` 非空 = 开关打开时 final 真把 `submit()` 叫了起来；`autoSendOffKeepsDraft` = 关掉时文字留在输入框且拿到焦点。`autoSpeak*` 是伪造一条 assistant 回复跑「ai:done→自动朗读」，`--with-ai` 再用真 DeepSeek 往返跑同一段（会往对话历史里留消息，验完清 `state.json` 的 `aiChat`）。`voiceCardFields`/`configVoiceKeys` 是防呆：`config.voice` 里每个键都得在设置卡片有对应控件，否则设置一保存就静默丢键（`autoSend` 差点栽过一次）。最后一段 `compose*` 验对话浮层：默认收起、录音中/有草稿不许收、**单击宠物只浮出输入条且绝不开麦**（`clickStartsRecording:false` 是关键判据：语音可用时点宠物也不许起录音，打还是说由他自己点麦克风决定）、双击不动浮层（它开的是 Harness 窗口）、右键打断——这一段全程不碰真麦克风（`asrReady` 临时改判、`startRecord` 换成计数器，测完还原），所以**真麦克风采音仍然要他本人现场点一次**。

加 `--shot` 会另外截两张真实画面到 `samples/ui-compose-{closed,open}.png`，改布局时用肉眼核对浮层位置和遮挡。

## 8. 弱机降级矩阵

目标机是集显（无独显），推理全在 CPU，所以关键变量是 CPU 档位不是显卡：

| 机器 | ASR | TTS |
| --- | --- | --- |
| 近几年 x86（N100 / 酷睿 i 系） | 默认 zipformer-zh-int8 | 默认走在线 edge；离线 Kokoro CPU 超实时，能扛兜底 |
| 更弱的 x86 / NAS 档（J4125 级） | 换 `--asr paraformer` 之外可再降 whisper-tiny 路线 | 换 VITS 小音色，或 `ttsEngine: "edge"` 把负载挪到网上 |
| 老到扛不住 | 只做 TTS，输入保留打字 | `edge` 在线 |

`tools/install-voice.js --asr paraformer` 已留了切换口（中英双语，999MB，精度更高）。

`numThreads` 固定 2：本机实测 Kokoro int8 从 2 线程加到 4 线程，一句 11 字仍是 2.4s vs 2.5s，没有收益（瓶颈在 DP 单线程段），再加只会和工具栏其他活抢核。Kokoro 约 1.2× 实时意味着**逐句播放**离线首声 ≈ 2.5s、后续句与播放基本并行；默认走在线之后这个数只在断网时才用得上，反过来完全离线的机器把 `ttsEngine` 锁成 `kokoro`，别每次等 edge 超时再降级。

## 9. 音色试听与调参

觉得声音生硬先跑试听，别一个个改配置试：

```bash
npm run voice:tryout     # = electron ./tools/voice-tryout.js，在线那几项要联网
```

同一句「你好呀，今天心情特别好，要不要一起喝杯奶茶？」合成 13 条落在 `samples/voice-tryout/`（`README.txt` 记着每条的参数和耗时），双击对比。本机实测：

| 候选 | 结果 |
| --- | --- |
| edge 晓晓 / 晓伊 / 云夏 | 1.1–1.5s、30KB MP3，都可用；晓伊本身就比晓晓少女，往上加 pitch 更甜 |
| edge 晓伊 pitch +0/+3/+6/+9Hz | 依次更亮更嗲，`+9Hz` 开始发尖；默认取 `+3Hz`，想更甜去设置面板选 `+6Hz` |
| 离线 sid 0/1/2/3/4/8 | 中位基频 sid3≈273Hz > sid0=sid4≈224Hz > sid8≈209Hz > sid1≈195Hz > sid2≈159Hz（越低越像男声）。离线默认取 sid 3 |

基频只是排序用的粗指标（autocorrelation 估的，会不会发尖还得靠听）。设置面板里「音高 / 在线音色 / 离线音色 (sid) / 语速」都支持**边改边试听**：试听按钮会把面板上还没保存的值临时传给 worker，不写盘。

## 10. 本期没做

- F9 全局快捷键唤起录音、免按键 VAD 连续对话（方案里的 M4）
- 声纹/多说话人、代码块与 markdown 的朗读跳过优化
- 打包分发时把模型一起带上（`tools/package.js` 未处理 `models/`）
