// git 格子（工作面板 gitzone 那一整块）的离线自检：不起应用、不跑真 git、不碰 D:\GitProject 里任何一个仓库。
//
// 假 spawn 按 cwd 现喂一份我按 git 2.56 实测形状写出来的 porcelain v2 文本，所以这一趟能验的是：
// 1) 解析 —— 四种记录（1 / 2 / u / ?）各自的段数，路径里带空格和中文不能被切开，改名的 from 是**紧跟的下一段**；
// 2) 焦点 —— 看哪个仓库由左边项目格递进来的 id 决定：没选中 / id 对不上时一个 git 进程都不起，只回一句 need；
//    一次只扫那一个、非仓库连 `git --version` 都不问、换项目缓存不作数、点文件时找回项目格那个 IDE；
// 3) 写侧的门 —— 只做四样、参数被 BANNED_ARGS 拦住、一次性 nonce、五种情况 gate 前拒；
// 4) 泄漏 —— 行数据、payload、错误文案里不许出现盘符路径，也不许出现 git.exe 的位置。
//
// 用法（Git Bash）: node tools/git-check.js
// 跑完全绿以后按 QODER.md 那条老规矩做一次变异（清单在本文件末尾的注释里）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const {
  Git,
  parsePorcelain,
  parseBranch,
  columns,
  classify,
  countFiles,
  statusError,
  spawnGone,
  writeError,
  tailOutput,
  insideRepo,
  assertSafeArgs,
  gate,
  confirmLines,
  OPS,
  BANNED_ARGS,
  STATUS_ARGS,
  STATUS_TTL_MS,
  MAX_FILES,
  MAX_OUTPUT,
  MAX_MESSAGE,
  CONFIRM_TTL_MS,
  GIT_ENV
} = require('../src/main/services/git');
const { Projects, insideDir } = require('../src/main/services/projects');
const layoutStore = require('../src/main/layout');

const APP_ROOT = path.resolve(__dirname, '..');
const tmp = path.join(os.tmpdir(), `toolbar-git-check-${process.pid}`);
const failures = [];
const consoleLines = [];

function expect(message, cond) {
  // 说明在前、条件在后。条件位上收到非布尔就是调用方把两条写反了——那种写法会让一条该红的断言
  // 默默绿掉，所以直接抛，不要往下走（projects-check 同一条款）。
  if (typeof cond !== 'boolean') throw new Error(`expect 的第 2 个参数不是布尔（说明和条件写反了？）：${message} / ${typeof cond}`);
  if (!cond) failures.push(message);
}

function makeDir(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- porcelain v2 的四种记录，段数照 git 2.56 实测 ----------
// 1 <XY> <sub> <m1> <m2> <mm> <s1> <s2> <path>                     = 9 段
// 2 <XY> <sub> <m1> <m2> <mm> <s1> <s2> <score> <path> \0 <srcPath> = 10 段 + 紧跟一段
// u <XY> <sub> <m1> <m2> <m3> <mm> <s1> <s2> <s3> <path>            = 11 段
// ? <path>                                                          = 2 段
const r1 = (xy, p, rest = {}) => ['1', xy, 'N...', rest.m1 || '100644', rest.m2 || '100644', '000000000', rest.s1 || 'a'.repeat(40), rest.s2 || 'b'.repeat(40), p].join(' ');
const r2 = (xy, p, from, score = 'R100') => [['2', xy, 'N...', '100644', '100644', '000000000', 'a'.repeat(40), 'b'.repeat(40), score, p].join(' '), from];
const ru = (p) => ['u', 'UU', 'N...', '100644', '100644', '100644', '000000000', 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), p].join(' ');
const rq = (p) => ['?', p].join(' ');
const head = (oid = 'f'.repeat(40), headName = 'main', upstream = 'origin/main', ab = '+1 -0') => {
  const lines = [`# branch.oid ${oid}`, `# branch.head ${headName}`];
  if (upstream) lines.push(`# branch.upstream ${upstream}`);
  if (ab) lines.push(`# branch.ab ${ab}`);
  return lines;
};
// git 的输出是一条条 NUL 结尾，最后一条后面也有一个 NUL
const out = (headers, records) => [...headers, ...[].concat(records).map((one) => one)].join('\0') + '\0';

// ---------- 假 spawn：按 cwd 现喂剧本，一个真 git 进程都不起 ----------
let calls = [];
function resetCalls() {
  calls = [];
}
const isVersion = (args) => args[0] === '--version';
const isStatus = (args) => args.includes('status');
const isRemote = (args) => args[0] === 'remote';
// 写进程 = 既不是探测版本、也不是读 status、也不是列远端
const writeCalls = () => calls.filter((c) => !isVersion(c.args) && !isStatus(c.args) && !isRemote(c.args));

function makeSpawn(table, opts = {}) {
  return function fakeSpawn(exe, args, options) {
    calls.push({ exe, args, cwd: options.cwd });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.unref = () => {};

    setTimeout(() => {
      const key = path.basename(options.cwd);
      const plan = table[key];

      if (isVersion(args)) {
        if (opts.noGit) {
          child.emit('error', Object.assign(new Error(`spawn ${exe} ENOENT`), { code: 'ENOENT' }));
          return;
        }
        child.stdout.emit('data', Buffer.from('git version 9.9.9.test\n', 'utf8'));
        child.emit('close', 0, null);
        return;
      }
      if (opts.brokenGit) {
        child.emit('close', 128, null);
        return;
      }
      if (!plan) {
        child.stderr.emit('data', Buffer.from('fatal: not a git repository\n', 'utf8'));
        child.emit('close', 128, null);
        return;
      }
      if (plan.hang) return; // 永远不回话：只有 runGit 到点自己 resolve 才测得到那条
      if (plan.enoent) {
        child.emit('error', Object.assign(new Error(`spawn ${exe} ENOENT`), { code: 'ENOENT' }));
        return;
      }

      if (isRemote(args)) {
        child.stdout.emit('data', Buffer.from(`${plan.remote === undefined ? 'origin' : plan.remote}\n`, 'utf8'));
        child.emit('close', 0, null);
        return;
      }
      if (isStatus(args)) {
        const buffer = Buffer.from(plan.stdout || '', 'utf8');
        if (plan.chop) {
          // 从一个多字节字符中间切开：按 chunk toString 会把中文文件名切成乱码，攒 Buffer 才解得开
          const at = buffer.indexOf(0xe4) + 1;
          if (at > 1 && at < buffer.length) {
            child.stdout.emit('data', buffer.subarray(0, at));
            child.stdout.emit('data', buffer.subarray(at));
          } else child.stdout.emit('data', buffer);
        } else child.stdout.emit('data', buffer);
      } else if (plan.write) {
        if (plan.write.stderr) child.stderr.emit('data', Buffer.from(plan.write.stderr, 'utf8'));
        if (plan.write.stdout) child.stdout.emit('data', Buffer.from(plan.write.stdout, 'utf8'));
        child.emit('close', plan.write.code === undefined ? 0 : plan.write.code, null);
        return;
      }
      if (plan.stderr) child.stderr.emit('data', Buffer.from(plan.stderr, 'utf8'));
      child.emit('close', plan.code === undefined ? 0 : plan.code, null);
    }, 1);
    return child;
  };
}

const item = (name, dir, extra = {}) => ({ id: extra.id, name, path: dir, root: tmp, git: true, touched: 100, ide: 'webstorm', ...extra });

function service(rows, table, opts = {}) {
  const git = new Git({ getProjects: () => ({ items: rows }), spawn: makeSpawn(table, opts), timeoutMs: opts.timeoutMs || 900, ...opts.git });
  return git;
}

(async () => {
  fs.mkdirSync(tmp, { recursive: true });

  // ================================================================= 1. 解析
  {
    const parsed = parsePorcelain(out(head(), [r1('.M', 'src/a.js'), r1('M.', 'src/b.js'), rq('new/folder/')]));
    expect(`分支头没读到：${JSON.stringify(parsed.branch)}`, parsed.branch.head === 'main' && parsed.branch.upstream === 'origin/main');
    expect(`ab 那两个数字读错：${JSON.stringify(parsed.branch)}`, parsed.branch.ahead === 1 && parsed.branch.behind === 0);
    expect(`.M 该算没暂存：${JSON.stringify(parsed.files[0])}`, parsed.files[0].kind === 'unstaged');
    expect(`M. 该算已暂存：${JSON.stringify(parsed.files[1])}`, parsed.files[1].kind === 'staged');
    expect(`未跟踪目录该标出来：${JSON.stringify(parsed.files[2])}`, parsed.files[2].dir === true && parsed.files[2].kind === 'untracked');
    expect(`未跟踪计数错：${parsed.untracked}`, parsed.untracked === 1);
  }
  {
    // 路径里有空格：不能按空格切。少切一段就会把「src/」当成路径、把后面的「名字.js」丢掉
    const parsed = parsePorcelain(out(head(), [r1('.M', 'src/有 空格 的 文件.js')]));
    expect(`带空格的路径被切开：${parsed.files[0]?.path}`, parsed.files[0].path === 'src/有 空格 的 文件.js');
    expect('带空格的路径多吐出一条', parsed.files.length === 1);
  }
  {
    // 改名：from 是**紧跟其后的那一段**，不是靠内容猜。放一个内容就叫「1 foo.txt」的诱饵在下面，
    // 按前缀猜实现会把 from 当成一条新记录解析，于是多吐一条改动、还把 from 弄丢
    const [rec, from] = r2('R.', 'src/new.js', '1 有 空格.txt');
    const parsed = parsePorcelain(out(head(), [rec, from]));
    expect(`改名的 from 没取到：${JSON.stringify(parsed.files[0])}`, parsed.files[0].from === '1 有 空格.txt');
    expect(`改名的路径切错：${parsed.files[0]?.path}`, parsed.files[0].path === 'src/new.js');
    expect(`改名多吐出一条（把 from 当记录了）：${parsed.files.length}`, parsed.files.length === 1);
  }
  {
    // 冲突记录 11 段：少写一段会把最后一个 hash 当路径（实测踩过，路径变成一长串十六进制）
    const parsed = parsePorcelain(out(head(), [ru('src/conflict.js')]));
    expect(`冲突的路径读到 hash 了：${parsed.files[0]?.path}`, parsed.files[0].path === 'src/conflict.js');
    expect(`冲突计数错：${parsed.conflicted}`, parsed.conflicted === 1);
    expect('冲突该标成 conflicted', parsed.files[0].kind === 'conflicted');
  }
  {
    const clean = parsePorcelain(out(head(), []));
    expect(`干净的仓库多出了东西：${JSON.stringify(clean.files)}`, clean.files.length === 0);
    expect('干净仓库的头读丢了', clean.branch.head === 'main');
    const ignored = parsePorcelain(out(head(), ['! build/out.js']));
    expect(`忽略的记录被当成改动了：${JSON.stringify(ignored.files)}`, ignored.files.length === 0);
    const noHeader = parsePorcelain('\0');
    expect('没有头的时候不该假装读到分支', noHeader.branch.head === '' && noHeader.branch.oid === '');
    const init = parseBranch(['# branch.oid (initial)', '# branch.head main']);
    expect(`还没有一次提交的样子没读出来：${JSON.stringify(init)}`, init.oid === '(initial)');
    const det = parseBranch(['# branch.oid ' + 'a'.repeat(40), '# branch.head (detached)']);
    expect(`游离 HEAD 没读出来：${JSON.stringify(det)}`, det.head === '(detached)');
    const noAb = parseBranch(['# branch.head main']);
    expect('没有远端时 ab 该是 null 而不是 0', noAb.ahead === null && noAb.behind === null);
  }
  {
    // 计数分开：commit -a 只带走已跟踪的，混成一个数字就是在骗人
    const parsed = parsePorcelain(out(head(), [r1('MM', 'both.js'), r1('.M', 'work.js'), r1('A.', 'staged.js'), rq('u.js')]));
    const row = { files: parsed.files, untracked: parsed.untracked, counts: {} };
    row.counts = countFiles(row);
    expect(`已跟踪的改动数错：${JSON.stringify(row.counts)}`, row.counts.tracked === 3);
    expect(`暂存/未暂存分开数错：${JSON.stringify(row.counts)}`, row.counts.staged === 2 && row.counts.unstaged === 2);
    expect(`未跟踪没单独计：${JSON.stringify(row.counts)}`, row.counts.untracked === 1);
    expect('MM 同时算两边（少算一边就低估了要提交几个）', classify('MM').staged && classify('MM').unstaged);
    expect('?? 不该被算成已暂存', classify('??').staged === false);
  }
  {
    expect('columns 切少了段该回 null', columns('1 a b', 9) === null);
    const three = columns('a b c d', 3);
    expect(`columns 把剩下的段又切了：${JSON.stringify(three)}`, three[2] === 'c d');
  }
  // ================================================================= 2. 焦点：看哪个仓库由左边那一下点决定
  {
    const a = makeDir('甲仓');
    const b = makeDir('乙非仓库');
    const gone = path.join(tmp, '已经不在了');
    const statusText = out(head('c'.repeat(40), 'dev', 'origin/dev', '+2 -3'), [r1('.M', 'x.js'), rq('todo/')]);
    const rows = [item('甲仓', a, { id: 0 }), { ...item('乙非仓库', b, { id: 1 }), git: false }, item('没了', gone, { id: 2 })];
    const table = { 甲仓: { stdout: statusText }, 乙非仓库: {}, 没了: {} };
    const git = service(rows, table);
    resetCalls();
    const res = await git.refresh(true, 0);

    // 一次只说一个仓库：rows 永远只有一条，而且就是 focus 那条
    expect(`选甲仓却读了 ${res.rows.length} 个仓库（该只有一条行）：${res.rows.map((r) => r.name).join(',')}`, res.rows.length === 1 && res.rows[0].name === '甲仓');
    expect(`focus 不是选中的那条：${JSON.stringify(res.focus)}`, res.focus && res.focus.id === 0 && res.focus.name === '甲仓' && res.focus.root === tmp && res.focus.repo === true);
    expect(`选中了仓库还有 need：${JSON.stringify(res.need)}`, res.need === '');
    expect(`focusId 没回给渲染层：${JSON.stringify(res.focusId)}`, res.focusId === 0);
    const jia = res.rows[0];
    expect(`甲仓的分支读错：${jia.branch}/${jia.upstream}`, jia.branch === 'dev' && jia.upstream === 'origin/dev');
    expect(`甲仓的领先落后读错：+${jia.ahead} -${jia.behind}`, jia.ahead === 2 && jia.behind === 3);
    expect(`甲仓的 sha 该截 7 位：${jia.sha}`, jia.sha === 'ccccccc');
    expect(`甲仓的计数错：${JSON.stringify(jia.counts)}`, jia.counts.tracked === 1 && jia.untracked === 1);
    expect(`id 得沿用项目格那批（不然点文件找不回 IDE）：${jia.id}`, jia.id === 0);
    expect(`root 那一句要从项目行带过来：${jia.root}`, jia.root === tmp);

    // 非仓库不发进程：发了就会被 git 往上走到父目录那个仓库，把父仓库的改动记在这个文件夹头上。
    // 这一条在焦点模型里更狠——连 `git --version` 都不问，因为压根不需要 git 就能知道它不是仓库。
    resetCalls();
    const plain = await git.refresh(true, 1);
    expect(`非仓库那格该是 repo:false 而不是报错：${JSON.stringify(plain.rows[0])}`, plain.rows.length === 1 && plain.rows[0].repo === false && plain.rows[0].error === '');
    expect(`非仓库的 focus：${JSON.stringify(plain.focus)}`, plain.focus.repo === false && plain.focus.name === '乙非仓库');
    expect(`非仓库也起了 git 进程（会把父仓库算进来）：${calls.map((c) => c.args.join(' ')).join(' | ')}`, calls.length === 0);

    // 目录没了仍然是「这一行自己的错」，不是整格空
    resetCalls();
    const missing = await git.refresh(true, 2);
    expect(`目录没了要说「已经不在了」：${missing.rows[0].error}`, /已经不在了/.test(missing.rows[0].error));

    // 没选中：一句 need，一个进程都不起（这是「默认态只留一句话」那条要求）
    resetCalls();
    for (const nothing of [undefined, null, '', 'abc', -1, 1.5]) {
      const idle = await git.refresh(true, nothing);
      expect(`没给 focusId（${JSON.stringify(nothing)}）也起了进程：${calls.map((c) => c.args.join(' ')).join(' | ')}`, calls.length === 0);
      expect(`没给 focusId（${JSON.stringify(nothing)}）该 need=select：${JSON.stringify(idle.need)}`, idle.need === 'select' && idle.rows.length === 0 && idle.focus === null);
    }
    // id 对不上这批行（项目格刚换过一批 / 那个文件夹被删了）：渲染层靠这句自己去重扫，别停在假数据上
    resetCalls();
    const stale = await git.refresh(true, 99);
    expect(`假 id 该 need=stale 而不是 select：${JSON.stringify(stale.need)}`, stale.need === 'stale');
    expect(`假 id 还起了进程：${calls.length}`, calls.length === 0);
    expect(`假 id 该把 focusId 带回去好对上：${stale.focusId}`, stale.focusId === 99 && stale.rows.length === 0);
    // idle 之后不许留着上一次的行（那是另一个仓库的数字）
    expect(`need=stale 时缓存里的行没清干净：${JSON.stringify(stale.rows)}`, git.rows.length === 0 && git.key === '' && git.scannedAt === 0);
  }
  {
    // 行数据和 payload 里不许有绝对路径 / git.exe 的位置
    const a = makeDir('泄漏检查');
    const git = service([item('泄漏检查', a, { id: 7 })], { 泄漏检查: { stdout: out(head(), [r1('.M', 'x.js')]) } });
    const res = await git.refresh(true, 7);
    const drive = /[A-Za-z]:[\\/]/;
    // root 是他在设置里自己配的仓库根，项目格那一行带的也是同一句话（信息卡那一句用它）——这条留着。
    // 除 root 以外，payload 里不许出现任何绝对路径：项目目录只能留在主进程，按 id 查。
    const strip = (value) => JSON.stringify(value, (key, one) => (key === 'root' ? undefined : one));
    expect(`除 root 外 payload 里还有盘符路径：${strip(res).slice(0, 220)}`, !drive.test(strip(res)));
    expect(`行里带了项目目录，渲染层只该拿到 id：${Object.keys(res.rows[0]).join(',')}`, res.rows[0].path === undefined);
    // payload 的键就是那份契约：将来谁想多回一个字段（比如 focus 带上 path），这条先红
    expect(`payload 的键变了：${Object.keys(res).sort().join(',')}（focus.path 这种东西只能留在主进程）`,
      Object.keys(res).sort().join(',') === 'cached,focus,focusId,git,need,rows,scannedAt');
    expect(`focus 里的键多了：${Object.keys(res.focus).sort().join(',')}`, Object.keys(res.focus).sort().join(',') === 'id,name,repo,root');
    expect(`行里的文件路径该是仓库内的相对路径：${JSON.stringify(res.rows[0].files)}`, res.rows[0].files.every((file) => !drive.test(file.path)));
    expect(`payload 里有 git.exe：${JSON.stringify(res.git)}`, !/git\.exe/i.test(JSON.stringify(res)));
    expect(`git 那一段该只说有没有和版本：${JSON.stringify(res.git)}`, res.git.found === true && res.git.version === '9.9.9.test');
    expect(`行里没有 id 就寻不了址：${res.rows[0].id}`, res.rows[0].id === 7);
    expect('payload 缺 cached 标记', res.cached === false);
    expect(`除 root 外 status() 也漏了路径：${strip(git.status()).slice(0, 220)}`, !drive.test(strip(git.status())));
  }
  {
    // 20 秒缓存 + force 绕开 + 单飞：同一个仓库不重复起进程，换项目则不作数
    const a = makeDir('缓存仓');
    const b = makeDir('第二个仓');
    const table = { 缓存仓: { stdout: out(head(), [r1('.M', 'x.js')]) }, 第二个仓: { stdout: out(head(), []) } };
    const rows = [item('缓存仓', a, { id: 0 }), item('第二个仓', b, { id: 1 })];
    const git = service(rows, table);
    resetCalls();
    await git.refresh(true, 0);
    const first = calls.filter((c) => isStatus(c.args)).length;
    expect(`一个仓库一次刷新起了 ${first} 个 status 进程（该恰好一个）`, first === 1);
    resetCalls();
    const cached = await git.refresh(false, 0);
    expect(`缓存命中还起了进程：${calls.filter((c) => isStatus(c.args)).length}`, calls.filter((c) => isStatus(c.args)).length === 0);
    expect(`缓存命中该标 cached：${JSON.stringify(cached.cached)}`, cached.cached === true);
    resetCalls();
    await git.refresh(true, 0);
    expect(`force 没绕开缓存：${calls.filter((c) => isStatus(c.args)).length}`, calls.filter((c) => isStatus(c.args)).length === first);
    // 两条同时来（连点两次刷新）只该起一批，而且拿到的是同一条 Promise
    resetCalls();
    const [r1a, r1b] = await Promise.all([git.refresh(true, 0), git.refresh(true, 0)]);
    expect(`同一行并发刷新建了两次进程：${calls.filter((c) => isStatus(c.args)).length}`, calls.filter((c) => isStatus(c.args)).length === first);
    expect('并发那两次没复用同一条 Promise（结果对象不是同一个）', r1a === r1b);
    // 切到另一个项目 = 换 key = 缓存不作数（这一格跟着左边点走，停在上一个仓库的数字是骗人）
    resetCalls();
    const other = await git.refresh(false, 1);
    expect(`换了项目还在吃上一个的缓存：${other.cached}`, other.cached === false);
    expect(`换项目没起进程：${calls.filter((c) => isStatus(c.args)).length}`, calls.filter((c) => isStatus(c.args)).length === first);
    expect(`换项目以后 focus 跟着换：${JSON.stringify(other.focus)}`, other.focus.id === 1 && other.focus.name === '第二个仓');
    // 缓存只有一个槽（this.key 是「正在看的这一个」）：切回去只能重读，代价是一个 git 进程，
    // 换来的是这一格永远说当前选中的那个仓库。攒两个槽就成了给人看另一个仓库的数字。
    resetCalls();
    const back = await git.refresh(false, 0);
    expect(`切回上一个项目用上了另一个仓库的缓存：${back.cached}`, back.cached === false && calls.filter((c) => isStatus(c.args)).length === first);
    resetCalls();
    const stay = await git.refresh(false, 0);
    expect(`同一个项目连着看却没吃到缓存：${stay.cached}`, stay.cached === true && calls.length === 0);
    expect(`缓存 TTL 不是 20 秒：${STATUS_TTL_MS}`, STATUS_TTL_MS === 20000);
    // 同一个 id 指向了另一个文件夹（项目格重扫后他把项目挪了地方）：缓存同样不作数
    const moved = service([item('缓存仓', a, { id: 0 })], table);
    await moved.refresh(true, 0);
    moved.getProjects = () => ({ items: [item('缓存仓', b, { id: 0 })] });
    resetCalls();
    const movedAgain = await moved.refresh(false, 0);
    expect(`同一个 id 换了目录还在吃缓存：${movedAgain.cached}`, movedAgain.cached === false && calls.filter((c) => isStatus(c.args)).length === first);
  }
  {
    // 项目格换了一批行：这一格不许拿上一批的行装样子
    const a = makeDir('换批甲');
    const git = service([item('换批甲', a, { id: 0 })], { 换批甲: { stdout: out(head('b'.repeat(40), 'one', 'origin/main', '+1 -0'), [r1('.M', 'x.js')]) } });
    await git.refresh(true, 0);
    expect(`第一批的行没读出来：${git.rows.length}`, git.rows.length === 1);
    git.getProjects = () => ({ items: [] });
    resetCalls();
    const gone = await git.refresh(false, 0);
    expect(`项目行空了以后还在给旧行：${JSON.stringify(gone.rows)}`, gone.rows.length === 0 && gone.need === 'stale');
    expect('项目行空了那次也起了进程', calls.length === 0);
  }
  {
    // status 非 0：三种翻译，且都不带盘符路径
    const cases = [
      ['fatal: not a git repository (or any of the parent directories): .git\n', /不是一个 git 仓库/],
      ['unable to create temporary file in D:\\Secret\\.git/index.lock\n', /索引正被别的操作占着/],
      ['fatal: bad object\n', /git 没答上来/]
    ];
    for (const [stderr, re] of cases) {
      const text = statusError({ ok: false, code: 128, stderr });
      expect(`status 失败翻译错（${stderr.slice(0, 20)}）：${text}`, re.test(text));
      expect(`status 失败文案漏了盘符路径：${text}`, !/[A-Za-z]:[\\/]/.test(text));
    }
    expect('status 超时的文案没提网络盘', /网络盘|移动硬盘/.test(statusError({ timeout: true })));
    expect(`git 被挪走那句该说 git：${spawnGone(Object.assign(new Error('x'), { code: 'ENOENT' }))}`, /本机没找到 git/.test(spawnGone(Object.assign(new Error('x'), { code: 'ENOENT' }))));
    expect('git 被挪走那句不许说「点重扫」（那是项目格的按钮名）', !/重扫/.test(spawnGone(Object.assign(new Error('x'), { code: 'ENOENT' }))));
  }
  {
    // 到点自己 resolve：假 spawn 永远不回话，这条必须还能出结果。
    // 以前是 kill 完等 'close'，而 push/fetch 会留下 ssh 那样的孙进程攥住管道 → Promise 永远挂着，
    // this.running 不清，这一格此后每次刷新都复用它，确认条一直停在「正在跑」。
    const a = makeDir('不回话');
    const git = service([item('不回话', a, { id: 0 })], { 不回话: { hang: true } }, { timeoutMs: 60 });
    const res = await git.refresh(true, 0);
    expect(`不回话时没在超时内给出结果：${JSON.stringify(res.rows[0].error)}`, /读取超时/.test(res.rows[0].error));
    expect('超时以后 this.running 没清掉（下次刷新会复用那条永远不完成的 Promise）', git.running === null);
    resetCalls();
    const again = await git.refresh(true, 0);
    expect(`超时以后再一次刷新没重起进程：${again.rows[0].error}`, /读取超时/.test(again.rows[0].error) && calls.filter((c) => isStatus(c.args)).length === 1);
  }
  {
    // 没 git（每个候选都 ENOENT）= 整格一句人话；git 起不来（非 ENOENT）= 每行各自的错。
    // 这两条分开才不把「被安全软件拦下」的人支去重装 git。
    const a = makeDir('没git仓');
    const rows = [item('没git仓', a, { id: 0 })];
    const none = service(rows, { 没git仓: { stdout: '' } }, { noGit: true });
    const resNone = await none.refresh(true, 0);
    expect(`本机没 git 时没说整格的话：${JSON.stringify(resNone.error)}`, /本机没找到 git/.test(resNone.error || ''));
    expect(`本机没 git 时该把行清空：${resNone.rows.length}`, resNone.rows.length === 0);
    expect(`没 git 时也要知道自己在看哪个（渲染层那句「读取中」不能停在空 focus 上）：${JSON.stringify(resNone.focus)}`, resNone.focus?.name === '没git仓' && resNone.need === '');
    expect(`没 git 时 payload 的 git 段：${JSON.stringify(resNone.git)}`, resNone.git.found === false);
    expect(`没 git 时 prepare 也该说同一句：${JSON.stringify((await none.prepare(0, 'fetch')).error)}`, /本机没找到 git/.test((await none.prepare(0, 'fetch')).error));
    expect(`没 git 时 notFound 该是 true：${none.notFound}`, none.notFound === true);

    const broken = service(rows, { 没git仓: { stdout: '' } }, { brokenGit: true });
    const resBroken = await broken.refresh(true, 0);
    const brokenPrep = await broken.prepare(0, 'fetch');
    expect(`git 起不来时该有行而不是整格空：${JSON.stringify(resBroken.rows)}`, resBroken.rows.length === 1);
    expect(`git 起不来时说的是「没找到 git」（该是起不来）：${resBroken.rows[0].error}`, !/本机没找到 git/.test(resBroken.rows[0].error));
    // 整格那句只留给「一次 git 都没跑起来」。这里 git 是跑得起来的（--version 答了，只是 status 退 128），
    // 所以每一行说自己那句，prepare 只是在它前面加一句「这个仓库现在读不到」。
    expect(`git 起不来时 prepare 该说这一行自己的错：${JSON.stringify(brokenPrep.error)}`, /这个仓库现在读不到/.test(brokenPrep.error || ''));
    expect(`git 起不来时 prepare 不该甩整格那句：${JSON.stringify(brokenPrep.error)}`, !/本机没找到 git|起不来/.test(brokenPrep.error || ''));
    expect(`git 起不来时 notFound 该是 false：${broken.notFound}`, broken.notFound === false);
    // 两句必须真是两句：把 noGitMessage 里那条改回另一条，这两行一起红
    expect(`git 没找到时整格那句：${none.noGitMessage()}`, /本机没找到 git/.test(none.noGitMessage()));
    expect(`git 在但跑不动时整格那句：${broken.noGitMessage()}`, /起不来/.test(broken.noGitMessage()));
  }
  {
    // 输出被截 / 条数超上限：都要在行上标出来，不能只数前面几条当全数
    const a = makeDir('超长');
    const many = Array.from({ length: 12 }, (unused, i) => r1('.M', `f${i}.js`));
    const git = service([item('超长', a, { id: 0 })], { 超长: { stdout: out(head(), many) } }, { git: { maxFiles: 5 } });
    const res = await git.refresh(true, 0);
    expect(`上限之上还全列出来了：${res.rows[0].files.length}`, res.rows[0].files.length === 5);
    expect('超上限没标 truncated', res.rows[0].truncated === true);
    expect(`截断以后未跟踪计数还能骗人：${res.rows[0].untracked}`, res.rows[0].untracked === 0);

    const big = service([item('超长', a, { id: 0 })], { 超长: { stdout: out(head(), [r1('.M', 'x.js'), rq('y'.repeat(MAX_OUTPUT))]) } });
    const resBig = await big.refresh(true, 0);
    expect(`超过 ${MAX_OUTPUT} 字节没标 truncated：${resBig.rows[0].truncated}`, resBig.rows[0].truncated === true);
    expect('输出爆掉以后行还在（不能整格没了）', resBig.rows.length === 1);
  }
  {
    // 中文路径被切成两个 chunk：按 chunk toString 会变乱码，攒 Buffer 才对
    const a = makeDir('中文');
    const git = service([item('中文', a, { id: 0 })], { 中文: { stdout: out(head(), [r1('.M', 'src/文档/说明 文件.md')]), chop: true } });
    const res = await git.refresh(true, 0);
    expect(`多字节被切开成了乱码：${res.rows[0].files[0]?.path}`, res.rows[0].files[0] && res.rows[0].files[0].path === 'src/文档/说明 文件.md');
  }
  {
    expect(`status 的参数顺序不对（-c 必须在子命令前，否则 git 退 129）：${STATUS_ARGS.join(' ')}`,
      STATUS_ARGS.slice(0, 3).join(' ') === '-c core.quotepath=false --no-optional-locks' && STATUS_ARGS[3] === 'status');
    expect(`交互提示没按住（会弹进管道里没人回答）：${GIT_ENV.GIT_TERMINAL_PROMPT}`, GIT_ENV.GIT_TERMINAL_PROMPT === '0');
  }

  // ================================================================= 3. 写侧：门、两步、一次性
  {
    const a = makeDir('写甲');
    const statusText = out(head('d'.repeat(40), 'main', 'origin/main', '+2 -0'), [r1('.M', 'src/a.js'), rq('new.txt')]);
    const table = { 写甲: { stdout: statusText, write: { stdout: `[main 1a2b3c4] 改一点\n\n 1 file changed, 1 insertion(+)\n` } } };
    const rows = [item('写甲', a, { id: 0 })];

    // 只做四样
    expect(`能做的事不止四个：${Object.keys(OPS).join(',')}`, Object.keys(OPS).length === 4 && ['fetch', 'pull', 'commit', 'push'].every((k) => OPS[k]));
    const git = service(rows, table);
    for (const op of ['stash', 'reset', 'checkout', 'clean', 'merge', 'rebase', '', undefined]) {
      const res = await git.prepare(0, op);
      expect(`第五件事「${op}」没被拒：${JSON.stringify(res)}`, res.ok === false && /不在这一格能做的事/.test(res.error));
    }
    resetCalls();
    for (const op of ['fetch', 'pull', 'commit', 'push']) await git.prepare(0, op, { message: '改一点' });
    expect(`prepare 起了写进程（${writeCalls().map((c) => c.args.join(' ')).join(' | ')}）`, writeCalls().length === 0);

    // 只有空格的说明：prepare 先 trim 再过闸，所以这条到不了 git（git 自己也会拒，但那句话不是人话）
    const blank = await git.prepare(0, 'commit', { message: '   ' });
    expect(`只有空格的提交说明没被拦：${JSON.stringify(blank)}`, blank.ok === false && /提交说明是空的/.test(blank.error));
    expect('空格说明那次也起了进程', writeCalls().length === 0);

    // 整条说明正好是一个被拦的词（「rebase」）：那还是说明，不是参数，闸必须过
    const wordy = await git.prepare(0, 'commit', { message: 'rebase' });
    expect(`说明写成「rebase」就没过闸：${JSON.stringify(wordy.error)}`, wordy.ok === true);

    // prepare 会现读一次 status（拿最新的数字过闸、说确认条那句），但**不许**把现读那条盖回 this.rows：
    // 展开着的清单用的是缓存那行的下标，盖了以后点第 1 个文件会开成第 2 个（清单缩短时最明显）。
    const shift = makeDir('错位');
    const shiftTable = { 错位: { stdout: out(head(), [r1('.M', 'src/一.js'), r1('.M', 'src/二.js')]) } };
    const shiftGit = service([item('错位', shift, { id: 0 })], shiftTable);
    await shiftGit.refresh(true, 0);
    const cachedFiles = shiftGit.rows[0].files.map((file) => file.path).join(',');
    shiftTable.错位.stdout = out(head(), [r1('.M', 'src/二.js')]);
    resetCalls();
    const shifted = await shiftGit.prepare(0, 'fetch');
    expect(`错位那条 prepare 没成：${JSON.stringify(shifted)}`, shifted.ok === true);
    expect(`prepare 现读的那条盖回缓存了，序号会错位：${shiftGit.rows[0].files.map((file) => file.path).join(',')} vs ${cachedFiles}`,
      shiftGit.rows[0].files.map((file) => file.path).join(',') === cachedFiles);
    expect('prepare 期间缓存不作数（跑完才重读）', calls.filter((c) => isStatus(c.args)).length === 1);

    // 参数逐字 + 一次性 nonce + 确认才起
    const argvOf = { fetch: ['fetch'], pull: ['pull', '--ff-only', '--no-rebase'], commit: ['commit', '-a', '-m', '改一点'], push: ['push'] };
    for (const [op, want] of Object.entries(argvOf)) {
      const prep = await git.prepare(0, op, { message: '改一点' });
      expect(`prepare(${op}) 没成功：${JSON.stringify(prep)}`, prep.ok === true);
      expect(`prepare(${op}) 没带 nonce`, typeof prep.nonce === 'string' && prep.nonce.length >= 12);
      expect(`prepare(${op}) 的确认窗口不是 ${CONFIRM_TTL_MS / 1000} 秒：${prep.expiresMs}`, prep.expiresMs === CONFIRM_TTL_MS);
      resetCalls();
      const done = await git.confirm(prep.nonce);
      expect(`confirm(${op}) 没成：${JSON.stringify(done)}`, done.ok === true);
      const mine = writeCalls();
      expect(`${op} 起了 ${mine.length} 个进程（该恰好一个）`, mine.length === 1);
      // 这里必须用 ?.：argv 被自己门禁拦下时 mine 是空的，直接取 .args 会把整个脚本弄崩，
      // 剩下的断言一条都跑不到，红是红了但只红出一句。
      expect(`${op} 的参数不对：${JSON.stringify(mine[0]?.args)}`, JSON.stringify(mine[0]?.args) === JSON.stringify(want));
      expect(`${op} 的 cwd 不是仓库目录：${mine[0]?.cwd}`, mine[0].cwd === a);
      expect(`${op} 跑完该给一句收尾：${JSON.stringify(done.output)}`, typeof done.output === 'string');
      // 同一个 nonce 再来一次：一次确认只跑一次
      resetCalls();
      const twice = await git.confirm(prep.nonce);
      expect(`同一个 nonce 第二次还认：${JSON.stringify(twice)}`, twice.ok === false);
      expect('重复确认还是起了进程', writeCalls().length === 0);
      // 跑完一步缓存不作数
      resetCalls();
      const after = await git.refresh(false, 0);
      expect(`跑完一步还在用缓存：${after.cached}`, after.cached !== true);
    }
  }
  {
    // 连点两次 prepare：旧 nonce 被拒，但**不许**把新那条一起吃掉（这是实测出来的真故障）
    const a = makeDir('连点');
    const table = { 连点: { stdout: out(head(), [r1('.M', 'x.js')]), write: { stdout: 'ok\n' } } };
    const git = service([item('连点', a, { id: 0 })], table);
    const oldPrep = await git.prepare(0, 'pull');
    const newPrep = await git.prepare(0, 'pull');
    resetCalls();
    const stale = await git.confirm(oldPrep.nonce);
    expect(`旧 nonce 没被拒：${JSON.stringify(stale)}`, stale.ok === false && /确认码不对/.test(stale.error));
    expect('旧 nonce 被拒时还起了进程', writeCalls().length === 0);
    resetCalls();
    const fresh = await git.confirm(newPrep.nonce);
    expect(`新那条被旧 nonce 连带作废了：${JSON.stringify(fresh)}`, fresh.ok === true);
    expect('新 nonce 没起进程', writeCalls().length === 1);

    // 过期：吃掉，然后说重新点
    const exp = await git.prepare(0, 'pull');
    git.pending.expiresAt = Date.now() - 1;
    const late = await git.confirm(exp.nonce);
    expect(`过期没拒：${JSON.stringify(late)}`, late.ok === false && /过期/.test(late.error));
    expect('过期以后 pending 没吃掉（还能再确认一次）', git.pending === null);

    // 取消：错的 nonce 不许误关
    const cn = await git.prepare(0, 'pull');
    expect('拿错 nonce 取消却关了', git.cancel('deadbeefdeadbeef').canceled === false && git.pending !== null);
    expect('拿对 nonce 取消没关', git.cancel(cn.nonce).canceled === true && git.pending === null);
    expect('取消之后还能确认', (await git.confirm(cn.nonce)).ok === false);
    expect('nonce 类型不对时该被拒而不是被当成字符串比', (await git.confirm({ toString: () => cn.nonce })).ok === false);
  }
  {
    // 五种情况在闸前就拒，而且给的是「下一步该谁做」
    const mkRow = (over) => ({ id: 0, name: 'x', repo: true, detached: false, conflicted: 0, unborn: false, upstream: 'origin/main', ahead: 1, behind: 0, branch: 'main', untracked: 0, counts: { tracked: 2 }, ...over });
    expect(`游离 HEAD 没拦住提交：${gate('commit', mkRow({ detached: true }), '说明')}`, /游离 HEAD/.test(gate('commit', mkRow({ detached: true }), '说明')));
    expect('游离 HEAD 拦不住抓取（抓取本来不动工作区）', gate('fetch', mkRow({ detached: true })) === '');
    expect('游离 HEAD 该拦住推送', /游离 HEAD/.test(gate('push', mkRow({ detached: true }))));
    expect(`冲突没拦住：${gate('pull', mkRow({ conflicted: 2 }))}`, /冲突/.test(gate('pull', mkRow({ conflicted: 2 }))));
    expect('空提交说明该拒（不替他编一句）', /提交说明是空的/.test(gate('commit', mkRow({}), '')));
    expect(`超长提交说明该拒：${gate('commit', mkRow({}), 'x'.repeat(MAX_MESSAGE + 1))}`, /太长/.test(gate('commit', mkRow({}), 'x'.repeat(MAX_MESSAGE + 1))));
    expect(`只有未跟踪时该说清 add 不在这格：${gate('commit', mkRow({ counts: { tracked: 0 }, untracked: 3 }), '说明')}`, /那不在这一格做/.test(gate('commit', mkRow({ counts: { tracked: 0 }, untracked: 3 }), '说明')));
    expect('只有未跟踪时不许说成「没有改动」', !/没有可提交的改动$/.test(gate('commit', mkRow({ counts: { tracked: 0 }, untracked: 3 }), '说明')));
    expect('已跟踪也没改动时说的是没改动', /没有可提交的改动/.test(gate('commit', mkRow({ counts: { tracked: 0 }, untracked: 0 }), '说明')));
    expect(`没上游的拉取该拦住并说不替他设上游：${gate('pull', mkRow({ upstream: '' }))}`, /不会顺手替你设上游/.test(gate('pull', mkRow({ upstream: '' }))));
    expect(`没上游的推送该指路去命令行：${gate('push', mkRow({ upstream: '' }))}`, /第一次推送/.test(gate('push', mkRow({ upstream: '' }))));
    expect('领先 0 条不该推（推了也什么都不推）', /没有比远端新/.test(gate('push', mkRow({ ahead: 0 }))));
    expect('还没有一次提交时拦拉取', gate('pull', mkRow({ unborn: true })).length > 0);
    expect('抓取向来说都能做（远端为空由 prepare 那句拦）', gate('fetch', mkRow({ upstream: '' })) === '');
  }
  {
    // 确认条那几句话：数字必须分开说，未跟踪的不许混进「要提交几个」
    const row = { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 3, untracked: 5, counts: { tracked: 4 }, detached: false };
    const commit = confirmLines('commit', row, '改一点');
    expect(`提交那几句没说要带走几个：${JSON.stringify(commit)}`, commit.some((line) => line.includes('4')));
    expect(`提交那几句没写未跟踪的 5 个不带：${JSON.stringify(commit)}`, commit.some((line => /未跟踪的 5 个不会被带上/.test(line))));
    expect('提交那几句要带上说明本身（点之前得看到自己写的话）', commit.some((line) => line.includes('改一点')));
    const pull = confirmLines('pull', row, '');
    expect(`拉取没承诺只做快进：${JSON.stringify(pull)}`, pull.some((line) => /快进/.test(line)));
    expect('拉取要提醒本地有没提交的改动', pull.some((line) => /4 处没提交/.test(line)));
    const push = confirmLines('push', row, '');
    expect(`推送没说别人看得见：${JSON.stringify(push)}`, push.some((line) => /看得见/.test(line)));
    expect('推送要说清推几条到哪儿', push.some((line) => line.includes('2') && line.includes('origin/main')));
    expect('远端还多的时候要提醒先拉取', push.some((line) => /先拉取|多半要先/.test(line)));
    const fetch = confirmLines('fetch', { ...row, upstream: '' }, '');
    expect('抓取没上游时那句要能读（不许写 undefined）', !/undefined/.test(fetch.join(' ')));
    expect('抓取要说不动工作区', fetch.some((line) => /不动你的文件/.test(line)));
  }
  {
    // BANNED_ARGS 是「将来有人加第五步」的门禁，不是防 git
    expect(`--force 不在拦的名单里：${BANNED_ARGS.join(',')}`, BANNED_ARGS.includes('--force') && BANNED_ARGS.includes('--amend') && BANNED_ARGS.includes('--no-verify'));
    for (const word of ['reset', 'clean', 'checkout', 'switch', 'stash', 'merge', 'rebase', 'rm', 'mv']) {
      expect(`${word} 没在拦的名单里`, BANNED_ARGS.includes(word));
    }
    for (const [op, plan] of Object.entries(OPS)) {
      expect(`${op} 拼出来的参数被自己的门禁拦了：${plan.argv(plan.message ? { message: 'x' } : {}).join(' ')}`, assertSafeArgs(plan.argv({ message: 'x' })).length === 0);
    }
    expect('把 --force 拼进 push 没被拦', assertSafeArgs(['push', '--force']).length > 0);
    // 提交说明原样进 argv：里面有 "reset" 这个词不算参数，误判就没法提交「重置样式」这种话
    expect('提交说明里的词被当成参数拦了（-m 后面那一段该跳过）：', assertSafeArgs(['commit', '-a', '-m', 'reset 一下样式，clean up']).length === 0);
    expect('整条说明正好是一个被拦的词（「rebase」）时被当成参数拦了', assertSafeArgs(['commit', '-a', '-m', 'rebase']).length === 0);
    expect('提交说明里 --force 这种字样也误判了', assertSafeArgs(['commit', '-m', '不要 --force']).length === 0);
  }
  {
    // 写侧失败的翻译：文案用**本机实测**的 git 原话，不许出现「快进不上」那种自己编的措辞
    const cases = [
      ['fatal: Not possible to fast-forward, aborting.\nhint: Diverging branches can\'t be fast-forwarded\n', /各走了各的|对不齐/],
      [' ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to \'/tmp/x\'\n', /先拉取再推/],
      ['error: Pulling is not possible because you have unmerged files.\n', /冲突没处理/],
      ['CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed\n', /冲突没处理/],
      ['error: Your local changes to the following files would be overwritten by merge:\n\tsrc/x.js\n', /不肯覆盖/],
      ['nothing to commit, working tree clean\n', /没有可提交的改动/],
      ['There is no tracking information for the current branch.\n', /没有上游分支/],
      ['fatal: could not read Username for https://github.com: terminal prompts disabled\n', /密码不经我的手/],
      ["fatal: '/tmp/nope' does not appear to be a git repository\n", /连不上远端/],
      ['fatal: unable to access https://x.invalid/: Could not resolve host\n', /连不上远端/],
      ['fatal: pre-commit hook declined\n', /钩子/]
    ];
    for (const [stderr, re] of cases) {
      const text = writeError({ stderr, code: 1 }, 60000);
      expect(`写侧失败没翻成人话（${stderr.slice(0, 24)}）：${text}`, re.test(text));
      expect(`写侧失败文案里说了这一格会做的事（合并/reset）：${text}`, !/我不会?替?你?(做|跑)?(merge|reset)/i.test(text));
    }
    const leaky = writeError({ stderr: `fatal: bad thing at D:\\Secret\\Path\\x.txt`, code: 128 }, 60000);
    expect(`写侧兜底文案漏了盘符路径：${leaky}`, !/[A-Za-z]:[\\/]/.test(leaky) && /路径/.test(leaky));
    expect('写侧兜底该带上退出码', /128/.test(writeError({ stderr: '', code: 128 }, 60000)));
    expect(`写侧超时该说这一步可能还在跑：${writeError({ timeout: true }, 120000)}`, /还在跑/.test(writeError({ timeout: true }, 120000)));
    expect(`超时文案里的秒数不是这一步的：${writeError({ timeout: true }, 120000)}`, /120 秒/.test(writeError({ timeout: true }, 120000)));
    expect(`收尾那几行没留下：${tailOutput('[main 1a2b3c4] 改一点\n\n 3 files changed, 4 insertions(+), 1 deletion(-)\n')}`, /3 files changed/.test(tailOutput('[main 1a2b3c4] 改一点\n\n 3 files changed, 4 insertions(+), 1 deletion(-)\n')));
    expect('tailOutput 只取最后三行', tailOutput(Array.from({ length: 9 }, (u, i) => `第${i}行`).join('\n')).startsWith('第6行'));
    expect(`tailOutput 漏路径：${tailOutput('D:\\Secret\\a.txt')}`, !/[A-Za-z]:[\\/]/.test(tailOutput('D:\\Secret\\a.txt')));
  }

  // ================================================================= 4. 只认 id / 序号，路径不出主进程
  {
    const a = makeDir('寻址');
    fs.mkdirSync(path.join(a, 'src'), { recursive: true });
    fs.writeFileSync(path.join(a, 'src', 'a.js'), 'x', 'utf8');
    const rows = [item('寻址', a, { id: 3 })];
    const git = service(rows, { 寻址: { stdout: out(head(), [r1('.M', 'src/a.js'), r1('.M', '../outside.js'), r1('.M', 'C:\\Windows\\system.ini')]) } });
    const res = await git.refresh(true, 3);
    expect(`id 不是整数该拿不到行：${JSON.stringify(git.pick('3x'))}`, git.pick('not-a-number') === null);
    expect('id 用字符串 "3" 应该认（IPC 不保证类型）', git.pick('3') !== null);
    expect('字符串 id 的序号也要认（IPC 不保证类型）', git.fileAt('3', 0).ok === true);
    expect(`没在看的仓库寻不到行（这格只留 focus 那一条，不是整批）：${JSON.stringify(git.pick(4))}`, git.pick(4) === null);
    expect(`越界序号该拒：${JSON.stringify(git.fileAt(3, 99))}`, git.fileAt(3, 99).ok === false);
    expect(`负序号该拒：${JSON.stringify(git.fileAt(3, -1))}`, git.fileAt(3, -1).ok === false);
    expect(`过期 id 该说列表过期：${JSON.stringify(git.fileAt(999, 0))}`, /列表已过期/.test(git.fileAt(999, 0).error));

    const hit = git.fileTarget(3, 0);
    expect(`正常的相对路径没拼出绝对路径：${JSON.stringify(hit)}`, hit.ok === true && hit.path === path.join(a, 'src', 'a.js'));
    expect('fileTarget 该带上项目行的 id（找回 IDE 用）', hit.projectId === 3);
    expect(`逃出去的路径没拦住：${JSON.stringify(git.fileTarget(3, 1))}`, git.fileTarget(3, 1).ok === false && /不在仓库里面/.test(git.fileTarget(3, 1).error));
    expect(`绝对路径没拦住：${JSON.stringify(git.fileTarget(3, 2))}`, git.fileTarget(3, 2).ok === false);
    expect(`fileTarget 的错误形状不是 {ok:false,error}：${JSON.stringify(git.fileTarget(3, 2))}`, Object.keys(git.fileTarget(3, 2)).sort().join(',') === 'error,ok');
    expect(`insideRepo 把大小写不同的盘符当外面：${insideRepo('d:\\x\\', 'A.js')}`, insideRepo(path.join(tmp, '寻址'), 'src/a.js') === path.join(a, 'src', 'a.js'));
    expect('insideRepo 该拦相对路径', insideRepo(a, '') === null && insideRepo(a, null) === null);
    expect(`insideRepo 不许把同前缀的兄弟目录算进来：${insideRepo(a, '../寻址2/x.js')}`, insideRepo(a, '../寻址2/x.js') === null);
  }
  {
    // projects 那一侧：openFile 落 spawn 前再核一遍，路径不回渲染层
    const a = makeDir('打开');
    fs.mkdirSync(path.join(a, 'src'), { recursive: true });
    fs.writeFileSync(path.join(a, 'src', 'b.js'), 'x', 'utf8');
    const spawned = [];
    const projects = new Projects({
      roots: [tmp],
      ideRoots: [],
      spawn: (exe, args) => {
        spawned.push({ exe, args });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.unref = () => {};
        setTimeout(() => child.emit('spawn'), 1);
        return child;
      }
    });
    projects.scan(true);
    const hit = projects.items.find((one) => one.name === '打开');
    expect('假想的项目目录没被扫出来（这一条前提是后面的断言都成立）', Boolean(hit));
    const ok = await projects.openFile(hit.id, path.join(a, 'src', 'b.js'));
    expect(`openFile 没成：${JSON.stringify(ok)}`, ok.ok === true);
    expect('openFile 的成功返回里不许有绝对路径', !/[A-Za-z]:[\\/]/.test(JSON.stringify(ok)));
    expect(`openFile 该把文件交给判出来的 IDE：${JSON.stringify(spawned[spawned.length - 1])}`, spawned.length === 1 && spawned[0].args[0] === path.join(a, 'src', 'b.js'));
    expect(`越界的路径没拦住：${JSON.stringify(await projects.openFile(hit.id, 'D:\\Windows\\system.ini'))}`, /不在项目目录里面/.test((await projects.openFile(hit.id, 'D:\\Windows\\system.ini')).error));
    expect(`相对路径没拦住：${JSON.stringify(await projects.openFile(hit.id, 'src/b.js'))}`, /不在项目目录里面/.test((await projects.openFile(hit.id, 'src/b.js')).error));
    expect('兄弟目录同前缀要拦住', insideDir(a, path.join(tmp, '打开2', 'x.js')) === null);
    expect(`文件没了那句该带文件名：${JSON.stringify(await projects.openFile(hit.id, path.join(a, 'src', '没了.js')))}`, /已经不在了/.test((await projects.openFile(hit.id, path.join(a, 'src', '没了.js'))).error));
    const before = spawned.length;
    expect(`假 id 该拒：${JSON.stringify(await projects.openFile(424242, path.join(a, 'src', 'b.js')))}`, /列表已过期/.test((await projects.openFile(424242, path.join(a, 'src', 'b.js'))).error));
    expect('假 id 那次也起了进程', spawned.length === before);
  }

  // ================================================================= 5. 两格是同一批行，左边点一下右边跟着换（「第二个视图」的全部含义）
  {
    const root = makeDir('两格根');
    const repo = path.join(root, '真项目');
    const plain = path.join(root, '空文件夹');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), '{}', 'utf8');
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(path.join(plain, 'main.py'), 'x', 'utf8');

    const projects = new Projects({ roots: [root], ideRoots: [] });
    const scanned = projects.scan(true);
    const git = new Git({
      getProjects: () => projects,
      spawn: makeSpawn({ 真项目: { stdout: out(head('e'.repeat(40), 'main', '', '+0 -0'), [r1('.M', 'src/a.js')]) }, 空文件夹: {} })
    });
    const repoItem = scanned.items.find((one) => one.name === '真项目');
    const plainItem = scanned.items.find((one) => one.name === '空文件夹');
    expect(`项目格没把这两个文件夹都扫出来（${scanned.items.map((i) => i.name).join(',')}），后面的断言前提没了`, Boolean(repoItem && plainItem));

    // 左边那一行的 id 就是这一格要找的仓库：两格对同一个项目的称呼一致，不用再映射一遍
    resetCalls();
    const res = await git.refresh(true, repoItem.id);
    expect(`左边点的 id 没对上这批行：${JSON.stringify(res.focus)} vs ${repoItem.id}`, res.focus && res.focus.id === repoItem.id && res.rows[0].id === repoItem.id);
    expect(`git 行的名字和项目行不一样：${res.rows[0].name} vs ${repoItem.name}`, res.rows[0].name === repoItem.name);
    expect(`root 那一句要从项目行带过来：${res.rows[0].root} / ${res.focus.root}`, res.rows[0].root === root && res.focus.root === root);
    expect('项目格还没扫过时 git 格也能拿到行（这条走的是 scan(false)）', git.projectRows().length === scanned.items.length);
    expect('两格共用 roots：git 服务不该自己读配置', !/repos|config/i.test(fs.readFileSync(path.join(APP_ROOT, 'src', 'main', 'services', 'git.js'), 'utf8').split('class Git')[1] || ''));

    // 换点另一个项目 = 右边整块跟着换。非仓库连 `git --version` 都不问：它是不是仓库，项目行早就说清了
    resetCalls();
    const switched = await git.refresh(true, plainItem.id);
    expect(`切到非仓库那条 focus 没跟着换：${JSON.stringify(switched.focus)}`, switched.focus.id === plainItem.id && switched.focus.repo === false);
    expect(`非仓库那行该是 repo:false 而不是报错：${JSON.stringify(switched.rows[0])}`, switched.rows.length === 1 && switched.rows[0].repo === false && switched.rows[0].error === '');
    expect(`非仓库起了 ${calls.length} 个进程（一个都不该有，包括版本探测）：${calls.map((c) => c.args.join(' ')).join(' | ')}`, calls.length === 0);
    resetCalls();
    await git.refresh(true, repoItem.id);
    const dirs = calls.filter((c) => isStatus(c.args)).map((c) => path.basename(c.cwd));
    expect(`切回仓库那次扫了不止那一个目录：${dirs.join(',')}`, dirs.length === 1 && dirs[0] === '真项目');

    // 点了改动文件：找回的是项目格判出来的那个 IDE
    const target = git.fileTarget(repoItem.id, 0);
    expect(`fileTarget 拿不到项目 id：${JSON.stringify(target)}`, target.projectId === repoItem.id);
    expect(`项目格那边查回的 IDE 是判出来的那个：${git.projectItem(repoItem.id).ide}`, git.projectItem(repoItem.id).ide === 'webstorm');
    expect('项目行里的目录和 git 行拼路径用的目录得是同一个', git.projectItem(repoItem.id).path === repo);
    // 没在看的仓库（这里是刚切走的那条）寻不到文件：这一格只留 focus 那一条行，不替别的仓库演数字
    expect(`切走以后那条非仓库还能寻到文件：${JSON.stringify(git.fileAt(plainItem.id, 0))}`, /列表已过期/.test(git.fileAt(plainItem.id, 0).error));
  }

  // ================================================================= 6. 跨文件契约：落位、preload、handler、组件纪律
  {
    const onDisk = layoutStore.load(APP_ROOT);
    const moduleAt = (layout, pageId, at) => layout.pages.find((page) => page.id === pageId)?.slots.find((slot) => slot.at === at)?.module;
    for (const [where, layout] of Object.entries({ 'layout.json': onDisk, DEFAULT_PAGES: layoutStore.DEFAULT_LAYOUT })) {
      expect(`${where}：工作面板 gitzone 格挂的是 "${moduleAt(layout, 'work', 'gitzone')}"，应为 "git"`, moduleAt(layout, 'work', 'gitzone') === 'git');
      expect(`${where}：工作面板 projzone 格挂的是 "${moduleAt(layout, 'work', 'projzone')}"，应为 "projects"`, moduleAt(layout, 'work', 'projzone') === 'projects');
      for (const at of ['gauges', 'workbench', 'slot2']) {
        expect(`${where}：工作面板「${at}」被顺手改成了 "${moduleAt(layout, 'work', at)}"`, moduleAt(layout, 'work', at) === 'placeholder');
      }
      // 合出来的两块是同一格的两半：谁再顺手加回 slot1 / player，这两条先红
      for (const at of ['slot1', 'player', 'clock']) {
        expect(`${where}：工作面板多出了「${at}」这一格（左列和中间已经各合成一整块了）`, moduleAt(layout, 'work', at) === undefined);
      }
      expect(`${where}：主界面的时钟被换掉了：${moduleAt(layout, 'home', 'clock')}`, moduleAt(layout, 'home', 'clock') === 'clock');
      expect(`${where}：生活面板的邮箱被换掉了：${moduleAt(layout, 'life', 'leftzone')}`, moduleAt(layout, 'life', 'leftzone') === 'mail');
      expect(`${where}：游戏面板的游戏列表被换掉了：${moduleAt(layout, 'game', 'gamezone')}`, moduleAt(layout, 'game', 'gamezone') === 'games');
      expect(`${where}：工作面板没绑虚拟桌面 2`, layout.pages.find((page) => page.id === 'work')?.desktop === 2);
      expect(`${where}：改完过不了校验：${layoutStore.validate(layout).join(' / ')}`, layoutStore.validate(layout).length === 0);
    }
    expect('两份落位说得不一样（工作面板那一页）', JSON.stringify(onDisk.pages.find((p) => p.id === 'work')) === JSON.stringify(layoutStore.DEFAULT_LAYOUT.pages.find((p) => p.id === 'work')));
  }
  {
    const mainSrc = fs.readFileSync(path.join(APP_ROOT, 'src', 'main', 'main.js'), 'utf8');
    const preloadSrc = fs.readFileSync(path.join(APP_ROOT, 'src', 'preload', 'preload.js'), 'utf8');
    const compSrc = fs.readFileSync(path.join(APP_ROOT, 'src', 'renderer', 'js', 'components', 'git.js'), 'utf8');
    const configSrc = fs.readFileSync(path.join(APP_ROOT, 'src', 'main', 'config.js'), 'utf8');

    for (const channel of ['git:status', 'git:prepare', 'git:confirm', 'git:cancel', 'git:openFile']) {
      expect(`main.js 里没有 handler：${channel}`, mainSrc.includes(`ipcMain.handle('${channel}'`));
      expect(`preload 里没有通道：${channel}`, preloadSrc.includes(`'${channel}'`));
    }
    expect('main.js 没把 projects 交给 git（第二个视图得吃同一批行）', /new Git\(\{[^}]*getProjects: \(\) => projects/.test(mainSrc));
    // 看哪个仓库由左边那一下点决定，所以 id 必须一路带到 refresh：漏了参数这一格就永远停在「先选项目」
    expect(`git:status 的 handler 没把 id 递给 refresh：${(mainSrc.match(/ipcMain\.handle\('git:status'[^\n]*/) || ['(没找到)'])[0]}`,
      /ipcMain\.handle\('git:status', \(_event, force, id\) => git\.refresh\(Boolean\(force\), id\)\)/.test(mainSrc));
    expect('git:openFile 没走项目格那条 openFile（IDE 该由项目格判）', /projects\.openFile\(/.test(mainSrc));
    expect('git:openFile 把绝对路径回给了渲染层', !/return[^;]*hit\.path/.test(mainSrc.replace(/await projects\.openFile\(hit\.projectId, hit\.path\)/g, 'OPENCALL')));

    // 渲染层的纪律：只递 id / 序号 / 一句话，别想递路径或参数
    expect(`组件里出现了盘符路径`, !/[A-Za-z]:\\\\/.test(compSrc));
    expect('组件直接调了 confirm 以外的路（confirm 必须只拿 nonce）', /TB\.api\.git\.confirm\((?:this\.ask|ask)\.nonce\)/.test(compSrc));
    expect('组件的 confirm 多递了参数（那样就能在确认那一步改掉要跑的命令）', !/TB\.api\.git\.confirm\([^)]*,/.test(compSrc));
    expect('组件的 openFile 递的不是序号', /TB\.api\.git\.openFile\((?:row|this)?\.?id?,?\s*(?:index|n)\)/.test(compSrc) || /TB\.api\.git\.openFile\(id, index\)/.test(compSrc));
    expect('组件的 prepare 递了路径（只能有 id、op 和说明）', !/TB\.api\.git\.prepare\([^)]*path/.test(compSrc));
    expect('组件里有 fetch( 直接问远端（该走主进程）', !/fetch\(/.test(compSrc));
    expect('组件没有注册（TB.register id:git）', /id: 'git'/.test(compSrc));
    // renderList 里不许 stopAsk：prepareOp 设完 this.ask 紧接着就 renderList，清了确认条永远出不来。
    // 函数体靠花括号配对取——原先是 `[^}]*` 那种正则，renderList 里一旦有了 if 块就漏判（改版时踩过）。
    const bodyOf = (name) => {
      const at = compSrc.indexOf(`  ${name}() {`);
      if (at < 0) return null;
      let depth = 0;
      for (let i = compSrc.indexOf('{', at); i < compSrc.length; i += 1) {
        if (compSrc[i] === '{') depth += 1;
        else if (compSrc[i] === '}') {
          depth -= 1;
          if (depth === 0) return compSrc.slice(at, i);
        }
      }
      return null;
    };
    const renderBody = bodyOf('renderList');
    expect('组件里找不到 renderList（改版时这条契约要跟着挪）', renderBody !== null);
    expect('确认条挂出来时 renderList 会把它清掉（stopAsk 不该在 renderList 里）', !renderBody?.includes('this.stopAsk()'));
    const cancelBody = bodyOf('cancelAsk');
    expect('组件里找不到 cancelAsk', cancelBody !== null);
    expect('点了「取消」不重渲染：确认条那 5 秒是把列表整段换掉的，不渲染回来就停在一条没人认领的确认条上（真机探针量出来过）',
      Boolean(cancelBody?.includes('this.renderList()')));

    // ---------- 两格联动：选中态只有一份，存在 app.state 上，两格都跟着它换 ----------
    const appSrc = fs.readFileSync(path.join(APP_ROOT, 'src', 'renderer', 'js', 'app.js'), 'utf8');
    const projSrc = fs.readFileSync(path.join(APP_ROOT, 'src', 'renderer', 'js', 'components', 'projects.js'), 'utf8');
    // 带参数的函数体也靠花括号配对取（`[^}]*` 那种正则一进 if 块就漏判）
    const braceBody = (src, opener) => {
      const at = src.indexOf(opener);
      if (at < 0) return null;
      let depth = 0;
      for (let i = src.indexOf('{', at); i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
          depth -= 1;
          if (depth === 0) return src.slice(at, i);
        }
      }
      return null;
    };

    expect('app.js 没有 selectProject（选中态得有一个唯一的地方放，不能各存一份）', /  selectProject\(item\) \{/.test(appSrc));
    const selBody = braceBody(appSrc, '  selectProject(item) {');
    expect('找不到 selectProject 的函数体', selBody !== null);
    expect(`selectProject 只刷新一格（两格得同时跟着换）：${selBody}`, /refresh\('projects'\)/.test(selBody) && /refresh\('git'\)/.test(selBody));
    expect('selectProject 少了「同一条重复点不重刷」：双击之前那一下左键会多点出一批 git 进程', /return false/.test(selBody));

    // git 格：数据只跟着选中项走，没选中时连 IPC 都不发
    expect('git 组件没从 TB.app.state.project 读选中项（那一份是两格共用的，不该自己记）', /TB\.app\.state\.project/.test(compSrc));
    expect(`git 组件的 status 没把选中项的 id 递出去：${(compSrc.match(/TB\.api\.git\.status\([^\n]*/) || ['(没找到)'])[0]}`,
      /TB\.api\.git\.status\(force, sel\.id\)/.test(compSrc));
    const loadBody = braceBody(compSrc, '  async load(force) {');
    expect('找不到 git 组件 load 的函数体', loadBody !== null);
    const guardAt = loadBody.indexOf('if (!sel)');
    expect('git 组件 load 里找不到「没选中就返回」那条守卫（默认态那句提示变成了一次真读取）', guardAt >= 0);
    expect('没选中也发了 git:status —— 「只留一句话」那条要求就是这么没的', guardAt < loadBody.indexOf('TB.api.git.status'));
    expect('need=stale 时组件不自己清选中、不重扫项目格（停在上一批行上是假数据，比空着更糟）',
      /need === 'stale'/.test(loadBody) && /selectProject\(null\)/.test(loadBody) && /TB\.projects\.load\(true\)/.test(loadBody));
    const listBody = braceBody(compSrc, '  renderList() {');
    expect('三态少了「还没选中」那一句（.gt-prompt）', /gt-prompt/.test(listBody || ''));
    expect('三态少了非仓库那张卡（infoCard）', /this\.infoCard\(\)/.test(listBody || ''));
    expect('三态少了仓库那一块（repoBlock）', /this\.repoBlock\(/.test(listBody || ''));
    expect('非仓库那张卡少了 roots 那一栏（他要的「配置信息」= 项目信息卡 + 仓库根目录清单）',
      /this\.rootsList\(\)/.test(compSrc) && /TB\.projects\?\.data\?\.roots/.test(compSrc));
    // 卡上的路径只抄项目格那行：git 的 payload 里除了 root 根本没有绝对路径，要从那儿取就是得给 payload 加字段
    expect('非仓库卡从 git 的返回里取路径（那份 payload 不该为一张卡多带一个字段）',
      !/(this\.data|res|status)\.rows[^\n]*\.path/.test(compSrc));

    // 项目格：左键选中、双击才交给 IDE，Ctrl+左键还是打开文件夹
    const projRowBody = braceBody(projSrc, '  row(item) {');
    expect('找不到项目格 row 的函数体（改版时这条联动契约要跟着挪）', projRowBody !== null);
    expect('项目格左键没走 selectProject（中间那一格就不跟着换仓库了）',
      /TB\.app\.selectProject\(item\)/.test((projRowBody || '').split('onclick:')[1]?.split('ondblclick:')[0] || ''));
    expect('项目格左键还在直接 launch（双击才是启动那条；左键一点就开 IDE 窗口，选中态永远看不清）',
      !/this\.launch\(/.test((projRowBody || '').split('onclick:')[1]?.split('ondblclick:')[0] || ''));
    expect('项目格没有双击交给 IDE 那条（左键改成选中以后，启动只剩双击这一个入口）',
      /ondblclick:/.test(projRowBody || '') && /this\.launch\(item\)/.test((projRowBody || '').split('ondblclick:')[1] || ''));
    expect('项目格 Ctrl+左键打开文件夹这条被顺手删了', /this\.reveal\(/.test(projRowBody || ''));
    expect('项目格没给选中行留标记类（sel 是这一行的唯一视觉反馈）', /'data-id'/.test(projSrc) && /classList\.toggle\('sel'/.test(projSrc));

    // 这一格没有任何配置项：roots 走项目格，凭据走系统助手。将来真加了一段，DEFAULTS 和白名单必须同时改
    const hasGitSection = /git:/.test(configSrc.split('const DEFAULTS')[1] || '');
    const inWhitelist = /git:/.test((configSrc.split('ordered')[1] || '').split('};')[0]);
    expect(`config 里有 git 段但 save() 白名单没有（一保存就整段消失）：has=${hasGitSection} white=${inWhitelist}`, hasGitSection === inWhitelist);
  }
  {
    // 假 electron 之下把 preload 真 require 进来，逐条打到 handler 名并带上参数
    const realLoad = Module._load;
    const invoked = [];
    const listen = {};
    const fakeElectron = {
      ipcRenderer: {
        invoke: (channel, ...args) => {
          invoked.push({ channel, args });
          return Promise.resolve({ channel });
        },
        on: (channel, fn) => {
          listen[channel] = fn;
        }
      },
      contextBridge: { exposeInMainWorld: (key, api) => { fakeElectron.exposed = { key, api }; } }
    };
    Module._load = function patched(request, parent, isMain) {
      if (request === 'electron') return fakeElectron;
      return realLoad.call(this, request, parent, isMain);
    };
    try {
      delete require.cache[require.resolve('../src/preload/preload.js')];
      require('../src/preload/preload.js');
    } finally {
      Module._load = realLoad;
    }
    const api = fakeElectron.exposed?.api;
    expect(`preload 没暴露 git 那一段：${Object.keys(api || {}).join(',')}`, Boolean(api?.git));
    const want = { status: [true, 2], prepare: [2, 'commit', { message: 'x' }], confirm: ['abc'], cancel: ['abc'], openFile: [2, 5] };
    for (const [method, args] of Object.entries(want)) {
      invoked.length = 0;
      await api.git[method](...args);
      expect(`git.${method} 打到的 channel 不对：${invoked[0]?.channel}`, invoked[0]?.channel === `git:${method}`);
      expect(`git.${method} 的参数没原样递过去：${JSON.stringify(invoked[0]?.args)}`, JSON.stringify(invoked[0].args) === JSON.stringify(args));
    }
    expect(`git 那一段开的门不止五样：${Object.keys(api.git).join(',')}`,
      Object.keys(api.git).length === 5 && ['status', 'prepare', 'confirm', 'cancel', 'openFile'].every((one) => typeof api.git[one] === 'function'));
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  consoleLines.push(`解析 ${'1/2/u/?' } 四种记录、段数与路径切法、改名 from、中文+空格、被截断、计数与档位`);
  consoleLines.push('焦点（没选中 / id 对不上时一个进程都不起、一次只扫那一个、切项目缓存不作数）');
  if (failures.length) {
    console.log(`\n✗ git 自检红了 ${failures.length} 条：`);
    for (const one of failures) console.log(`  - ${one}`);
    process.exitCode = 1;
  } else {
    console.log(`\n✓ git 自检全绿。钉住的是：${consoleLines.join('；')}。`);
    console.log('  读侧：porcelain v2 四种记录的段数（1=9 / 2=10+紧跟的 from / u=11 / ?=2）、带空格与中文的路径、');
    console.log('    改名不多吐一条、被 4MB 截断要标 truncated、');
    console.log('    焦点：refresh 的第二个参数决定看哪个仓库——没给 / 给了对不上时 need=select|stale 且一个进程都不起（null 和空串也不许当成 id 0）、');
    console.log('    一次只回一行且就是 focus 那条、非仓库连 `git --version` 都不问（发了会把父仓库的改动记到它头上）、');
    console.log('    缓存只有一个槽（换项目就重读，切回也重读）、同一行并发只起一批、20 秒 TTL 与 force、');
    console.log('    到点自己 resolve（假 spawn 永不回话也必须出结果，否则 this.running 永远挂着）、');
    console.log('    没 git 整格一句 vs git 起不来那一行一句、除 root 以外 payload 里没有盘符路径也没有 git.exe，键集合就是契约那七个（项目目录只留在主进程按 id 查）。');
    console.log('  写侧：只有四样（第五个名字当场拒）、argv 逐字、BANNED_ARGS 门禁且 -m 后面那一段不误判、');
    console.log('    prepare 一个写进程都不起、confirm 恰好一个、同一 nonce 第二次不认、');
    console.log('    旧 nonce 被拒时不许把新的那条一起吃掉、5 秒过期就吃掉、取消只认对的那条 nonce、');
    console.log('    七种情况在闸前拒（游离/冲突/说明空或超长/只有未跟踪/没上游/领先0/尚无提交）、');
    console.log('    确认条四句话分开说已跟踪与未跟踪、失败翻译用实测原话且不漏盘符。');
    console.log('  契约：id 与项目格同一批、点文件找回的是项目格判的 IDE、路径落 spawn 前 projects 再核一遍、');
    console.log('    两份落位都是 work/projzone=projects + work/gitzone=git 且 slot1|player|clock 再没回来、preload 五条通道 + main 五个 handler、');
    console.log('    status 那条把选中 id 一路带到 refresh、组件没选中不发 IPC、need=stale 自己清选中并重扫项目格、');
    console.log('    三态齐（.gt-prompt / repoBlock / infoCard+rootsList）、卡上路径只抄 TB.app.state.project、');
    console.log('    项目格左键选中 + 双击启动 + Ctrl 打开文件夹、组件只递 id/序号/说明、config 里若要加 git 段则 DEFAULTS 与白名单必须同时有。');
  }
})().catch((err) => {
  console.error('✗ git 自检脚本自己崩了：', err);
  process.exitCode = 1;
});

// ---------- 变异清单（跑绿以后照这里逐条改坏真实文件，每条都必须出 ✗）----------
// 判「红」看两件事：出 ✗，或者压根没打印「全绿」——第 5 条那种改法不会报错，它让那条 Promise 永不 settle，
// Node 事件循环空了就静默退出（exit 0，什么都没打印）。
//  1. parsePorcelain：'u' 的 columns(record, 11) 改成 10                → 冲突路径变成一串 hash
//  2. parsePorcelain：'2' 的 from 改成「按 /^1 / 前缀猜」                → 多吐一条假改动、from 丢
//  3. parsePorcelain：路径列 cols[8] 改成 cols[7]                        → 带空格的路径被切
//  4. runGit：Buffer.concat 改成按 chunk toString 拼接                    → 中文路径跨块成乱码
//  5. runGit：超时那句 finish({ok:false,timeout:true}) 删掉               → 永不 settle，脚本静默退出不打印全绿
//  6. scan()：去掉 !item.git 那条提前返回                                → 非仓库也发进程（会把父仓库算进来）
//  7. refresh()：`focusId === null || … || focusId === '' ? NaN : Number(focusId)` 改回 Number(focusId)
//                → null / 空串被当成 id 0，「没选中一个进程都不起」变成「默认态扫第一个仓库」
//  8. refresh()：`if (!Number.isInteger(id) || id < 0) return this.idle('select', null)` 删掉
//                → 没给 id 时往下崩（find 不到 item），或假装在看某个仓库
//  9. refresh()：`if (!item) return this.idle('stale', id)` 改成 idle('select', null)
//                → 项目格换批后渲染层不知道该重扫，停在「点左边项目」那句上
// 10. idle()：`this.rows = []` 删掉                                       → 换项目时把上一个仓库的数字演下去
// 11. scan()：`this.rows = [await this.one(...)]` 改成对 projectRows() 全批 one()
//                → 一次点一个项目却把六个仓库全扫了（focus 模型的核心那条）
// 12. payload()：focus 里多回一个 `path: item.path`                       → 盘符过 IPC，键集合那条一起红
// 13. countFiles：tracked 改回 staged + unstaged                          → `MM` 数两遍，确认条把 3 个说成 4 个
// 14. OPS：pull 去掉 --ff-only                                           → argv 逐字 + 「不自动合并」那句话
// 15. OPS：commit 的 '-a' 改成 '--all'                                   → 被自己的 BANNED_ARGS 门禁拦下
// 16. OPS：push 加上 '-u'                                                → 同上，门禁那条红
// 17. assertSafeArgs：去掉跳过 -m 后面那段                                → 整条说明正好是「rebase」时被当参数拒了
// 18. gate：删掉「只有未跟踪」那条                                        → commit -a 静默什么都不提交
// 19. gate：push 的 ahead===0 删掉                                       → 白起一次进程
// 20. confirm：把 `this.pending = null` 挪回比对 nonce 之前              → 旧 nonce 把新那条吃掉
// 21. confirm：不做一次性（确认完不清 pending）                           → 同一 nonce 能跑两次
// 22. prepare：把 nonce 改成固定串                                        → 第二次 prepare 还能用第一次的
// 23. prepare：把现读的 row 塞回 this.rows                                → 清单缩短后点 A 文件开成 B 文件
// 24. scan()：`!exe && this.notFound` 改成 `!exe && !this.spawn`          → 「没 git」那句话在自检里永远测不到
// 25. spawnGone：删掉 ENOENT 那条，直接走 explainSpawnError               → 说的是「点重扫」，按钮名不对
// 26. WRITE_FAILS：'unmerged files' 改成 'unmerged filz'                 → 落到兜底那句英文原文
// 27. insideRepo：+ path.sep 去掉                                         → 兄弟目录同前缀被放行
// 28. projects.openFile：去掉 insideDir 那道复核                          → 落 spawn 前没人再拦
// 29. layout.json：work/gitzone 改回 placeholder                          → 两份落位不一致 + gitzone 那条红
// 30. layout.js：WORK_GRID 两行的 gitzone 改回 slot1                       → DEFAULT 那份的 gitzone + validate 两条红
//     （改 layout.json 加 slot1 是咬不到的，而且是**对的**：load() 见 validate 不过整份退回 DEFAULT，
//       那份文件根本没被读进来。要在磁盘文件上咬，只能咬「形状仍合法但内容错了」的那类，就是第 29 条。）
// 31. main.js：git:status 的 handler 少接一个参数（`(_event, force) => git.refresh(Boolean(force))`）
//                → 这一格从此永远 need=select，一个进程都不起
// 32. preload：git:confirm 改成 git:confirm:run                           → channel 对不上
// 33. preload：status 那条改成 `invoke('git:status', force)`               → 选中 id 过不去（参数原样那条红）
// 34. main.js：git:openFile 把 hit.path 也回给渲染层                       → 绝对路径过了 IPC
// 35. 组件：把 confirm 调用改成 (ask.nonce, ask.id)                        → 递参数进确认那一步
// 36. 组件：renderList 开头加回 this.stopAsk()                             → 确认条永远出不来
// 37. 组件：cancelAsk 里去掉 this.renderList()                             → 点了「取消」确认条还挂着（真机踩过）
// 38. 组件：load 里把 `if (!sel)` 那条守卫挪到 TB.api.git.status 之后      → 没选中也发 IPC（顺序断言红）
// 39. 组件：status 调用少递 sel.id（`TB.api.git.status(force)`）            → 这一格永远停在「先选项目」
// 40. 组件：need==='stale' 那支去掉 selectProject(null) / TB.projects.load(true) → 停在假数据上
// 41. 组件：renderList 里去掉 this.infoCard() 那一支                        → 非仓库变成空列表
// 42. 组件：infoCard 的 roots 那一栏改成写死一句「去设置里看」                → rootsList / TB.projects.data.roots 红
// 43. app.js：selectProject 里只留 refresh('projects')                      → 右边那一格不跟着换
// 44. 项目格组件：row 的 onclick 改回 this.launch(item)                     → 左键启动那条 + 选中契约红
// 45. 项目格组件：去掉 ondblclick                                           → 双击交给 IDE 没了入口
//
// 按设计不红的（别当成 bug）：
//  · 组件里把 opTitle / tooltip 的说明文字改掉——那些话只是悬浮提示，没有任何断言钉它。
//  · 组件 summary() 里那几个词的顺序、以及「非仓库」到底说成「非仓库」还是「不是仓库」——没有断言钉措辞。
//  · runGit 里 MAX_OUTPUT 之后「收下跨线那一块」——把它改成直接丢弃，只有一整块超标的喂法能测到，
//    而那句断言看的是 truncated 标记，两条都标 true；区别只在「行还剩多少」，不值得钉。
//  · refresh 里 key 用 `${item.id}:${item.path}:${item.git?'g':'-'}` 换成别的等价拼法——
//    断言看的是「换项目 / 换目录要重读」这个行为，不是那串 key 长什么样。
