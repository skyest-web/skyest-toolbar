// Steam 库扫描/启动服务的离线自检：不起应用，也不碰 H 盘那个真库。
//
// 它在自己建的临时目录里写几份假 appmanifest_*.acf，于是能验到最要紧的三件事：
// 1) 解析规则对不对（StateFlags 只认 4、运行库那份清单要被挡掉、排序按最近游玩）；
// 2) 给渲染层的 payload 里到底有没有路径（dir 只留在主进程缓存里）；
// 3) 点一下拼出来的到底是哪个 steam:// 地址——注入 openExternal 记下参数，不真去叫 Steam。
//
// 用法（Git Bash）: node tools/steam-check.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Steam, steamappsDir, field } = require('../src/main/services/steam');

const tmp = path.join(os.tmpdir(), `toolbar-steam-check-${process.pid}`);
const apps = path.join(tmp, 'steamapps');
const failures = [];
const opened = [];
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function expect(cond, message) {
  if (!cond) failures.push(message);
}

// 按真文件的形状写：键值之间是空白，值里的反斜杠是双写的
function acf(appid, name, { flags = '4', played = 0, size = 0, installdir = '' } = {}) {
  return `"AppInstallId"\t\t"${appid}"
"appid"\t"${appid}"
"name"\t"${name}"
"StateFlags"\t"${flags}"
"installdir"\t"${installdir}"
"LastPlayed"\t"${played}"
"SizeOnDisk"\t"${size}"
"UserConfig"
{
\t"language"\t\t"english"
}
`;
}

function service() {
  return new Steam({
    getConfig: () => ({ steam: { folder: tmp } }),
    openExternal: (url) => {
      opened.push(url);
      return Promise.resolve(true);
    },
    openPath: (dir) => {
      opened.push(`openPath:${dir}`);
      return Promise.resolve('');
    }
  });
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function main() {
  fs.mkdirSync(path.join(apps, 'common', 'PBZ'), { recursive: true });
  fs.mkdirSync(path.join(apps, 'common', 'Left 4 Dead 2'), { recursive: true });

  fs.writeFileSync(path.join(apps, 'appmanifest_4115450.acf'), acf(4115450, 'Phantom Blade Zero', { played: NOW - DAY, size: 150856184777, installdir: 'PBZ' }));
  fs.writeFileSync(path.join(apps, 'appmanifest_252490.acf'), acf(252490, 'Rust', { played: NOW - 30 * DAY, size: 50000000000, installdir: 'Rust' }));
  fs.writeFileSync(path.join(apps, 'appmanifest_10.acf'), acf(10, 'Counter-Strike', { played: 0, size: 1000, installdir: 'Counter-Strike' }));
  fs.writeFileSync(path.join(apps, 'appmanifest_228980.acf'), acf(228980, 'Steamworks Common Redistributables', { installdir: 'Steamworks' }));
  // StateFlags=4 才是"装好了"；8 = 待下载，不该出现在列表里
  fs.writeFileSync(path.join(apps, 'appmanifest_736220.acf'), acf(736220, 'Pumpkin Jack', { flags: '8', installdir: 'Pumpkin' }));
  fs.writeFileSync(path.join(apps, 'appmanifest_500.acf'), acf(500, 'Left 4 Dead 2', { played: NOW - 2 * DAY, size: 8000000000, installdir: 'Left 4 Dead 2' }));
  // 清单在但没名字：不该进列表
  fs.writeFileSync(path.join(apps, 'appmanifest_1234567.acf'), acf(1234567, '', { installdir: 'NoName' }));
  // 文件名里的数字是 appid 的兜底来源（这份缺 appid 字段）
  fs.writeFileSync(path.join(apps, 'appmanifest_55001.acf'), '"StateFlags"\t"4"\n"name"\t"Brotato"\n"installdir"\t"Brotato"\n"LastPlayed"\t"' + (NOW - 5 * DAY) + '"\n');
  fs.writeFileSync(path.join(apps, 'appmanifest_notanumber.acf'), 'garbage');
  fs.writeFileSync(path.join(apps, 'libraryfolders.vdf'), 'not an appmanifest');

  console.log(`解析器：appid=${field(acf(42, 'X'), 'appid')} name=${field(acf(42, 'X'), 'name')} flags=${field(acf(42, 'X'), 'StateFlags')}`);
  expect(field(acf(42, 'X'), 'appid') === '42', 'field() 没读出 appid');
  expect(field(acf(42, 'X'), 'StateFlags') === '4', 'field() 没读出 StateFlags');
  expect(field('no such key', 'name') === '', 'field() 读不到键时不该给假值');
  expect(steamappsDir(tmp) === apps, '填库根目录时没拼上 steamapps');
  expect(steamappsDir(`${apps}\\`) === apps, '填 steamapps（带尾斜杠）时不该再拼一层');

  const steam = service();
  const first = steam.scan(true);
  const names = first.items.map((item) => item.name);

  console.log(`扫到 ${first.items.length} 款：`);
  for (const item of first.items) console.log(`  ${item.id} | ${item.name} appid=${item.appid} played=${item.played} dir=${item.dir || '(缓存里没有)'}`);

  expect(first.items.length === 5, `应该只有 5 款（PBZ / L4D2 / Brotato / Rust / CS），实际 ${first.items.length}`);
  expect(!names.includes('Steamworks Common Redistributables'), '运行库清单没被挡掉');
  expect(!names.includes('Pumpkin Jack'), 'StateFlags=8（待下载）的也进了列表');
  expect(!names.some((n) => n === ''), '空名字的条目没被跳过');
  expect(names[0] === 'Phantom Blade Zero', `最近游玩的没排在第一条：${names[0]}`);
  expect(names[1] === 'Left 4 Dead 2', '排序没按 LastPlayed 倒序');
  expect(names[2] === 'Brotato', '第三格该是 5 天前玩过的 Brotato（appid 从文件名兜底那条）');
  expect(names[4] === 'Counter-Strike', '从没玩过的该排在最后');
  expect(first.items.every((item, i) => i === 0 || item.id === first.items[i - 1].id + 1), 'id 不是连续的');
  expect(first.items.every((item) => !('dir' in item) && !('clientRoot' in item) && !('path' in item)), 'payload 漏出去路径了');
  expect(steam.items.every((item) => typeof item.dir === 'string'), '主进程缓存里该留着安装目录');

  // 缓存：60 秒内不重读文件；force 才重读
  const at = steam.status().scannedAt;
  const hit = steam.scan(false);
  expect(hit.cached === true, '60 秒内应该命中缓存');
  // 缓存命中的是另一条 return，剥字段要两条都做——曾经只在新扫那条剥，60 秒内的第二次调用就把 dir 带出去了
  expect(hit.items.every((item) => !('dir' in item) && !('clientRoot' in item) && !('path' in item)), '缓存命中的 payload 漏出去路径了');
  expect(JSON.stringify(hit.items) === JSON.stringify(first.items), '缓存命中和新扫给渲染层的两份数据不一样');
  expect(steam.status().scannedAt === at, '命中缓存却不该刷新 scannedAt');
  expect(steam.scan(true).cached !== true, 'force=true 不该走缓存');

  // 启动：拼的是 steam://rungameid/<缓存里的 appid>，渲染层给什么都进不来
  const launch = steam.launch(0);
  expect(launch.ok === true && launch.appid === 4115450, `启动第一条失败：${JSON.stringify(launch)}`);
  expect(steam.launch(9999).error?.includes('重扫'), '未知 id 没被挡在缓存这一层');
  expect(steam.launch('H:/steamapps/common/PBZ/PBZ.exe').error?.includes('重扫'), '渲染层递路径进来居然被接受了？');
  expect(steam.launch(0).error?.includes('刚刚已经交给 Steam'), '4 秒防抖没生效');

  // 缺 appid 字段的那份要退回文件名里的数字
  const brotato = first.items.find((item) => item.name === 'Brotato');
  expect(brotato && brotato.appid === 55001, `appid 没退回文件名：${JSON.stringify(brotato)}`);

  // 定位：走缓存里的 dir，目录不存在要说清
  const revealMissing = steam.reveal(3);
  expect(revealMissing.ok === false && /不存在/.test(revealMissing.error || ''), `installdir 指向不存在的目录却没报错：${JSON.stringify(revealMissing)}`);
  expect(steam.reveal(0).ok === true, '定位 PBZ 失败');

  await settle();
  console.log(`交给 Steam / 资源管理器的调用：${opened.join(' | ')}`);
  expect(opened.filter((s) => s.startsWith('steam://')).length === 1, `一次点击该只发一个协议地址：${opened.join(' | ')}`);
  expect(opened[0] === 'steam://rungameid/4115450', `拼出来的地址不对：${opened[0]}`);
  expect(opened.some((s) => s === `openPath:${path.join(apps, 'common', 'PBZ')}`), 'reveal 没打开缓存里那个目录');

  // 三种配置错误要给成人话，不能抛
  const none = new Steam({ getConfig: () => ({ steam: { folder: '' } }) }).scan(true);
  expect(none.error?.includes('还没配置'), `没配库时没说清：${JSON.stringify(none.error)}`);
  const missing = new Steam({ getConfig: () => ({ steam: { folder: path.join(tmp, '这里没有这个目录') } }) }).scan(true);
  expect(missing.error?.includes('找不到 steamapps'), `目录不存在时没说清：${JSON.stringify(missing.error)}`);
  const relative = new Steam({ getConfig: () => ({ steam: { folder: '相对路径\\不行' } }) }).scan(true);
  expect(relative.error?.includes('绝对路径'), `相对路径没被挡：${JSON.stringify(relative.error)}`);
  console.log(`未配置 => 「${none.error}」`);
  console.log(`不存在 => 「${missing.error}」`);
  console.log(`相对路径 => 「${relative.error}」`);

  // openExternal 报错（比如系统没注册 steam://）不能把渲染层的点击打成崩溃
  const broken = new Steam({
    getConfig: () => ({ steam: { folder: tmp } }),
    openExternal: () => Promise.reject(new Error('协议没注册'))
  });
  broken.scan(true);
  const rescued = broken.launch(0);
  expect(rescued.ok === true, 'openExternal 失败不该影响"已交给 Steam"这个结论');
  await settle();
}

main()
  .catch((err) => failures.push(`脚本自己抛了：${err.stack || err.message}`))
  .then(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (failures.length) {
      for (const line of failures) console.log(`✗ ${line}`);
      process.exitCode = 1;
    } else {
      console.log('✓ Steam 服务自检全绿：acf 解析、只认 StateFlags=4、挡运行库、按最近游玩排序、payload 不带路径、缓存只认 id、防抖、地址拼对、三种配置错误、openExternal 报错不崩');
    }
  });
