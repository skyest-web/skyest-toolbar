// 语音模型安装器：下载 sherpa-onnx 的流式 ASR 与 Kokoro TTS 模型到 models/
// 用法: node tools/install-voice.js [--force] [--asr paraformer] [--source auto|hf|github]
// 校验：压缩包按整包 sha256，HuggingFace 逐文件 sha256，都写进 models/manifest.json；
// 之后的安装按 manifest 复核，对不上就拒绝使用。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP_ROOT = path.join(__dirname, '..');
const MODELS_DIR = path.join(APP_ROOT, 'models');
const MANIFEST_FILE = path.join(MODELS_DIR, 'manifest.json');

const GH_RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
// 同一作者（csukuangfj）把 release 里的模型原样镜像到了 HuggingFace；
// 本机实测 GitHub 只有 ~31KB/s（140MB 要 76 分钟），hf-mirror ~610KB/s，所以默认先走镜像。
const HF_BASE = process.env.VOICE_HF_BASE || 'https://hf-mirror.com';

const ASR_OPTIONS = {
  zipformer: 'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30',
  paraformer: 'sherpa-onnx-streaming-paraformer-bilingual-zh-en'
};

const TTS_DIR = 'kokoro-int8-multi-lang-v1_1';

function argValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FORCE = process.argv.includes('--force');
const SOURCE = argValue('source', 'auto');
if (!['auto', 'hf', 'github'].includes(SOURCE)) {
  console.error(`[voice] --source 只认 auto|hf|github，收到 ${SOURCE}`);
  process.exit(2);
}

const asrName = ASR_OPTIONS[argValue('asr', 'zipformer')] || ASR_OPTIONS.zipformer;
const targets = [
  { kind: 'asr', dir: asrName, channel: 'asr-models' },
  { kind: 'tts', dir: TTS_DIR, channel: 'tts-models' }
];

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function readManifest() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  } catch {
    return {};
  }
  // 早期版本直接 `目录: 压缩包sha256`，统一迁成对象形态
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') raw[key] = { archive: value };
  }
  return raw;
}

function writeManifest(manifest) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
}

function curl(args) {
  execFileSync('curl', args, { stdio: 'inherit' });
}

function downloadArchive(url, dest) {
  // 上一轮可能已经下完但解压失败；压缩包在就复用，别再来一次 30 分钟
  if (fs.existsSync(dest)) {
    console.log(`[voice] 复用已下载文件 ${path.basename(dest)}`);
    return;
  }
  // curl 自带断点续传；-L 跟 GitHub 的 blob 重定向
  curl(['-fSL', '--retry', '3', '--continue-at', '-', '-o', dest, url]);
}

function extract(tarball, destDir) {
  // Git-Bash 的 GNU tar 会把 D:\x\y 里的冒号当成「远程主机:path」，报 Cannot connect to D:
  // Windows 自带的 bsdtar 认 Windows 路径，所以显式用它
  const bsdtar = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  execFileSync(bsdtar, ['-xf', tarball, '-C', destDir], { stdio: 'inherit' });
}

async function installFromArchive(target, entry) {
  const url = `${GH_RELEASE}/${target.channel}/${target.dir}.tar.bz2`;
  const archive = path.join(MODELS_DIR, `${target.dir}.tar.bz2`);
  console.log(`[voice] [github] ${url}`);
  downloadArchive(url, archive);

  const digest = await sha256(archive);
  if (entry.archive && entry.archive !== digest) {
    throw new Error(`${target.dir} 压缩包 sha256 不匹配 manifest（${digest} != ${entry.archive}），拒绝解压`);
  }
  if (!entry.archive) {
    entry.archive = digest;
    console.log(`[voice] 记录压缩包 sha256: ${digest}`);
  }
  console.log(`[voice] 解压 ${target.dir} ...`);
  const modelDir = path.join(MODELS_DIR, target.dir);
  fs.rmSync(modelDir, { force: true, recursive: true });
  extract(archive, MODELS_DIR);
  if (!fs.existsSync(path.join(modelDir, 'tokens.txt'))) {
    throw new Error(`${target.dir} 解压后缺 tokens.txt，压缩包可能不完整`);
  }
  fs.rmSync(archive);
  fs.rmSync(`${modelDir}.part`, { force: true, recursive: true });
  entry.source = 'github';
}

const OPTIONAL_PREFIXES = ['espeak-ng-data/voices/!v/'];
// Kokoro 中文实际读到的最小集合：缺一个就别装，缺 !v 下的第三方音色无所谓
const REQUIRED_FILES = [
  'tokens.txt',
  'voices.bin',
  'lexicon-zh.txt',
  'date-zh.fst',
  'number-zh.fst',
  'phone-zh.fst',
  'dict/jieba.dict.utf8',
  'dict/hmm_model.utf8',
  'dict/idf.utf8',
  'dict/stop_words.utf8',
  'espeak-ng-data/phontab',
  'espeak-ng-data/intonations',
  'espeak-ng-data/cmn_dict',
  'espeak-ng-data/en_dict'
];

function isOptional(name) {
  return OPTIONAL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function hfFileList(repo) {
  const body = execFileSync('curl', ['-fsSL', '--retry', '3', '--max-time', '60', `${HF_BASE}/api/models/${repo}?blobs=true`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  return JSON.parse(body).siblings
    .map((sibling) => ({ name: sibling.rfilename, size: sibling.size || 0 }))
    .filter((file) => !file.name.startsWith('.github/'));
}

// 378 个文件逐个起 curl = 378 次 TLS 握手，实测小文件平均 5s/个、光词典就要半小时。
// 一次 curl 多 url/output 会复用连接，再配 -Z 并发，小文件段直接塌缩成几十秒。
// 并发只开到 2：镜像对 6 并发直接回 429，重试也压不住。
function hfDownloadBatch(repo, files, stageDir) {
  if (!files.length) return;
  const configPath = path.join(MODELS_DIR, '.curl-config');
  const CHUNK = 40;
  for (let start = 0; start < files.length; start += CHUNK) {
    const group = files.slice(start, start + CHUNK);
    const lines = [];
    for (const file of group) {
      lines.push(`url = "${HF_BASE}/${repo}/resolve/main/${encodeURI(file.name)}"`);
      // 正斜杠：curl 的配置文件解析会把反斜杠当转义符，Windows 路径必须改写
      lines.push(`output = "${path.join(stageDir, file.name).replace(/\\/g, '/')}"`);
    }
    fs.writeFileSync(configPath, lines.join('\n'));
    try {
      curl(['-sS', '--fail', '--location', '--retry', '6', '--retry-all-errors', '--retry-delay', '5',
        '--create-dirs', '-Z', '--parallel-max', '2', '--config', configPath]);
    } catch (error) {
      console.warn(`[voice] [hf] 这一段有文件没下成，重跑会按体积只补缺的：${String(error.message).split('\n').pop()}`);
    }
    console.log(`[voice] [hf] ${Math.min(start + CHUNK, files.length)}/${files.length}`);
  }
  fs.rmSync(configPath, { force: true });
}

// 体积对上才算这个文件下全了：既当续跑的依据，也挡一半下载的残文件
function stagedSize(stageDir, file) {
  try {
    const stat = fs.statSync(path.join(stageDir, file.name));
    return stat.size === file.size ? stat.size : null;
  } catch {
    return null;
  }
}

async function installFromHf(target, entry) {
  const repo = `csukuangfj/${target.dir}`;
  const files = hfFileList(repo);
  if (!files.some((file) => file.name === 'tokens.txt')) throw new Error(`${repo} 里没有 tokens.txt，仓库名对不上`);
  console.log(`[voice] [hf] ${repo} 共 ${files.length} 个文件`);

  // 先落到 .part 目录，全绿了再改名，避免中断留下半坨被当成已安装。
  // .part 失败时不清空：那是断点，重跑按 size 跳过已完整的，只补差集。
  const modelDir = path.join(MODELS_DIR, target.dir);
  const stageDir = `${modelDir}.part`;
  fs.mkdirSync(stageDir, { recursive: true });
  const digestMap = {};

  const pending = files.filter((file) => stagedSize(stageDir, file) === null);
  if (pending.length < files.length) {
    console.log(`[voice] [hf] 复用已下好的 ${files.length - pending.length} 个，补 ${pending.length} 个`);
  }
  hfDownloadBatch(repo, pending, stageDir);

  const present = files.filter((file) => stagedSize(stageDir, file) !== null);
  const missing = files.filter((file) => stagedSize(stageDir, file) === null);
  const blocked = missing.filter((file) => !isOptional(file.name));
  if (blocked.length) {
    throw new Error(`${blocked.length} 个文件下载缺失，例如 ${blocked.slice(0, 3).map((file) => file.name).join(', ')}`);
  }
  if (missing.length) console.warn(`[voice] [hf] 放过 ${missing.length} 个可选音色文件（${OPTIONAL_PREFIXES[0]}）`);
  for (const name of REQUIRED_FILES) {
    if (!present.some((file) => file.name === name)) throw new Error(`缺关键文件 ${name}，模型不可用`);
  }

  for (const file of present) {
    digestMap[file.name] = await sha256(path.join(stageDir, file.name));
  }

  // 复核一遍清单里已有的摘要（首次安装时清单为空，等于只记录）
  const known = entry.files || {};
  for (const [name, digest] of Object.entries(known)) {
    if (digestMap[name] && digestMap[name] !== digest) {
      throw new Error(`${target.dir}/${name} sha256 不匹配 manifest（${digestMap[name]} != ${digest}）`);
    }
  }
  entry.files = digestMap;
  entry.source = 'hf';
  fs.rmSync(modelDir, { force: true, recursive: true });
  fs.renameSync(stageDir, modelDir);
}

async function ensure(target, manifest) {
  const modelDir = path.join(MODELS_DIR, target.dir);
  // 只看目录在不在不够：下载被掐断会留下半坨文件，必须验到模型自己的 tokens.txt
  if (!FORCE && fs.existsSync(path.join(modelDir, 'tokens.txt'))) {
    console.log(`[voice] ${target.kind} 已存在: ${target.dir}`);
    return;
  }
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const entry = manifest[target.dir] || (manifest[target.dir] = {});
  const order = SOURCE === 'auto' ? ['hf', 'github'] : [SOURCE];
  const errors = [];
  for (const source of order) {
    try {
      if (source === 'hf') await installFromHf(target, entry);
      else await installFromArchive(target, entry);
      writeManifest(manifest);
      console.log(`[voice] ${target.kind} 就绪（${source}）: ${modelDir}`);
      return;
    } catch (error) {
      console.warn(`[voice] ${target.kind} 走 ${source} 失败: ${error.message}`);
      errors.push(`${source}: ${error.message}`);
    }
  }
  throw new Error(`${target.dir} 安装失败 -> ${errors.join(' | ')}`);
}

(async () => {
  const manifest = readManifest();
  for (const target of targets) await ensure(target, manifest);
  writeManifest(manifest);
  console.log('[voice] 全部模型安装完成');
})().catch((error) => {
  console.error('[voice] 安装失败:', error.message);
  process.exit(1);
});
