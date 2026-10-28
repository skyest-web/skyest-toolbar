const fs = require('node:fs');
const path = require('node:path');

const CONFIG_FILE = 'toolbar.config.json';

const DEFAULTS = {
  display: {
    mode: 'auto',
    index: 1,
    match: { width: 1920, height: 540, tolerance: 80 },
    bounds: null
  },
  window: {
    alwaysOnTop: false,
    autoHideCursorMs: 4000
  },
  metrics: { pollMs: 1500, historySize: 90, slowPollMs: 3000 },
  clipboard: { enabled: true, maxItems: 30, pollMs: 800 },
  theme: { accent: '#57b6ff' },
  dockCategories: [],
  dock: [],
  music: { folder: '', recursive: true, volume: 0.7, repeat: 'all' },
  ai: {
    model: 'deepseek-chat',
    systemPrompt: '你是常驻在桌面工具栏里的助手，回答尽量简短。',
    temperature: 0.6,
    maxTokens: 1024,
    contextMessages: 12,
    timeoutMs: 60000,
    firstByteTimeoutMs: 15000,
    persistHistory: true,
    name: '小肥鱼',
    persona: 'video',
    emotion: true,
    motion: 'full'
  },
  voice: {
    enabled: true,
    // auto=在线 edge 优先、断网降级离线 Kokoro；kokoro=只用离线；edge=只用在线
    ttsEngine: 'auto',
    ttsVoice: 'zh-CN-XiaoyiNeural',
    // edge 的 pitch 只吃 Hz：正数更亮更少女，负数更沉。范围见设置面板的「音高」
    ttsPitch: '+3Hz',
    // 1.0 原速；在线时折算成 rate 百分数（0.9 → -10%），离线时是 Kokoro 的 speed
    ttsSpeed: 1.0,
    // 离线 Kokoro 的说话人编号（voices.bin 里的第几个音色）；3 是实测基频最高的女声（≈273Hz）
    ttsSid: 3,
    autoSpeak: true,
    // 识别出最终文本就直接问 AI；想先改字就关掉，那时文字停在输入框
    autoSend: true
  },
  // DeepSeek Harness（官方 dsh）：双击宠物开它的独立窗口（能拖到别的屏幕）。
  // 新开顶层段必须同时改这里和 save() 的 ordered 白名单，否则设置一保存就整段消失。
  dsh: {
    enabled: true,
    // dsh 的 sandbox 根 = 子进程 cwd，这个目录等于交给它写
    workspace: 'dsh-workspace',
    port: 3080,
    startupTimeoutMs: 120000,
    // 官方默认 FEEDBACK_ONLY 会把会话日志发到 deepseeksvc.com，按拍板关掉
    telemetry: false
  },
  // Everything 全盘文件搜索（vendor/everything 里的便携版 + SDK）。
  // 一切查询都在工作进程里跑，出网为零：Everything 只读本机索引。
  search: {
    enabled: true,
    maxResults: 20,
    // 少于这个字数不发查询：单字符在全盘索引上又慢又没意义
    minChars: 2,
    // 阻塞调用堵住工作进程时，超过这么久就当这次没成功（渲染层还会再试最后一次输入）
    timeoutMs: 1500,
    // Everything 客户端没在跑时用 vendor 里的 exe 拉一个
    autoStart: true,
    sort: 'NAME_ASCENDING'
  }
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (!isObject(base) || !isObject(patch)) return structuredClone(patch);
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = deepMerge(base[key], value);
  return out;
}

function load(appRoot) {
  const file = path.join(appRoot, CONFIG_FILE);
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[config] ${CONFIG_FILE} is not valid JSON (${err.message}); using defaults`);
    }
  }
  return deepMerge(structuredClone(DEFAULTS), raw);
}

function save(appRoot, config) {
  const file = path.join(appRoot, CONFIG_FILE);
  const ordered = {
    display: config.display,
    window: config.window,
    metrics: config.metrics,
    clipboard: config.clipboard,
    theme: config.theme,
    dockCategories: config.dockCategories,
    dock: config.dock,
    music: config.music,
    ai: config.ai,
    voice: config.voice,
    dsh: config.dsh,
    search: config.search
  };
  fs.writeFileSync(file, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
  return file;
}

module.exports = { load, save, merge: deepMerge, CONFIG_FILE };
