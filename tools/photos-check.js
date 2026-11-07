// 相册格子（生活面板 gauges 那一整条）的离线自检：不起应用、不渲染一张图、不发一个网络包。
//
// 它盯六件事：
// 1) 四种「没东西可看」的说法各是哪句（没设文件夹 / 文件夹没了 / 那是个文件 / 里面没有能显示的图）；
// 2) 只收 Chromium 解得动的位图——.heic（iPhone 默认）和 .svg（矢量）必须挡在外面，
//    前者是一张破图、后者根本不是照片；顺带验 file:/// 那串地址编得对（空格和 # 不编码就只加载到一半路径）；
// 3) 递归、目录跳过（node_modules / .git / $Recycle.Bin，大小写都算）、深度上限、limit 截断、
//    按修改时间倒序（照片墙要的是「最近拍的在最前面」）、标题不剥前缀；
// 4) 对着仓库里的 samples/ 真扫一遍：那里一堆 .png 混着 .log/.txt/.mp3/.ps1，正好当过滤器靶子；
// 5) 落位：生活面板 leftzone=邮箱 / gauges=相册 / slot1=音乐 / slot2=视频，
//    layout.json 和 DEFAULT_PAGES 两份说同一句话、仍过校验，且主界面 gauges 还是系统指标；
// 6) 三段跨文件契约：preload 的 photos.* 打到哪几个通道（且只有这两条——相册不往 state.json 写东西）、
//    main.js 注册了对应 handler、config.js 的 DEFAULTS 与 save() 白名单都带 photos 段。
//
// 用法（Git Bash）: node tools/photos-check.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const APP_ROOT = path.resolve(__dirname, '..');
const photos = require('../src/main/services/photos');
const configStore = require('../src/main/config');
const layoutStore = require('../src/main/layout');

const failures = [];
// 参数顺序照 tools/layout-check.js / video-check.js：说明在前、条件在后。
// 条件位上放个非空字符串就恒真——收到非布尔值直接抛，把这类错误变成响的，而不是又一次全绿。
function expect(message, cond) {
  if (typeof cond !== 'boolean') throw new TypeError(`expect 的参数顺序写反了（应为 expect('说明', 布尔条件)）：条件位上收到 ${JSON.stringify(cond)} —— 出自「${message}」`);
  if (!cond) failures.push(message);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-photos-'));
const p = (...parts) => path.join(root, ...parts);
const touch = (file, text = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const stamp = (file, unixSeconds) => {
  fs.utimesSync(file, new Date(unixSeconds * 1000), new Date(unixSeconds * 1000));
  return file;
};

// ---------- 1. 四种「没东西可看」的说法 ----------
expect(`没给文件夹时报的是「${photos.scan('').error}」`, photos.scan('').error === '未设置照片文件夹');
expect('没给文件夹时还回了条目', photos.scan('').photos.length === 0);
const gone = p('没有这个目录');
expect(`文件夹没了却不说「文件夹不存在：…」：${JSON.stringify(photos.scan(gone).error)}`, photos.scan(gone).error.startsWith('文件夹不存在：'));
expect(`文件夹没了却没把原路径带出来：${JSON.stringify(photos.scan(gone).error)}`, photos.scan(gone).error.includes(gone));
const aFile = touch(p('一张图.png'));
expect(`把文件当文件夹却没拒绝：${JSON.stringify(photos.scan(aFile).error)}`, photos.scan(aFile).error === '所选路径不是文件夹');
expect(`选错成文件时还回了 ${photos.scan(aFile).photos.length} 张`, photos.scan(aFile).photos.length === 0);
const emptyDir = p('空的');
fs.mkdirSync(emptyDir, { recursive: true });
expect(`空文件夹报的不是「该文件夹里没有能显示的图片」：${JSON.stringify(photos.scan(emptyDir).error)}`,
  photos.scan(emptyDir).error === '该文件夹里没有能显示的图片');

// ---------- 2. 扩展名白名单 + file:/// 地址 ----------
const ALLOWED = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.bmp'];
expect(`收进来的扩展名是 ${[...photos.PHOTO_EXT].sort().join(',')}，应为 ${[...ALLOWED].sort().join(',')}`,
  [...photos.PHOTO_EXT].sort().join(',') === [...ALLOWED].sort().join(','));
expect('把 .heic 收进来了：iPhone 直出的默认格式，Chromium 解不了，扫进来就是一张破图', !photos.PHOTO_EXT.has('.heic'));
expect('把 .svg 收进来了：矢量图不是照片，缩略图上墙只会显得奇怪', !photos.PHOTO_EXT.has('.svg'));
expect('把 .tiff 收进来了：同 .heic，浏览器解不了', !photos.PHOTO_EXT.has('.tiff'));

// 空格 / # / ? / % / 中文都要能原样绕回来：file:///D:/a b.png 不编码的话，<img> 只会请求到 "D:/a"
const tricky = 'D:\\照片 集\\2024 #1 全#家福.png';
const trickyUrl = photos.fileUrl(tricky);
expect(`地址不是 file:/// 开头的绝对形式：${trickyUrl}`, trickyUrl.startsWith('file:///'));
expect(`空格没编码：${trickyUrl}`, !trickyUrl.includes(' ') && trickyUrl.includes('%20'));
expect(`# 没编码（会被 URL 当成就锚点，路径从那儿截断）：${trickyUrl}`, !trickyUrl.includes('#') && trickyUrl.includes('%23'));
const backToPath = decodeURIComponent(new URL(trickyUrl).pathname).replace(/^\//, '').replace(/\//g, path.sep);
expect(`这串地址解不回原路径（${backToPath} ≠ ${tricky}），<img> 会加载失败`, backToPath === tricky);
expect(`反斜杠没换成正斜杠：${photos.fileUrl('D:\\a.png')}`, photos.fileUrl('D:\\a.png') === 'file:///D:/a.png');
expect(`盘符的冒号被编成 %3A（file:///D%3A/ 是开不出来的）：${photos.fileUrl('D:\\a.png')}`, photos.fileUrl('D:\\a.png').includes('D:/'));
expect(`? 没编码（会被当成查询串截断）：${photos.fileUrl('D:\\a?b.png')}`, !photos.fileUrl('D:\\a?b.png').includes('?'));
expect(`落单的 % 没编成 %25（那会被当成残缺转义，路径对不上）：${photos.fileUrl('D:\\100%完成.png')}`,
  photos.fileUrl('D:\\100%完成.png').includes('100%25'));
expect(`问号绕不回去：${photos.fileUrl('D:\\a?b.png')}`,
  decodeURIComponent(new URL(photos.fileUrl('D:\\a?b.png')).pathname).replace(/^\//, '') === 'D:/a?b.png');
// 极空间那台 NAS 挂载之后就是 \\z4s\photo\x.png：主机名待在 host 位才连得上
expect(`网络路径没把主机名放进 host 位：${photos.fileUrl('\\\\z4s\\photo\\x.png')}`,
  photos.fileUrl('\\\\z4s\\photo\\x.png') === 'file://z4s/photo/x.png');
expect(`根路径拼错了（三个斜杠才对）：${photos.fileUrl('/x/a.png')}`, photos.fileUrl('/x/a.png') === 'file:///x/a.png');

// ---------- 3. 扫描：过滤 / 递归 / 跳过 / 深度 / 排序 / limit ----------
const lib = p('相册');
touch(path.join(lib, '近照.png'));
touch(path.join(lib, 'IMG_20240601_101233.jpg'));
touch(path.join(lib, '截图.heic'));
touch(path.join(lib, '笔记.txt'));
touch(path.join(lib, '图标.svg'));
touch(path.join(lib, 'node_modules', '别扫我.png'));
touch(path.join(lib, 'Node_Modules', '大写也别扫.jpg'));
touch(path.join(lib, '.git', '仓库里.png'));
touch(path.join(lib, '$Recycle.Bin', '回收站.png'));
touch(path.join(lib, '子目录', '子里.webp'));
touch(path.join(lib, 'a', 'b', 'c', '深处.bmp'));
touch(path.join(lib, 'a', 'b', 'c', 'd', 'e', '太深了.jpg'));
// 修改时间：近照最新 → 子里 → 相机直出的 → 最深处，照片墙要的是「最近拍的在最前面」
stamp(path.join(lib, 'IMG_20240601_101233.jpg'), 1_700_000_000);
stamp(path.join(lib, '子目录', '子里.webp'), 1_800_000_000);
stamp(path.join(lib, '近照.png'), 1_900_000_000);
stamp(path.join(lib, 'a', 'b', 'c', '深处.bmp'), 1_600_000_000);
const scan = photos.scan(lib);
const found = scan.photos.map((photo) => photo.file);
expect(`扫进来的东西不对：${JSON.stringify(found)}`, found.length === 4 && found.includes('子里.webp') && found.includes('深处.bmp'));
expect('过滤没生效（.heic / .svg / .txt / 回收站 / 第 5 层都该剪掉）', !found.some((name) => /截图|图标|笔记|别扫我|大写也别扫|仓库里|回收站|太深了/.test(name)));
expect(`按修改时间没倒序：${JSON.stringify(scan.photos.map((photo) => [photo.file, photo.mtime]))}`,
  JSON.stringify(found) === JSON.stringify(['近照.png', '子里.webp', 'IMG_20240601_101233.jpg', '深处.bmp']));
expect(`recursive:false 扫到 ${photos.scan(lib, { recursive: false }).photos.length} 张，顶层只有 2 张能显示的`,
  photos.scan(lib, { recursive: false }).photos.length === 2);
expect('recursive:false 把所属文件夹记错了', photos.scan(lib, { recursive: false }).photos.every((photo) => photo.folder === lib));
expect('子目录里的图没记下真正所在那一层', scan.photos.find((photo) => photo.file === '子里.webp')?.folder === path.join(lib, '子目录'));
expect(`limit 给了 2 却回 ${photos.scan(lib, { limit: 2 }).photos.length} 张`, photos.scan(lib, { limit: 2 }).photos.length === 2);
const one = scan.photos[0];
expect(`条目少了字段（渲染层要 id/path/url/folder/dir/file/ext/title/size/mtime）：${JSON.stringify(Object.keys(one))}`,
  ['id', 'path', 'url', 'folder', 'dir', 'file', 'ext', 'title', 'size', 'mtime'].every((key) => one[key] !== undefined && one[key] !== ''));
expect(`id 不是小写全路径：${one.id}`, one.id === one.path.toLowerCase());
expect(`ext 带了点或不是小写：${JSON.stringify(one.ext)}`, !one.ext.startsWith('.') && one.ext === one.ext.toLowerCase());
expect('url 少了或者不是 file:/// 形式（<img> 拿不到地址就整格空白）',
  scan.photos.every((photo) => String(photo.url || '').startsWith('file:///')));
expect('url 和 path 指的是同一张图', scan.photos.every((photo) => photos.fileUrl(photo.path) === photo.url));
expect('mtime 不是秒（TB.util.date 按秒算，用不了）', Math.abs(one.mtime - Math.floor(fs.statSync(one.path).mtimeMs / 1000)) <= 1);
expect('size 不是字节数', one.size === fs.statSync(one.path).size);
expect('folder 记的不是它所在那一层目录', one.folder === path.dirname(one.path));
// 相机名本身就是他认得的东西，不像剧集有「集数」可剥
expect(`相机名被改动了：${JSON.stringify(scan.photos.find((photo) => photo.file === 'IMG_20240601_101233.jpg')?.title)}`,
  scan.photos.find((photo) => photo.file === 'IMG_20240601_101233.jpg').title === 'IMG_20240601_101233');
expect(`标题不是「文件名去掉扩展名」：${JSON.stringify(scan.photos.map((photo) => [photo.file, photo.title]))}`,
  scan.photos.every((photo) => photo.title === path.basename(photo.file, path.extname(photo.file))));

// 同一秒拍的两张（连拍/批量拷贝常见）：光看 mtime 分不出先后，得有个稳定顺序
const sameSec = p('同一秒');
for (const dir of ['d1', 'd2']) {
  const file = touch(path.join(sameSec, dir, '图.png'));
  stamp(file, 1_700_000_000);
}
expect(`同一秒的两张顺序不是按路径来的：${JSON.stringify(photos.scan(sameSec).photos.map((photo) => photo.dir))}`,
  JSON.stringify(photos.scan(sameSec).photos.map((photo) => photo.dir)) === JSON.stringify(['d1', 'd2']));
expect('同一秒的两张扫出来只剩一张（limit 之外的都被吞了）', photos.scan(sameSec).photos.length === 2);

// ---------- 4. 真文件：samples/ 里 .png 混着一堆日志和音频 ----------
const samples = path.join(APP_ROOT, 'samples');
const real = photos.scan(samples, { recursive: false });
const pngs = fs.readdirSync(samples).filter((name) => name.toLowerCase().endsWith('.png'));
expect(`扫 samples/ 只回 ${real.photos.length} 张，目录里实际有 ${pngs.length} 个 png`, real.photos.length === pngs.length);
expect(`samples/ 的扫描里混进了非图片：${JSON.stringify(real.photos.filter((photo) => photo.ext !== 'png').map((photo) => photo.file))}`,
  real.photos.every((photo) => photo.ext === 'png'));
expect('samples/ 里有报不出大小的', real.photos.every((photo) => photo.size > 0));
expect('samples/ 的条目没带绝对路径', real.photos.every((photo) => path.isAbsolute(photo.path)));
expect('samples/ 的 url 不是 file:/// 形式（<img> 加载不了就整格空白）', real.photos.every((photo) => String(photo.url || '').startsWith('file:///')));
expect('递归扫 samples/ 时子目录的图也进来了，却没一个解码得了的扩展名外的东西',
  photos.scan(samples).photos.every((photo) => ALLOWED.includes(`.${photo.ext}`)));

// ---------- 5. 落位：生活面板那一整条是相册，两份配置说同一句话 ----------
const lifeOf = (layout) => layout.pages.find((page) => page.id === 'life');
const moduleAt = (page, at) => page.slots.find((slot) => slot.at === at)?.module;
const want = { leftzone: 'mail', gauges: 'photos', slot1: 'player', slot2: 'video' };
const onDisk = layoutStore.load(APP_ROOT);
const pagesOf = (layout) => layout.pages.find((page) => page.id === 'home');
const homePages = { DEFAULT_PAGES: pagesOf(layoutStore.DEFAULT_LAYOUT), 'layout.json': pagesOf(onDisk) };
for (const [where, page] of Object.entries({ DEFAULT_PAGES: lifeOf(layoutStore.DEFAULT_LAYOUT), 'layout.json': lifeOf(onDisk) })) {
  for (const [at, module] of Object.entries(want)) {
    expect(`${where}：生活面板「${at}」挂的是 "${moduleAt(page, at)}"，应为 "${module}"`, moduleAt(page, at) === module);
  }
  const middle = JSON.stringify(page.grid.areas.slice(1, 3).map((row) => row.slice(1, 3)));
  expect(`${where}：生活面板中间那块被改动了（${middle}），中间两行本该跟全局逐字一样`, middle === JSON.stringify([['gauges', 'gauges'], ['slot1', 'slot2']]));
}
expect(`改完落位后 layout.json 过不了校验：${layoutStore.validate(onDisk).join(' / ')}`, layoutStore.validate(onDisk).length === 0);
// 他点名的只有生活面板那一格：主界面那张 gauges 还是系统指标，工作面板照旧空着
for (const [where, page] of Object.entries(homePages)) {
  expect(`${where}：主界面 gauges 被顺手改成了 "${moduleAt(page, 'gauges')}"（他点名的只有生活面板那一格）`, moduleAt(page, 'gauges') === 'gauges');
}
expect(`工作面板 gauges 被顺手改成了 "${moduleAt(onDisk.pages.find((page) => page.id === 'work'), 'gauges')}"`,
  moduleAt(onDisk.pages.find((page) => page.id === 'work'), 'gauges') === 'placeholder');
expect(`游戏面板 gauges 这一格本不该存在，却被写进了 "${JSON.stringify(lifeOf(layoutStore.DEFAULT_LAYOUT).grid.areas)}"`,
  !JSON.stringify(onDisk.pages.find((page) => page.id === 'game').grid.areas).includes('gauges'));

// ---------- 6. 三段跨文件契约 ----------
// preload 在普通 node 里 require('electron') 只会拿到一个二进制路径字符串，contextBridge 是 undefined，
// 于是照 tools/video-check.js 的办法先换成一份假的：记下 exposeInMainWorld 交出来的对象，再打一遍 photos.*。
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
expect('preload 没有 photos 这一层（组件会直接报 TB.api.photos is undefined）', Boolean(api?.photos));
if (api?.photos) {
  expect(`photos 这层多出了方法：${JSON.stringify(Object.keys(api.photos))}，相册只该有 scan / pickFolder（不往 state.json 写「上次第几张」）`,
    JSON.stringify(Object.keys(api.photos).sort()) === JSON.stringify(['pickFolder', 'scan']));
  const cases = [['scan', 'photos:scan', ['D:/照片']], ['pickFolder', 'photos:pickFolder', []]];
  for (const [method, channel, args] of cases) {
    expect(`preload 的 photos.${method} 不是函数`, typeof api.photos[method] === 'function');
    invokes.length = 0;
    api.photos[method](method === 'pickFolder' ? undefined : 'D:/照片');
    expect(`photos.${method}() 打到的是 ${JSON.stringify(invokes)}，应为 [["${channel}",${JSON.stringify(args)}]]`,
      JSON.stringify(invokes) === JSON.stringify([[channel, args]]));
  }
}
const mainSrc = fs.readFileSync(path.join(APP_ROOT, 'src', 'main', 'main.js'), 'utf8');
for (const channel of ['photos:scan', 'photos:pickFolder']) {
  expect(`preload 打了 "${channel}"，main.js 里没有对应的 ipcMain.handle`, mainSrc.includes(`ipcMain.handle('${channel}'`));
}
expect('main.js 冒出了一个 photos:save（相册按设计不记进度，state.json 也不该多出这一段）', !mainSrc.includes("ipcMain.handle('photos:save'"));

// 图片走 file://，前提是 CSP 的 img-src 一直放着 file:；收紧成只允许 self 就整格空白，所以钉在这儿
// （截到分号或属性收尾的引号为止，别在 'self' 那个引号上就断了）
const csp = fs.readFileSync(path.join(APP_ROOT, 'src', 'renderer', 'index.html'), 'utf8').match(/img-src[^;"]*/)?.[0] || '';
expect(`CSP 的 img-src 里没放 file:（照片全靠 file:/// 显示）：${JSON.stringify(csp)}`, /file:/.test(csp));
expect(`CSP 的 img-src 收成 'none' 了：${JSON.stringify(csp)}`, !/'none'/.test(csp));
const componentSrc = fs.readFileSync(path.join(APP_ROOT, 'src', 'renderer', 'js', 'components', 'photos.js'), 'utf8');
// 注释里提一句 track:// 是讲道理，代码里真用它就是绕远路（<img> 不受跨源媒体策略限制，file:// 直接够）
const componentCode = componentSrc.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
expect('相册组件的代码里出现 track://（那是给 <audio>/<video> 准备的，<img> 用不上还多绕一段协议）', !componentCode.includes('track://'));
expect('相册组件给滚动列表里的缩略图加了 loading="lazy"（游戏列表那条教训：一屏之外不加载，滚过去是一片白）',
  !/loading:\s*['"]lazy['"]/.test(componentCode));
expect('相册组件没有 TB.photos 这个对象', /TB\.photos\s*=/.test(componentSrc));
// 注册 id 只看 TB.register({ 之后紧跟着的那一个 key，往后找会撞进 build 里那个 { id: 'photos' }
const regId = componentSrc.match(/TB\.register\(\{\s*id:\s*'([^']+)'/)?.[1];
expect(`相册组件注册出来的 id 是 ${JSON.stringify(regId)}，应为 "photos"（落位那格写的就是它，对不上界面永远是占位符）`, regId === 'photos');
expect(`组件 build 出来的容器 id 不是 photos（styles.css 里 .photos-area #photos 那条规则会落空）`, componentSrc.includes("{ id: 'photos' }"));
expect(`组件挂的样式类不含 photos-area（.area 的高度/内边距全靠它）`, /cls:\s*'area photos-area'/.test(componentSrc));

// 样式表：横条靠 .ph-strip 横向滚，浮层靠 body 上那条 position:fixed。
// 少一条 .ph-view[hidden]{display:none} 的话，display:flex 会盖掉 hidden 属性，浮层从头就压在界面上不放。
const css = fs.readFileSync(path.join(APP_ROOT, 'src', 'renderer', 'styles.css'), 'utf8');
const rule = (selector) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] || '';
for (const selector of ['.photos-area', '.ph-strip', '.ph-item', '.ph-thumb', '.ph-view', '.ph-stage', '.ph-full']) {
  expect(`styles.css 里没有 ${selector} 这条规则`, css.includes(`${selector} {`));
}
expect('.ph-strip 不能横向滚（少了 overflow-x:auto）：一整排照片只能看见头几张', /overflow-x:\s*auto/.test(rule('.ph-strip')));
expect('.ph-strip 没锁住纵向，冒出第二条滚动条会把缩略图那一行顶出格子', /overflow-y:\s*hidden/.test(rule('.ph-strip')));
expect('.ph-strip 没关滚动锚定（重建清单时 scrollLeft 会被弹走，和游戏列表同一坑）', /overflow-anchor:\s*none/.test(rule('.ph-strip')));
expect('.ph-thumb 没定高，横条会被一张原图撑破格子', /height:\s*\d+px/.test(rule('.ph-thumb')));
expect('.ph-thumb 没写 object-fit，非正方形的图会被拉伸', /object-fit:\s*cover/.test(rule('.ph-thumb')));
expect('.ph-view 不是 position:fixed，越出格子的那截会被 .area 的 overflow:hidden 静默吃掉', /position:\s*fixed/.test(rule('.ph-view')));
expect('.ph-view[hidden] 没有 display:none，浮层一开局就盖在住界面上', /display:\s*none/.test(rule('.ph-view[hidden]')));
expect('.ph-full 没有 max-width/max-height，大图会把说明条挤出窗口', /max-width:\s*100%/.test(rule('.ph-full')) && /max-height:\s*100%/.test(rule('.ph-full')));
expect('.ph-full 被写成了 object-fit: cover，大图会被裁掉一圈', /object-fit:\s*contain/.test(rule('.ph-full')));
expect('浮层的 z-index 压到了设置弹窗(50)之上，开着照片打不开设置', (() => {
  const z = Number(rule('.ph-view').match(/z-index:\s*(\d+)/)?.[1] || 0);
  return z > 40 && z < 50;
})());

// 新开顶层配置段必须同时进 DEFAULTS 和 save() 的 ordered 白名单，少一条就是「一保存整段没了」
const fresh = configStore.load(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-photos-cfg-')));
expect('DEFAULTS 里没有 photos 段（老配置文件升上来后 main 读 config.photos.folder 直接崩）', Boolean(fresh.photos));
expect('photos 段没有 folder', typeof fresh.photos?.folder === 'string');
expect('photos 段没有 recursive', typeof fresh.photos?.recursive === 'boolean');
expect('photos 段没有 limit 或不是数字', typeof fresh.photos?.limit === 'number');
expect(`photos 的 limit 是 ${fresh.photos?.limit}，太小了照片墙就只剩几张`, fresh.photos?.limit >= 100);
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-photos-save-'));
configStore.save(cfgDir, configStore.merge(fresh, { photos: { folder: lib } }));
expect(`存进去再读回来是 ${JSON.stringify(configStore.load(cfgDir).photos?.folder)}，不是那一个（save 的白名单没写 photos：一保存并应用照片文件夹整段消失）`,
  configStore.load(cfgDir).photos?.folder === lib);
expect('合并一份别的东西时把 photos 段弄丢了', Boolean(configStore.merge(structuredClone(fresh), { display: { mode: 'auto' } }).photos));
// pickFolder 回来以后主进程要立刻把新文件夹并进配置再落盘，否则重启就回到「没设置文件夹」
const pickAt = mainSrc.indexOf("ipcMain.handle('photos:pickFolder'");
const pickBlock = mainSrc.slice(pickAt, pickAt + 900);
expect(`photos:pickFolder 没把选中的文件夹并回 config（${pickBlock.split('\n').length} 行里找不到 config.photos）`, /config\.photos/.test(pickBlock) && /configStore\.merge/.test(pickBlock));
expect('photos:pickFolder 选了却没落盘（下次启动又回到没设置文件夹）', /configStore\.save\(APP_ROOT, config\)/.test(pickBlock));
expect('photos:scan 直接把渲染层传来的字符串当文件夹用，没兜配置里那个（组件传空时读不到照片）',
  /folder \|\| config\.photos\.folder/.test(pickAt >= 0 ? mainSrc.slice(mainSrc.indexOf("ipcMain.handle('photos:scan'"), pickAt) : ''));

fs.rmSync(root, { recursive: true, force: true });

if (failures.length) {
  for (const line of failures) console.log(`✗ ${line}`);
  process.exitCode = 1;
  return;
}
console.log(`✓ 相册格子自检全绿：四种「没东西可看」的说法各自对上、只收 jpg/jpeg/png/webp/avif/gif/bmp（.heic/.svg/.tiff 都挡住）、` +
  `file:/// 把空格与 # 编得对且能原样解回路径；递归与深度上限与 node_modules/.git/$Recycle.Bin 跳过都对、limit 生效、按修改时间倒序、相机名不剥；` +
  `真扫 samples/ 的 ${pngs.length} 个 png 全在且没混进日志音频；生活面板 leftzone=邮箱 / gauges=相册 / slot1=音乐 / slot2=视频，两份一致且过校验、主界面与工作面板没被顺手改；` +
  `preload 只有 scan / pickFolder 两条通道且都打到对应 handler、main.js 没有 photos:save、CSP 的 img-src 仍放 file:、config 的 DEFAULTS 和 save 白名单都带 photos 段`);
