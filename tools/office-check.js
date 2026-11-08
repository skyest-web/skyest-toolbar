// 办公文档格子（工作面板 officezone）的离线自检：不起应用、不开任何 Word/Excel，也不发一个网络包。
//
// 它盯六件事：
// 1) 六种「没东西可看」的说法各是哪句（没配置 / 写成相对路径 / 目录没了 / 那是个文件 / 没权限 / 里面没文档），
//    合成一句「打不开」他得自己猜是哪一个；
// 2) 只收 Word / Excel / PPT / PDF 那四族（带宏的 docm/xlsm/pptm 同族要收，odt / heic / avi 不收），
//    而且 Office 自己写的 ~$ 锁文件不许进列表——点开只会报错，出现一次就让人怀疑一次；
// 3) 递归、跳过目录、深度上限、limit、按 mtime 倒序、id 是小写全路径（大写路径递进来还认得上那条）；
// 4) 打开/定位只认这次缓存里的 id：路径递不进去（拿 path 当 id 要被拒），EACCES 之外那句系统原话要打码，
//    同一个文档 3 秒内连点两次只起一次；改了文件夹缓存必须自己作废；
// 5) 落位：工作面板第 3 列两行是 officezone 挂 office，layout.json 和 DEFAULT_PAGES 两份说同一句话、仍过校验，
//    别的面板一格没动（gauges 在主界面/生活面板还在，工作面板不该再有 gauges/slot2）；
// 6) 三段跨文件契约：preload 的 office.* 打到哪几个通道、main.js 有没有注册那四个 handler、
//    config.js 的 DEFAULTS / save() 白名单有没有 office 段（少一条就是「保存并应用」后文件夹整段没了）。
//
// 用法（Git Bash）: node tools/office-check.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const APP_ROOT = path.resolve(__dirname, '..');
const { Office, KIND, EXT_TO_KIND, kindLabel } = require('../src/main/services/office');
const configStore = require('../src/main/config');
const layoutStore = require('../src/main/layout');

const failures = [];
// 参数顺序照 tools/layout-check.js：说明在前、条件在后。条件位上放个非空字符串会恒真，
// 收到非布尔值直接抛，把「整份自检全绿却什么都没断」变成响的错误。
function expect(message, cond) {
  if (typeof cond !== 'boolean') throw new TypeError(`expect 的参数顺序写反了（应为 expect('说明', 布尔条件)）：条件位上收到 ${JSON.stringify(cond)} —— 出自「${message}」`);
  if (!cond) failures.push(message);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-office-'));
const p = (...parts) => path.join(root, ...parts);
const touch = (file, text = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
// 一份只记账的替身：openPath / showItemInFolder 会真的把 Word 和资源管理器拉起来，
// 跑自检的机器上不该出现那种窗口，所以这两条一律换成"记下参数"。
const makes = (openPathReturns = '') => {
  const calls = { open: [], reveal: [] };
  return {
    calls,
    openPath: (target) => { calls.open.push(target); return Promise.resolve(openPathReturns); },
    revealPath: (target) => { calls.reveal.push(target); return undefined; }
  };
};
const svc = (folder, extra = {}, harness = makes()) =>
  Object.assign(new Office({ getConfig: () => ({ office: { folder, ...extra } }), ...harness }), { harness });

// 改 mtime 用固定偏移，别依赖"现在几点"：倒序那条只比先后，不比绝对值
const setMtime = (file, seconds) => fs.utimesSync(file, new Date(seconds * 1000), new Date(seconds * 1000));

// ---------- 1. 六种「没东西可看」的说法 ----------
{
  const noFolder = svc('');
  expect(`没配置时报的是「${noFolder.scan().error}」`, noFolder.scan().error === '还没配置办公文档文件夹（设置 → 办公文档 → 文件夹）');
  expect('没配置时还回了条目', noFolder.scan().items.length === 0);

  const relative = svc('办公\\子目录');
  expect(`相对路径没被拒绝：${JSON.stringify(relative.scan().error)}`, relative.scan().error.startsWith('文件夹路径要写绝对路径：'));
  expect(`相对路径没把原样带出来：${JSON.stringify(relative.scan().error)}`, relative.scan().error.includes('办公'));

  const gone = p('没有这个目录');
  expect(`文件夹没了却不报「文件夹不存在或不可读」：${JSON.stringify(svc(gone).scan().error)}`, svc(gone).scan().error.startsWith('文件夹不存在或不可读'));
  expect(`文件夹没了却没带上错误码（ENOENT）：${JSON.stringify(svc(gone).scan().error)}`, svc(gone).scan().error.includes('ENOENT'));

  const aFile = touch(p('一个文件.docx'));
  expect(`把文件当文件夹却没拒绝：${JSON.stringify(svc(aFile).scan().error)}`, svc(aFile).scan().error === '所选路径不是文件夹');

  const emptyDir = p('空的');
  fs.mkdirSync(emptyDir, { recursive: true });
  expect(`空文件夹报的不是「没有 Word / Excel / PPT / PDF 文件」：${JSON.stringify(svc(emptyDir).scan().error)}`,
    svc(emptyDir).scan().error === '该文件夹里没有 Word / Excel / PPT / PDF 文件');
  // 这一条是「扫成了、里面没有」，和下面五种「压根没扫成」不一样，计数牌靠这个 empty 位分辨（写「未就绪」就是报假故障）
  expect('空文件夹那条没带 empty（计数牌会把一个正常空文件夹说成「未就绪」）', svc(emptyDir).scan().empty === true);
  expect(`没配置那条带了 empty（压根没扫成，不该说成「扫到了 0 份」）：${JSON.stringify(noFolder.scan().empty)}`, !noFolder.scan().empty);
  expect(`相对路径那条带了 empty：${JSON.stringify(relative.scan().empty)}`, !relative.scan().empty);
  expect(`文件夹没了那条带了 empty：${JSON.stringify(svc(gone).scan().empty)}`, !svc(gone).scan().empty);
  expect(`文件当文件夹那条带了 empty：${JSON.stringify(svc(aFile).scan().empty)}`, !svc(aFile).scan().empty);

  // 没权限这一句在 Windows 上造不出真目录（改 ACL 太重），所以只把 readdirSync 换成"对该路径抛 EACCES"，
  // 断的是这条分支的**说法**和"它必须先于 walk 命中"——顺序写反了会得到上面那句「里面没有文档」。
  const unreadable = p('读不动');
  fs.mkdirSync(unreadable, { recursive: true });
  const realReaddir = fs.readdirSync;
  fs.readdirSync = (dir, options) => {
    if (path.resolve(String(dir)) === unreadable) { const err = new Error('EACCES: permission denied'); err.code = 'EACCES'; throw err; }
    return realReaddir.call(fs, dir, options);
  };
  try {
    expect(`读不动的目录报的不是「没有读取权限」：${JSON.stringify(svc(unreadable).scan().error)}`,
      svc(unreadable).scan().error === '没有读取权限');
    expect('读不动的目录还回了条目', svc(unreadable).scan().items.length === 0);
    expect('读不动那条带了 empty（压根没扫成，不该说成「扫到了 0 份」）', !svc(unreadable).scan().empty);
  } finally {
    fs.readdirSync = realReaddir;
  }

  const words = new Set([noFolder.scan().error, relative.scan().error, svc(gone).scan().error, svc(aFile).scan().error, svc(emptyDir).scan().error]);
  expect(`六种说法里有两句是同一句话：${JSON.stringify([...words])}`, words.size === 5);
}

// ---------- 2. 收哪些后缀，挡哪些锁文件 ----------
{
  const ALLOWED = {
    '.doc': 'word', '.docx': 'word', '.docm': 'word',
    '.xls': 'sheet', '.xlsx': 'sheet', '.xlsm': 'sheet', '.csv': 'sheet',
    '.ppt': 'slides', '.pptx': 'slides', '.pptm': 'slides',
    '.pdf': 'pdf'
  };
  const collected = [...EXT_TO_KIND.keys()].sort().join(',');
  const want = Object.keys(ALLOWED).sort().join(',');
  expect(`收进来的扩展名是 ${collected}，应为 ${want}`, collected === want);
  for (const [ext, kind] of Object.entries(ALLOWED)) {
    expect(`${ext} 归到了 "${EXT_TO_KIND.get(ext)}"，应为 "${kind}"`, EXT_TO_KIND.get(ext) === kind);
    expect(`${ext} 的类别标签不是人话：${kindLabel(kind)}`, ['文档', '表格', '演示', 'PDF'].includes(kindLabel(kind)));
  }
  expect('KIND 里没有 word 这一族（筛选条四类该都在）', Object.keys(KIND).join(',') === 'word,sheet,slides,pdf');
  expect('认不出的类别给了标签：', kindLabel('nope') === '文档');
  // 本机没装对应软件、点开只会「没有应用打得开这种文件」的那些，不收
  for (const ext of ['.odt', '.ods', '.odp', '.pages', '.md', '.txt', '.rtf', '.one']) {
    expect(`把 ${ext} 收进来了（点开只会报「没有应用」，列表里出现一次就让人怀疑一次）`, !EXT_TO_KIND.has(ext));
  }

  const locks = p('锁文件');
  touch(path.join(locks, '预算表.xlsx'));
  touch(path.join(locks, '~$预算表.xlsx'));
  touch(path.join(locks, '~WRS{8A1F}.tmp'));
  const lockScan = svc(locks).scan(true);
  expect(`Office 的锁文件进列表了：${JSON.stringify(lockScan.items.map((item) => item.file))}`, lockScan.items.length === 1);
  expect('锁文件把唯一那份真文档挤掉了', lockScan.items[0]?.file === '预算表.xlsx');
}

// ---------- 3. 扫描：递归 / 跳过 / 深度 / limit / 排序 / 字段 ----------
{
  const lib = p('文档库');
  touch(path.join(lib, '甲 报告.docx'));
  touch(path.join(lib, '乙 预算.XLSX'));
  touch(path.join(lib, '丙 汇报.pptx'));
  touch(path.join(lib, '丁 手册.pdf'));
  touch(path.join(lib, '读我.txt'));
  touch(path.join(lib, '视频.avi'));
  touch(path.join(lib, 'node_modules', '别扫我.docx'));
  touch(path.join(lib, '.git', '也别扫我.docx'));
  touch(path.join(lib, '子目录', '子里.doc'));
  touch(path.join(lib, 'a', 'b', 'c', '深处.xlsx'));
  touch(path.join(lib, 'a', 'b', 'c', 'd', 'e', '太深了.docx'));

  const scan = svc(lib).scan(true);
  const files = scan.items.map((item) => item.file);
  expect(`扫进来的东西不对：${JSON.stringify(files)}`, files.length === 6 && files.includes('子里.doc') && files.includes('深处.xlsx'));
  expect('过滤没生效（.txt / .avi / node_modules / .git / 第 5 层都该剪掉）', !files.some((name) => /读我|视频|别扫我|太深了/.test(name)));

  const noRecurse = svc(lib, { recursive: false }).scan(true);
  expect(`recursive:false 扫到 ${noRecurse.items.length} 条，顶层只有 4 份（子里 / 深处 都不该算进来）`, noRecurse.items.length === 4);
  expect('recursive:false 把顶层的文档弄丢了', noRecurse.items.every((item) => item.folder === lib));

  expect(`limit 给了 2 却回 ${svc(lib, { limit: 2 }).scan(true).items.length} 条`, svc(lib, { limit: 2 }).scan(true).items.length === 2);
  expect(`limit 写成 0 或乱值时没兜回默认上限：${svc(lib, { limit: 0 }).scan(true).items.length}`, svc(lib, { limit: 0 }).scan(true).items.length === 6);

  // 倒序：把六份的时间拉开到互不相同（新东西落在"现在"，不写死就会盖住刚设的这几个值），再按整串顺序比
  setMtime(path.join(lib, '丙 汇报.pptx'), 1700003000);
  setMtime(path.join(lib, '乙 预算.XLSX'), 1700002000);
  setMtime(path.join(lib, '甲 报告.docx'), 1700001000);
  setMtime(path.join(lib, '丁 手册.pdf'), 1700000000);
  setMtime(path.join(lib, '子目录', '子里.doc'), 1699000000);
  setMtime(path.join(lib, 'a', 'b', 'c', '深处.xlsx'), 1698000000);
  const ordered = svc(lib).scan(true).items.map((item) => item.file);
  expect(`不是按修改时间倒序：${JSON.stringify(ordered)}`,
    JSON.stringify(ordered) === JSON.stringify(['丙 汇报.pptx', '乙 预算.XLSX', '甲 报告.docx', '丁 手册.pdf', '子里.doc', '深处.xlsx']));

  const one = svc(lib).scan(true).items[0];
  expect(`条目少了字段（渲染层要 id/path/dir/file/ext/kind/kindLabel/title/size/mtime）：${JSON.stringify(Object.keys(one))}`,
    ['id', 'path', 'folder', 'dir', 'file', 'ext', 'kind', 'kindLabel', 'title', 'size', 'mtime'].every((key) => one[key] !== undefined && one[key] !== ''));
  expect(`id 不是小写全路径：${one.id}`, one.id === one.path.toLowerCase());
  expect(`ext 带了点或不是小写：${JSON.stringify(one.ext)}`, !one.ext.startsWith('.') && one.ext === one.ext.toLowerCase());
  expect(`大写扩展名没被认出来（.XLSX 该归到表格）：${JSON.stringify(svc(lib).scan(true).items.find((i) => i.file === '乙 预算.XLSX'))}`,
    svc(lib).scan(true).items.find((i) => i.file === '乙 预算.XLSX')?.kind === 'sheet');
  expect(`kindLabel 和 kind 对不上：${one.kind} → ${one.kindLabel}`, one.kindLabel === kindLabel(one.kind));
  expect(`title 还留着扩展名：${one.title}`, one.title === path.basename(one.file, path.extname(one.file)));
  expect('mtime 不是秒（TB.util.ago 按秒算，用不了）', Math.abs(one.mtime - Math.floor(fs.statSync(one.path).mtimeMs / 1000)) <= 1);
  expect('size 不是字节数', one.size === fs.statSync(one.path).size);
  expect('folder 记的不是它所在那一层目录', one.folder === path.dirname(one.path));
  expect(`dir 不是所在目录的名字：${one.dir}`, one.dir === path.basename(path.dirname(one.path)));
}

// ---------- 4. 缓存 / 只认 id / 打开与定位 ----------
(async () => {
  const lib = p('动作库');
  const docx = touch(path.join(lib, '合同 v2.docx'));
  const xlsx = touch(path.join(lib, '台账.xlsx'));

  {
    const harness = makes();
    const office = new Office({ getConfig: () => ({ office: { folder: lib } }), ...harness });
    const first = office.scan();
    expect(`第一次扫没拿到列表（应为 2 份）：${first.items.length}`, first.items.length === 2);
    const second = office.scan();
    expect('60 秒内第二次扫还重扫了一遍（该走缓存、cached 为 true）', second.cached === true);
    const forced = office.scan(true);
    expect('force 没绕开缓存', forced.cached !== true && forced.items.length === 2);

    // 改了文件夹 = 缓存作废：这条是"设置里换了目录，切回来还是旧列表"那个症状的根
    const other = p('另一个文件夹');
    touch(path.join(other, '别的项目.pdf'));
    const moved = new Office({ getConfig: () => ({ office: { folder: lib } }), ...makes() });
    moved.scan();
    moved.getConfig = () => ({ office: { folder: other } });
    const afterMove = moved.scan();
    expect(`换了文件夹还吃旧缓存：${JSON.stringify(afterMove.items.map((i) => i.file))}`, afterMove.cached !== true && afterMove.items.length === 1);

    // 只认这次缓存里那批 id。id 本身就是小写全路径（和 photos / video 同一套），所以
    // "递一个路径进来"能不能开得成，取决于那条路径在不在刚扫出来的列表里——不在就必须被拒，
    // 而且一个 openPath 都不许起；在的话用的也必须是缓存里那一条的 path（不是渲染层递来的那串）。
    const outsider = p('没扫过的文件夹\\外部.docx');
    const byPath = await office.open(outsider);
    expect(`列表外的路径当 id 却打开了：${JSON.stringify(byPath)}`, byPath.ok === false && byPath.error === '列表已过期，请点「重扫」');
    expect(`列表外的路径还是起了 openPath：${JSON.stringify(harness.calls.open)}`, harness.calls.open.length === 0);
    const upper = await office.open(docx.toUpperCase());
    expect(`大写路径当 id 没被认出来（id 一律按小写存）：${JSON.stringify(upper)}`, upper.ok === true);
    expect(`打开用的不是缓存里那条绝对路径：${JSON.stringify(harness.calls.open)}`, harness.calls.open[0] === docx);
    expect(`open 回包少了 name/kind：${JSON.stringify(upper)}`, upper.name === '合同 v2' && upper.kind === 'word');

    // 同一个文档 3 秒内连点两次只起一次（双击时浏览器会送两发 click）
    const again = await office.open(docx.toLowerCase());
    expect(`3 秒防抖没拦住第二次：${JSON.stringify(again)}`, again.ok === false && again.error === '刚刚已经点开过同一个，等它起来');
    expect(`3 秒内同一个文档起了 ${harness.calls.open.length} 次 openPath，应为 1 次`, harness.calls.open.length === 1);

    const revealed = office.reveal(xlsx.toLowerCase());
    expect(`定位失败：${JSON.stringify(revealed)}`, revealed.ok === true);
    expect(`定位用的不是缓存里那条路径：${JSON.stringify(harness.calls.reveal)}`, harness.calls.reveal[0] === xlsx);
    const revealStale = office.reveal('D:\\不是列表里的\\东西.docx');
    expect(`拿路径当 id 也去定位了：${JSON.stringify(revealStale)}`, revealStale.ok === false && revealStale.error === '列表已过期，请点「重扫」');
    expect(`拿路径当 id 时还是翻了资源管理器：${JSON.stringify(harness.calls.reveal)}`, harness.calls.reveal.length === 1);

    const status = office.status();
    expect(`status 少了字段：${JSON.stringify(status)}`, status.folder === lib && status.count === 2 && status.scannedAt > 0);
  }

  // openPath 回的是系统原话，那句里带路径的要打码——渲染层那句提示不该出现盘符
  {
    const noisy = makes('No application knows how to open D:\\文档库\\合同.docx (.docx).');
    const office = svc(lib, {}, noisy);
    office.scan(true);
    const res = await office.open(office.items[0].id);
    expect(`系统原话直接回给了渲染层：${JSON.stringify(res)}`, res.ok === false);
    expect(`那句失败话里漏了盘符路径：${res.error}`, !/[A-Za-z]:[\\/]/.test(res.error));
    expect('打码把整句话打没了', res.error.length > 0 && res.error.includes('No application'));

    const boom = { openPath: () => Promise.reject(new Error('EPERM: operation not permitted, D:\\x.docx')), revealPath: () => {} };
    const bad = svc(lib, {}, boom);
    bad.scan(true);
    const rejected = await bad.open(bad.items[0].id);
    expect(`openPath 抛错没接住（会冒到主进程顶层弹错误框）：${JSON.stringify(rejected)}`, rejected.ok === false && !/[A-Za-z]:[\\/]/.test(rejected.error));
  }

  // ---------- 5. 落位：第 3 列那一整块挂 office，两份说同一句话 ----------
  {
    const onDisk = layoutStore.load(APP_ROOT);
    const moduleAt = (layout, at) => layout.pages.find((page) => page.id === 'work')?.slots.find((slot) => slot.at === at)?.module;
    const workOf = (layout) => layout.pages.find((page) => page.id === 'work');
    for (const [where, layout] of Object.entries({ 'layout.json': onDisk, DEFAULT_PAGES: layoutStore.DEFAULT_LAYOUT })) {
      const page = workOf(layout);
      expect(`${where}：工作面板 officezone 挂的是 "${moduleAt(layout, 'officezone')}"，应为 "office"`, moduleAt(layout, 'officezone') === 'office');
      expect(`${where}：工作面板格子清单是 "${page.slots.map((slot) => slot.at).join(',')}"，应为 projzone,gitzone,officezone,workbench`,
        page.slots.map((slot) => slot.at).join(',') === 'projzone,gitzone,officezone,workbench');
      const column = page.grid.areas.slice(1, 3).map((row) => row[2]);
      expect(`${where}：第 3 列两行不是同一块（${JSON.stringify(column)}），gauges 右半 + slot2 本该合成 officezone`,
        column.every((token) => token === 'officezone'));
      expect(`${where}：officezone 这一格没有中文标签`, page.slots.find((slot) => slot.at === 'officezone')?.label?.includes('办公'));
      expect(`${where}：合掉的格子又回来了：${JSON.stringify(column)}`, !column.includes('gauges') && !column.includes('slot2'));
      expect(`${where}：改完落位后过不了校验：${layoutStore.validate(layout).join(' / ')}`, layoutStore.validate(layout).length === 0);
    }
    // 两份必须逐字一样：layoutStore.load 校验不过会整份退回默认，磁盘那份写坏了画面照样"看起来对"
    expect('两份配置里工作面板这一页逐字不一样（改了一份漏了另一份）',
      JSON.stringify(workOf(onDisk)) === JSON.stringify(workOf(layoutStore.DEFAULT_LAYOUT)));
    // 别的面板一格没动：主界面没有自己的 grid（跟着全局骨架走），gauges 要还在全局那份里；
    // 生活面板那一整条相册、生活 slot2 那档视频都不该被顺手改掉
    expect('全局骨架（主界面跟着它走）里的 gauges 没了', JSON.stringify(onDisk.grid.areas).includes('gauges'));
    expect('生活面板 gauges 那一整条没了（相册格跟着塌）', JSON.stringify(onDisk.pages.find((p) => p.id === 'life').grid.areas).includes('gauges'));
    expect(`生活面板 slot2 被顺手改成了 "${onDisk.pages.find((p) => p.id === 'life').slots.find((s) => s.at === 'slot2')?.module}"`,
      onDisk.pages.find((p) => p.id === 'life').slots.find((s) => s.at === 'slot2')?.module === 'video');
    expect('别的页面出现了 officezone（他点名的只有工作面板第 3 列）',
      onDisk.pages.filter((page) => page.id !== 'work').every((page) =>
        !JSON.stringify(page.grid?.areas || []).includes('officezone') && !page.slots.some((slot) => slot.at === 'officezone')));
  }

  // ---------- 6. 跨文件契约：preload / main / config / 组件纪律 ----------
  {
    const exposed = {};
    const invokes = [];
    const realLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request !== 'electron') return realLoad.call(this, request, parent, isMain);
      return {
        contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
        ipcRenderer: {
          invoke: (channel, ...args) => { invokes.push([channel, args]); return Promise.resolve({ channel, args }); },
          on: () => () => {}
        }
      };
    };
    delete require.cache[require.resolve('../src/preload/preload.js')];
    require('../src/preload/preload.js');
    Module._load = realLoad;

    const api = exposed.deskToolbar;
    expect('preload 没往 window 上挂 deskToolbar', Boolean(api));
    expect('preload 没有 office 这一层（组件会直接报 TB.api.office is undefined）', Boolean(api?.office));
    const cases = [['scan', 'office:scan', [true]], ['open', 'office:open', ['a.docx']], ['reveal', 'office:reveal', ['a.docx']], ['pickFolder', 'office:pickFolder', []]];
    for (const [method, channel, args] of cases) {
      expect(`preload 的 office.${method} 不是函数`, typeof api?.office?.[method] === 'function');
      invokes.length = 0;
      api.office[method](...args);
      expect(`office.${method}() 打到的是 ${JSON.stringify(invokes)}，应为 [["${channel}",${JSON.stringify(args)}]]`,
        JSON.stringify(invokes) === JSON.stringify([[channel, args]]));
    }
    expect(`office 这层多开了口子：${Object.keys(api.office).join(',')}`, Object.keys(api.office).sort().join(',') === 'open,pickFolder,reveal,scan');
    expect('preload 给 office 留了 save（这一格不落盘，只列不改）', api.office.save === undefined);

    const mainSrc = fs.readFileSync(path.join(APP_ROOT, 'src', 'main', 'main.js'), 'utf8');
    for (const channel of ['office:scan', 'office:open', 'office:reveal', 'office:pickFolder']) {
      expect(`preload 打了 "${channel}"，main.js 里没有对应的 ipcMain.handle`, mainSrc.includes(`ipcMain.handle('${channel}'`));
    }
    expect('main.js 没 new Office（office.scan 那条 handler 一跑就崩）', /new Office\(/.test(mainSrc));
    expect('main.js 里的 Office 没接 getConfig（文件夹就不是从 config 来的）', /new Office\(\{ getConfig: \(\) => config \}\)/.test(mainSrc));
    for (const channel of ['office:open', 'office:reveal']) {
      expect(`"${channel}" 的 handler 收了第二个参数（那条路就成了"递路径我帮你打开"）`,
        !new RegExp(`ipcMain\\.handle\\('${channel}', *\\(_event, id, [a-z]`).test(mainSrc));
    }

    const fresh = configStore.load(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-office-cfg-')));
    expect('DEFAULTS 里没有 office 段（老配置升上来后 main 读 config.office.folder 直接崩）', Boolean(fresh.office));
    expect('office 段没有 folder', typeof fresh.office?.folder === 'string');
    expect('office 段没有 recursive', typeof fresh.office?.recursive === 'boolean');
    expect(`office 段没有 limit（或不是个数）：${fresh.office?.limit}`, typeof fresh.office?.limit === 'number' && fresh.office.limit > 0);
    expect(`DEFAULTS 里那条兜底文件夹说的是「${fresh.office?.folder}」，他点名的指向丢了`, fresh.office?.folder === 'D:\\OneDrive\\办公');
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-office-save-'));
    configStore.save(cfgDir, configStore.merge(fresh, { office: { folder: lib } }));
    expect(`存进去再读回来是 ${JSON.stringify(configStore.load(cfgDir).office?.folder)}，不是那一个（save 的白名单没写 office：一保存并应用文件夹整段消失）`,
      configStore.load(cfgDir).office.folder === lib);
    expect('合并一份别的东西时把 office 段弄丢了', Boolean(configStore.merge(structuredClone(fresh), { display: { mode: 'auto' } }).office));

    // 组件那一侧的纪律：只递 id，不把自己的 path 交给 IPC；也不许出现"给我一个路径我帮你开"
    const componentSrc = fs.readFileSync(path.join(APP_ROOT, 'src', 'renderer', 'js', 'components', 'office.js'), 'utf8').replace(/\/\/.*$/gm, '');
    expect('组件源码里没有 TB.register 的 office', /id: 'office'/.test(componentSrc));
    expect('组件把 item.path 递进 IPC 了（那条路就成了"传路径我帮你 openPath"）', !/office\.(open|reveal)\(\s*item\.path/.test(componentSrc));
    expect('组件里没有 open(item.id)（左键那一路该走 id）', /TB\.api\.office\.open\(item\.id\)/.test(componentSrc));
    expect('组件里出现了 fetch/XHR（这一格不出网）', !/\bfetch\(|XMLHttpRequest/.test(componentSrc));
    expect('组件没换成系统默认程序那句话，写死了某个 Office 软件名', !/WINWORD|EXCEL\.EXE|powerpnt/i.test(componentSrc));
    expect('Ctrl+左键那一路没走 reveal', /TB\.api\.office\.reveal\(item\.id\)/.test(componentSrc));
    // 光比对 /lastClick/ 不够：那条属性声明 `lastClick: { id: null, at: 0 }` 一直在，
    // 把 click 里那两行判断删掉照样匹配，于是「双击的第二发没咽掉」这条永远是绿的（变异测出来过）
    expect('双击的第二发 click 没咽掉（主进程 3 秒防抖会每次都弹一句「刚刚已经点开过同一个」）',
      /this\.lastClick\.id === item\.id && Date\.now\(\) - this\.lastClick\.at < \d+\) return;/.test(componentSrc)
        && /this\.lastClick = \{ id: item\.id, at: Date\.now\(\) \};/.test(componentSrc));
    // 真机探针抓到过一次：列表有 error 时只渲染那句提示，牌子却按 items.length 写「6 份」——画面自相矛盾。
    // 反过来也不能一律写「未就绪」：`empty` 那一档是真的 0 份，写成未就绪就是给他一个假故障。
    expect('计数牌在报错时还会按 items 报份数（列表只剩那句提示，牌子写「6 份」自相矛盾）',
      /error && !this\.data\?\.empty \? '未就绪' : `\$\{items\.length\} 份`/.test(componentSrc));
    expect('计数牌把所有 error 都说成「未就绪」（正常空文件夹该写 0 份，那条得看 empty 位）',
      !/textContent = error \? '未就绪'/.test(componentSrc));

    // CSS 那几条排版规矩：竖向吃满整块、超出交给列表自己滚、截断不写在行上
    const css = fs.readFileSync(path.join(APP_ROOT, 'src', 'renderer', 'styles.css'), 'utf8');
    const block = (start) => css.slice(css.indexOf(start), css.indexOf('*/', css.indexOf(start)));
    const officeBlock = block('/* ---------- office（工作面板');
    expect('CSS 里没有 office 这一段（.office-area 全靠它排版）', officeBlock.length > 10);
    expect('.of-list 没写 overflow-y:auto（超出就被 .area 静默裁掉，看不见也说不清）', /\.of-list \{[^}]*overflow-y: auto/.test(css));
    expect('.of-list 没写 overflow-anchor:none（OneDrive 边下边动，滚动会被锚定拽着跳）', /\.of-list \{[^}]*overflow-anchor: none/.test(css));
    expect('.of-item 写了 overflow:hidden（内容盒在横向 flex 行里会塌成 0：DOM 全在、探针全绿，人却看不清）',
      !/\.of-item \{[^}]*overflow: hidden/.test(css));
    expect('.of-name 没自己写省略号三件套', /\.of-name \{[^}]*text-overflow: ellipsis/.test(css));
    expect('.of-list > * 没写 flex: 0 0 auto（行会被压扁成十几 px 的空壳）', /\.of-list > \* \{[^}]*flex: 0 0 auto/.test(css));
    expect('.of-item 的字号低于 13px（这屏 dpr=1，正文再小就看不清）', /\.of-item \{[^}]*font-size: 0\.88rem/.test(css));
    expect('四类牌子的颜色没分开设（文档/表格/演示/PDF 只看字容易认错）',
      /\.of-kind\.kind-word/.test(css) && /\.of-kind\.kind-sheet/.test(css) && /\.of-kind\.kind-slides/.test(css) && /\.of-kind\.kind-pdf/.test(css));
  }

  fs.rmSync(root, { recursive: true, force: true });

  if (failures.length) {
    for (const line of failures) console.log(`✗ ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ 办公文档格子自检全绿：六种「没东西可看」的说法各自对上（含「读不动」必须先于 walk 命中，且只有「扫到了但里面没有」带 empty 位）、` +
    `只收 doc/docx/docm + xls/xlsx/xlsm/csv + ppt/pptx/pptm + pdf（odt/md/txt/avi 都不收）、~$ 锁文件与 ~WRS 临时件挡在门外、` +
    `递归/深度/跳过目录/limit/mtime 倒序/id 小写全路径/大写扩展名都认、60 秒缓存与换文件夹自动作废、` +
    `打开与定位只认 id（路径递进去被拒且一个进程都不起）且 3 秒防抖只起一次、系统原话打码不带盘符；` +
    `落位两份配置逐字一致（work/officezone=office、第 3 列两行是同一块、合掉的 gauges/slot2 没回来、别的面板一格没动）且过校验；` +
    `preload 四条通道都打到 handler 并带参数、没有 save、config 的 DEFAULTS 与 save 白名单都带 office 段、组件只递 id 且双击的第二发在组件里就咽掉、计数牌按 empty 位分得开「没扫成（未就绪）」和「扫到了但没有（0 份）」、CSS 那八条排版规矩都在`);
})();
