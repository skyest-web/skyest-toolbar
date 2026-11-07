// 视频格子（生活面板 slot2）的离线自检：不起应用、不播任何文件、不发一个网络包。
//
// 它盯六件事：
// 1) 四种「没东西」的说法各是哪句（没设文件夹 / 文件夹没了 / 那是个文件 / 里面没有能播的），他得知道去哪儿点；
// 2) 只收 Chromium 解得动的容器，且每一个收进来的扩展名都有对应 MIME——漏一条 track:// 就回
//    application/octet-stream，<video> 直接不播；认不出的扩展名反过来必须回 octet-stream；
// 3) 递归、目录跳过（node_modules）、深度上限、limit 截断、按标题排序、id 用小写全路径（换大小写还认得上次那条）；
// 4) 对着真文件扫一遍 assets/pet 那批 webm（真机探针就是拿它当片源放真画面的）；
// 5) 落位：生活面板 slot1=音乐、slot2=视频，layout.json 和 DEFAULT_PAGES 两份得说同一句话，且仍过校验；
// 6) 三段跨文件契约：preload 的 video.* 打到哪几个通道、main.js 有没有注册这三个 handler、
//    config.js 的 DEFAULTS / save() 白名单有没有 video 段（少一条就是「保存并应用」后文件夹整段没了）。
//
// 用法（Git Bash）: node tools/video-check.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const APP_ROOT = path.resolve(__dirname, '..');
const video = require('../src/main/services/video');
const configStore = require('../src/main/config');
const layoutStore = require('../src/main/layout');

const failures = [];
// 参数顺序照 tools/layout-check.js：说明在前、条件在后。
// 下面那道类型闸是必须的：QODER.md 记过一次「顺序写反，整份自检全绿却什么都没断」——条件位上放个
// 非空字符串就恒真。这里收到非布尔值直接抛，把同一类错误变成响的，而不是又一次全绿。
function expect(message, cond) {
  if (typeof cond !== 'boolean') throw new TypeError(`expect 的参数顺序写反了（应为 expect('说明', 布尔条件)）：条件位上收到 ${JSON.stringify(cond)} —— 出自「${message}」`);
  if (!cond) failures.push(message);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-video-'));
const p = (...parts) => path.join(root, ...parts);
const touch = (file, text = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

// ---------- 1. 四种「没东西」的说法 ----------
expect(`没给文件夹时报的是「${video.scan('').error}」`, video.scan('').error === '未设置视频文件夹');
expect('没给文件夹时还回了条目', video.scan('').clips.length === 0);
const gone = p('没有这个目录');
expect(`文件夹没了却不说「文件夹不存在：…」：${JSON.stringify(video.scan(gone).error)}`, video.scan(gone).error.startsWith('文件夹不存在：'));
expect(`文件夹没了却没把原路径带出来：${JSON.stringify(video.scan(gone).error)}`, video.scan(gone).error.includes(gone));
const aFile = touch(p('一个文件.mp4'));
expect(`把文件当文件夹却没拒绝：${JSON.stringify(video.scan(aFile).error)}`, video.scan(aFile).error === '所选路径不是文件夹');
expect(`选错成文件时还回了 ${video.scan(aFile).clips.length} 条`, video.scan(aFile).clips.length === 0);
const emptyDir = p('空的');
fs.mkdirSync(emptyDir, { recursive: true });
expect(`空文件夹报的不是「没有可播放的视频文件」：${JSON.stringify(video.scan(emptyDir).error)}`, video.scan(emptyDir).error === '该文件夹里没有可播放的视频文件');

// ---------- 2. 只收解得动的容器，且每条都有 MIME ----------
const ALLOWED = ['.mp4', '.m4v', '.mov', '.webm', '.mkv'];
expect(`收进来的扩展名是 ${[...video.VIDEO_EXT].sort().join(',')}，应为 ${[...ALLOWED].sort().join(',')}`, [...video.VIDEO_EXT].sort().join(',') === [...ALLOWED].sort().join(','));
expect('把 .avi 收进来了：Chromium 解不了，扫进来只是给用户一个黑屏', !video.VIDEO_EXT.has('.avi'));
expect('把 .flv 收进来了：同上（他要放这类文件请先转成 mp4）', !video.VIDEO_EXT.has('.flv'));
for (const ext of ALLOWED) {
  expect(`${ext} 没有对应 MIME（track:// 会回 octet-stream，<video> 直接不播）`, video.mimeFor(`x${ext}`).startsWith('video/'));
}
expect(`认不出的扩展名没回 octet-stream：${video.mimeFor('x.avi')}`, video.mimeFor('x.avi') === 'application/octet-stream');
expect(`大写扩展名没被认出来：${video.mimeFor('x.MP4')}`, video.mimeFor('x.MP4') === 'video/mp4');

// ---------- 3. 扫描：过滤 / 递归 / 跳过 / 深度 / 排序 / limit ----------
const lib = p('片库');
touch(path.join(lib, '01 - 第一集.mp4'));
touch(path.join(lib, '第二集.MP4'));
touch(path.join(lib, '花絮.avi'));
touch(path.join(lib, '说明.txt'));
touch(path.join(lib, 'node_modules', '别扫我.mp4'));
touch(path.join(lib, '子目录', '子里.webm'));
touch(path.join(lib, 'a', 'b', 'c', '深处.mkv'));
touch(path.join(lib, 'a', 'b', 'c', 'd', 'e', '太深了.mp4'));
const scan = video.scan(lib);
const found = scan.clips.map((clip) => clip.file);
expect(`扫进来的东西不对：${JSON.stringify(found)}`, found.length === 4 && found.includes('子里.webm') && found.includes('深处.mkv'));
expect('过滤没生效（.avi / .txt / node_modules / 第 5 层都该剪掉）', !found.some((name) => /花絮|说明|别扫我|太深了/.test(name)));
expect(`recursive:false 扫到 ${video.scan(lib, { recursive: false }).clips.length} 条，顶层只有 2 个能播的（子里 / 深处 / 太深了都不该算进来）`, video.scan(lib, { recursive: false }).clips.length === 2);
expect('recursive:false 把顶层的文件弄丢了', video.scan(lib, { recursive: false }).clips.every((clip) => clip.folder === lib));
const titles = scan.clips.map((clip) => clip.title);
expect(`标题没排序：${JSON.stringify(titles)}`, JSON.stringify(titles) === JSON.stringify([...titles].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))));
expect('文件名前那段集数没去掉（列表里会写着「01 - 第一集」）', !scan.clips.some((clip) => /^01/.test(clip.title)));
expect(`limit 给了 2 却回 ${video.scan(lib, { limit: 2 }).clips.length} 条`, video.scan(lib, { limit: 2 }).clips.length === 2);
const one = scan.clips[0];
expect(`条目少了字段（渲染层要 id/path/folder/dir/file/ext/title/size/mtime）：${JSON.stringify(Object.keys(one))}`,
  ['id', 'path', 'folder', 'dir', 'file', 'ext', 'title', 'size', 'mtime'].every((key) => one[key] !== undefined && one[key] !== ''));
expect(`id 不是小写全路径：${one.id}`, one.id === one.path.toLowerCase());
expect(`ext 带了点或不是小写：${JSON.stringify(one.ext)}`, !one.ext.startsWith('.') && one.ext === one.ext.toLowerCase());
expect('mtime 不是秒（TB.util.ago 按秒算，用不了）', Math.abs(one.mtime - Math.floor(fs.statSync(one.path).mtimeMs / 1000)) <= 1);
expect('size 不是字节数', one.size === fs.statSync(one.path).size);
expect('folder 记的不是它所在那一层目录', one.folder === path.dirname(one.path));

// 剥集数单独一条：直接喂一批名字，不借上面那个混合目录
const named = p('名字');
for (const name of ['01 - 甲.mp4', '02.乙.mp4', '03、丙.mp4', '丁.mp4', '01..mp4']) touch(path.join(named, name));
const stripped = Object.fromEntries(video.scan(named).clips.map((clip) => [clip.file, clip.title]));
expect(`"01 - 甲" 没剥成「甲」：${JSON.stringify(stripped['01 - 甲.mp4'])}`, stripped['01 - 甲.mp4'] === '甲');
expect(`"02.乙" 没剥成「乙」：${JSON.stringify(stripped['02.乙.mp4'])}`, stripped['02.乙.mp4'] === '乙');
expect(`没有集数前缀的「丁」被改动了：${JSON.stringify(stripped['丁.mp4'])}`, stripped['丁.mp4'] === '丁');
expect(`整串都是序号时标题没退回原名：${JSON.stringify(stripped['01..mp4'])}`, stripped['01..mp4'] === '01.');

// ---------- 4. 真文件：探针就是拿这批 webm 放真画面的 ----------
const petDir = path.join(APP_ROOT, 'src', 'renderer', 'assets', 'pet');
const real = video.scan(petDir);
const webm = fs.readdirSync(petDir).filter((name) => name.toLowerCase().endsWith('.webm'));
expect(`扫 assets/pet 只回 ${real.clips.length} 条，目录里实际有 ${webm.length} 个 webm`, real.clips.length === webm.length);
expect('assets/pet 里有报不出大小的', real.clips.every((clip) => clip.size > 0));
expect('assets/pet 的条目没带绝对路径', real.clips.every((clip) => path.isAbsolute(clip.path)));
expect(`宠物待机片段「待机呼吸休闲」不在扫描结果里（真机探针要放它）：${JSON.stringify(real.clips.map((clip) => clip.title))}`,
  real.clips.some((clip) => clip.title === '待机呼吸休闲'));
expect('webm 的 MIME 不是 video/webm', real.clips.every((clip) => video.mimeFor(clip.path) === 'video/webm'));

// ---------- 5. 落位：slot1 音乐、slot2 视频，两份说同一句话 ----------
const lifeOf = (layout) => layout.pages.find((page) => page.id === 'life');
const moduleAt = (page, at) => page.slots.find((slot) => slot.at === at)?.module;
const want = { leftzone: 'mail', slot1: 'player', slot2: 'video' };
const onDisk = layoutStore.load(APP_ROOT);
const homePage = onDisk.pages.find((page) => page.id === 'home');
for (const [where, page] of Object.entries({ DEFAULT_PAGES: lifeOf(layoutStore.DEFAULT_LAYOUT), 'layout.json': lifeOf(onDisk) })) {
  for (const [at, module] of Object.entries(want)) {
    expect(`${where}：生活面板「${at}」挂的是 "${moduleAt(page, at)}"，应为 "${module}"`, moduleAt(page, at) === module);
  }
  const middle = JSON.stringify(page.grid.areas.slice(1, 3).map((row) => row.slice(1, 3)));
  expect(`${where}：生活面板中间那块被改动了（${middle}），中间三格本该跟全局逐字一样`, middle === JSON.stringify([['gauges', 'gauges'], ['slot1', 'slot2']]));
}
expect(`改完落位后 layout.json 过不了校验：${layoutStore.validate(onDisk).join(' / ')}`, layoutStore.validate(onDisk).length === 0);
expect(`主界面 slot2 被顺手改成了 "${moduleAt(homePage, 'slot2')}"（他点名的只有生活面板那一格）`, moduleAt(homePage, 'slot2') !== 'video');

// ---------- 6. 三段跨文件契约 ----------
// preload 在普通 node 里 require('electron') 只会拿到一个二进制路径字符串，contextBridge 是 undefined，
// 于是照 tools/mail-check.js 的办法先换成一份假的：记下 exposeInMainWorld 交出来的那个对象，
// 再用假的 ipcRenderer 打一遍，验 video.* 三条各落到哪个通道、参数带没带上。
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
expect('preload 没有 video 这一层（组件会直接报 TB.api.video is undefined）', Boolean(api?.video));
if (api?.video) {
  // scan 带文件夹、save 带那份进度；pickFolder 是开原生对话框，本来就无参
  const cases = [['scan', 'video:scan', ['D:/x']], ['pickFolder', 'video:pickFolder', []], ['save', 'video:save', ['D:/x']]];
  for (const [method, channel, args] of cases) {
    expect(`preload 的 video.${method} 不是函数`, typeof api.video[method] === 'function');
    invokes.length = 0;
    api.video[method]('D:/x');
    expect(`video.${method}() 打到的是 ${JSON.stringify(invokes)}，应为 [["${channel}",${JSON.stringify(args)}]]`,
      JSON.stringify(invokes) === JSON.stringify([[channel, args]]));
  }
}
const mainSrc = fs.readFileSync(path.join(APP_ROOT, 'src', 'main', 'main.js'), 'utf8');
for (const channel of ['video:scan', 'video:pickFolder', 'video:save']) {
  expect(`preload 打了 "${channel}"，main.js 里没有对应的 ipcMain.handle`, mainSrc.includes(`ipcMain.handle('${channel}'`));
}
expect('track:// 的 Content-Type 没走视频表（扫出来的 mp4 会被当下载，或 <video> 报 Bad MIME type）',
  /function mediaMime/.test(mainSrc) && /video\.mimeFor/.test(mainSrc) && /'Content-Type': mediaMime\(filePath\)/.test(mainSrc));
expect("boot:get 没把上次的播放位置交给渲染层（回到这一格不接上次）", /video: store\.get\('video'\)/.test(mainSrc));

// 新开顶层配置段必须同时进 DEFAULTS 和 save() 的 ordered 白名单，少一条就是「一保存整段没了」
const fresh = configStore.load(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-video-cfg-')));
expect('DEFAULTS 里没有 video 段（老配置文件升上来后 main 读 config.video.folder 直接崩）', Boolean(fresh.video));
expect('video 段没有 folder', typeof fresh.video?.folder === 'string');
expect('video 段没有 recursive', typeof fresh.video?.recursive === 'boolean');
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-video-save-'));
configStore.save(cfgDir, configStore.merge(fresh, { video: { folder: lib } }));
expect(`存进去再读回来是 ${JSON.stringify(configStore.load(cfgDir).video?.folder)}，不是那一个（save 的白名单没写 video：一保存并应用视频文件夹整段消失）`,
  configStore.load(cfgDir).video.folder === lib);
expect('合并一份别的东西时把 video 段弄丢了', Boolean(configStore.merge(structuredClone(fresh), { display: { mode: 'auto' } }).video));

fs.rmSync(root, { recursive: true, force: true });

if (failures.length) {
  for (const line of failures) console.log(`✗ ${line}`);
  process.exitCode = 1;
  return;
}
console.log(`✓ 视频格子自检全绿：四种「没东西」的说法各自对上、只收 mp4/m4v/mov/webm/mkv 且每条都有 video/* MIME（认不出的回 octet-stream）、` +
  `递归与深度上限与 node_modules 跳过都对、limit 生效、按标题排、集数前缀剥掉、id 是小写全路径；` +
  `真扫 assets/pet 的 ${webm.length} 个 webm 全在（探针那片源）；生活面板 leftzone=邮箱 / slot1=音乐 / slot2=视频，两份配置一致且过校验、主界面没被顺手改；` +
  `preload 三条通道都打到对应 handler 并带上参数、track:// 认得出视频 MIME、config 的 DEFAULTS 和 save 白名单都带上了 video 段`);
