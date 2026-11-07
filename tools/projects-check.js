// 项目格子（工作面板左下那一格）的离线自检：不起应用、不开任何 IDE、不碰 D:\GitProject。
//
// 在自己建的临时目录里造出各种标记组合，验最要紧的四件事：
// 1) 判序 —— 尤其「既有 .idea/dataSources.xml 又有一份 PYTHON_MODULE 的 .iml」那种（他真有这么一个目录），
//    反过来排就会被判成 PyCharm；
// 2) 上次动过的两种来源 —— git 的 reflog 时间戳优先，没有才退回目录自身的 mtime；
// 3) 给渲染层的行里到底有没有 IDE 的 exe 路径（项目目录路径可以带，exe 只能留在主进程）；
// 4) 点一下把哪个路径交给了哪个 exe —— 注入只记账的 spawn，本机一个 IDE 都不会被拉起来。
//
// 用法（Git Bash）: node tools/projects-check.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { Projects, PRODUCTS, findBinDir, reflogTime, DEFAULT_ROOT } = require('../src/main/services/projects');
const layoutStore = require('../src/main/layout');

const APP_ROOT = path.resolve(__dirname, '..');
const tmp = path.join(os.tmpdir(), `toolbar-projects-check-${process.pid}`);
const root = path.join(tmp, 'GitProject');
const failures = [];
const spawns = [];
const opened = [];
const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

function expect(message, cond) {
  // 参数顺序是「说明在前、条件在后」：条件位上收到非布尔就是调用方把两条写反了，
  // 那种写法会让一条本该失败的断言默默绿掉，所以直接抛，不要往下走。
  if (typeof cond !== 'boolean') throw new Error(`expect 的第 2 个参数不是布尔（说明和条件写反了？）：${message} / ${typeof cond}`);
  if (!cond) failures.push(message);
}

const p = (...parts) => path.join(root, ...parts);

function makeDir(...parts) {
  const dir = path.join(...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function touchAt(dir, seconds) {
  const at = new Date(seconds * 1000);
  fs.utimesSync(dir, at, at);
}

// 真 reflog 一行：<旧sha> <新sha> 名字 <邮箱> <秒> <时区>\t动作: 说明
function reflog(gitDir, lastTs, extra = '') {
  const sha = (c) => c.repeat(40);
  const lines = [`${sha('0')} ${sha('1')} 他 <t@x> ${lastTs - 7200} +0800\tcommit (initial): 起头\n`];
  if (extra) lines.push(extra);
  lines.push(`${sha('1')} ${sha('2')} 他 <t@x> ${lastTs} +0800\tcommit: 最近一次\n`);
  write(path.join(gitDir, 'logs', 'HEAD'), lines.join(''));
}

// 假 IDE 安装：Program Files 那种 <产品>/bin 两层，Toolbox 那种 <产品>/ch-0/<版本>/bin 四层
function fakeIdea() {
  const programFiles = makeDir(tmp, 'IDE', 'JetBrains');
  const toolbox = makeDir(tmp, 'IDE', 'Toolbox', 'apps');
  const bins = {
    datagrip: makeDir(programFiles, 'DataGrip'),
    webstorm: makeDir(programFiles, 'WebStorm'),
    // PyCharm 只存在于 Toolbox 那棵更深的路径下：认不到就说明 depth 没给够
    pycharm: makeDir(toolbox, 'PyCharm-P', 'ch-0', '262.10000.8')
  };
  // 干扰项：配置目录那种有 bin 但里面没有启动器的，还有名字像但不是目录的
  makeDir(programFiles, 'Daemon', 'bin');
  write(path.join(programFiles, 'acme.txt'), '不是目录');
  for (const product of PRODUCTS) write(path.join(bins[product.id], 'bin', product.exe), '假 exe');
  return [
    { dir: programFiles, depth: 2 },
    { dir: toolbox, depth: 3 },
    // 一个不存在的根：不能把整次识别带崩
    { dir: path.join(tmp, 'IDE', '这个根不存在'), depth: 2 }
  ];
}

function service(options = {}) {
  return new Projects({
    roots: options.roots === undefined ? [root] : options.roots,
    ideRoots: options.ideRoots === undefined ? fakeIdea() : options.ideRoots,
    spawn: options.spawn || ((exe, args, opts) => {
      spawns.push({ exe, args, opts });
      const child = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => child.emit('spawn'));
      return child;
    }),
    openPath: options.openPath || (async (dir) => { opened.push(dir); return ''; })
  });
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

async function main() {
  // ---------- 1. 造项目 ----------
  // package.json 是判据，里面什么都不必写
  write(p('webapp', 'package.json'), '{"name":"webapp"}');
  write(p('webapp', 'readme.md'), '# hi');
  touchAt(p('webapp'), NOW - 2 * DAY);

  write(p('pyreq', 'requirements.txt'), 'requests\n');
  touchAt(p('pyreq'), NOW - 5 * DAY);

  // .iml 里写着 PYTHON_MODULE，但顶层没有任何 Python 文件：仍然该判成 PyCharm
  write(p('pyiml', '.idea', 'pyiml.iml'), '<?xml version="1.0"?><module type="PYTHON_MODULE" version="4"><component name="NewModuleRootManager" /></module>');
  write(p('pyiml', 'notes.md'), 'x');
  touchAt(p('pyiml'), NOW - 9 * DAY);

  // 关键那条：数据库工程 + 一份从 PyCharm 模板留下来的 PYTHON_MODULE（他 D:\GitProject\datagrip 就是这样）
  write(p('dbproj', '.idea', 'dbproj.iml'), '<module type="PYTHON_MODULE" version="4" />');
  write(p('dbproj', '.idea', 'dataSources.xml'), '<project><component name="DataSourceManagerImpl" /></project>');
  write(p('dbproj', 'main.py'), 'print(1)');
  touchAt(p('dbproj'), NOW - 3 * DAY);

  // dataSources 是个目录、没有 .xml 也算
  makeDir(p('dbdir', '.idea', 'dataSources'));
  write(p('dbdir', '.idea', 'modules.xml'), '<project />');
  touchAt(p('dbdir'), NOW - 4 * DAY);

  // 只有一张 .py 的小脚本目录
  write(p('scriptonly', 'main.py'), 'print(1)');
  touchAt(p('scriptonly'), NOW - 7 * DAY);

  // 三个「目录名本身就是 IDE 名」的用例。名字必须各不相同：Windows 的路径不分大小写，
  // pycharm 和 PyCharm 是同一个目录，上一条就栽在这里（空目录被判成了前端工程）。
  makeDir(p('pycharm'));
  touchAt(p('pycharm'), NOW - 30 * DAY);

  // 内容判据赢过目录名：名字叫 DataGrip，里面是一份 .py 脚本
  write(p('DataGrip', 'main.py'), 'print(3)');
  touchAt(p('DataGrip'), NOW - 11 * DAY);

  // 全大写的目录名也要按名字认得出来；里面只有子目录，没别的判据
  makeDir(p('WEBSTORM', 'sub'));
  touchAt(p('WEBSTORM'), NOW - 6 * DAY);

  // 都不认得：走默认 IDE，但行里要说出「按默认那条判的」
  write(p('rustapp', 'Cargo.toml'), '[package]');
  touchAt(p('rustapp'), NOW - 8 * DAY);

  // 判据名单是小写的、`.py` 那条是 /i 的：这两条只有真拿大写名字喂进去才测得出来。
  // 光看 ide 不够——「UpperPkg」认不出也会落到默认的 WebStorm，所以还得核对悬浮说明那句是谁判的。
  write(p('UpperPy', 'Main.PY'), 'print(4)');
  touchAt(p('UpperPy'), NOW - 4 * DAY);
  write(p('UpperPkg', 'Package.JSON'), '{}');
  touchAt(p('UpperPkg'), NOW - 2 * DAY);

  // 干扰项：根下的文件、点开头、回收站都不算项目
  write(path.join(root, 'notes.txt'), '不是项目');
  write(p('.cache-dir', 'package.json'), '{}');
  write(p('$RECYCLE.BIN', 'junk.txt'), 'x');

  // 上次动过：reflog 比目录 mtime 新（改了源码只动 reflog，目录 mtime 停在几天前）
  write(p('webapp', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  reflog(p('webapp', '.git'), NOW - 3600);

  // ---------- 2. 判序 ----------
  const svc = service();
  const scan = svc.scan(true);
  const byName = Object.fromEntries(scan.items.map((item) => [item.name, item]));
  console.log(`扫到 ${scan.items.length} 个：`);
  for (const item of scan.items) console.log(`  ${item.id} | ${item.name.padEnd(12)} ide=${item.ide} ready=${item.ideReady} ${item.touchedBy} ${item.empty ? '[空]' : ''} <= ${item.why}`);

  expect(`该有 12 个项目，实际 ${scan.items.length}：${scan.items.map((i) => i.name).join(',')}`, scan.items.length === 12);
  expect('根下的散文件被当成项目了', !byName['notes.txt']);
  expect('点开头的目录被当成项目了', !byName['.cache-dir']);
  expect('回收站目录被当成项目了', !byName['$RECYCLE.BIN']);

  expect(`数据库工程判成了 "${byName.dbproj?.ide}"（.idea/dataSources.xml 那条必须排在 PYTHON_MODULE 前面）`, byName.dbproj?.ide === 'datagrip');
  expect(`只有 dataSources/ 目录没写 xml 的没判成数据库工程：${byName.dbdir?.ide}`, byName.dbdir?.ide === 'datagrip');
  expect(`requirements.txt 的没判成 Python：${byName.pyreq?.ide}`, byName.pyreq?.ide === 'pycharm');
  expect(`.iml 写着 PYTHON_MODULE 的没判成 Python：${byName.pyiml?.ide}`, byName.pyiml?.ide === 'pycharm');
  expect(`只有一张 main.py 的没判成 Python：${byName.scriptonly?.ide}`, byName.scriptonly?.ide === 'pycharm');
  expect(`package.json 的没判成前端：${byName.webapp?.ide}`, byName.webapp?.ide === 'webstorm');
  expect(`空目录没按名字认成 PyCharm：${byName.pycharm?.ide}`, byName.pycharm?.ide === 'pycharm');
  expect(`全大写的目录名没按名字认出来（Windows 路径不分大小写）：${byName.WEBSTORM?.ide}`, byName.WEBSTORM?.ide === 'webstorm');
  expect(`大写扩展名的 .py 没判成 Python：${byName.UpperPy?.ide}`, byName.UpperPy?.ide === 'pycharm');
  expect(`大写名字的 Package.JSON 没判成前端：${byName.UpperPkg?.ide} / ${byName.UpperPkg?.why}`, byName.UpperPkg?.ide === 'webstorm');
  expect(`大写名字的 Package.JSON 那句判据说的不是前端那条（走的是默认，说明名单没小写）：${byName.UpperPkg?.why}`,
    /前端|Node/.test(byName.UpperPkg?.why || ''));
  expect(`目录名叫 DataGrip、里面只有 .py 时，名字盖过了内容判据：${byName.DataGrip?.ide}`, byName.DataGrip?.ide === 'pycharm');
  expect(`认不出类型的没走默认 IDE（${DEFAULT_ROOT} 这台机器默认是 webstorm）：${byName.rustapp?.ide}`, byName.rustapp?.ide === 'webstorm');
  expect(`认不出类型时悬浮说明没写「默认」：${byName.rustapp?.why}`, /默认/.test(byName.rustapp?.why || ''));
  expect(`空项目没被标出来：${JSON.stringify(byName.pycharm?.empty)}`, byName.pycharm?.empty === true);
  expect(`只有子目录的 WEBSTORM 被误标成空的：${byName.WEBSTORM?.empty}`, byName.WEBSTORM?.empty !== true);
  expect(`非空项目被误标成空的：${byName.webapp?.empty}`, byName.webapp?.empty !== true);

  // ---------- 3. 上次动过的两种来源 ----------
  expect(`webapp 的「上次动过」没取 reflog 最后那条（取到 reflog 就不该看目录 mtime）`, Math.abs((byName.webapp?.touched || 0) - (NOW - 3600)) <= 2);
  expect(`webapp 的来源没标成 git：${byName.webapp?.touchedBy}`, byName.webapp?.touchedBy === 'git');
  expect(`pyreq 的「上次动过」没取目录 mtime：${byName.pyreq?.touched}`, Math.abs((byName.pyreq?.touched || 0) - (NOW - 5 * DAY)) <= 2);
  expect(`pyreq 的来源没标成目录时间：${byName.pyreq?.touchedBy}`, byName.pyreq?.touchedBy === 'dir');

  const order = scan.items.map((item) => item.name);
  expect(`第一条该是刚提交过的 webapp，实际「${order[0]}」`, order[0] === 'webapp');
  const sortedDesc = order.every((name, i) => i === 0 || byName[order[i - 1]].touched >= byName[name].touched);
  expect(`没按「最近动过」倒序：${JSON.stringify(order)}`, sortedDesc);

  // ---------- 4. 行里没有 IDE 的 exe 路径 ----------
  const exeNames = PRODUCTS.map((product) => product.exe);
  const json = JSON.stringify(scan.items);
  const ideRootDir = path.join(tmp, 'IDE');
  expect(`行里出现了启动器文件名：${json.slice(0, 200)}`, !exeNames.some((exe) => json.includes(exe)));
  expect('行里出现了假 IDE 根目录（exe 路径只能留在主进程）', !json.includes(ideRootDir));
  expect('行少了渲染层要用的字段', ['id', 'name', 'path', 'root', 'ide', 'ideLabel', 'ideReady', 'why', 'touched', 'touchedBy', 'empty', 'git'].every((key) => key in scan.items[0]));
  expect(`ideLabel 不是人话：${scan.items[0].ideLabel}`, typeof scan.items[0].ideLabel === 'string' && /[A-Za-z]/.test(scan.items[0].ideLabel));
  expect('touched 不是秒（渲染层 TB.util.ago 按秒算）', scan.items.every((item) => item.touched > 1e9 && item.touched < 1e11));
  expect('id 不是连续序号', scan.items.every((item, i) => item.id === i));
  expect('三个 IDE 本机都该认到', scan.ides.every((ide) => ide.found));
  expect(`ides 里漏出了 exe 路径：${JSON.stringify(scan.ides)}`, !/exe/i.test(JSON.stringify(scan.ides)));
  expect(`缓存里的 exe 表没建起来：${[...svc.exes.keys()].join(',')}`, svc.exes.size === 3);

  // ---------- 5. 缓存与 force ----------
  const at = svc.status().scannedAt;
  const hit = svc.scan(false);
  expect('60 秒内该命中缓存', hit.cached === true);
  expect('缓存命中的那份和新扫的那份不一样（剥字段只剥了一条路）', JSON.stringify(hit.items) === JSON.stringify(scan.items));
  expect('缓存命中的 ides 丢了（渲染层的「未装」标记会跟着变绿）', JSON.stringify(hit.ides) === JSON.stringify(scan.ides));
  // 渲染层靠这一份比对「设置里改过根目录没有」，缓存命中时漏掉 roots 会让它永远不重扫
  expect(`缓存命中的 roots 和新扫的不一样：${JSON.stringify(hit.roots)}`, JSON.stringify(hit.roots) === JSON.stringify(scan.roots));
  expect('缓存命中的 warnings 丢了（一个根读不到时那一行提示会闪一下就没了）', JSON.stringify(hit.warnings) === JSON.stringify(scan.warnings));
  expect('命中缓存却刷新了 scannedAt', svc.status().scannedAt === at);
  expect('force 还走缓存', svc.scan(true).cached !== true);

  // ---------- 6. 启动：把哪个路径交给了哪个 exe ----------
  spawns.length = 0;
  const web = byName.webapp;
  const launched = await svc.launch(web.id);
  await settle();
  expect(`启动第一条失败：${JSON.stringify(launched)}`, launched.ok === true && launched.name === 'webapp');
  expect(`一次点击该只发一个 spawn，实际 ${spawns.length} 个`, spawns.length === 1);
  expect(`交给的启动器不是判出来的那个 IDE：${spawns[0]?.exe}`, /webstorm64\.exe$/i.test(spawns[0]?.exe || ''));
  expect(`启动参数该只有项目目录一项：${JSON.stringify(spawns[0]?.args)}`, JSON.stringify(spawns[0]?.args) === JSON.stringify([web.path]));
  expect('启动没走 detached/stdio:ignore（会被工具栏的退出拖住）', spawns[0]?.opts?.detached === true && spawns[0]?.opts?.stdio === 'ignore');
  expect('同一个项目 4 秒内点第二次该拦住', (await svc.launch(web.id)).error?.includes('刚刚已经把'));
  expect(`未知 id 没挡在缓存这一层：${JSON.stringify(await svc.launch(9999))}`, (await svc.launch(9999)).error?.includes('重扫'));
  expect('渲染层递路径进来居然被接受了', (await svc.launch('C:\\\\Windows\\\\system32')).error?.includes('重扫'));

  // 本机没装判出来的那个 IDE：要说清是哪个 IDE，且文案里不带 exe 路径，也不许偷偷 spawn
  const noIde = service({ ideRoots: [{ dir: path.join(tmp, '这台机器没装 JetBrains'), depth: 2 }] });
  const noIdeScan = noIde.scan(true);
  expect(`认不到 IDE 时行里 ideReady 该是 false：${JSON.stringify(noIdeScan.items[0])}`, noIdeScan.items.every((item) => item.ideReady === false));
  expect('认不到 IDE 时 ides 该全报 found:false', noIdeScan.ides.every((ide) => ide.found === false));
  const spawnsBefore = spawns.length;
  const missing = await noIde.launch(noIdeScan.items[0].id);
  await settle();
  expect(`没装 IDE 时该直接报错而不是硬启：${JSON.stringify(missing)}`, missing.ok === false && /本机没找到/.test(missing.error || ''));
  expect(`报错没说是哪个 IDE：${missing.error}`, /WebStorm|PyCharm|DataGrip/.test(missing.error || ''));
  expect(`报错里漏出了 exe 路径：${missing.error}`, !/[A-Za-z]:[\\/]/.test(missing.error || ''));
  expect(`认不到 IDE 时还是偷偷 spawn 了：${JSON.stringify(spawns.slice(spawnsBefore))}`, spawns.length === spawnsBefore);

  // spawn 的两条失败来路都要接住：报 'error' 事件的（EACCES）和同步就抛的（ENOENT）
  const eacces = service({
    spawn: () => {
      const child = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })));
      return child;
    }
  });
  eacces.scan(true);
  const denied = await eacces.launch(eacces.items[1].id);
  expect(`EACCES 那条没接住（会冒到主进程顶层弹错误框）：${JSON.stringify(denied)}`, denied.ok === false && /拒绝访问/.test(denied.error || ''));

  const throwing = service({
    spawn: () => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    }
  });
  throwing.scan(true);
  const gone = await throwing.launch(throwing.items[2].id);
  expect(`spawn 同步抛的那条没接住：${JSON.stringify(gone)}`, gone.ok === false && /不在了|拒绝|启不来/.test(gone.error || ''));

  // ---------- 7. 定位文件夹 ----------
  opened.length = 0;
  const revealed = await svc.reveal(byName.pyreq.id);
  expect(`定位失败：${JSON.stringify(revealed)}`, revealed.ok === true);
  expect(`reveal 没打开缓存里那个目录：${opened.join(',')}`, opened.length === 1 && opened[0] === byName.pyreq.path);
  fs.rmSync(p('scriptonly'), { recursive: true, force: true });
  const revealGone = await svc.reveal(byName.scriptonly.id);
  expect(`目录已经没了却没报错：${JSON.stringify(revealGone)}`, revealGone.ok === false && /不在了/.test(revealGone.error || ''));
  expect('未知 id 的定位没挡在缓存这一层', (await svc.reveal(9999)).error?.includes('重扫'));

  // ---------- 8. 四种「读不到」的文案 ----------
  const noRoot = service({ roots: [path.join(tmp, '这个根不存在')] }).scan(true);
  expect(`根目录不存在时没说清：${JSON.stringify(noRoot.error)}`, /找不到仓库根目录/.test(noRoot.error || ''));
  const notDir = service({ roots: [write(path.join(tmp, '是个文件.txt'), 'x')] }).scan(true);
  expect(`根路径指向文件时没说清：${JSON.stringify(notDir.error)}`, /不是目录/.test(notDir.error || ''));
  const relative = service({ roots: ['相对路径\\不行'] }).scan(true);
  expect(`相对路径没被挡：${JSON.stringify(relative.error)}`, /绝对路径/.test(relative.error || ''));
  const emptyRoot = service({ roots: [makeDir(tmp, '空根')] }).scan(true);
  expect(`根目录是空的该给空列表而不是报错：${JSON.stringify(emptyRoot.error)}`, !emptyRoot.error && emptyRoot.items.length === 0);
  console.log(`不存在 => 「${noRoot.error}」`);
  console.log(`是文件 => 「${notDir.error}」`);
  console.log(`相对路径 => 「${relative.error}」`);
  console.log(`空目录 => 0 条，无报错`);

  // ---------- 8b. 多个根：去重、一个坏根不掀整张表、全坏才报错 ----------
  // 这里不写死条数：上面第 7 节把 scriptonly 那个目录删了，此刻单根实际只有 11 条。
  // 拿同一时刻的单根扫描当基准，照样能测出「一个根被扫了两遍」那种去重失效。
  const refCount = service({ roots: [root] }).scan(true).items.length;
  expect(`基准都不可信：单根扫出 ${refCount} 条`, refCount >= 11);

  // 同一条路径写两遍 + 只差大小写写两遍，再加空行：Windows 路径不分大小写，这三条指的是同一个目录
  const twice = service({ roots: [root, root, `${root.toUpperCase()}`, '  ', ''] });
  const twiceScan = twice.scan(true);
  expect(`roots 没去重/没去空行：${JSON.stringify(twice.roots)}`, JSON.stringify(twice.roots) === JSON.stringify([root]));
  expect(`同一个根写三遍该只扫一遍，实际 ${twiceScan.items.length} 条（基准 ${refCount}）`, twiceScan.items.length === refCount);

  const upper = service({ roots: [root.toUpperCase()] }).scan(true);
  expect(`根路径全大写扫出来的条数和原样不一样（判据大小写敏感）：${upper.items.length} vs ${refCount}`, upper.items.length === refCount);

  // 一个坏根 + 一个好根：坏的那条进 warnings，好根的行照样列出来，整次不算失败
  const mixed = service({ roots: [path.join(tmp, '这个根不存在'), root] }).scan(true);
  expect(`一个根读不到不该把整张表掀了：${JSON.stringify(mixed.error)} / ${mixed.items.length} 条`, !mixed.error && mixed.items.length === refCount);
  expect(`读不到的那个根没进 warnings：${JSON.stringify(mixed.warnings)}`, mixed.warnings.length === 1 && /找不到仓库根目录/.test(mixed.warnings[0]));
  expect(`warnings 里没带上那个根的路径（他不知道是哪一条坏了）：${JSON.stringify(mixed.warnings)}`, mixed.warnings[0].includes(path.join(tmp, '这个根不存在')));
  expect(`roots 顺序被扫的过程改了：${JSON.stringify(mixed.roots)}`, JSON.stringify(mixed.roots) === JSON.stringify([path.join(tmp, '这个根不存在'), root]));

  // 全部读不到才当错误报，且那句是把每条拼起来（只报第一条会让他以为另一条是好的）
  const allBad = service({ roots: [path.join(tmp, '坏一'), path.join(tmp, '坏二')] }).scan(true);
  expect(`所有根都读不到时没报错：${JSON.stringify(allBad.error)}`, /找不到仓库根目录/.test(allBad.error || ''));
  expect(`报错文案没把两个根都列出来：${allBad.error}`, (allBad.error.match(/找不到仓库根目录/g) || []).length === 2);
  expect('所有根都读不到时 warnings 也该带着两条', allBad.warnings.length === 2);

  // 空列表：他真在设置里清空了 roots，照实说「没配置」，不偷偷兜回 D:\GitProject
  const none = service({ roots: [] }).scan(true);
  expect(`roots 是空数组时没报错：${JSON.stringify(none.error)}`, /没有配置仓库根目录/.test(none.error || ''));
  expect(`roots 是空数组还扫出东西了：${none.items.length}`, none.items.length === 0);
  const blanks = service({ roots: ['   ', ''] }).scan(true);
  expect(`roots 全是空行时说的是「没配置」：${JSON.stringify(blanks.error)}`, /没有配置仓库根目录/.test(blanks.error || ''));

  // 完全不传（配置里没这一段）才回兜底根：这句是给老配置文件留的路
  const legacy = new Projects({ ideRoots: fakeIdea() });
  expect(`没给 roots 时没兜回 ${DEFAULT_ROOT}：${JSON.stringify(legacy.roots)}`, JSON.stringify(legacy.roots) === JSON.stringify([DEFAULT_ROOT]));
  console.log(`空 roots => 「${none.error}」`);
  console.log(`一个坏根 + 一个好根 => ${mixed.items.length} 条 + ${mixed.warnings.length} 句 warning：「${mixed.warnings[0]}」`);

  // 多个根时行里要能说清这个项目是从哪个根扫出来的（git 格那一行要说这句话）
  // 注意 tmp\第二个根 才是根、它下面的 other 才是项目：把根指到 other 那一层就一个项目都扫不到
  const root2 = path.dirname(makeDir(tmp, '第二个根', 'other'));
  const two = service({ roots: [root, root2] }).scan(true);
  const inOther = two.items.find((item) => item.name === 'other');
  expect(`第二个根里的项目没被列出来：${two.items.map((i) => i.name).join(',')}`, Boolean(inOther));
  expect(`从第二个根扫出来的行没带上那个根：${inOther?.root}`, inOther?.root === root2);
  expect(`两个根的行数不对：${two.items.length} 条（基准 ${refCount} + 1）`, two.items.length === refCount + 1);
  expect(`行里的 root 不是这两个根之一：${[...new Set(two.items.map((i) => i.root))].join(' | ')}`,
    two.items.every((item) => item.root === root || item.root === root2));

  // 生产那条路是 getRoots（现读配置），不是构造时拷一份死数组：
  // 写成死值的话「保存并应用」换了 roots，得重启应用才见效——这一条只能在服务这边测。
  const live = { roots: [root] };
  const liveSvc = new Projects({ getRoots: () => live.roots, ideRoots: fakeIdea() });
  expect(`getRoots 那条路没读到根：${JSON.stringify(liveSvc.roots)}`, JSON.stringify(liveSvc.roots) === JSON.stringify([root]));
  liveSvc.scan(false);
  live.roots = [root2];
  const after = liveSvc.scan(false);
  expect(`换了 roots 还吃 60 秒缓存（该重扫的是新根）：cached=${after.cached}`, after.cached !== true);
  expect(`换了 roots 扫出来的还是旧根的行：${[...new Set(after.items.map((i) => i.root))].join(' | ')}`,
    after.items.length === 1 && after.items[0].root === root2);
  expect(`roots 没再动却还在重扫：cached=${liveSvc.scan(false).cached}`, liveSvc.scan(false).cached === true);
  // 只是把同一条路径换了个大小写：不该被当成「换了根」而白白重扫一次
  live.roots = [root2.toUpperCase()];
  expect('同一条根只是大小写不同也被算成换了配置（比对没按小写来）', liveSvc.scan(false).cached === true);
  // 手改 toolbar.config.json 时把 roots 写成一根字符串也该认，别整段回落到兜底根
  expect(`roots 写成字符串时没认：${JSON.stringify(new Projects({ getRoots: () => root }).roots)}`,
    JSON.stringify(new Projects({ getRoots: () => root }).roots) === JSON.stringify([root]));

  // ---------- 9. 单独验两个工具函数 ----------
  // 两种装法各按生产里那对 (根目录, 深度) 来找：Program Files 两层、Toolbox 四层
  expect(`Program Files 那种两层结构没认到：${findBinDir(path.join(tmp, 'IDE', 'JetBrains'), 'datagrip64.exe', 2)}`,
    /DataGrip[\\/]bin/i.test(findBinDir(path.join(tmp, 'IDE', 'JetBrains'), 'datagrip64.exe', 2) || ''));
  const toolboxBin = findBinDir(path.join(tmp, 'IDE', 'Toolbox', 'apps'), 'pycharm64.exe', 3);
  expect(`Toolbox 那种四层路径没认到：${toolboxBin}`, /ch-0/i.test(toolboxBin || '') && /pycharm/i.test(toolboxBin || ''));
  expect('深度不够时该回 null（Toolbox 的四层用 depth=2 找不齐，而不是找错地方）', findBinDir(path.join(tmp, 'IDE', 'Toolbox', 'apps'), 'pycharm64.exe', 2) === null);
  expect('根下没有启动器时该回 null', findBinDir(path.join(tmp, 'IDE', '这个根不存在'), 'pycharm64.exe', 3) === null);
  expect('有 bin 但里面没有启动器的（配置目录那种）该回 null', findBinDir(path.join(tmp, 'IDE', 'JetBrains'), 'clion64.exe', 2) === null);

  const gitDir = makeDir(tmp, 'reflog样例', '.git');
  // 中间那行的时间戳比最后一条大：取到 1700000000 才说明读的是「最后一行」，不是「最大的那行」
  reflog(gitDir, 1700000000, `${'1'.repeat(40)} ${'3'.repeat(40)} 他 <t@x> 1700000500 +0800\tcheckout: moving from main to dev\n`);
  expect(`reflog 取的不是最后一条：${reflogTime(gitDir)}`, reflogTime(gitDir) === 1700000000);
  const freshGit = makeDir(tmp, 'reflog空', '.git');
  write(path.join(freshGit, 'logs', 'HEAD'), '');
  expect('空 reflog 该回 null（新 clone 完没提交过）', reflogTime(freshGit) === null);
  expect('.git 里没有 logs/HEAD 时该回 null', reflogTime(makeDir(tmp, '没有logs', '.git')) === null);
  expect('.git 是个文件（worktree/submodule）时该回 null 而不是抛', reflogTime(write(path.join(tmp, 'git文件.txt'), 'gitdir: ...')) === null);
  const garbage = makeDir(tmp, 'reflog乱码', '.git');
  write(path.join(garbage, 'logs', 'HEAD'), '这一行没有时间戳\n');
  expect('读不懂的 reflog 该回 null（让上层退回目录 mtime）', reflogTime(garbage) === null);

  // ---------- 10. 落位：只有工作面板左边那一整块动了 ----------
  // 左列两格合成一整块 projzone（这一格），中间合成 gitzone（项目格的第二个视图，该挂什么由 git:check 钉）；
  // 这一条继续守的是「别顺手把没点名的格子也改了」，所以名单里只有剩下那三格。
  const onDisk = layoutStore.load(APP_ROOT);
  const moduleAt = (layout, pageId, at) => layout.pages.find((page) => page.id === pageId)?.slots.find((slot) => slot.at === at)?.module;
  for (const [where, layout] of Object.entries({ 'layout.json': onDisk, DEFAULT_PAGES: layoutStore.DEFAULT_LAYOUT })) {
    expect(`${where}：工作面板 projzone 格挂的是 "${moduleAt(layout, 'work', 'projzone')}"，应为 "projects"`, moduleAt(layout, 'work', 'projzone') === 'projects');
    for (const at of ['gauges', 'workbench', 'slot2']) {
      expect(`${where}：工作面板「${at}」被顺手改成了 "${moduleAt(layout, 'work', at)}"（他点名的只有 projzone 和 gitzone 两块）`, moduleAt(layout, 'work', at) === 'placeholder');
    }
    // 合掉的那几格不许以别的名字回来：左列和中间各是一整块，多一格就是布局没改对
    for (const at of ['player', 'clock', 'slot1']) {
      expect(`${where}：工作面板又冒出了「${at}」这一格（左列/中间各只该有一整块）`, moduleAt(layout, 'work', at) === undefined);
    }
    expect(`${where}：主界面 player 格（音乐播放器）被动了：${moduleAt(layout, 'home', 'player')}`, moduleAt(layout, 'home', 'player') === 'player');
    expect(`${where}：生活面板 slot1 的音乐被动了：${moduleAt(layout, 'life', 'slot1')}`, moduleAt(layout, 'life', 'slot1') === 'player');
    expect(`${where}：游戏面板 gamezone 被动了：${moduleAt(layout, 'game', 'gamezone')}`, moduleAt(layout, 'game', 'gamezone') === 'games');
    expect(`${where}：工作面板没绑虚拟桌面 2`, layout.pages.find((page) => page.id === 'work')?.desktop === 2);
    expect(`${where}：改完过不了校验：${layoutStore.validate(layout).join(' / ')}`, layoutStore.validate(layout).length === 0);
  }
  expect('两份落位说得不一样', JSON.stringify(onDisk.pages.find((page) => page.id === 'work')) === JSON.stringify(layoutStore.DEFAULT_LAYOUT.pages.find((page) => page.id === 'work')));

  // ---------- 11. 跨文件契约：preload 三条通道、main.js 三个 handler、组件注册 ----------
  // preload 在普通 node 里 require('electron') 只会拿到一个二进制路径字符串，照 mail-check 的办法换成假的
  const exposed = {};
  const invokes = [];
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request !== 'electron') return realLoad.call(this, request, parent, isMain);
    return {
      contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
      ipcRenderer: { invoke: (channel, ...args) => { invokes.push([channel, args]); return Promise.resolve({ channel, args }); }, on: () => () => {} }
    };
  };
  delete require.cache[require.resolve('../src/preload/preload.js')];
  require('../src/preload/preload.js');
  Module._load = realLoad;

  const api = exposed.deskToolbar;
  expect('preload 没往 window 上挂 deskToolbar', Boolean(api));
  expect('preload 没有 projects 这一层（组件会直接报 TB.api.projects is undefined）', Boolean(api?.projects));
  const channels = [['list', 'projects:list', [true]], ['launch', 'projects:launch', [7]], ['reveal', 'projects:reveal', [7]]];
  for (const [method, channel, args] of channels) {
    expect(`preload 的 projects.${method} 不是函数`, typeof api?.projects?.[method] === 'function');
    invokes.length = 0;
    api.projects[method](args[0]);
    expect(`projects.${method}() 打到的是 ${JSON.stringify(invokes)}，应为 [["${channel}",${JSON.stringify(args)}]]`, JSON.stringify(invokes) === JSON.stringify([[channel, args]]));
    expect(`preload 打了 "${channel}"，main.js 里没有对应的 ipcMain.handle`, fs.readFileSync(path.join(APP_ROOT, 'src', 'main', 'main.js'), 'utf8').includes(`ipcMain.handle('${channel}'`));
  }
  // 设置面板那张「浏览…加一条」按钮走的是 repos 这一层，不带参数
  expect('preload 没有 repos.pickFolder（设置里那个浏览按钮会直接报错）', typeof api?.repos?.pickFolder === 'function');
  invokes.length = 0;
  api.repos.pickFolder();
  expect(`repos.pickFolder() 打到的是 ${JSON.stringify(invokes)}，应为 [["repos:pickFolder",[]]]`, JSON.stringify(invokes) === JSON.stringify([['repos:pickFolder', []]]));
  expect('preload 打了 "repos:pickFolder"，main.js 里没有对应的 ipcMain.handle', fs.readFileSync(path.join(APP_ROOT, 'src', 'main', 'main.js'), 'utf8').includes(`ipcMain.handle('repos:pickFolder'`));
  // 根目录现在是配置项了（项目格和 git 格共用 repos.roots），所以这一段反过来钉两件事：
  // DEFAULTS 里有它，且 save() 的白名单里有它。少前者是「服务读不到」，少后者是「一保存整段没了」，
  // 后者光看源码看不出来，所以走一遍存盘再读回。
  const configSrc = fs.readFileSync(path.join(APP_ROOT, 'src', 'main', 'config.js'), 'utf8');
  expect('config.js 里没有 repos 段（roots 又变回写死在服务里了）', /repos:/.test(configSrc));
  const cfg = require('../src/main/config');
  const bareDir = makeDir(tmp, '没有配置文件的目录');
  const defaults = cfg.load(bareDir);
  expect(`DEFAULTS 里 repos.roots 不是数组（服务那边兜底会失效）：${JSON.stringify(defaults.repos)}`, Array.isArray(defaults.repos?.roots));
  expect(`DEFAULTS 里那条兜底根和 DEFAULT_ROOT 说的不是一个目录：${JSON.stringify(defaults.repos?.roots)}`,
    (defaults.repos?.roots || []).some((r) => r.toLowerCase() === DEFAULT_ROOT.toLowerCase()));
  const probe = { ...defaults, repos: { roots: ['D:\\One', 'D:\\Two'] } };
  cfg.save(bareDir, probe);
  const back = cfg.load(bareDir);
  expect(`存盘再读回 roots 没了/变了：${JSON.stringify(back.repos)}（save() 的白名单漏了 repos 段）`, JSON.stringify(back.repos?.roots) === JSON.stringify(['D:\\One', 'D:\\Two']));
  expect('roots 里的一条被读成了相对路径以外的东西（保存时该原样回传字符串数组）', back.repos.roots.every((r) => typeof r === 'string'));

  const componentSrc = fs.readFileSync(path.join(APP_ROOT, 'src', 'renderer', 'js', 'components', 'projects.js'), 'utf8');
  expect('组件没注册 id "projects"（layout 里那个 module 名找不到组件，这一格会整块留空）', /id: 'projects'/.test(componentSrc));
  expect('组件脚本不在 components/ 目录里（loader 扫不到它）', fs.existsSync(path.join(APP_ROOT, 'src', 'renderer', 'js', 'components', 'projects.js')));
  expect('组件里出现了启动器文件名的引用（渲染层不该知道任何 exe 位置）', !/\.exe/i.test(componentSrc));
  expect('渲染层自己拼了 file://（这一格不需要）', !/file:\/\//.test(componentSrc));
  expect(`组件里又写死了盘符路径（根目录该从 scan.roots 来）：${(componentSrc.match(/[A-Za-z]:\\\\[^"'`\n]*/) || [''])[0]}`, !/[A-Za-z]:\\\\/.test(componentSrc));

  // ---------- 11b. 手势：左键选中、双击才交给 IDE（中间那格跟着选中换）----------
  const projBody = (() => {
    const at = componentSrc.indexOf('  row(item) {');
    if (at < 0) return null;
    let depth = 0;
    for (let i = componentSrc.indexOf('{', at); i < componentSrc.length; i += 1) {
      if (componentSrc[i] === '{') depth += 1;
      else if (componentSrc[i] === '}') {
        depth -= 1;
        if (depth === 0) return componentSrc.slice(at, i);
      }
    }
    return null;
  })();
  expect('找不到组件 row(item) 的函数体（手势契约要跟着改版挪）', projBody !== null);
  expect('左键还在直接启动 IDE（双击才是启动，选中态必须能被点出来）',
    !/this\.launch\(/.test((projBody || '').split('onclick:')[1]?.split('ondblclick:')[0] || ''));
  expect('左键那一段没走到 selectProject（点下去右边不跟着换）',
    /TB\.app\.selectProject\(item\)/.test((projBody || '').split('onclick:')[1]?.split('ondblclick:')[0] || ''));
  expect('双击交给 IDE 那条没了', /ondblclick:/.test(projBody || '') && /this\.launch\(item\)/.test(projBody || ''));
  expect('Ctrl+左键打开文件夹被顺手改了', /this\.reveal\(item\)/.test(projBody || ''));
  // 选中态存在 app.state 上而不是组件里：切面板会重建这一格，DOM 和组件字段都没了，只有它是活的
  expect('组件自己记了一份选中态（那两格就会各说各话）', !/this\.selected[A-Za-z]*\s*=/.test(componentSrc));
  expect('组件没从 TB.app.state.project 读回选中行（重建后高亮就丢了）', /TB\.app\.state\.project/.test(componentSrc));
  expect('选中行没有视觉标记（.pj-item.sel 那条样式没人挂）', /classList\.toggle\('sel'/.test(componentSrc) && /'data-id'/.test(componentSrc));
  // 重扫和切页都会重建这一批行；选中态还在 app.state 里，高亮必须跟着重建补回去（真机踩过：重扫后左边看不出选的是哪一行）
  expect('render() 重建列表以后没补高亮（重扫/切页回来就看不出选中）',
    /render\(\)\s*\{[\s\S]{0,400}?this\.markSelection\(\)/.test(componentSrc));

  // ---------- 12. 磁盘上那份配置 + 设置卡片那条真路径 ----------
  // toolbar.config.json 是进 git 的，且「保存并应用」会整段重写：这一段没写也算合法（config.load
  // 拿 DEFAULTS 兜），一旦写了就必须是对的形状——手改这个文件的人不少，路径写错了当场说。
  const onDiskConfig = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'toolbar.config.json'), 'utf8'));
  if ('repos' in onDiskConfig) {
    expect(`toolbar.config.json 里 repos.roots 形状不对：${JSON.stringify(onDiskConfig.repos)}`,
      Array.isArray(onDiskConfig.repos?.roots) && onDiskConfig.repos.roots.every((item) => typeof item === 'string' && /^[A-Za-z]:[\\/]/.test(item)));
  } else {
    console.log('（磁盘上那份 toolbar.config.json 还没有 repos 段——正常，config.load 用 DEFAULTS 兜；点一次「保存并应用」就有了）');
  }

  // 卡片存在但「保存并应用」不写它 = 摆设；引用了 uniqueRoots 却没定义 = 一保存就 ReferenceError
  const settingsSrc = fs.readFileSync(path.join(APP_ROOT, 'src', 'renderer', 'js', 'settings.js'), 'utf8');
  expect('settings.js 里没有 config.repos = 这一句（卡片是摆设，一保存 roots 又回默认）', /config\.repos\s*=/.test(settingsSrc));
  expect('settings.js 用了 uniqueRoots 却没在这份文件里定义（点保存会 ReferenceError，整张面板白填）',
    !/uniqueRoots\(/.test(settingsSrc) || /function uniqueRoots\(/.test(settingsSrc));
  expect('settings.js 里那张卡片没接浏览按钮（TB.api.repos.pickFolder 没人调）', /TB\.api\.repos\.pickFolder/.test(settingsSrc));

  fs.rmSync(tmp, { recursive: true, force: true });
}

main()
  .catch((err) => failures.push(`脚本自己抛了：${err.stack || err.message}`))
  .then(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (failures.length) {
      for (const line of failures) console.log(`✗ ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log('✓ 项目格子自检全绿：判序（dataSources 抢在 PYTHON_MODULE 前、内容判据赢过目录名、认不出走默认）、');
    console.log('  上次动过（git reflog 优先、没有才退回目录 mtime、四种读不到的样子）、倒序、');
    console.log('  行里没有 exe 路径但留着项目路径、只认 id、4 秒防抖、spawn 两条失败来路都接住、');
    console.log('  多个根：去重去空行、一个坏根只进 warnings 不掀表、全坏才报错、空 roots 说「没配置」、「不传才兜回 DEFAULT_ROOT」、');
    console.log('  Toolbox 四层路径认得到、落位只动工作面板 projzone（gitzone 归 git 格，其余三格没动，合掉的三格没回来）、');
    console.log('  手势：左键选中 / 双击交给 IDE / Ctrl+左键打开文件夹、选中态只在 TB.app.state.project 一份、');
    console.log('  preload 三条通道 + repos.pickFolder 都打到 handler 并带上参数、');
    console.log('  repos.roots 存盘再读回还在（DEFAULTS 和 save 白名单两处都在）、设置卡片真的写这一段');
  });
