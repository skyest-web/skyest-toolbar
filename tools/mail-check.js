// 邮箱服务（163 IMAP 只读）的离线自检：不起应用、不连真服务器、不碰任何真邮箱。
//
// 它注入一个假 ImapFlow 客户端，于是能验到最要紧的五件事：
// 1) 取哪一截（序列号窗口 total-N+1:*、上限 200 封、60 秒缓存、force 绕缓存、连接复用、并发只一条会话）；
// 2) 排成什么顺序（最新的在前），未读数按整箱 SEARCH 而不是「这一窗里有几条没读」；
// 3) 跨 IPC 的东西里有没有授权码（行数据、错误文案、status 里的 auth 都得干净）；
// 4) 服务器把话怼回来时，他看到的是「去哪儿开 IMAP」而不是裸错误码，而且手里那条死连接被丢掉；
// 5) 授权码落盘只走 DPAPI：能读回来、文件里没有明文、safeStorage 不在时直接拒存。
//
// 用法（Git Bash）: node tools/mail-check.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// mail.js 在模块顶层就取了 electron.safeStorage / electron.shell，而普通 node 里 require('electron')
// 只会拿到一个二进制路径字符串，那两个都是 undefined —— 授权码这一段就没法验。
// 于是在 require mail.js 之前把 'electron' 换成一份假的：safeStorage 用「异或 + 魔数头」扮演 DPAPI
// （只验「文件里没有明文、还能原样读回来」，不验真加密强度），并留一个开关演「加密不可用」那条分支。
const opened = [];
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
  if (request === 'electron') return { safeStorage: fakeSafeStorage, shell: { openExternal: (url) => shellOpened.push(url) } };
  return realLoad.call(this, request, parent, isMain);
};
const { Mail, MailAuth, FALLBACK, AUTH_FILE } = require('../src/main/services/mail');
Module._load = realLoad;

const PASS = 'qwertyasdfghjklz'; // 16 位，和 163 给的那串形状一样
const failures = [];

function expect(cond, message) {
  if (!cond) failures.push(message);
}

// 形状照 imapflow 的真实返回：ENVELOPE 整个收在 msg.envelope 里（from/subject/date 都在里面），
// flags 是 Set，只有 seq/uid 平铺。假数据必须照库写，不能照实现写——照着有 bug 的实现写，
// 「满屏未知发件人 /（无主题）」能一路测绿。
// rawDate 扮演服务器给的日期串解析不了（imapflow 就原样留字符串）；subject/from 传 null 扮演 NIL（字段干脆不存在）。
function message(seq, { name, address, subject, minutes, seen = true, rawDate = false }) {
  const date = new Date(Date.now() - minutes * 60000);
  const envelope = { date: rawDate ? date.toUTCString() : date };
  if (subject !== null) envelope.subject = subject;
  if (name !== null) envelope.from = [{ name, address }];
  return {
    seq,
    uid: 1000 + seq,
    envelope,
    flags: new Set(seen ? ['\\Seen'] : []),
    size: 2048
  };
}

// 假客户端：形状照 imapflow 现在用的那几个方法（connect / getMailboxLock / fetch / search /
// mailbox.exists / logout / close / on），记账每次调用；三个 *Throws 用来扮演服务器把话怼回来。
function fakeClient(spec = {}) {
  const calls = { connect: 0, lock: [], fetch: [], search: 0, logout: 0, close: 0, events: [] };
  const messages = spec.messages || [];
  const client = {
    calls,
    connected: false,
    mailbox: { exists: spec.total ?? messages.length },
    on(event, handler) {
      calls.events.push(event);
      if (event === 'error' && spec.emitError) setTimeout(() => spec.emitError(handler), 0);
    },
    async connect() {
      calls.connect += 1;
      if (spec.connectThrows) throw spec.connectThrows;
      client.connected = true;
    },
    async getMailboxLock(box) {
      calls.lock.push(box);
      if (spec.lockThrows) throw spec.lockThrows;
      return { path: box, release() {} };
    },
    async *fetch(range) {
      calls.fetch.push(range);
      if (spec.fetchThrows) throw spec.fetchThrows;
      for (const msg of messages) yield msg;
    },
    async search() {
      calls.search += 1;
      return spec.unseenIds !== undefined
        ? spec.unseenIds
        : messages.filter((msg) => !msg.flags.has('\\Seen')).map((msg) => msg.uid);
    },
    async logout() {
      calls.logout += 1;
      client.connected = false;
    },
    close() {
      calls.close += 1;
      client.connected = false;
    }
  };
  return client;
}

// options 只管「配置长什么样、有没有授权码、密钥存哪」；服务器怼回来的样子一律写在 spec 里。
function service(spec = {}, options = {}) {
  const box = { client: null, made: 0 };
  const events = [];
  const mail = new Mail({
    getConfig: () => ({ mail: { ...FALLBACK, account: 'abc@163.com', ...(options.config || {}) } }),
    dir: options.dir,
    getAuth: () => (options.noAuth ? null : PASS),
    clientFactory: () => {
      box.client = fakeClient(spec);
      box.made += 1;
      return box.client;
    },
    openExternal: (url) => opened.push(url),
    onEvent: (channel, payload) => events.push({ channel, ...(payload || {}) })
  });
  return { mail, box, events };
}

async function main() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'toolbar-mail-check-')), 'userData');
  // 先把授权码按应用真实的样子存进 userData：后面 status 里那个 hint、以及换码丢连接都读这份真文件
  new MailAuth(dir).set(PASS);

  // ---------- 1. 三种「还没配好」必须先说清楚，别去握手 ----------
  const off = service({}, { config: { enabled: false } });
  const offResult = await off.mail.list(true);
  expect(offResult.error === '邮箱在设置里被关了' && off.box.made === 0, `邮箱被关掉却还是去连了：${offResult.error}`);

  const noAccount = service({}, { config: { account: '' } });
  const noAccountResult = await noAccount.mail.list(true);
  expect(noAccountResult.error?.includes('设置 → 邮箱 → 账号') && noAccount.box.made === 0, `没填账号却没提示去哪儿填：${noAccountResult.error}`);

  const noPass = service({}, { noAuth: true });
  const noPassResult = await noPass.mail.list(true);
  expect(noPassResult.error?.includes('授权') && noPass.box.made === 0, `没存授权码却还是握手了：${noPassResult.error}`);

  // ---------- 2. 取哪一截：窗口是尾部 N 封，序列号从 total-N+1 起 ----------
  // 30 封里 i%3===0 的没读；取尾部 20 封（i=10..29）时窗内只有 6 封未读，而整箱 SEARCH 说 17 —— 两个数必须分开
  const many = Array.from({ length: 30 }, (_, i) =>
    message(i + 1, { name: `发件人${i + 1}`, address: `a${i + 1}@163.com`, subject: `主题 ${i + 1}`, minutes: i, seen: i % 3 !== 0 })
  );
  const win = service(
    { total: 500, messages: many.slice(-20), unseenIds: Array.from({ length: 17 }, (_, i) => 9000 + i) },
    { dir }
  );
  const got = await win.mail.list(true);
  expect(got.ok === true, `拉取失败：${got.error}`);
  expect(win.box.client.calls.fetch[0] === '481:*', `窗口起点不对，实际取的是 ${win.box.client.calls.fetch[0]}`);
  expect(win.box.client.calls.lock.join() === 'INBOX', `选中邮箱目录不对：${JSON.stringify(win.box.client.calls.lock)}`);
  expect(got.rows.length === 20, `行数不对，实际 ${got.rows.length}`);
  expect(got.stats.unseen === 17 && got.rows.filter((row) => row.unseen).length === 6,
    `未读数该按整箱 SEARCH 给 17（这一窗里只有 6 条），实际 ${got.stats.unseen}`);
  expect(got.rows.every((row, i) => row.id === i), 'id 不是从 0 连续编号（渲染层只认 id）');
  expect(got.rows[0].date >= got.rows[got.rows.length - 1].date, '列表不是最新的在前');
  expect(got.rows[0].subject === '主题 11' && got.rows[0].address === 'a11@163.com',
    `第一行不是最新那封：${JSON.stringify(got.rows[0])}`);

  // 收件箱比窗口小：起点收到 1，而不是算出 0 或负数
  const tiny = service({ total: 3, messages: many.slice(0, 3) }, { config: { maxMessages: 20 } });
  await tiny.mail.list(true);
  expect(tiny.box.client.calls.fetch[0] === '1:*', `收件箱比窗口小时起点没收到 1：${tiny.box.client.calls.fetch[0]}`);

  // 空箱：不发 fetch，也不报成错误
  const empty = service({ total: 0, messages: [] });
  const none = await empty.mail.list(true);
  expect(none.ok === true && none.rows.length === 0 && none.stats.total === 0, `空收件箱被报成错误：${none.error}`);
  expect(empty.box.client.calls.fetch.length === 0, '空收件箱还去 fetch 了');

  // ---------- 2b. ENVELOPE 的字段读法：读错一层，整屏都是兜底文案 ----------
  // 这节是踩过一次才加的：rowOf 曾按平铺的 msg.from / msg.subject 读，而 imapflow 把它们收在 msg.envelope 里，
  // 于是真邮箱 66 封全渲染成「未知发件人 /（无主题）」——而假数据照抄了实现，所以那版自检一路全绿。
  const odd = [
    message(1, { name: '招商银行信用卡中心', address: 'no-reply@cmbchina.com', subject: '账单与还款提醒', minutes: 5 }),
    message(2, { name: '发件人2', address: 'a2@163.com', subject: null, minutes: 6 }), // 服务器把 SUBJECT 回成 NIL：字段干脆不存在
    message(3, { name: null, address: null, subject: '主题 3', minutes: 7, rawDate: true }), // FROM 是 NIL + 日期串认不出来
    message(4, { name: '', address: 'solo@163.com', subject: '只有地址没有名字', minutes: 8 }) // 显示名为空，退回邮箱地址
  ];
  const oddService = service({ total: 4, messages: odd });
  const oddRows = (await oddService.mail.list(true)).rows;
  expect(oddRows[0].name === '招商银行信用卡中心' && oddRows[0].subject === '账单与还款提醒',
    `没从 msg.envelope 里读 from/subject：${JSON.stringify(oddRows[0])}`);
  expect(oddRows[0].date > Date.now() - 600000, `date 是 Date 时没取成毫秒：${oddRows[0].date}`);
  const bySeq = (seq) => oddRows.find((row) => row.seq === seq) || {};
  expect(bySeq(2).subject === '（无主题）', 'SUBJECT 为 NIL 时没落到兜底文案');
  expect(bySeq(3).name === '未知发件人', 'FROM 为 NIL 时没落到兜底文案');
  expect(bySeq(3).date > 0, 'date 是字符串时没解析成毫秒');
  expect(bySeq(4).name === 'solo@163.com', '显示名为空时没退回邮箱地址');

  // 库把字段改名时也要有动静：断言装的这一版 imapflow 确实把 ENVELOPE 收成 msg.envelope.subject/.from/.date
  const imapflowTools = fs.readFileSync(
    path.join(path.dirname(require.resolve('imapflow/package.json')), 'dist/cjs/tools.js'),
    'utf8'
  );
  expect(/map\.envelope\s*=\s*parseEnvelope\(/.test(imapflowTools)
    && /envelope\.subject\s*=/.test(imapflowTools)
    && /envelope\.from\s*=/.test(imapflowTools)
    && /envelope\.date\s*=/.test(imapflowTools),
    '装的 imapflow 不再把 ENVELOPE 收成 msg.envelope.{date,subject,from}，rowOf 的读法要跟着改');

  // ---------- 3. 上限、缓存、复用、并发 ----------
  const capped = service({ total: 9000, messages: many.slice(0, 2) }, { config: { maxMessages: 5000 } });
  await capped.mail.list(true);
  expect(capped.box.client.calls.fetch[0] === '8801:*', `maxMessages 没夹到 200，窗口是 ${capped.box.client.calls.fetch[0]}`);

  const cached = service({ total: 4, messages: many.slice(0, 4) });
  await cached.mail.list(true);
  const second = await cached.mail.list(false);
  expect(second.cached === true && cached.box.client.calls.fetch.length === 1, '60 秒内的第二次读取又去拉了一遍');
  const third = await cached.mail.list(true);
  expect(third.cached !== true && cached.box.client.calls.fetch.length === 2, '点「刷新」却还是走了缓存');

  // 连接是复用的：还连着就不该重新握手，更不该 new 出第二条会话
  const reused = service({ total: 4, messages: many.slice(0, 4) });
  await reused.mail.list(true);
  reused.box.client.calls.connect = 0;
  await reused.mail.list(true);
  expect(reused.box.made === 1 && reused.box.client.calls.connect === 0,
    `客户端明明还连着，却又 new 了一个（made=${reused.box.made} connect=${reused.box.client.calls.connect}）`);

  // 并发只允许一条会话在飞，两次拿到的是同一批数据
  const racing = service({ total: 4, messages: many.slice(0, 4) });
  const [ra, rb] = await Promise.all([racing.mail.list(true), racing.mail.list(true)]);
  expect(racing.box.made === 1 && racing.box.client.calls.connect === 1,
    `并发拉取开了两条会话（made=${racing.box.made} connect=${racing.box.client.calls.connect}）`);
  expect(ra.rows === rb.rows, '并发两次返回不是同一批数据');

  // ---------- 4. 授权码不出门 ----------
  const outside = JSON.stringify({ rows: got.rows, stats: got.stats, status: win.mail.status() });
  expect(!outside.includes(PASS), '行数据或 status 里出现了授权码明文');
  const st = win.mail.status();
  expect(st.account === 'abc@163.com', `status 没把账号带出去（设置那一格要用它显示）：${st.account}`);
  expect(Object.keys(st.auth).sort().join() === 'encrypted,hint,set',
    `status 的 auth 字段形状变了（只该有 set/hint/encrypted）：${JSON.stringify(st.auth)}`);
  expect(st.auth.set === true && st.auth.hint.includes('位') && !st.auth.hint.includes(PASS),
    `auth 没按「只给 hint」露出来：${JSON.stringify(st.auth)}`);

  // ---------- 5. 服务器怼回来时：说人话、不漏码、丢连接 ----------
  const connectFails = service({ connectThrows: Object.assign(new Error(`Authenticating failed: LOGIN ${PASS} invalid`), { code: 'EAUTH' }) });
  const bad = await connectFails.mail.list(true);
  expect(bad.error?.includes('授权码不对'), `登录失败没翻成人话：${bad.error}`);
  expect(!bad.error?.includes(PASS), `错误文案里漏了授权码：${bad.error}`);
  expect(connectFails.mail.client === null, '握手失败后手里还留着那条连接');

  const fetchFails = service({ total: 4, messages: many.slice(0, 4), fetchThrows: new Error('socket timeout') });
  const stale = await fetchFails.mail.list(true);
  expect(stale.error?.includes('连不上'), `拉取中途超时没说清：${stale.error}`);
  expect(fetchFails.box.client.calls.logout === 1 && fetchFails.mail.client === null,
    `失败后没把手里那条连接丢掉（logout=${fetchFails.box.client.calls.logout}）`);

  const unsafe = service({ connectThrows: new Error('[ALERT] Unsafe Login. Please contact 客服 for help') });
  expect((await unsafe.mail.list(true)).error?.includes('开启'), '「Unsafe Login」没告诉他去开 IMAP');

  const dns = service({ connectThrows: Object.assign(new Error('queryA ENOTFOUND imap.163.com'), { code: 'ENOTFOUND' }) });
  const dnsResult = await dns.mail.list(true);
  expect(dnsResult.error?.includes('这台机器连不上'), `域名解析失败没说清：${dnsResult.error}`);

  const mailboxBad = service({ total: 4, messages: many.slice(0, 4), lockThrows: Object.assign(new Error('NO Mailbox does not exist')) });
  const mailboxResult = await mailboxBad.mail.list(true);
  expect(mailboxResult.error?.includes('INBOX'), `目录打不开没报成可读的错：${mailboxResult.error}`);

  // 事件监听器必须挂上：imapflow 抛 'error' 时没人听会冒到主进程顶层弹模态框
  expect(win.box.client.calls.events.includes('error'), `没给客户端挂 error 监听：${JSON.stringify(win.box.client.calls.events)}`);

  // 别人家的失败不该弄丢正常服务手里已有的列表：他先看「信还在不在」，再看那句错误
  const afterFail = await win.mail.list(true);
  expect(afterFail.ok === true && afterFail.rows.length === 20, `前面的失败把行数据弄丢了：${afterFail.error}`);

  // ---------- 6. 交给系统浏览器的地址只从配置来 ----------
  opened.length = 0;
  const web = win.mail.openWebmail();
  await Promise.resolve();
  expect(web.ok === true && opened[0] === FALLBACK.webmail, `正常网页地址没交给浏览器：${JSON.stringify({ web, opened })}`);

  opened.length = 0;
  const notUrl = service({}, { config: { webmail: 'mail.163.com' } });
  expect(notUrl.mail.openWebmail().ok === false && opened.length === 0, '不像 URL 的地址也照样交给浏览器了');

  // 应用里没注入 openExternal，走的是 electron.shell —— 这条默认路径也得通
  shellOpened.length = 0;
  const viaShell = new Mail({ getConfig: () => ({ mail: { account: 'abc@163.com' } }), getAuth: () => PASS });
  viaShell.openWebmail();
  await Promise.resolve();
  expect(shellOpened[0] === FALLBACK.webmail, `没注入 openExternal 时没走 shell：${JSON.stringify(shellOpened)}`);

  // ---------- 7. 授权码落盘：只走 DPAPI，绝不退化成明文 ----------
  const file = path.join(dir, AUTH_FILE);
  const auth = new MailAuth(dir);
  expect(auth.set(PASS).ok === true, 'safeStorage 可用时保存失败了');
  expect(fs.existsSync(file), '保存成功却没落盘');
  expect(!fs.readFileSync(file).includes(PASS), '落盘的字节里能直接读到授权码明文');
  expect(new MailAuth(dir).get() === PASS, '换个实例读不回来（加密/解密对不上）');
  expect(auth.status().set === true && auth.status().hint.includes(String(PASS.length)), '状态没说自己是已保存');
  expect(auth.set('   ').ok === false, '空授权码没被拒');
  expect(auth.set('abcd efgh ijkl').ok === false, '带空格的授权码没被拒');
  expect(auth.set('abc123').ok === false, '太短的授权码没被拒');
  expect(auth.clear().set === false && auth.get() === null && !fs.existsSync(file), 'clear 之后还能读到东西');

  // safeStorage 暂时不可用时：宁可不存，也不写明文
  fakeSafeStorage.enabled = false;
  expect(new MailAuth(dir).set(PASS).ok === false, '没有 safeStorage 却保存成功了（等于明文落盘）');
  expect(!fs.existsSync(file), '没有 safeStorage 却还是往盘上写了东西');
  fakeSafeStorage.enabled = true;

  // 换了授权码，手里那条连接用的还是旧凭据，必须丢掉
  const reauth = service({ total: 1, messages: many.slice(0, 1) }, { dir });
  await reauth.mail.list(true);
  expect(reauth.mail.setAuth('newpass12345678ab').ok === true && reauth.box.client.calls.logout === 1 && reauth.mail.client === null,
    `换了授权码却没丢连接（logout=${reauth.box.client.calls.logout}）`);
  expect(new Mail({ getConfig: () => ({}) }).setAuth('newpass12345678ab').ok === false, '没有 userData 目录却存下授权码了');

  // ---------- 8. 老 toolbar.config.json 里根本没有 mail 段 ----------
  const bareStatus = new Mail({ getConfig: () => ({}) }).status();
  expect(bareStatus.host === 'imap.163.com' && bareStatus.port === 993 && bareStatus.mailbox === 'INBOX' &&
    bareStatus.maxMessages === 20 && bareStatus.pollMs === 120000,
    `配置里没有 mail 段时默认值没兜住：${JSON.stringify(bareStatus)}`);

  // 配置里填了乱七八糟的值：主机/端口/超时/目录/上限都得被修成能用的，而且真的传到连接上
  let seenOptions = null;
  const messy = new Mail({
    getConfig: () => ({ mail: { account: ' abc@163.com ', host: '', port: 'abc', timeoutMs: '50', mailbox: '   ', maxMessages: '5000' } }),
    getAuth: () => PASS,
    clientFactory: (options) => {
      seenOptions = options;
      return fakeClient({ total: 0, messages: [] });
    }
  });
  await messy.list(true);
  expect(seenOptions.host === 'imap.163.com' && seenOptions.port === 993 && seenOptions.secure === true,
    `乱填的主机/端口没修：${JSON.stringify(seenOptions)}`);
  expect(seenOptions.socketTimeout === 3000 && seenOptions.connTimeout === 3000,
    `过短的超时没夹到 3 秒：${seenOptions.socketTimeout}`);
  expect(seenOptions.auth.user === 'abc@163.com' && seenOptions.auth.pass === PASS, `账号/授权码没原样交给 IMAP：${JSON.stringify(seenOptions.auth)}`);
  // 163 收不到 IMAP ID 就回「Unsafe Login」，这份 clientInfo 正是那条报错的解药
  expect(seenOptions.clientInfo?.name === 'screen-toolbar' && seenOptions.logger === false,
    `clientInfo/logger 没按预期传：${JSON.stringify({ ci: seenOptions.clientInfo, logger: seenOptions.logger })}`);
  expect(messy.cfg().mailbox === 'INBOX' && messy.cfg().maxMessages === 200,
    `空目录/超大上限没被修：${JSON.stringify(messy.cfg())}`);

  // ---------- 9. 新邮件提醒：基线那一轮不喊，之后只看 uid ----------
  const grew = { total: 4, messages: many.slice(0, 4) };
  const watch = service(grew);
  await watch.mail.list(true);
  expect(watch.events.filter((event) => event.channel === 'mail:new').length === 0,
    `开机第一轮把旧未读当成新邮件播报了：${JSON.stringify(watch.events)}`);
  expect(watch.events.some((event) => event.channel === 'mail:updated'), '拉到了却没推 mail:updated，开着的那一格不会重画');

  // IMAP 的 uid 随到达递增：比基线大的就是这一轮新到的
  watch.box.client.mailbox.exists = 6;
  grew.messages.push(
    message(5, { name: '张三', address: 'zs@163.com', subject: '主题 5', minutes: -1 }),
    message(6, { name: '李四', address: 'ls@163.com', subject: '主题 6', minutes: -2 })
  );
  await watch.mail.list(true);
  const announced = watch.events.filter((event) => event.channel === 'mail:new');
  expect(announced.length === 1 && announced[0].count === 2 && announced[0].name === '李四',
    `新到两封没报成「2 封 / 最新那封的发件人」：${JSON.stringify(announced)}`);

  // 同一批不重复播报：下一次轮询没有新 uid 就该完全安静
  await watch.mail.list(true);
  expect(watch.events.filter((event) => event.channel === 'mail:new').length === 1,
    '没有新邮件也重复播报了（提醒会变成噪音）');

  // uid 空间整体变小（换目录 / 邮箱被重建）：「比基线大」没有意义，重打基线且不播报，
  // 下一次真新到了才报——否则要么从此哑掉，要么把整窗当成刚到的喊一遍
  const shrankSpec = { total: 4, messages: many.slice(0, 4) };
  const shrank = service(shrankSpec);
  await shrank.mail.list(true); // 基线 uid=1004
  shrank.box.client.mailbox.exists = 1;
  shrankSpec.messages.length = 0;
  shrankSpec.messages.push(message(1, { name: '赵六', address: 'zl@163.com', subject: '主题 1', minutes: 3 })); // uid=1001 < 基线
  await shrank.mail.list(true);
  expect(shrank.events.filter((event) => event.channel === 'mail:new').length === 0,
    `uid 空间变小那一次把整窗当成新邮件播报了：${JSON.stringify(shrank.events.filter((event) => event.channel === 'mail:new'))}`);
  shrank.box.client.mailbox.exists = 2;
  shrankSpec.messages.push(message(2, { name: '钱七', address: 'qq@163.com', subject: '主题 2', minutes: -1 })); // uid=1002，基线已重打到 1001
  await shrank.mail.list(true);
  const afterShrink = shrank.events.filter((event) => event.channel === 'mail:new');
  expect(afterShrink.length === 1 && afterShrink[0].count === 1 && afterShrink[0].name === '钱七',
    `重打基线之后新到的一封没报出来：${JSON.stringify(afterShrink)}`);

  // notify 关掉：updated 照发（列表要跟着刷新），new 一条都不发
  const quietSpec = { total: 2, messages: many.slice(0, 2) };
  const quiet = service(quietSpec, { config: { notify: false } });
  await quiet.mail.list(true);
  quiet.box.client.mailbox.exists = 3;
  quietSpec.messages.push(message(3, { name: '王五', address: 'ww@163.com', subject: '主题 3', minutes: -1 }));
  await quiet.mail.list(true);
  expect(quiet.events.filter((event) => event.channel === 'mail:new').length === 0
    && quiet.events.filter((event) => event.channel === 'mail:updated').length === 2,
    `关掉提醒后不该再发 mail:new：${JSON.stringify(quiet.events.map((event) => event.channel))}`);

  // ---------- 10. 看护定时器：只有主进程这一条，且改配置不重启就生效 ----------
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  const timers = [];
  const live = () => timers.filter((entry) => !entry.cleared).length;
  const fresh = () => {
    timers.length = 0;
  };
  global.setInterval = (fn, ms) => {
    const entry = { fn, ms, cleared: false };
    timers.push(entry);
    return entry;
  };
  global.clearInterval = (entry) => {
    if (entry) entry.cleared = true;
  };
  try {
    fresh();
    const ticking = service({ total: 1, messages: many.slice(0, 1) }, { config: { pollMs: 1000 } });
    await ticking.mail.list(true); // 先建出那条假连接，下面才量得到 fetch 次数
    ticking.mail.sync();
    expect(timers.length === 1 && timers[0].ms === 30000,
      `看护间隔没夹到 30 秒下限（163 会限流）：${JSON.stringify(timers.map((entry) => entry.ms))}`);
    ticking.mail.sync();
    expect(timers.length === 2 && live() === 1, `sync 两次留下了 ${live()} 条定时器，轮询会越存越多`);
    // 到点真的去拉一次（把缓存假装过期，否则 list(false) 会直接复用上一轮）
    ticking.mail.fetchedAt = 0;
    const fetchedBefore = ticking.box.client.calls.fetch.length;
    timers[timers.length - 1].fn();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ticking.box.client.calls.fetch.length === fetchedBefore + 1, '定时器到点没有去拉取');

    fresh();
    const stopped = service({ total: 1, messages: many.slice(0, 1) }, { config: { pollMs: 60000 } });
    stopped.mail.sync();
    const created = timers.length;
    stopped.mail.dispose();
    expect(timers.length === created && live() === 0, 'dispose 没停掉看护定时器');

    fresh();
    service({ total: 1, messages: many.slice(0, 1) }, { config: { pollMs: 0 } }).mail.sync();
    expect(timers.length === 0, 'pollMs=0 是「只手动刷新」，不该起定时器');

    fresh();
    service({ total: 1, messages: many.slice(0, 1) }, { config: { enabled: false, pollMs: 60000 } }).mail.sync();
    expect(timers.length === 0, '邮箱在设置里被关了还起定时器');
  } finally {
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
  }

  fs.rmSync(path.dirname(dir), { recursive: true, force: true });

  if (failures.length) {
    for (const line of failures) console.error(`✗ ${line}`);
    console.error(`\n邮箱自检失败 ${failures.length} 项`);
    process.exitCode = 1;
    return;
  }
  console.log('✓ 邮箱自检全绿：三种没配好的说法、尾部窗口与空箱、200 封上限、60 秒缓存与连接复用、并发只一条会话、' +
    '未读按整箱算、最新在前、授权码不出现在行数据/错误文案/status、四类错误翻成人话且丢掉死连接、' +
    '网页地址只从配置来（含 shell 默认路径）、授权码只走 DPAPI 且换码即丢连接、老配置没有 mail 段也按默认跑、' +
    '新邮件只看 uid 增量（开机第一轮与 uid 变小那一次都不播报、notify 关掉只发 updated、同一批不重复报）、' +
    '看护定时器全应用只有主进程那一条（30 秒下限、sync 不叠加、pollMs=0 或关掉邮箱不起、dispose 会停）');
}

main().catch((err) => {
  console.error('✗ 邮箱自检自己炸了：', err);
  process.exitCode = 1;
});
