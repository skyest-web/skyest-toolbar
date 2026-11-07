// git 状态（工作面板 gitzone 那一整块）：项目格的第二个视图。
//
// 这一格**不自己扫盘**，也**不一次看一批仓库**。要看哪个仓库由左边项目格的选中决定（`focusId` 就是项目格那行的 id），
// 行数据全部来自项目格那次扫描的结果（`projects.items`）：同一个文件夹、同一个 id、同一个顺序基准。
// 两格唯一的区别是问的问题不同——项目格问「该用哪个 IDE 打开」，这一格问「这里有什么还没交出去」。
// 所以 id 空间是共用的：渲染层递进来的 id 在项目格那边一定能查到同一条，
// 点一个改动文件时，主进程用那个 id 找回项目行，再按项目格判出来的那个 IDE 把文件递过去。
// 没选中（或选中的那条已经不在这批行里）时一个 git 进程都不起，只回一句该说什么的 `need`。
//
// 读侧只有一条命令：`git -c core.quotepath=false --no-optional-locks status --porcelain=v2 -z --branch`。
// 挑 v2 而不是默认的 v1，是因为 v1 把分支和上下游混在一起还得自己再问一遍，
// v2 把它们摆在 `#` 打头的那几行，记录一条一段、NUL 分隔——带空格和中文的文件名不会被拆成两段
// （`quotepath=false` 关掉 git 默认的「非 ASCII 转八进制」，不然他的中文目录名在格子里变成 \346\226\207）。
// `--no-optional-locks` 是给后台刷新留的：不加它 status 可能去写 index.lock，
// 那时他正好在 IDE 里 commit 就会撞上一个「无法创建索引文件」的假故障。
//
// 规矩和项目格、Steam、修改器那几格一样：
//   1) 渲染层只递 id 和序号，目录从项目行的缓存里取、相对路径从这一格自己的缓存里取；
//   2) 行数据里的文件路径是**仓库内相对路径**，绝对路径不过 IPC，git.exe 的位置更不过（只说本机有没有 git、什么版本）；
//   3) 失败文案不带盘符路径（走 spawn-result 那套 redact）。
//
// 写侧（fetch / pull / commit / push）四条额外的规矩，都是他点名的：
//   1) **只做这四样**。切分支、stash、reset、clean、checkout、`--force`、`--amend`、`--no-verify` 一个都不碰，
//      argv 由 `plan()` 现拼、`assertSafeArgs()` 当场拦（见那两个函数上方的理由）；
//   2) commit 固定 `-a`：只带走已跟踪文件的改动。未跟踪的那些单独计数，并在确认条里写明「不会被带上」；
//   3) pull 固定 `--ff-only --no-rebase`：能快进就快进，不能就报错给他看，绝不自动产生一次合并；
//   4) commit 和 push 都要走应用内确认条：`prepare()` 只发一个一次性 nonce（5 秒作废），
//      `confirm(nonce)` 才真起进程。push 是别人看得见的动作，所以这条链上没有「直接调」的入口。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn: realSpawn } = require('node:child_process');
const { explainSpawnError, redactPaths } = require('./spawn-result');

// 20 秒：这一格说的是「现在有什么没提交」，缓存太久等于给人看假状态。
// 但每刷新一次就是几个 git 进程，太密会把磁盘占住，所以只有切到这一格和点「刷新」才发起。
const STATUS_TTL_MS = 20000;
const STATUS_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 4000;
// 单仓输出上限 4MB：一个把 node_modules 全暴露出来的仓库能打出几十 MB 的 status，
// 截了比让主进程内存爆掉好；截了就在行上标 truncated，只数前 MAX_FILES 条。
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_FILES = 400;

const STATUS_ARGS = ['-c', 'core.quotepath=false', '--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch'];
// 交互一律按住：凭据提示弹进管道里不会有人回答，进程就永远不退出。
// 凭据走的是他系统里配好的 git 凭据助手，我们不经手任何东西。
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };

// PATH 里找不到才试这几个常见安装位置（和 IDE 那一格同一个思路：认位置，不碰注册表）。
const GIT_CANDIDATES = [
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'D:\\Program Files\\Git\\cmd\\git.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe')
];

// 确认条那条 nonce 的寿命。5 秒是他点头时说过的手感：短到「这条确认就是你刚才那一下」，
// 长到不至于读完两行字就赶上了。过期只能重新点一次，不做「续一下」。
const CONFIRM_TTL_MS = 5000;
const COMMIT_TIMEOUT_MS = 20000;
const NETWORK_TIMEOUT_MS = 60000;
const PUSH_TIMEOUT_MS = 120000;
const MAX_MESSAGE = 4000;

// 这一格会做的四件事，argv 全在这里现拼——渲染层递不进任何一个字节的参数。
// 为什么是这四个：fetch 只动 origin/* 那些引用，不碰工作区；pull 固定快进，进不了就报错给他看；
// commit 固定 -a，只带走已跟踪文件；push 推当前分支已有的上游。
// 为什么没有 --all / --prune / --tags：fetch 那条只要「默认远端」，多一个参数就多一处要解释的话。
// 为什么 push 不带 -u：那会写他的分支配置，等于顺手改了一件不在范围内的事；没上游就直说。
const OPS = {
  fetch: { label: '抓取', timeoutMs: NETWORK_TIMEOUT_MS, argv: () => ['fetch'] },
  pull: { label: '拉取', timeoutMs: NETWORK_TIMEOUT_MS, argv: () => ['pull', '--ff-only', '--no-rebase'] },
  commit: { label: '提交', timeoutMs: COMMIT_TIMEOUT_MS, argv: (plan) => ['commit', '-a', '-m', plan.message] },
  push: { label: '推送', timeoutMs: PUSH_TIMEOUT_MS, argv: () => ['push'] }
};

// 这些词一个都不该出现在我们自己拼的 argv 里。
// 这不是防 git 命令本身——是防「将来有人图省事往这条链上加一步」：加的人当场得到一句拒绝，
// 而不是让这一格在半年后悄悄变成能 reset --hard 的东西。自检拿它当门禁，变异测试能验到这条还在生效。
const BANNED_ARGS = [
  '--force', '-f', '--force-with-lease', '--no-verify', '--no-edit', '--amend',
  'reset', 'clean', 'checkout', 'switch', 'stash', 'rebase', 'merge', 'rm', 'mv',
  '--hard', '--mixed', '--soft', '-u', '--set-upstream', '--all', '--prune'
];

// 他写的提交说明原样进 argv（`-m <message>`），里面出现「reset」这种词不算参数。
// 所以扫的时候跳过 `-m` 后面那一段——这是整条链上唯一的外部字符串，也是唯一需要绕过去的地方。
function assertSafeArgs(argv) {
  const bad = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-m' || token === '--message') { i += 1; continue; }
    if (BANNED_ARGS.includes(token)) bad.push(token);
  }
  return bad;
}

// 只有仓库内相对路径能拼进绝对路径：git 自己不会给出 `..`，但这条链上出错时宁可拦下来。
function insideRepo(repoDir, relPath) {
  if (!relPath || typeof relPath !== 'string') return null;
  if (path.isAbsolute(relPath)) return null;
  const full = path.resolve(repoDir, relPath);
  const base = path.resolve(repoDir);
  return full.toLowerCase().startsWith(base.toLowerCase() + path.sep) ? full : null;
}

// 确认条之前先过这道闸。这些情况 git 自己也会拒，但它给的是一句英文；在这里拦住，
// 是给出一句人话的机会——而且说一句「该谁接着做」（切分支、处理冲突、第一次推送带 -u），这一格都不做。
function gate(kind, row, message) {
  if (kind !== 'fetch' && row.detached) {
    return '现在是游离 HEAD（没在任何分支上），这一步会把东西落在分支外面 —— 请先在 IDE 里切回分支';
  }
  if (kind !== 'fetch' && row.conflicted) {
    return `还有 ${row.conflicted} 个文件在冲突中 —— 先把冲突处理掉（这一格不做合并）`;
  }

  if (kind === 'commit') {
    if (!message) return '提交说明是空的 —— 这一步我不做（也不替你编一句）';
    if (message.length > MAX_MESSAGE) return `提交说明太长（${message.length} 字，上限 ${MAX_MESSAGE}）`;
    if (!row.counts.tracked) {
      return row.untracked
        ? `没有已跟踪文件的改动（未跟踪的 ${row.untracked} 个这一步不会带上）—— 要先 add，那不在这一格做`
        : '没有可提交的改动';
    }
    return '';
  }

  if (kind === 'fetch') return '';

  if (kind === 'pull') {
    if (row.unborn) return '这个仓库还没有一次提交，拉取没法快进 —— 请在 IDE 里处理';
    if (!row.upstream) return '这条分支没有上游分支，不知道从哪儿拉 —— 这一步我不会顺手替你设上游';
    return '';
  }

  // push
  if (!row.upstream) return '这条分支没有上游分支，push 不知道该推到哪儿 —— 第一次推送请在 IDE 或命令行里做（那一步要带 -u，会写你的分支配置，不在这一格）';
  if (row.unborn) return '这个仓库还没有一次提交，推不了';
  if (row.ahead === 0) return '本地没有比远端新的提交，这一步什么都不推';
  return '';
}

// 确认条上的话：先说清「这一步会动到什么」，再决定点不点。数字直接来自 prepare 里那次现读。
function confirmLines(op, row, message) {
  const tracked = row.counts.tracked;
  if (op === 'fetch') {
    const out = [`从 ${row.upstream ? row.upstream.split('/')[0] : '默认远端'} 抓取新的提交`];
    out.push('只更新远端那些引用，不动你的文件和分支');
    if (row.behind) out.push(`远端比本地多 ${row.behind} 条，抓完这个数字才会变`);
    return out;
  }
  if (op === 'pull') {
    const out = [];
    out.push(row.behind ? `快进 ${row.behind} 条远端提交` : '远端没有新提交，这一步多半什么都不做');
    out.push('只走快进：对不齐就报错给你看，不会自动产生一次合并');
    if (tracked) out.push(`注意：本地有 ${tracked} 处没提交的改动，git 可能因此拒绝拉取`);
    return out;
  }
  if (op === 'commit') {
    return [
      `提交 ${tracked} 个已跟踪文件的改动（只 add 过的和改过的）`,
      row.untracked ? `未跟踪的 ${row.untracked} 个不会被带上，这一步没有 add` : '没有未跟踪文件',
      `提交说明：${message}`
    ];
  }
  const out = [`把 ${row.branch} 的 ${row.ahead || 0} 条提交推到 ${row.upstream}`];
  out.push('这一步别人看得见');
  if (row.behind) out.push(`远端还多 ${row.behind} 条，多半要先拉取`);
  return out;
}

// 一条记录切成「前 count 段 + 剩下的整段」。路径里可以有空格，所以不能无脑 split(' ')。
function columns(record, count) {
  const out = [];
  let rest = record;
  while (out.length < count - 1) {
    const at = rest.indexOf(' ');
    if (at < 0) return null;
    out.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  out.push(rest);
  return out;
}

// # branch.oid / head / upstream / ab 那几行（ab 只有接了远端才有）
function parseBranch(lines) {
  const branch = { oid: '', head: '', upstream: '', ahead: null, behind: null };
  for (const line of lines) {
    const m = /^# branch\.(oid|head|upstream|ab)\s+(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'ab') {
      const ab = /^\+(\d+)\s+-(\d+)/.exec(m[2]);
      branch.ahead = ab ? Number(ab[1]) : null;
      branch.behind = ab ? Number(ab[2]) : null;
    } else {
      branch[m[1]] = m[2].trim();
    }
  }
  return branch;
}

// 索引位和工作树位分开看：'M.' 是「add 过了、之后没再改」，'.M' 是「改了但没 add」，'MM' 两边都有。
// '.' 就是那一位干净。'?' 只出现在未跟踪那一种记录里，这里一并挡掉，免得把 '?.' 算成已暂存。
function classify(code) {
  const index = code[0] || '.';
  const work = code[1] || '.';
  return {
    staged: index !== '.' && index !== '?',
    unstaged: work !== '.' && work !== '?'
  };
}

// stdout 是整段 NUL 分隔的记录。结尾那个空段是最后一个分隔符带的，丢掉。
// 改名/复制（'2'）的「从哪个路径来」是**紧跟其后的那一段**，这是 git 定的次序，不能靠内容猜：
// 有个文件就叫 `1 foo.txt` 时按前缀猜会把 from 丢回去当记录解析，多吐一条假改动。
function parsePorcelain(text) {
  const records = String(text || '').split('\0');
  if (records.length && records[records.length - 1] === '') records.pop();

  const headers = [];
  const files = [];
  let conflicted = 0;
  let untracked = 0;

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    if (record[0] === '#') { headers.push(record); continue; }

    if (record[0] === '1' || record[0] === '2') {
      const rename = record[0] === '2';
      const cols = columns(record, rename ? 10 : 9);
      if (!cols) continue;
      const flags = classify(cols[1]);
      const file = {
        code: cols[1],
        kind: flags.unstaged ? 'unstaged' : 'staged',
        path: cols[rename ? 9 : 8]
      };
      if (rename) {
        file.from = records[i + 1] || '';
        i += 1;
      }
      files.push(file);
      continue;
    }

    if (record[0] === 'u') {
      // 实测（git 2.56）冲突记录是 10 个定长段 + 路径：u XY sub m1 m2 m3 mH h1 h2 h3 <path>，
      // 比 '1' 多一个模式和两个 hash（三个 stage 各一份），少写一段就会把最后一个 hash 当成路径。
      const cols = columns(record, 11);
      if (!cols) continue;
      conflicted += 1;
      files.push({ code: cols[1], kind: 'conflicted', path: cols[10] });
      continue;
    }

    if (record[0] === '?') {
      const cols = columns(record, 2);
      if (!cols) continue;
      untracked += 1;
      // 目录以 / 结尾 = 整目录都没跟踪，git 只报一条；原样留着，让人自己去数那里面有多少
      files.push({ code: '??', kind: 'untracked', path: cols[1], dir: cols[1].endsWith('/') });
      continue;
    }

    // '!' 是 --ignored 才会有的记录，这条命令没开；真撞上了忽略即可（比当成改动安全）
  }

  return { branch: parseBranch(headers), files, conflicted, untracked };
}

// 计数分开说：已跟踪的改动（`commit -a` 会带走的那些）和未跟踪的（不会被带走）。
// 这两个数字将来直接出现在确认条里，混成一个「N 处改动」就成了骗人。
function countFiles(row) {
  let staged = 0;
  let unstaged = 0;
  let tracked = 0;
  for (const file of row.files) {
    if (file.kind === 'conflicted') continue;
    const flags = classify(file.code);
    if (flags.staged) staged += 1;
    if (flags.unstaged) unstaged += 1;
    // tracked 是「几个文件」，不是 staged + unstaged：`MM` 那个文件同时占两边名额，
    // 加起来会把「提交带走几个」报多一个——那句话是他决定要不要按确认的依据，不能骗人。
    if (flags.staged || flags.unstaged) tracked += 1;
  }
  return { staged, unstaged, tracked, untracked: row.untracked, conflicted: row.conflicted };
}

function runGit(exe, args, cwd, { spawn, timeoutMs = STATUS_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = (spawn || realSpawn)(exe, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV });
    } catch (error) {
      resolve({ ok: false, error });
      return;
    }
    const chunks = [];
    const errs = [];
    let bytes = 0;
    let overflow = false;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    // 到点就自己判超时，**不等 'close'**。'close' 要等 stdio 全关掉，而 push/fetch 会留下 ssh
    // 或凭据助手那样的孙进程攥住管道——那时不 resolve，`this.running` 永远挂着，
    // 这一格此后每次刷新都复用那条不会完成的 Promise，确认条也一直停在「正在跑」。
    // 已经被 kill 的命令没有什么值得再等的输出。
    const timer = setTimeout(() => {
      try { child.kill(); } catch (killError) { /* 已经退了 */ }
      finish({ ok: false, timeout: true });
    }, timeoutMs);

    // 'error' 一定得有人听：ENOENT（git 被挪走）和 EACCES 都从这里来，
    // 漏了就是把异常抛到主进程顶层，弹出那个 Electron 模态错误框。
    child.on('error', (error) => finish({ ok: false, error }));
    // 按 Buffer 攒着最后一起转：中文路径是多字节，按 chunk toString 会把跨块的字符切成乱码
    child.stdout.on('data', (chunk) => {
      // 跨过上限那一块还是收下，之后的丢掉：只看不收会让"一整块就超标"（自检就是这么喂的）
      // 把整段输出扔了，那一行只能回一句「没读懂 git 的输出」，而真相是「太大了」。
      if (overflow) return;
      bytes += chunk.length;
      chunks.push(chunk);
      if (bytes > MAX_OUTPUT) overflow = true;
    });
    child.stderr.on('data', (chunk) => { if (errs.join('').length < 8000) errs.push(chunk); });
    child.on('close', (code, signal) => {
      finish({ ok: code === 0, code, signal, stdout: Buffer.concat(chunks).toString('utf8'), stderr: Buffer.concat(errs).toString('utf8'), overflow });
    });
  });
}

// 失败翻译成人话。三条都是他会撞上的：目录没了、git 起不来、仓库正在被别的 git 占着。
// status 成功就是退出码 0（有冲突也是 0），所以非 0 一律当故障处理。
// explainSpawnError 那句 ENOENT 说的是「点『重扫』」——那是项目格的按钮名，而且在这条链上
// 文件不在了指的是 git.exe 不在了，不是某个项目，所以这里单独翻一条，其余码照走公共那套（都不带盘符路径）。
function spawnGone(error) {
  if (String(error?.code || '').toUpperCase() === 'ENOENT') return '本机没找到 git（可能被移动或删除），点「刷新」再试';
  return explainSpawnError(error);
}

function statusError(result) {
  if (result.timeout) return '读取超时（这个仓库太大、在网络盘或移动硬盘上，或者正被别的 git 占着）';
  if (result.error) {
    // 目录不存在那条路在 one() 里先拦了，不会走到 spawn，所以这里的 ENOENT 只可能是 git 自己没了
    return spawnGone(result.error);
  }
  const first = String(result.stderr || '').split(/\r?\n/).find((line) => line.trim()) || '';
  if (/not a git repository/i.test(first)) return '这里不是一个 git 仓库（往上那一层才是）';
  if (/index\.lock|unable to create/i.test(first)) return 'git 的索引正被别的操作占着，过几秒再刷新';
  return `git 没答上来：${redactPaths(first) || `退出码 ${result.code}`}`;
}

// 写侧的失败翻译，顺序按「越具体越在前」：git 的话里 'merge' 这个词到处出现，
// 先抓最独特的那几句（冲突没处理、快进不上、被远端拒、要凭据），落到最后才是原样（打码后）。
// 每一条都以「下一步该去哪儿」收尾——这一格不做的事，要说清该谁做。
// 最后一条是 /hook/，所以任何一句里都不许出现 hook、unmerged、rejected、merge 这些词——
// 它们都会命中某条更具体的规则，写探针的人会被自己的样例文案绕进去。
// 右边那句里的每个分支都对着**本机实测**的 git 原话（git 2.56）：
//   快进不上 = `fatal: Not possible to fast-forward, aborting.` + hint `Diverging branches can't be fast-forwarded`
//   冲突没处理 = `error: Pulling is not possible because you have unmerged files.`
//   推送被拒 = `! [rejected] main -> main (non-fast-forward)` + `error: failed to push some refs to ...`
//   没上游 = `There is no tracking information for the current branch.`
// 为什么把「冲突」排在「快进不上」前面：两条都出现在同一次失败里（`unmerged files` 那段 hint 紧跟着
// `fatal: Not possible to fast-forward` 也会打印），排在后面的那条永远轮不到，等于白写。
const WRITE_FAILS = [
  [/nothing to commit/i, '没有可提交的改动（未跟踪的那些不算，这一步不会带上它们）'],
  [/would be overwritten by (merge|checkout)/i, '本地有没提交的改动，git 不肯覆盖它们 —— 先提交，或者在 IDE 里放一边'],
  [/unmerged files|CONFLICT \(merge conflict\)|Automatic merge failed/i, '还有冲突没处理完，git 停在原地 —— 请先在 IDE 里把冲突解决掉（这一格不做合并）'],
  [/(not possible to fast-forward|diverging branches|fast-forward is not possible|Need to specify how to reconcile)/i, '本地和远端各走了各的，对不齐。这一步要做合并，我不替你动 —— 请在 IDE 里处理'],
  [/(failed to push some refs|\[rejected\])/i, '远端有别人推的新提交，这次推送被拒了 —— 先拉取再推'],
  [/(no upstream|no tracking information|has no branch to merge)/i, '这条分支没有上游分支，git 不知道该从哪儿拉、往哪儿推 —— 这一步我不会顺手替你设上游'],
  [/terminal prompts disabled|Authentication failed|could not read (Username|Password)/i, '远端要凭据，而这一步把交互提示按住了（你的密码不经我的手）—— 请在 IDE 或命令行里过一次登录'],
  [/(Could not read from remote repository|Unable to access|Failed to connect|Could not resolve host|does not appear to be a git repository)/i, '连不上远端（网络不通、地址不对，或者那个仓库不存在）'],
  [/error: pathspec .* did not match/i, 'git 找不到要处理的路径，这一步没做'],
  [/hook/i, '仓库自己的钩子把这一步拦下了（我们没有跳过钩子的权限，也不该跳）']
];

function writeError(result, timeoutMs) {
  if (result.timeout) return `这一步超时了（约 ${Math.round((timeoutMs || NETWORK_TIMEOUT_MS) / 1000)} 秒）。git 可能还在跑，先去 IDE 里看一眼再决定重试`;
  if (result.error) return spawnGone(result.error);
  const text = String(result.stderr || '');
  for (const [pattern, message] of WRITE_FAILS) {
    if (pattern.test(text)) return message;
  }
  const first = text.split(/\r?\n/).find((line) => line.trim()) || '';
  return `git 没做成：${redactPaths(first) || `退出码 ${result.code}`}`;
}

// git 收尾那几行是有用的（`3 files changed, 4 insertions(+)`），只取最后三行非空并打码。
function tailOutput(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return redactPaths(lines.slice(-3).join(' · ')).slice(0, 400);
}

class Git {
  // getProjects 给的是**项目服务本身**，不是它某一次的行快照——
  // 「git 格是项目格的第二个视图」这句话要在代码里成立，而不是拷一份行数据再各自漂移。
  // spawn 是自检留的接缝（同 steam/trainers）：注入了就一个真 git 进程都不起。
  constructor({ getProjects, spawn, timeoutMs = STATUS_TIMEOUT_MS, maxFiles = MAX_FILES } = {}) {
    this.getProjects = typeof getProjects === 'function' ? getProjects : () => null;
    this.spawn = spawn;
    this.timeoutMs = timeoutMs;
    this.maxFiles = maxFiles;
    this.exe = null;
    this.version = '';
    this.rows = [];
    this.scannedAt = 0;
    this.key = '';
    // 要看哪个仓库由左边项目格说了算。没选中时 focus 是 null、need 是 'select'，
    // 一个 git 进程都不起——这是「默认态只留一句话」那条要求在服务侧的落点。
    this.focus = null;
    this.focusId = null;
    this.need = 'select';
    this.running = null;
    this.runningKey = '';
    // 同一时刻只留一条待确认的操作：这一格就一个确认条，攒两条「等一下」迟早点错。
    this.pending = null;
    // 试探是不是「哪儿都 ENOENT」= 本机根本没装 git。和「git 在那儿但起不来（超时/被拦）」分开：
    // 前者整格一句人话，后者是每行各自的错——把后者也说成「没找到 git」会把人支去重装。
    // 这一条也决定了自检能不能验到「没 git」那句话：以前用 `!this.spawn` 判，注入替身就永远走不到。
    this.notFound = false;
  }

  // git 在哪：先按 PATH 试（这台机器是 C:\Program Files\Git\ucrt64\bin），撞不到再试那几个常见位置。
  // 认出来就留着，force 刷新才重新找（刚装完 git 点一次刷新就能认到）。
  async resolveExe(force) {
    if (this.exe && !force) return this.exe;
    for (const candidate of ['git', ...GIT_CANDIDATES]) {
      const result = await runGit(candidate, ['--version'], process.cwd(), { spawn: this.spawn, timeoutMs: PROBE_TIMEOUT_MS });
      if (result.ok) {
        this.exe = candidate;
        this.version = String(result.stdout || '').trim().replace(/^git version\s+/, '');
        this.notFound = false;
        return this.exe;
      }
      // PATH 里没有才是 ENOENT，接着试下一个形状；超时/权限那些说明 git 在那儿但起不来，换路径也白搭
      if (!result.error || result.error.code !== 'ENOENT') {
        this.notFound = false;
        break;
      }
      this.notFound = true;
    }
    this.exe = null;
    this.version = '';
    return null;
  }

  // 「没 git」和「git 起不来」两句话，collect 和 prepare 都要用，写在一处
  noGitMessage() {
    return this.notFound
      ? '本机没找到 git（认的是 PATH 里的 git，和 Program Files\\Git\\cmd 那两处）'
      : 'git 起不来（超时或被安全软件拦下），先点「刷新」看每一行上的提示';
  }

  // 项目格那批行：这一格一次盘都不扫。项目格还没扫过就让它现扫一次（60 秒缓存那边兜着）。
  projectRows() {
    const projects = this.getProjects();
    if (!projects) return [];
    if (Array.isArray(projects.items) && projects.items.length) return projects.items;
    if (typeof projects.scan === 'function') {
      const out = projects.scan(false);
      return Array.isArray(out?.items) ? out.items : [];
    }
    return [];
  }

  // 一格只看一个仓库，看哪个由左边项目格选中。focusId 没给或对不上（项目格换了一批行）时
  // 这一格不该假装「全都干净」：它什么都还没看，说 needs 就行话。
  idle(need, focusId) {
    this.rows = [];
    this.key = '';
    this.scannedAt = 0;
    this.focus = null;
    this.need = need;
    this.focusId = Number.isInteger(focusId) ? focusId : null;
    return this.payload(false);
  }

  // focusId 就是项目格那行的 id——两格对同一个项目的称呼一致，这里不用再映射一遍。
  async refresh(force = false, focusId = null) {
    // null / undefined / 空串一律算「左边还没点」。不能让 Number(null)===0 混过去：
    // 0 恰好是第一个项目的 id，那样「默认态一个进程都不起」会变成「默认态替他把第一个仓库扫了」。
    const id = focusId === null || focusId === undefined || focusId === '' ? NaN : Number(focusId);
    if (!Number.isInteger(id) || id < 0) return this.idle('select', null);

    const item = this.projectRows().find((row) => row.id === id);
    if (!item) return this.idle('stale', id);

    // 项目那一行换过（目录被删、或者刚 git init 成仓库）缓存就不作数；
    // 代价不过是几个 git 进程，换来的是两格永远说同一批东西。
    const key = `${item.id}:${item.path}:${item.git ? 'g' : '-'}`;
    this.focus = { id: item.id, name: item.name, root: item.root, repo: Boolean(item.git) };
    this.focusId = item.id;
    this.need = '';

    if (!force && this.scannedAt && key === this.key && Date.now() - this.scannedAt < STATUS_TTL_MS) {
      return this.payload(true);
    }
    // 同一行还没跑完又点了一次：复用那条 Promise，不把 git 进程叠起来
    if (this.running && this.runningKey === key) return this.running;

    this.runningKey = key;
    const job = this.scan(key, item, force).finally(() => {
      if (this.running === job) this.running = null;
    });
    this.running = job;
    return job;
  }

  async scan(key, item, force) {
    // 非仓库先发这一条：`git status` 在不是仓库的目录里会往上走到父目录那个仓库，
    // 把父仓库的改动记到这个文件夹头上（`D:\GitProject` 自己就是个仓库，这坑就在脚边）。
    // one() 在 !item.git 时直接回那一行，一个进程都不起，连 `git --version` 都不问。
    if (!item.git) {
      this.rows = [await this.one('git', item)];
      this.key = key;
      this.scannedAt = Date.now();
      return this.payload(false);
    }

    const exe = await this.resolveExe(Boolean(force));
    if (!exe && this.notFound) {
      // 没 git 不是「这个仓库干净」：整格一句人话，别列一行读不到的假数据
      this.rows = [];
      this.key = key;
      this.scannedAt = 0;
      return this.payload(false, this.noGitMessage());
    }

    this.rows = [await this.one(exe || 'git', item)];
    this.key = key;
    this.scannedAt = Date.now();
    return this.payload(false);
  }

  payload(cached, error = '') {
    return {
      focus: this.focus,
      focusId: this.focusId,
      need: this.need,
      rows: this.rows,
      scannedAt: this.scannedAt,
      git: { found: Boolean(this.exe), version: this.version },
      cached: Boolean(cached),
      ...(error ? { error } : {})
    };
  }

  // 一行一个仓库：`item` 是项目格那条行，字段（id/name/root/touched）直接沿用它的，两格说同一个项目才不打架。
  // 非仓库走不到下面那几行，base 原样回——所以这一句返回的 rows 永远只有一条，且一定对得上 focus。
  async one(exe, item) {
    const base = {
      id: item.id,
      name: item.name,
      root: item.root,
      touched: item.touched || 0,
      repo: Boolean(item.git),
      branch: '',
      detached: false,
      unborn: false,
      sha: '',
      upstream: '',
      ahead: null,
      behind: null,
      files: [],
      conflicted: 0,
      untracked: 0,
      truncated: false,
      counts: { staged: 0, unstaged: 0, tracked: 0, untracked: 0, conflicted: 0 },
      error: ''
    };
    if (!item.git) return base;
    if (!fs.existsSync(item.path)) return { ...base, error: '项目目录已经不在了' };

    const result = await runGit(exe, STATUS_ARGS, item.path, { spawn: this.spawn, timeoutMs: this.timeoutMs });
    if (!result.ok) return { ...base, error: statusError(result) };

    const parsed = parsePorcelain(result.stdout);
    if (!parsed.branch.oid && !parsed.branch.head) {
      // 连 # branch 头都没有：git 换了形状或者输出被截了，这句比列一张空表诚实
      return { ...base, error: '没读懂 git 的输出（这一格只认 porcelain v2）' };
    }

    const row = {
      ...base,
      branch: parsed.branch.head === '(detached)' ? '' : parsed.branch.head,
      detached: parsed.branch.head === '(detached)',
      unborn: parsed.branch.oid === '(initial)',
      sha: /^[0-9a-f]{7,}$/i.test(parsed.branch.oid) ? parsed.branch.oid.slice(0, 7) : '',
      upstream: parsed.branch.upstream,
      ahead: parsed.branch.ahead,
      behind: parsed.branch.behind,
      files: parsed.files.slice(0, this.maxFiles),
      conflicted: parsed.conflicted,
      untracked: parsed.untracked,
      truncated: result.overflow || parsed.files.length > this.maxFiles
    };
    row.counts = countFiles(row);
    return row;
  }

  // 只认这次缓存里的 id：行没了说「列表已过期」，和项目格同一句话
  pick(id) {
    const n = Number(id);
    if (!Number.isInteger(n)) return null;
    return this.rows.find((row) => row.id === n) || null;
  }

  // 文件也用序号寻址：渲染层递 (id, 第几条)，绝对路径由主进程拼（项目行的目录 + 这里的相对路径）。
  // 失败一律 {ok:false,error}：和其它服务同一形状，渲染层只判 res.ok 一件事。
  fileAt(id, index) {
    const row = this.pick(id);
    if (!row) return { ok: false, error: '列表已过期，点「刷新」' };
    const n = Number(index);
    if (!Number.isInteger(n) || n < 0 || n >= row.files.length) return { ok: false, error: '这条已经不在了，点「刷新」' };
    return { ok: true, row, file: row.files[n] };
  }

  // ---------- 写侧：两步。prepare 只发一次性凭据，confirm 才真起 git 进程 ----------

  // 项目格里那条行：目录和该用哪个 IDE 都写在它身上，这一格不留副本。
  projectItem(id) {
    const n = Number(id);
    if (!Number.isInteger(n)) return null;
    return this.projectRows().find((item) => item.id === n) || null;
  }

  // 确认条上那几个数字必须现读：拿 20 秒前的缓存说「要提交 3 个文件」是骗人。
  // 远端那条也一样现问（`git remote` 只列名字，不发网络），不然 fetch 会对着一个不存在的远端干等。
  async prepare(id, op, extra = {}) {
    const kind = String(op || '').toLowerCase();
    const action = OPS[kind];
    if (!action) return { ok: false, error: '这一步不在这一格能做的事里（这里只做抓取 / 拉取 / 提交 / 推送）' };

    const item = this.projectItem(id);
    if (!item) return { ok: false, error: '列表已过期，点「刷新」' };
    if (!item.git) return { ok: false, error: `${item.name} 不是 git 仓库，这一步没得做` };
    if (!fs.existsSync(item.path)) return { ok: false, error: `项目目录已经不在了：${item.name}` };

    const exe = await this.resolveExe(false);
    if (!exe) return { ok: false, error: this.noGitMessage() };

    const row = await this.one(exe, item);
    // 这里**不**把现读的那条塞回 this.rows。渲染层的「点第 N 个文件」用的就是 this.rows 里那个数组的下标：
    // prepare 一覆盖，展开着的那份清单和缓存就错位了，确认完再点一个文件会打开**另一个**文件。
    // 现读的数字只用于这一闸和确认条那句话；列表本身等下一步跑完（confirm 里 invalidate）再重读。
    if (row.error) return { ok: false, error: `这个仓库现在读不到：${row.error}` };

    const message = kind === 'commit' ? String(extra.message || '').trim() : '';
    const blocked = gate(kind, row, message);
    if (blocked) return { ok: false, error: blocked };

    let remote = '';
    if (kind === 'fetch') {
      const listed = await runGit(exe, ['remote'], item.path, { spawn: this.spawn, timeoutMs: PROBE_TIMEOUT_MS });
      remote = listed.ok ? String(listed.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || '' : '';
      if (!remote) return { ok: false, error: '这个仓库还没接远端（git remote 是空的），抓取没处可抓' };
    }

    const argv = action.argv({ message });
    const bad = assertSafeArgs(argv);
    if (bad.length) return { ok: false, error: `这一步要用的参数被拦下了：${bad.join(' ')}` };

    // nonce 一次性：同一时刻只留最新这条，旧的那条立刻作废（他连点两次，第一次那条不该还能跑）
    this.pending = {
      id: item.id,
      op: kind,
      name: item.name,
      exe,
      argv,
      message,
      timeoutMs: action.timeoutMs,
      nonce: crypto.randomBytes(9).toString('hex'),
      expiresAt: Date.now() + CONFIRM_TTL_MS,
      created: Date.now()
    };
    return {
      ok: true,
      op: kind,
      label: action.label,
      name: item.name,
      nonce: this.pending.nonce,
      expiresMs: CONFIRM_TTL_MS,
      lines: confirmLines(kind, row, message)
    };
  }

  // 只认 nonce。id、参数、说明全部是 prepare 时那份——渲染层在 confirm 这一步递不进任何东西，
  // 所以「给他看的那句话」和「真跑的那条命令」不可能对不上。
  //
  // 「吃掉 pending」只对上了才做。原先无条件先清，实测出一个真故障：一条对不上的确认（渲染层留着的
  // 老确认条）会把**刚点出来那条合法的**一起作废，用户点新条的「确认」得到一句「没有待确认的操作」，
  // 只能回去重点。留着不吃的代价是零：nonce 是每次 prepare 现生成的随机串，对不上永远跑不了，
  // 而且 5 秒自己过期——一次性靠「用完即清」保证，不需要靠「猜错也清」兜。
  async confirm(nonce) {
    const pending = this.pending;
    if (!pending) return { ok: false, error: '没有待确认的操作' };
    if (typeof nonce !== 'string' || nonce !== pending.nonce) {
      return { ok: false, error: '确认码不对（这条确认不是刚才那一次点出来的）' };
    }
    this.pending = null;
    if (Date.now() > pending.expiresAt) return { ok: false, error: '确认已经过期（5 秒），请重新点一次' };

    const item = this.projectItem(pending.id);
    if (!item) return { ok: false, error: '列表已过期，点「刷新」' };
    const bad = assertSafeArgs(pending.argv);
    if (bad.length) return { ok: false, error: `这一步要用的参数被拦下了：${bad.join(' ')}` };

    const result = await runGit(pending.exe, pending.argv, item.path, { spawn: this.spawn, timeoutMs: pending.timeoutMs });
    // 不管成没成，缓存都不作数了：这一步动的就是这仓库的状态，留着只会给人看假数字。
    this.invalidate();
    if (!result.ok) {
      return { ok: false, op: pending.op, name: pending.name, error: writeError(result, pending.timeoutMs) };
    }
    return { ok: true, op: pending.op, name: pending.name, output: tailOutput(result.stdout) };
  }

  cancel(nonce) {
    const had = this.pending && this.pending.nonce === nonce;
    if (had) this.pending = null;
    return { ok: true, canceled: Boolean(had) };
  }

  // 跑完一步（提交 / 推送 / 拉取）就把这一格作废：下一次刷新重读，别拿旧数字接着演。
  // 只清 scannedAt 和 key，不清 focus——刚提交完还盯着同一个仓库看是对的。
  invalidate() {
    this.scannedAt = 0;
    this.key = '';
    return { ok: true };
  }

  // 点一个改动文件：目录从项目行取，文件是这一格的仓库内相对路径，两者都在主进程拼。
  // 用哪个 IDE 由项目格判（这就是「第二个视图」的含义），这一格只把绝对路径交给它。
  fileTarget(id, index) {
    const hit = this.fileAt(id, index);
    if (!hit.ok) return hit;
    const item = this.projectItem(id);
    if (!item) return { ok: false, error: '列表已过期，点「刷新」' };
    const full = insideRepo(item.path, hit.file.path);
    if (!full) return { ok: false, error: '这个路径不在仓库里面，不打开' };
    return { ok: true, projectId: item.id, path: full, file: hit.file.path };
  }

  // 给自检和「这一格现在在看哪个仓库」用的：字段和 payload 同一批，同样不许出现盘符路径（root 除外）。
  status() {
    return {
      found: Boolean(this.exe),
      version: this.version,
      focus: this.focus,
      focusId: this.focusId,
      need: this.need,
      rows: this.rows.length,
      scannedAt: this.scannedAt
    };
  }
}

module.exports = {
  Git,
  parsePorcelain,
  parseBranch,
  columns,
  classify,
  countFiles,
  statusError,
  spawnGone,
  runGit,
  // 写侧
  OPS,
  BANNED_ARGS,
  assertSafeArgs,
  gate,
  confirmLines,
  writeError,
  tailOutput,
  insideRepo,
  STATUS_ARGS,
  STATUS_TTL_MS,
  STATUS_TIMEOUT_MS,
  NETWORK_TIMEOUT_MS,
  PUSH_TIMEOUT_MS,
  COMMIT_TIMEOUT_MS,
  CONFIRM_TTL_MS,
  MAX_MESSAGE,
  MAX_FILES,
  MAX_OUTPUT,
  GIT_ENV
};
