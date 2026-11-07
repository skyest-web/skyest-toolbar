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
    autoHideCursorMs: 4000,
    // 跟随虚拟桌面：切到新桌面时把窗口重建一次，新窗口就落在当前桌面上。
    // 代价是一次约 200–400ms 的重载闪动。关掉它，窗口就钉死在第一次创建它的那个桌面。
    followVirtualDesktop: true
  },
  metrics: { pollMs: 1500, historySize: 90, slowPollMs: 3000 },
  clipboard: { enabled: true, maxItems: 30, pollMs: 800 },
  theme: { accent: '#57b6ff' },
  dockCategories: [],
  dock: [],
  music: { folder: '', recursive: true, volume: 0.7, repeat: 'all' },
  // 本地视频文件夹（生活面板 slot2 那一格）。上次看到哪儿不在这段里，在 state.json 的 video。
  // 只收 Chromium 解得动的容器：mp4 / m4v / mov / webm / mkv，avi、flv 那些扫进来也是黑屏。
  video: { folder: '', recursive: true },
  // 本地照片文件夹（生活面板 gauges 那一格的照片墙）。只收 Chromium 解得动的位图，
  // .heic（iPhone 默认）和 .svg（矢量，不是照片）都不收。这里不记「看到第几张」，浮层关掉就结束。
  photos: { folder: '', recursive: true, limit: 400 },
  // 修改器（trainer）文件夹：空 = 组件报「还没配置」。扫顶层 exe 和一层子目录里的 exe。
  trainers: { folder: '' },
  // Steam 库：填 SteamLibrary 或它下面的 steamapps 都认。空 = 组件报「还没配置」。
  steam: { folder: '' },
  // 仓库根目录（项目格与 git 格共用这一份）：每个根取它的**顶层文件夹**当一个项目。
  // 数组可以多条，同一条目录在两个根里都出现只算一次（按小写绝对路径去重，Windows 不分大小写）。
  repos: { roots: ['D:\\GitProject'] },
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
    motion: 'full',
    // 让它能调本机工具（目前只有只读的 search_files）。默认关：开了就意味着本机文件路径
    // 会作为模型输入发到 DeepSeek，而且它说话开始依赖一台机器上的索引。
    agentTools: { enabled: false }
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
  },
  // 163 邮箱只读收件（IMAP）。授权码不在这里——它在 userData/mail-auth.bin（safeStorage 加密），
  // 这个段落里只有「连哪儿、拉几封、多久拉一次」这类没有凭据的信息。
  mail: {
    enabled: true,
    // 完整地址，形如 abc@163.com；host/mailbox 一般不用改
    account: '',
    host: 'imap.163.com',
    port: 993,
    secure: true,
    mailbox: 'INBOX',
    // 一次拉最近多少封的头部（上限 200，服务端按整箱回未读数）
    maxMessages: 20,
    // 组件自动刷新间隔；0 = 只手动点「刷新」
    pollMs: 120000,
    // 握手 + 取头部的总时限；超了就报「连不上」，不会把这一格挂死
    timeoutMs: 20000,
    // 点「网页邮箱」时交给系统浏览器的地址，只能从配置里来
    webmail: 'https://mail.163.com',
    // 来了新邮件：宠物动一下 + 提示条（语音提示是下面那条单独的开关）
    notify: true,
    notifyVoice: true
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
    video: config.video,
    photos: config.photos,
    trainers: config.trainers,
    steam: config.steam,
    repos: config.repos,
    ai: config.ai,
    voice: config.voice,
    dsh: config.dsh,
    search: config.search,
    mail: config.mail
  };
  fs.writeFileSync(file, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
  return file;
}

module.exports = { load, save, merge: deepMerge, CONFIG_FILE };
