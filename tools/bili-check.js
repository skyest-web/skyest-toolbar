// B 站服务（只读列表 + 交给浏览器打开）的离线自检：不起应用、不出网、不碰任何真 cookie。
//
// 它注入一个假的 transport（真机上那是 https.get），于是能验到最要紧的六件事：
// 1) 三张单子各自的字段读法（稍后再看 data.list / 历史 data 本身是数组 / 收藏先夹子再 medias），
//    读错一层就是整屏兜底文案；
// 2) 60 秒缓存、force 绕缓存、section 与 folderId 的白名单（渲染层递进来的乱七八糟值不能变成请求）、
//    nav 全局只问一次；
// 3) SESSDATA 绝不出现在行数据、status、错误文案，更不出现在发出去的 URL 里（它只该在请求头）；
// 4) B 站的业务码翻成人话：-101 让他去重填、-403 让他别猛点，而不是甩一个负数；
// 5) open() 只认这次发出去的行 id，交给系统的地址一律是 bilibili.com 的 https——
//    渲染层递进来的字符串到不了 shell.openExternal；
// 6) cookie 落盘只走 DPAPI：能读回来、文件里没有明文、safeStorage 不在时直接拒存。
//
// 用法（Git Bash）: node tools/bili-check.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// bili.js 在模块顶层就取了 electron.safeStorage / electron.shell，而普通 node 里 require('electron')
// 只会拿到一个二进制路径字符串，那两个都是 undefined。于是在 require 之前换成一份假的：
// safeStorage 用「异或 + 魔数头」扮演 DPAPI（只验「文件里没有明文、还能原样读回来」），
// 并留一个开关演「加密不可用」那条分支。
const shellOpened = [];
const MAGIC = Buffer.from('fake-dpapi:');
const flip = (buf) => Buffer.from(buf.map((byte) => byte ^ 0x5a));
const fakeSafeStorage = {
  enabled: true,
  isEncryptionAvailable() {
    return fakeSafeStorage.enabled;
  },
  encryptString(plain) {
    return Buffer.concat([MAGIC, flip(Buffer.from(plain, 'utf8'))]);
  },
  decryptString(packed) {
    if (Buffer.compare(packed.subarray(0, MAGIC.length), MAGIC) !== 0) throw new Error('这份假 DPAPI 解不开不是它写的字节');
    return flip(packed.subarray(MAGIC.length)).toString('utf8');
  }
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  // 真的 shell.openExternal 回的是 Promise，假的也必须回一个：外面是 .then(onOk, onErr)，
  // 在这里改成同步返回就把「主进程会不会因为浏览器拒绝打开而炸」这条测漏了
  if (request === 'electron') {
    return {
      safeStorage: fakeSafeStorage,
      shell: {
        openExternal: (url) => {
          shellOpened.push(url);
          return Promise.resolve();
        }
      }
    };
  }
  return realLoad.call(this, request, parent, isMain);
};
const { Bili, BiliAuth, extractSessdata, coverUrl, translate, AUTH_FILE, CACHE_TTL_MS, MAX_ITEMS, ENDPOINTS } = require('../src/main/services/bili');
Module._load = realLoad;

// 形状和 163 那串一样是「一长串没有空格分号的字符」，故意取得足够特别，好让「漏了」在断言里显眼
const SESS = 'abcdef12%2C34567890ghijklmn*op';
const failures = [];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbar-bili-check-'));

function expect(cond, message) {
  if (!cond) failures.push(message);
}

// 假 transport：按 pathname 路由，记账每一次请求。routes 的值可以是 {json} 或 {error}
// （error 扮演 HTTP 层失败，如 not-json / ENOTFOUND / timeout）。
function fakeTransport(table = {}) {
  const seen = [];
  const transport = (url, options = {}) => {
    const parsed = new URL(url);
    seen.push({ url, cookie: options.cookie, pathname: parsed.pathname, search: parsed.search });
    const route = table[parsed.pathname];
    if (!route) return Promise.resolve({ ok: false, error: 'no-route' });
    return Promise.resolve(route.error ? { ok: false, error: route.error } : { ok: true, json: route.json });
  };
  transport.seen = seen;
  transport.count = (pathname) => seen.filter((entry) => entry.pathname === pathname).length;
  return transport;
}

// 稍后再看：data.list，条目带 progress（上次看到第几秒）
const toviewItem = (i) => ({
  bvid: `BV1toview${i}`,
  aid: 500000 + i,
  title: `稍后再看 ${i}`,
  owner: { name: `UP主${i}` },
  duration: 100 + i,
  progress: i === 1 ? 33 : 0,
  pic: `${i === 1 ? 'http' : 'https'}://i0.hdslb.com/bfs/seed/a${i}.jpg`,
  pubdate: 1700000000 + i
});

// 历史：data 本身就是一组（和别的接口不一样），字段是 view_at / cover
const historyItem = (i) => ({
  bvid: `BV1hist${i}`,
  aid: 600000 + i,
  title: `历史 ${i}`,
  owner: { name: `UP主${i}` },
  duration: 200 + i,
  view_at: 1700001000 + i,
  cover: `https://i0.hdslb.com/bfs/seed/h${i}.jpg`
});

const folderItem = (i) => ({ id: 900 + i, title: `收藏夹 ${i}`, media_count: 12 + i, cover: `https://i0.hdslb.com/bfs/seed/f${i}.jpg`, mid: 2333 });
const mediaItem = (i) => ({ id: 700000 + i, bvid: `BV1fav${i}`, title: `收藏 ${i}`, upper: { name: `UP收藏${i}` }, duration: 60 + i, cover: '', add_time: 1700002000 + i });

const navOk = { json: { code: 0, data: { isLogin: true, mid: 2333, uname: '肥鱼不上岸' } } };

// overrides 用来扮演某一条接口出错或回空；不给就是四张单子都有正常数据
function routeTable(overrides = {}) {
  return {
    [ENDPOINTS.nav]: navOk,
    [ENDPOINTS.toview]: { json: { code: 0, data: { list: [1, 2, 3, 4].map(toviewItem) } } },
    [ENDPOINTS.history]: { json: { code: 0, data: Array.from({ length: MAX_ITEMS + 5 }, (_, i) => historyItem(i + 1)) } },
    [ENDPOINTS.favFolders]: { json: { code: 0, data: { list: [folderItem(1), folderItem(2)] } } },
    [ENDPOINTS.favItems]: { json: { code: 0, data: { info: { media_count: 40 }, medias: [1, 2, 3].map(mediaItem) } } },
    ...overrides
  };
}

// options.noCookie = 还没填 cookie 的样子。每一次新建都给一个自己的 userData 子目录：
// 这一份假 DPAPI 文件是共享状态，两个服务串门就会把「换 cookie 立刻丢缓存」那节测成假绿。
let boxIndex = 0;
function service(overrides = {}, options = {}) {
  const transport = fakeTransport(routeTable(overrides));
  const bili = new Bili({ dir: path.join(root, `svc-${(boxIndex += 1)}`), transport });
  if (!options.noCookie) bili.setAuth(SESS);
  return { bili, transport };
}

async function main() {
  const dir = path.join(root, 'auth-probe');

  // ---------- 1. 还没填 cookie：说清去哪儿填，而且一趟请求都不发 ----------
  const bare = service({}, { noCookie: true });
  const bareList = await bare.bili.list('toview', { force: true });
  expect(bareList.error?.includes('SESSDATA') && bareList.error?.includes('设置'), `没 cookie 没说清去哪儿填：${bareList.error}`);
  expect(bare.transport.seen.length === 0, `没 cookie 却还是发了请求：${JSON.stringify(bare.transport.seen.map((entry) => entry.url))}`);
  expect(bare.bili.status().set === false, '没存 cookie 时 status 说自己已存');
  const bareCheck = await bare.bili.check();
  expect(bareCheck.ok === false && bare.transport.seen.length === 0, `没 cookie 的「测一下」还是发了请求：${JSON.stringify(bare.transport.seen)}`);

  // ---------- 2. 三张单子的字段读法 ----------
  const ok = service({});
  const toList = await ok.bili.list('toview', { force: true });
  expect(!toList.error, `稍后再看拉取失败：${toList.error}`);
  expect(toList.rows.length === 4 && toList.total === 4, `稍后再看行数不对：${toList.rows.length}/${toList.total}`);
  expect(toList.rows[0].id === 'v:BV1toview1', `稍后再看 id 形状不对：${toList.rows[0].id}`);
  expect(toList.rows[0].title === '稍后再看 1' && toList.rows[0].up === 'UP主1', `稍后再看没读到 title/owner.name：${JSON.stringify(toList.rows[0])}`);
  expect(toList.rows[0].duration === 101 && toList.rows[0].seenAt === 33, `progress/duration 没读出来（「上次看到」靠它）：${JSON.stringify({ d: toList.rows[0].duration, s: toList.rows[0].seenAt })}`);
  expect(toList.rows[1].seenAt === null, 'progress=0 被当成了「看到过第 0 秒」，界面会多出一句没意义的话');
  expect(toList.rows[0].cover.startsWith('https://'), `http 封面没升级成 https（https 页面里会被混合内容挡掉）：${toList.rows[0].cover}`);
  expect(toList.section === 'toview', `section 没回给渲染层：${toList.section}`);

  const hist = await ok.bili.list('history', { force: true });
  expect(!hist.error && hist.rows.length === MAX_ITEMS, `观看历史该截到 ${MAX_ITEMS} 行，实际 ${hist.rows?.length}（${hist.error || ''}）`);
  expect(hist.total === MAX_ITEMS + 5, `历史被截断但总数没带上（渲染层要写「这里列 30 / 共 N」）：${hist.total}`);
  expect(hist.rows[0].id === 'v:BV1hist1' && hist.rows[0].up === 'UP主1', `历史没从 data 数组本身读条目：${JSON.stringify(hist.rows[0])}`);
  expect(hist.rows[0].seenAt === null && hist.rows[0].viewAt === 1700001001, `历史的 view_at 没落到 viewAt：${JSON.stringify({ v: hist.rows[0].viewAt, s: hist.rows[0].seenAt })}`);

  const favs = await ok.bili.list('fav', { force: true });
  expect(!favs.error && favs.rows.length === 2, `收藏夹没列出夹子：${JSON.stringify({ n: favs.rows?.length, e: favs.error })}`);
  expect(favs.rows[0].kind === 'folder' && favs.rows[0].id === 'f:901' && favs.rows[0].count === 13, `夹子行字段不对：${JSON.stringify(favs.rows[0])}`);
  // 夹子那一次必须带上自己的 mid：favFolders 要 up_mid 才知道问谁的收藏
  const favCall = ok.transport.seen.find((entry) => entry.pathname === ENDPOINTS.favFolders);
  expect(favCall?.search.includes('up_mid=2333'), `收藏夹没把 nav 里的 mid 当 up_mid 递过去：${favCall?.search}`);

  const drilled = await ok.bili.list('fav', { force: true, folderId: favs.rows[0].folderId });
  expect(!drilled.error && drilled.rows.length === 3, `点进夹子没列到视频：${JSON.stringify({ n: drilled.rows?.length, e: drilled.error })}`);
  expect(drilled.folderId === 901, `下钻后 folderId 没回给渲染层（「← 收藏夹列表」那一个按钮靠它）：${drilled.folderId}`);
  expect(drilled.rows[0].id === 'v:BV1fav1' && drilled.rows[0].up === 'UP收藏1', `夹子里的视频没从 data.medias / upper.name 读：${JSON.stringify(drilled.rows[0])}`);
  expect(drilled.total === 40, `夹子里的总数没取 info.media_count：${drilled.total}`);
  expect(drilled.rows[0].cover === '', `没有封面的条目不该凭空造一个地址：${drilled.rows[0].cover}`);

  // nav 只该问一次：后面每张单子都复用同一个 mid，别拿 B 站的接口当心跳打
  expect(ok.transport.count(ENDPOINTS.nav) === 1, `nav 被重复问了 ${ok.transport.count(ENDPOINTS.nav)} 次`);

  // ---------- 3. 白名单 + 空数据 ----------
  const bogus = service({});
  const wrongSection = await bogus.bili.list('https://api.bilibili.com/x/v2/history', { force: true });
  expect(wrongSection.section === 'toview', `乱填的 section 没退回默认：${wrongSection.section}`);
  const wrongFolder = await bogus.bili.list('fav', { force: true, folderId: 'abc' });
  expect(wrongFolder.folderId === null, `乱填的 folderId 没归零：${wrongFolder.folderId}`);
  expect(wrongFolder.rows.length === 2 && wrongFolder.rows[0].kind === 'folder', `乱填的 folderId 却下钻成了视频列表：${JSON.stringify(wrongFolder.rows)}`);

  const empties = service(
    {
      [ENDPOINTS.toview]: { json: { code: 0, data: { list: [] } } },
      [ENDPOINTS.history]: { json: { code: 0, data: [] } },
      [ENDPOINTS.favFolders]: { json: { code: 0, data: { list: [] } } },
      [ENDPOINTS.favItems]: { json: { code: 0, data: { info: {}, medias: [] } } }
    }
  );
  const emptyCases = [['toview', {}], ['history', {}], ['fav', {}], ['fav', { folderId: 901 }]];
  for (const [section, opts] of emptyCases) {
    const emptyResult = await empties.bili.list(section, { force: true, ...opts });
    expect(!emptyResult.error && emptyResult.rows.length === 0, `空单子被报成了错误（${section}${opts.folderId ? ' 里的夹子' : ''}）：${emptyResult.error}`);
  }

  // 一条都没有的行：既没 bvid 也没 aid，直接丢，别留一行点开是空的
  const junk = service({ [ENDPOINTS.toview]: { json: { code: 0, data: { list: [{ title: '没编号' }, toviewItem(2)] } } } });
  const junkRows = await junk.bili.list('toview', { force: true });
  expect(junkRows.rows.length === 1 && junkRows.total === 2, `没有 bvid/aid 的条目没被丢掉：${JSON.stringify(junkRows.rows)}`);

  // aid 兜底：没有 bvid 的老稿件也要能打开
  const aidOnly = service({ [ENDPOINTS.toview]: { json: { code: 0, data: { list: [{ aid: 12345, title: '老稿件', pic: '' }] } } } });
  const aidRows = await aidOnly.bili.list('toview', { force: true });
  shellOpened.length = 0;
  expect(aidRows.rows[0].id === 'a:12345', `没有 bvid 时 id 没退回 av：${aidRows.rows[0].id}`);
  expect(aidOnly.bili.open('a:12345').ok === true && shellOpened[0] === 'https://www.bilibili.com/video/av12345', `av 兜底没交给浏览器：${JSON.stringify(shellOpened)}`);

  // ---------- 4. 缓存与 force ----------
  const cached = service({});
  const first = await cached.bili.list('toview', { force: true });
  const before = cached.transport.count(ENDPOINTS.toview);
  const second = await cached.bili.list('toview');
  expect(first.cached === false && second.cached === true, `60 秒内第二次读取没走缓存：cached=${second.cached}`);
  expect(cached.transport.count(ENDPOINTS.toview) === before, `走缓存却仍发了请求：${before} → ${cached.transport.count(ENDPOINTS.toview)}`);
  expect(second.rows === first.rows, '缓存返回的不是同一批行数据');
  const forced = await cached.bili.list('toview', { force: true });
  expect(forced.cached === false && cached.transport.count(ENDPOINTS.toview) === before + 1, `点「刷新」却还是走了缓存`);
  expect(CACHE_TTL_MS === 60000, `缓存时限变了（${CACHE_TTL_MS}），文档和探针里那句「60 秒」要跟着改`);

  // 每个 section / 每个夹子各自一条缓存：别拿稍后再看的结果回历史
  const perKey = await cached.bili.list('history', { force: true });
  expect(perKey.section === 'history' && perKey.rows[0].id === 'v:BV1hist1', `切到历史却读到稍后再看的缓存：${JSON.stringify(perKey.rows?.[0])}`);
  const favOnce = await cached.bili.list('fav', { force: true, folderId: 901 });
  const favAgain = await cached.bili.list('fav', { folderId: 901 });
  expect(favAgain.cached === true && favAgain.rows === favOnce.rows, `同一个夹子的第二次读取没走缓存`);
  expect((await cached.bili.list('fav')).cached === false, `换到夹子列表那一层却读到了夹子里视频的缓存`);

  // 失败的这一次不该被缓存住：否则一次网络抖动之后要等满 60 秒才能重试
  const flaky = service({ [ENDPOINTS.toview]: { error: 'ECONNRESET' } });
  const flakyFirst = await flaky.bili.list('toview');
  expect(flakyFirst.error?.includes('连不上') || flakyFirst.error?.includes('失败'), `连接被重置没说清：${flakyFirst.error}`);
  expect(flakyFirst.cached !== true, `失败结果被缓存了（一次抖动要等 60 秒才能重试）`);

  // ---------- 5. B 站的业务码翻成人话 ----------
  const expired = service({ [ENDPOINTS.toview]: { json: { code: -101, message: '账号未登录' } } });
  const expiredError = (await expired.bili.list('toview', { force: true })).error;
  expect(/-101/.test(expiredError) && /SESSDATA/.test(expiredError), `-101 没翻成「去重填 SESSDATA」：${expiredError}`);
  const risk = service({ [ENDPOINTS.toview]: { json: { code: -403, message: '访问权限异常' } } });
  expect(/风控/.test((await risk.bili.list('toview', { force: true })).error || ''), '-403 没翻成「风控」');
  const verify = service({ [ENDPOINTS.toview]: { json: { code: -352, message: 'risk check error' } } });
  expect(/验证/.test((await verify.bili.list('toview', { force: true })).error || ''), '-352 没说要先过一次验证');
  const notJson = service({ [ENDPOINTS.toview]: { error: 'not-json' } });
  expect(/不是 JSON/.test((await notJson.bili.list('toview', { force: true })).error || ''), '网关回 HTML 时没说清');
  const dns = service({ [ENDPOINTS.toview]: { error: 'ENOTFOUND' } });
  expect(/连不上 api\.bilibili\.com/.test((await dns.bili.list('toview', { force: true })).error || ''), '解析失败没说清');
  const slow = service({ [ENDPOINTS.toview]: { error: 'ETIMEDOUT' } });
  expect(/超时/.test((await slow.bili.list('toview', { force: true })).error || ''), '超时没说清');
  expect(translate(-400, '')?.includes('-400'), `-400 没翻出来：${translate(-400, '')}`);
  expect(translate(0) === null, 'code 0 不该翻成错误');
  expect(translate(-99999, '奇怪的说明')?.includes('奇怪的说明'), '没见过的码没把 B 站的说明带上');

  // isLogin:false：code 是 0，光看 code 会当成成功
  const notLogged = service({ [ENDPOINTS.nav]: { json: { code: 0, data: { isLogin: false, mid: 0, uname: '' } } } });
  const notLoggedResult = await notLogged.bili.list('toview', { force: true });
  expect(notLoggedResult.error?.includes('没登录'), `isLogin:false 被当成了登录成功：${notLoggedResult.error}`);
  expect(notLogged.bili.status().logged === null, `没登录却把 nav 的结果留在了 status 里：${JSON.stringify(notLogged.bili.status())}`);

  // ---------- 6. cookie 一个字节都不出门 ----------
  const outside = JSON.stringify({ list: toList.rows, hist: hist.rows, favs: favs.rows, drilled: drilled.rows, status: ok.bili.status() });
  expect(!outside.includes(SESS), '行数据或 status 里出现了 SESSDATA 明文');
  expect(!outside.includes('SESSDATA='), '行数据里漏了 cookie 的形状');
  expect(ok.transport.seen.every((entry) => !entry.url.includes(SESS)), 'SESSDATA 被拼进了 URL（它只该在请求头）');
  expect(ok.transport.seen.every((entry) => entry.cookie === SESS), `有的请求没带上 cookie：${JSON.stringify(ok.transport.seen.map((entry) => Boolean(entry.cookie)))}`);
  expect(ok.transport.seen.every((entry) => entry.url.startsWith('https://api.bilibili.com')),
    `出网打到了 api.bilibili.com 之外的地方：${JSON.stringify([...new Set(ok.transport.seen.map((entry) => entry.url))])}`);
  const st = ok.bili.status();
  expect(Object.keys(st).sort().join() === 'encrypted,hasCookie,hint,logged,mid,set,uname', `status 的字段形状变了：${JSON.stringify(Object.keys(st).sort())}`);
  expect(st.hint.includes('位') && st.hint.endsWith(SESS.slice(-2)), `hint 没按「只给位数 + 尾两字」来：${st.hint}`);
  expect(st.logged === true && st.uname === '肥鱼不上岸' && st.mid === 2333, `status 没把登录身份带出去（设置那一格要用）：${JSON.stringify(st)}`);

  // B 站的 message 里带上凭据时，翻错误也不能原样拼出去
  const leaky = service({ [ENDPOINTS.nav]: { json: { code: -101, message: `bad cookie ${SESS}`, data: null } } });
  const leakError = (await leaky.bili.list('toview', { force: true })).error || '';
  expect(!leakError.includes(SESS), `错误文案里漏了 cookie：${leakError}`);

  // ---------- 7. open()：只认这次发出去的行 id，地址一律主进程拼 ----------
  shellOpened.length = 0;
  const opened = ok.bili.open('v:BV1toview1');
  await Promise.resolve();
  expect(opened.ok === true && shellOpened[0] === 'https://www.bilibili.com/video/BV1toview1', `点一行没把视频页交给浏览器：${JSON.stringify({ opened, shellOpened })}`);
  expect(opened.toast.includes('上次看到 00:33'), `有 progress 的行没在 toast 里带上「上次看到」：${opened.toast}`);
  expect(!JSON.stringify(opened).includes(SESS), '交给渲染层的那句 toast 里漏了 cookie');

  shellOpened.length = 0;
  const openedNoProgress = ok.bili.open('v:BV1toview2');
  await Promise.resolve();
  expect(openedNoProgress.ok === true && !openedNoProgress.toast.includes('上次看到'), '没看过的行硬编了一句「上次看到」');

  shellOpened.length = 0;
  const openedHistory = ok.bili.open('v:BV1hist1');
  await Promise.resolve();
  expect(openedHistory.ok === true && shellOpened[0] === 'https://www.bilibili.com/video/BV1hist1', `历史那一条交给浏览器时地址不对：${JSON.stringify(shellOpened)}`);

  shellOpened.length = 0;
  const openedFolder = ok.bili.open('f:901');
  await Promise.resolve();
  expect(openedFolder.ok === true && /^https:\/\/space\.bilibili\.com\/2333\/favlist\?fid=901/.test(shellOpened[0]), `夹子那一条没交给个人空间：${JSON.stringify(shellOpened)}`);

  // 只给 id 不给 URL：渲染层能递进来的字符串永远只是 id
  shellOpened.length = 0;
  const injected = ok.bili.open('https://evil.example.com/');
  expect(injected.ok === false && shellOpened.length === 0, `渲染层递进来的字符串被当成地址交给浏览器了：${JSON.stringify({ injected, shellOpened })}`);
  const unknown = ok.bili.open('v:BV1neverissued');
  expect(unknown.ok === false && unknown.error?.includes('刷新'), `不认识的 id 没说「先点刷新」：${unknown.error}`);
  // flush 之后连刚才发出去过的行都不该再认得
  ok.bili.flush();
  expect(ok.bili.open('v:BV1toview1').ok === false, 'flush 之后 open 还认得上一批行');
  expect(ok.bili.status().logged === null, 'flush 没把 nav 一起丢掉（换 cookie 后还报旧账号名）');

  // ---------- 8. cookie 换 / 清：缓存和 nav 都得跟着丢 ----------
  const swap = service({});
  await swap.bili.list('toview', { force: true });
  const navBefore = swap.transport.count(ENDPOINTS.nav);
  expect(swap.bili.setAuth('zzzz%2Cyyyyyyyyxxxxxxxx1234').ok === true, '换 cookie 没存下');
  expect(swap.transport.count(ENDPOINTS.nav) === navBefore, '换 cookie 时不该自己去问 nav');
  const afterSwap = await swap.bili.list('toview', { force: true });
  expect(afterSwap.cached === false && swap.transport.count(ENDPOINTS.nav) === navBefore + 1, `换了 cookie 却读到上一个账号的缓存：cached=${afterSwap.cached}`);
  expect(swap.transport.seen.at(-1).cookie === 'zzzz%2Cyyyyyyyyxxxxxxxx1234', '换完 cookie 发请求还在用旧的那串');
  expect(swap.bili.status().uname === '肥鱼不上岸', `换 cookie 之后 status 里的旧账号名该跟着 flush 掉：${swap.bili.status().uname}`);

  shellOpened.length = 0;
  expect(swap.bili.clearAuth().set === false, '清除 cookie 后 status 还说已存');
  expect((await swap.bili.list('toview')).error?.includes('SESSDATA'), '清完 cookie 还能列单子');

  // ---------- 9. 粘法：整串 cookie / 只粘值 / 粘错了都怎么算 ----------
  const cookieHeader = 'buvid3=ABCDEF; SESSDATA=abcdef%2C12345%2Aghijklmnop; bili_jct=deadbeef';
  expect(extractSessdata(cookieHeader) === 'abcdef%2C12345%2Aghijklmnop', `粘整串 cookie 没取出 SESSDATA：${extractSessdata(cookieHeader)}`);
  expect(extractSessdata('abcdef%2C12345%2Aghijklmnop') === 'abcdef%2C12345%2Aghijklmnop', '只粘值时不该原样退回');
  expect(extractSessdata('SESSDATA=abc123; sid=123') === 'abc123', '整串里 SESSDATA 排第一时没取出来');
  expect(extractSessdata('sessdata=abc123; sid=123') === 'abc123', '字段名大小写不同也该认');
  expect(extractSessdata('buvid3=AAA; sid=123') === '', '整串里没有 SESSDATA 却硬取了一个值');
  const extract = service({});
  expect(extract.bili.setAuth(cookieHeader).ok === true, '粘整串 cookie 没保存成功');
  expect(extract.bili.auth.get() === 'abcdef%2C12345%2Aghijklmnop', `存下来的不是 SESSDATA 那一个值：${extract.bili.auth.get()}`);
  expect(extract.bili.setAuth('   ').ok === false, '空的没被拒');
  expect(extract.bili.setAuth('SESSDATA=abc def ghi').ok === false, '带空格的没被拒');
  expect(extract.bili.setAuth('sessdata=short').ok === false, '太短的没被拒');
  expect(extract.bili.setAuth('buvid3=onlyothercookievalue').ok === false, '粘了没有 SESSDATA 的整串却保存成功了');

  // ---------- 10. 封面地址的形状：只收 http(s)，别的都不给渲染层 ----------
  expect(coverUrl('http://x/y.jpg') === 'https://x/y.jpg', 'http 没升级');
  expect(coverUrl('//i0.hdslb.com/y.jpg') === '', '协议相对地址不该放行（<img> 会跟着页面走 file://）');
  expect(coverUrl('file:///D:/a.jpg') === '', '本地路径不该当成封面放出去');
  expect(coverUrl(null) === '', 'null 封面没兜住');

  // ---------- 11. check()：先清缓存再真问一次 nav ----------
  const checked = service({});
  await checked.bili.list('toview', { force: true });
  const checkBefore = checked.transport.count(ENDPOINTS.nav);
  const checkResult = await checked.bili.check();
  expect(checkResult.ok === true && checkResult.logged === true && checkResult.uname === '肥鱼不上岸', `「测一下」没回登录态：${JSON.stringify(checkResult)}`);
  expect(checked.transport.count(ENDPOINTS.nav) === checkBefore + 1, '「测一下」没真问 nav');
  expect(!JSON.stringify(checkResult).includes(SESS), '「测一下」的返回里漏了 cookie');

  const failCheck = service({ [ENDPOINTS.nav]: { error: 'ECONNRESET' } });
  const failed = await failCheck.bili.check();
  expect(failed.ok === false && Boolean(failed.error), `「测一下」连不上时该回 ok:false + 人话：${JSON.stringify(failed)}`);

  // ---------- 12. cookie 落盘：只走 DPAPI，绝不退化成明文 ----------
  const file = path.join(dir, AUTH_FILE);
  const auth = new BiliAuth(dir);
  expect(auth.set(SESS).ok === true, 'safeStorage 可用时保存失败了');
  expect(fs.existsSync(file), '保存成功却没落盘');
  const packed = fs.readFileSync(file);
  expect(!packed.includes(SESS), '落盘的字节里能直接读到 cookie 明文');
  expect(new BiliAuth(dir).get() === SESS, '换个实例读不回来（加密/解密对不上）');
  expect(auth.status().hint === `${SESS.length} 位 · 尾 ${SESS.slice(-2)}`, `hint 掩码不对：${auth.status().hint}`);
  fakeSafeStorage.enabled = false;
  expect(new BiliAuth(dir).set(SESS).ok === false, '没有 safeStorage 却保存成功了（等于明文落盘）');
  expect(fs.readFileSync(file).equals(packed), '没有 safeStorage 却还是动了盘上那份');
  fakeSafeStorage.enabled = true;
  expect(auth.clear().set === false && !fs.existsSync(file), 'clear 之后文件还在');

  fs.rmSync(path.dirname(dir), { recursive: true, force: true });

  if (failures.length) {
    for (const line of failures) console.error(`✗ ${line}`);
    console.error(`\nB 站自检失败 ${failures.length} 项`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ B 站自检全绿：没 cookie 一趟请求都不发、三张单子各自的字段读法（data.list / data 是数组 / 夹子再 medias）与 ${MAX_ITEMS} 行上限、` +
    '空单子不算错误、http 封面升级 https、60 秒缓存与 force 绕缓存（失败不缓存、每档各一条）、nav 只问一次、' +
    'section 与 folderId 白名单、六种错误码翻成人话（-101 去重填、-403 风控、-352 要验证、非 JSON、超时、解析失败）、' +
    'isLogin:false 不算成功、SESSDATA 不出现在行数据/status/错误文案/URL（只在请求头）、出网只有 api.bilibili.com 一个主机、' +
    'open 只认这次发出去的行 id 且地址一律 bilibili.com（含 av 兜底、flush 后不再认）、' +
    '换或清 cookie 立刻丢缓存与账号名、粘整串 cookie 只取 SESSDATA、cookie 只走 DPAPI 且没有 safeStorage 就拒存');
}

main().catch((err) => {
  console.error('✗ B 站自检自己炸了：', err);
  process.exitCode = 1;
});
