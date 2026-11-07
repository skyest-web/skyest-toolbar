// 修改器 ↔ Steam 游戏的对应表。
//
// 为什么必须内置：修改器的文件名是中文叫法（《鬼泣5》修改器），Steam 清单里的 name 是商店名
// （Devil May Cry 5），两边没有一处能直接对上——实测 65 个修改器里只有 5 个名字能撞上。
// 所以这里按这台机器上的实际名字手写一张别名表，不做手动绑定的 UI。
//
// 用法：
//   · steam 字段写 **Steam 清单里的原名**，游戏那一侧靠 canon 精确相等来认（改名字了就是没对上，游戏照样显示，只是没有修改器）。
//   · keys 写修改器文件里会出现的**游戏名说法**，修改器那一侧靠「包含」来认，并按 key 长度从长到短试——
//     这样《仙剑奇侠传五前传》不会被《仙剑奇侠传五》抢走。
//   · 对不上 Steam 的修改器不显示（他定的），所以 keys 只服务「认得出主人」这一件事。

// 归一化：小写 → 去掉成对的方括号/圆括号组（厂商前缀 [风灵]、平台后缀（XGP版）都是噪声）→
// 只留汉字、字母、数字。NFKC 会把 ™ 摊平成 TM，省得「Street Fighter™ 6」这种名字到处漏。
const DROP_GROUPS_RE = /(\[[^\]]*\]|【[^】]*】|\([^)]*\)|（[^）]*）)/g;

function canon(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(DROP_GROUPS_RE, ' ')
    .replace(/[^0-9a-z\u4e00-\u9fff]+/g, '');
}

const GAMES = [
  { steam: 'Phantom Blade Zero', keys: ['影之刃零'] },
  { steam: 'Cyberpunk 2077', keys: ['赛博朋克2077'] },
  { steam: '侠客风云传(Tale of Wuxia)', keys: ['侠客风云传'] },
  { steam: 'Sword and Fairy 4', keys: ['仙剑奇侠传四', '仙剑奇侠传4'] },
  { steam: 'Sword and Fairy 5', keys: ['仙剑奇侠传五', '仙剑奇侠传5'] },
  { steam: 'Sword and Fairy 5 Prequel', keys: ['仙剑奇侠传五前传', '仙剑奇侠传5前传'] },
  { steam: 'Sword and Fairy 6', keys: ['仙剑奇侠传六', '仙剑奇侠传6'] },
  { steam: 'Sword and Fairy 7', keys: ['仙剑奇侠传七', '仙剑奇侠传7'] },
  { steam: '古剑奇谭三(Gujian3)', keys: ['古剑奇谭三', '古剑奇谭3'] },
  { steam: '鬼谷八荒 Tale of Immortal', keys: ['鬼谷八荒'] },
  { steam: 'Tomb Raider', keys: ['古墓丽影9'] },
  { steam: 'Rise of the Tomb Raider', keys: ['古墓丽影崛起'] },
  { steam: 'Shadow of the Tomb Raider', keys: ['古墓丽影暗影'] },
  // 合集是一个游戏、三份修改器：三个 key 都归到同一款，列表里就是一行三个标签
  { steam: 'Devil May Cry HD Collection', keys: ['鬼泣1', '鬼泣2', '鬼泣3'] },
  { steam: 'Devil May Cry 4 Special Edition', keys: ['鬼泣4'] },
  { steam: 'Devil May Cry 5', keys: ['鬼泣5'] },
  { steam: 'DmC Devil May Cry', keys: ['DMC鬼泣', 'DMC：鬼泣'] },
  { steam: 'ONE PIECE: PIRATE WARRIORS 4', keys: ['海贼无双4'] },
  { steam: 'Black Myth: Wukong', keys: ['黑神话悟空'] },
  { steam: 'Hogwarts Legacy', keys: ['霍格沃茨之遗'] },
  { steam: 'Street Fighter V', keys: ['街头霸王5'] },
  { steam: 'Persona 5 Royal', keys: ['女神异闻录5皇家版'] },
  { steam: 'The Elder Scrolls V: Skyrim Special Edition', keys: ['上古卷轴5天际重制版', '上古卷轴5'] },
  { steam: 'Two Point Campus', keys: ['双点校园'] },
  { steam: 'The Scroll of Taiwu : Beyond The Dome', keys: ['太吾绘卷'] },
  { steam: "Sid Meier's Civilization VI", keys: ['文明6'] },
  { steam: 'The Witcher 3: Wild Hunt — Remastered', keys: ['巫师3'] },
  { steam: 'Grand Theft Auto V Enhanced', keys: ['侠盗猎车5', 'GTA5'] },
  { steam: 'Chinese Parents', keys: ['中国式家长'] },
  { steam: 'JUMP FORCE', keys: ['Jump大乱斗'] },
  { steam: 'Resident Evil 2', keys: ['生化危机2'] },
  { steam: 'Resident Evil 3', keys: ['生化危机3'] },
  { steam: 'Resident Evil 4', keys: ['生化危机4'] }
];

// key → 该归到哪款游戏，按 key 长度倒序排好：长名字先认，避免《五前传》被《五》截走
const KEY_INDEX = GAMES.flatMap((entry) => {
  const steam = canon(entry.steam);
  return entry.keys
    .map((key) => ({ key: canon(key), steam, label: entry.steam }))
    .filter((item) => item.key.length >= 2);
}).sort((a, b) => b.key.length - a.key.length);

const STEAM_INDEX = new Map(GAMES.map((entry) => [canon(entry.steam), entry.steam]));

// 一款 Steam 游戏在表里的那一行；没登记的游戏返回 null（列表照样显示它，只是没有修改器标签）
function gameEntry(steamName) {
  const known = STEAM_INDEX.get(canon(steamName));
  return known ? GAMES.find((entry) => entry.steam === known) || null : null;
}

// 一个修改器归谁：返回表里对应的 steam 原名，认不出返回 null
function trainerOwner(trainerName) {
  const text = canon(trainerName);
  if (!text) return null;
  for (const item of KEY_INDEX) {
    if (text.includes(item.key)) return item.steam;
  }
  return null;
}

module.exports = { GAMES, canon, gameEntry, trainerOwner };
