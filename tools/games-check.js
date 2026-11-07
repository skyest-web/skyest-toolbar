// 游戏列表这一层的离线自检：不起应用，也不碰 H 盘的真库和真修改器目录。
//
// 在自己的临时目录里造一份假的 Steam 库（appmanifest + appcache/librarycache 图标）
// 和一份假的修改器目录，于是能验到四件最容易坏的事：
// 1) 别名表把修改器认给了谁——包括「五 vs 五前传」这种必须长名字先赢的，和对不上就整条不显示；
// 2) 图标是怎么从 librarycache 里认出来的（那个 40 位哈希名只能列目录，猜不出来）；
// 3) 标签上写的短句是怎么从一长串文件名里抠出来的；
// 4) 给渲染层的行数据里到底有什么（只有 id / 名字 / 图标路径，没有任何 .exe 路径）。
//
// 用法（Git Bash）: node tools/games-check.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Steam } = require('../src/main/services/steam');
const { Trainers } = require('../src/main/services/trainers');
const { Library, chipLabel } = require('../src/main/services/library');
const { GAMES, canon, gameEntry, trainerOwner } = require('../src/main/services/game-alias');

const tmp = path.join(os.tmpdir(), `toolbar-games-check-${process.pid}`);
const libraryRoot = path.join(tmp, 'SteamLibrary');
const apps = path.join(libraryRoot, 'steamapps');
const clientRoot = path.join(tmp, 'SteamClient');
const iconRoot = path.join(clientRoot, 'appcache', 'librarycache');
const trainerRoot = path.join(tmp, 'trainers');

const failures = [];
const expect = (cond, message) => { if (!cond) failures.push(message); };
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const HASH = '0123456789abcdef0123456789abcdef01234567';

function acf(appid, name, { played = 0 } = {}) {
  // LauncherPath 按真清单的写法：值里的反斜杠是双写的
  const launcher = `${clientRoot}\\steam.exe`.replace(/\\/g, '\\\\');
  return `"AppInstallId"\t\t"${appid}"
"appid"\t"${appid}"
"name"\t"${name}"
"StateFlags"\t"4"
"installdir"\t"${name}"
"LauncherPath"\t"${launcher}"
"LastPlayed"\t"${played}"
"SizeOnDisk"\t"1073741824"
`;
}

function iconOf(appid) {
  return path.join(iconRoot, String(appid), `${HASH}.jpg`);
}

function writeFixtures() {
  fs.mkdirSync(path.join(apps, 'common'), { recursive: true });
  fs.mkdirSync(trainerRoot, { recursive: true });

  // LastPlayed 写的是「什么时候玩过」的时间戳，不是「几天前」——按真清单的语义造
  const games = [
    [4115450, 'Phantom Blade Zero', NOW - 2 * DAY],
    [377530, '侠客风云传(Tale of Wuxia)', NOW - 4 * DAY],
    [681830, 'Sword and Fairy 5', NOW - 6 * DAY],
    [681840, 'Sword and Fairy 5 Prequel', NOW - 8 * DAY],
    [631510, 'Devil May Cry HD Collection', 0],
    [1196590, 'Resident Evil Village', NOW - 1 * DAY],
    [620, 'Portal 2', 0]
  ];
  for (const [appid, name, played] of games) {
    fs.writeFileSync(path.join(apps, `appmanifest_${appid}.acf`), acf(appid, name, { played }), 'utf8');
    fs.mkdirSync(path.dirname(iconOf(appid)), { recursive: true });
    fs.writeFileSync(iconOf(appid), 'fake jpeg', 'utf8');
  }
  // 没图标的一款：走 appCacheDirs 里那个不存在的根也照样不该崩
  fs.writeFileSync(path.join(apps, 'appmanifest_70.acf'), acf(70, 'Portal'), 'utf8');

  // 每款游戏 0～3 个修改器，名字按真机上的写法
  const trainers = [
    '[风灵]《影之刃零》修改器.exe',
    '[风灵]《侠客风云传》修改器.exe',
    '[小幸]《侠客风云传》修改器.exe',
    '《侠客风云传》修改器.exe',
    '[小幸]《仙剑奇侠传五》修改器.exe',
    '[小幸]《仙剑奇侠传五前传》修改器.exe',
    '《鬼泣1：HD》修改器.exe',
    '《鬼泣2：HD》修改器.exe',
    '《生化危机2：重制版》修改器.exe',
    '《博德之门3》修改器.exe',
    'unins000.exe'
  ];
  for (const name of trainers) fs.writeFileSync(path.join(trainerRoot, name), 'fake exe', 'utf8');
  // 一层子目录里的 exe 用目录名当显示名：这条走的是和真机一样的取名字规则
  const sub = path.join(trainerRoot, '[小幸]《仙剑奇侠传七》修改器 方块、Steam、Wegame等平台版本');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'trainer.exe'), 'fake exe', 'utf8');
}

function build(getConfig) {
  const steam = new Steam({ getConfig, openExternal: () => Promise.resolve(true), openPath: () => Promise.resolve('') });
  const trainers = new Trainers({ getConfig });
  return { steam, trainers, library: new Library({ steam, trainers }) };
}

const CFG = () => ({ steam: { folder: libraryRoot }, trainers: { folder: trainerRoot } });

async function main() {
  writeFixtures();

  // ---------- 别名表自身的完整性 ----------
  const steamCanons = new Map();
  for (const entry of GAMES) {
    const key = canon(entry.steam);
    expect(!steamCanons.has(key), `别名表里 "${entry.steam}" 归一化后和 "${steamCanons.get(key)}" 撞了`);
    steamCanons.set(key, entry.steam);
    expect(entry.keys.length > 0, `别名表里 "${entry.steam}" 一个 keys 都没有`);
    for (const alias of entry.keys) {
      expect(canon(alias).length >= 2, `别名 "${alias}" 归一化后太短，会到处乱认`);
    }
  }

  // 长名字必须先赢：《仙剑奇侠传五前传》不能被《仙剑奇侠传五》截走
  expect(trainerOwner('[小幸]《仙剑奇侠传五前传》修改器') === canon('Sword and Fairy 5 Prequel'), '五前传被五截走了');
  expect(trainerOwner('[小幸]《仙剑奇侠传五》修改器') === canon('Sword and Fairy 5'), '仙剑五认错了');
  expect(trainerOwner('《只狼：影逝二度》修改器') === null, '库里没有的《只狼》居然认出了主人');
  expect(gameEntry('Devil May Cry HD Collection') !== null, '合集这款没在表里');
  expect(gameEntry('Portal 2') === null, '没登记的 Portal 2 不该被认成登记过');

  // ---------- 标签文案 ----------
  expect(chipLabel('[风灵]《侠客风云传》修改器') === '风灵', `[风灵]《侠客风云传》修改器 => 「${chipLabel('[风灵]《侠客风云传》修改器')}」，应是「风灵」`);
  expect(
    chipLabel('[小幸]《仙剑奇侠传七》修改器 XGP（XBox Game Pass）平台版本') === '小幸 · XGP 平台版本',
    `XGP 那条抠出来是「${chipLabel('[小幸]《仙剑奇侠传七》修改器 XGP（XBox Game Pass）平台版本')}」`
  );
  expect(chipLabel('《DMC：鬼泣》修改器 v1.0 Plus 9') === 'v1.0 Plus 9', `DMC 那条是「${chipLabel('《DMC：鬼泣》修改器 v1.0 Plus 9')}」`);
  // 除了游戏名什么都没剩：退回原名，《鬼泣1：HD》那种编号就是唯一的区分信息
  expect(chipLabel('《鬼泣1：HD》修改器') === '《鬼泣1：HD》修改器', `鬼泣1 那条退回了「${chipLabel('《鬼泣1：HD》修改器')}」`);

  // ---------- 拼出来的行 ----------
  const { steam, library } = build(CFG);
  const first = library.list(true);
  expect(!first.error, `主进程这边报了错：${first.error}`);

  const byName = new Map(first.rows.map((row) => [row.name, row]));
  expect(first.rows.length === 8, `库里写了 8 款，列表给了 ${first.rows.length} 款`);
  // Steam 自己的顺序（最近游玩优先）不能被拼列表打乱：fixture 里昨天刚玩过 RE Village
  expect(first.rows[0].name === 'Resident Evil Village', `第一行是「${first.rows[0].name}」，应按最近游玩排`);
  expect(byName.get('Portal')?.icon === null, '没有图标的一款应该给 null，而不是指向不存在的路径');
  expect(byName.get('Phantom Blade Zero')?.icon === iconOf(4115450), '图标没从 appcache/librarycache 里认出来');
  expect(byName.get('Resident Evil Village')?.trainers.length === 0, '没登记的 Portal/RE Village 不该有标签');
  expect(byName.get('侠客风云传(Tale of Wuxia)')?.trainers.length === 3, `侠客风云传应有 3 个标签，实际 ${byName.get('侠客风云传(Tale of Wuxia)')?.trainers.length}`);
  expect(byName.get('Devil May Cry HD Collection')?.trainers.length === 2, '鬼泣 HD 合集应有 1、2 两个标签');
  expect(byName.get('Sword and Fairy 5')?.trainers.length === 1, '仙剑五只该拿到自己那一个标签');
  expect(byName.get('Sword and Fairy 5 Prequel')?.trainers.length === 1, '仙剑五前传只该拿到自己那一个标签');
  // 《博德之门3》对不上这款库里的任何游戏：按他定的规则整条不显示
  const allChips = first.rows.flatMap((row) => row.trainers.map((chip) => chip.name));
  expect(!allChips.some((name) => name.includes('博德之门')), '对不上 Steam 的修改器还是露出来了');
  expect(!allChips.some((name) => name.includes('unins')), '卸载器被当成修改器列了出来');
  // matched 数的是「认到主人的修改器」，包含主人没装进库的那两条（《仙剑七》《生化危机2》），
  // 所以它比真正落到行上的标签多——行里只会出现装了游戏的那批。
  expect(allChips.length === 8, `行里应有 8 个标签，实际 ${allChips.length}`);
  expect(first.stats.matched === 10, `stats.matched=${first.stats.matched}，认到主人的应是 10 条`);
  expect(first.stats.games === 8 && first.stats.icons === 7 && first.stats.withTrainer === 5, `stats 不对：${JSON.stringify(first.stats)}`);

  // 给渲染层的只有这几样：id / appid / 名字 / 图标 / 时间 / 大小 / 标签
  const rowKeys = Object.keys(first.rows[0]).sort().join(',');
  expect(rowKeys === 'appid,icon,id,name,played,size,trainers', `行字段变了：${rowKeys}`);
  expect(!JSON.stringify(first.rows).includes(trainerRoot), '行数据里漏了修改器目录');
  for (const row of first.rows) {
    for (const chip of row.trainers) {
      expect(Object.keys(chip).sort().join(',') === 'id,name,short', `标签字段变了：${Object.keys(chip).join(',')}`);
      expect(typeof chip.id === 'number', '标签 id 不是数字，trainers.launch 会认不到');
    }
  }
  // 图标是主进程自己扫出来的绝对路径，只能指向 librarycache
  for (const row of first.rows.filter((r) => r.icon)) {
    expect(row.icon.includes(path.join('appcache', 'librarycache')), `图标路径不在 librarycache 下：${row.icon}`);
  }

  // ---------- 缓存：没过期不重算 ----------
  const again = library.list(false);
  expect(again.cached === true && again.rows === first.rows, '第二次调用没走缓存');
  const forced = library.list(true);
  expect(forced.cached === undefined && forced.rows !== first.rows, 'force 之后应该重算出一份新行');

  // ---------- 配置缺任何一边：报人话，别崩 ----------
  const noSteam = build(() => ({ steam: { folder: '' }, trainers: { folder: trainerRoot } })).library.list(true);
  expect(noSteam.error?.includes('Steam 库'), `没配 Steam 库时的文案：${JSON.stringify(noSteam.error)}`);
  expect(noSteam.rows.length === 0 && noSteam.stats.games === 0, '报错时不该留下半截列表');
  const noTrainers = build(() => ({ steam: { folder: libraryRoot }, trainers: { folder: '' } })).library.list(true);
  expect(noTrainers.error?.includes('修改器'), `没配修改器目录时的文案：${JSON.stringify(noTrainers.error)}`);
  const badFolder = build(() => ({ steam: { folder: path.join(tmp, '没有这个库') }, trainers: { folder: trainerRoot } })).library.list(true);
  expect(badFolder.error?.includes('steamapps'), `库不存在时的文案：${JSON.stringify(badFolder.error)}`);

  // ---------- steam 那份 payload + appCacheDirs ----------
  // 这次 scan(true) 会刷新 scannedAt，所以放在缓存那条之后
  const steamPayload = steam.scan(true);
  expect(!('dir' in steamPayload.items[0]) && !('clientRoot' in steamPayload.items[0]), 'steam:list 把安装目录/客户端根透给了渲染层');
  // 清单里写的客户端根是真存在的那个，不存在的（多库/搬过 Steam）会被滤掉
  const roots = steam.appCacheDirs();
  expect(roots.length === 1 && roots[0] === path.join(clientRoot, 'appcache', 'librarycache'), `appCacheDirs 给的根不对：${JSON.stringify(roots)}`);
  expect(steam.appCacheDirs().every((dir) => fs.existsSync(dir)), 'appCacheDirs 把不存在的目录也给了出去');
}

main()
  .then(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (failures.length) {
      for (const line of failures) console.log(`✗ ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log(`✓ 游戏列表自检全绿：别名表 ${GAMES.length} 条无碰撞、长名字先赢、图标按 librarycache 认出、标签文案按写法抠出、对不上 Steam 的修改器整条不显示、行数据里没有任何 exe 路径`);
  })
  .catch((error) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.error(`[games-check] 失败：${error.stack}`);
    process.exitCode = 1;
  });
