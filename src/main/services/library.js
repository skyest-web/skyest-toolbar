// 游戏列表：把 Steam 库 + 修改器目录 + 别名表 + 本地图标缓存拼成渲染层要的那一份行数据。
//
// 这一层只读不写：Steam 和修改器各自的启动/定位仍走它们自己的 IPC，
// 渲染层拿到的 id 就是那两个服务自己的缓存序号，点对调 steam.launch、点标签调 trainers.launch。
//
// 图标是 Steam 自己缓存的本地图（<客户端根>/appcache/librarycache/<appid>/<40位哈希>.jpg），
// 那个哈希是 CDN 文件名的 sha1，猜不出来，只能列目录取里面唯一那张 .jpg。
// 这里把路径原样交给渲染层拼 file:///，跟桌宠图标同一个做法；CSP 已经放了 file:。

const fs = require('node:fs');
const path = require('node:path');
const { canon, gameEntry, trainerOwner } = require('./game-alias');

// librarycache 里每个 appid 目录只有一张 40 位十六进制命名的 .jpg，那就是 32×32 的方图标
const ICON_RE = /^[0-9a-f]{40}\.jpg$/i;
const VENDOR_RE = /[\[【]([^\]】]*)[\]】]/;
const GAME_PART_RE = /《([^》]*)》/;

// 标签上只写「谁做的 + 哪一版」：游戏名已经在行首了，修改器四个字也不用重复。
// 全删完什么都不剩时退回原名——《鬼泣1：HD》那种，编号就是唯一的区分信息。
function chipLabel(name) {
  const text = String(name || '');
  const vendor = (text.match(VENDOR_RE) || [])[1]?.trim() || '';
  const rest = text
    .replace(/[\[【][^\]】]*[\]】]/g, ' ')
    .replace(/《[^》]*》/g, ' ')
    .replace(/（[^）]*）|\([^)]*\)/g, ' ')
    .replace(/修改器|trainer/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (rest) return vendor ? `${vendor} · ${rest}` : rest;
  return vendor || text;
}

class Library {
  // steam / trainers 是两个已存在的扫描服务，这里只消费它们的缓存结果
  constructor({ steam, trainers } = {}) {
    this.steam = steam;
    this.trainers = trainers;
    this.rows = [];
    this.iconCache = new Map();
    this.stamp = '';
    this.stats = { games: 0, registered: 0, withTrainer: 0, trainers: 0, matched: 0, icons: 0 };
  }

  // 任一侧重扫过（scannedAt 变了）就重算并清图标缓存；否则直接回上次的行
  list(force = false) {
    const s = this.steam.scan(force);
    const t = this.trainers.scan(force);
    // 两个文件夹原样带回去：渲染层靠它判断「配置里换过目录了」，好自动重扫，也好在空列表里报当前路径
    const folders = { steamFolder: this.steam.folderPath(), trainersFolder: this.trainers.folderPath() };
    if (s.error || t.error) {
      // 一边没配好也照常出列表：只有游戏没有修改器，或者只有修改器没有游戏，都不该让整块空掉
      this.rows = [];
      this.stamp = '';
      this.stats = { games: 0, registered: 0, withTrainer: 0, trainers: 0, matched: 0, icons: 0 };
      return { rows: [], error: s.error || t.error, stats: this.stats, ...folders };
    }

    const stamp = `${this.steam.folder}|${this.trainers.folder}|${this.steam.scannedAt}|${this.trainers.scannedAt}`;
    if (!force && stamp === this.stamp && this.stamp) return { rows: this.rows, cached: true, stats: this.stats, ...folders };

    const byGame = new Map();
    for (const trainer of t.items) {
      const owner = trainerOwner(trainer.name);
      if (!owner) continue;
      if (!byGame.has(owner)) byGame.set(owner, []);
      byGame.get(owner).push({ id: trainer.id, name: trainer.name, short: chipLabel(trainer.name) });
    }

    const roots = this.steam.appCacheDirs();
    this.iconCache = new Map();
    const rows = s.items.map((game) => {
      const chips = byGame.get(canon(game.name)) || [];
      return {
        // id 就是 Steam 服务那批缓存里的序号：点行首的游戏名走 steam.launch(id)
        id: game.id,
        appid: game.appid,
        name: game.name,
        icon: this.iconFor(roots, game.appid),
        played: game.played,
        size: game.size,
        // 对不上 Steam 的修改器不显示；反过来对不上修改器的游戏照样在列表里，只是没有标签
        trainers: chips
      };
    });

    this.rows = rows;
    this.stamp = stamp;
    this.stats = {
      games: rows.length,
      // 表里登记了、这局却一个修改器都没抓到：多半是游戏在 Steam 里改了名，或者那包的修改器没下载
      registered: rows.filter((row) => !row.trainers.length && gameEntry(row.name)).length,
      withTrainer: rows.filter((row) => row.trainers.length).length,
      trainers: t.items.length,
      matched: [...byGame.values()].reduce((sum, list) => sum + list.length, 0),
      icons: rows.filter((row) => row.icon).length
    };
    return { rows, stats: this.stats, ...folders };
  }

  iconFor(roots, appid) {
    if (this.iconCache.has(appid)) return this.iconCache.get(appid);
    let found = null;
    for (const dir of roots) {
      const appDir = path.join(dir, String(appid));
      let names = null;
      try {
        names = fs.readdirSync(appDir);
      } catch (err) {
        continue;
      }
      const file = names.find((name) => ICON_RE.test(name));
      if (file) {
        found = path.join(appDir, file);
        break;
      }
    }
    this.iconCache.set(appid, found);
    return found;
  }
}

module.exports = { Library, chipLabel };
