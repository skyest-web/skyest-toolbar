// 修改器扫描/启动服务的离线自检：不起应用、也不碰 H 盘那个真目录。
//
// 两条腿：
// 1) 真 spawn 打在假 .exe（文本文件改名）上——它必然失败，要看的是"错误被接住了、没有冒到顶层"。
//    顶层冒出异常，就是应用里那个「A JavaScript error occurred in the main process」错误框的来路。
// 2) 注入只记账的 spawn 替身，按剧本喂 'error' / 'close'。于是「EACCES 补发一次 UAC」「UAC 被点否」
//    「文案里不许带盘符路径」这几条能离线断言，跑自检这台机器上一个弹窗都不会出现。
//
// 用法（Git Bash）: node tools/trainers-check.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Trainers } = require('../src/main/services/trainers');

const tmp = path.join(os.tmpdir(), `toolbar-trainers-check-${process.pid}`);
const failures = [];

function expect(cond, message) {
  if (!cond) failures.push(message);
}

// EventEmitter 上 'error' 没人听是同步抛出的，所以这里不用造假象：服务漏接一条，
// 自检进程自己就炸。把它记成失败，好让后面的断言汇总照常打印。
process.on('uncaughtException', (err) => {
  failures.push(`顶层冒出异常（应用里那个错误框就是这么来的）：${err?.message || err}`);
});

// 剧本一个调用一条：{error:'EACCES'} 只报错；{close:n, stderr:'…'} 起来之后按码退出
function fakeSpawn(script) {
  const calls = [];
  const spawnFn = (exe, args, options) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.unref = () => {};   // 真的 ChildProcess 有这个方法，替身缺了就会在 spawnResult 里炸
    calls.push({ exe, args: args || [], options: options || {} });
    const step = script[calls.length - 1];
    queueMicrotask(() => {
      if (!step) return;
      if (step.error) child.emit('error', Object.assign(new Error(`spawn ${exe} ${step.error}`), { code: step.error }));
      else {
        child.emit('spawn');
        if (step.close !== undefined) {
          if (step.stderr) child.stderr.emit('data', Buffer.from(step.stderr));
          child.emit('close', step.close);
        }
      }
    });
    return child;
  };
  spawnFn.calls = calls;
  return spawnFn;
}

// 每个剧本一个新实例：lastLaunch 是实例状态，共用的话第二个剧本会被 3 秒防抖挡掉
function trainersWith(spawnFn) {
  const trainers = new Trainers({ getConfig: () => ({ trainers: { folder: tmp } }), spawn: spawnFn });
  trainers.scan(true);
  return trainers;
}

const hasPath = (text) => /[A-Za-z]:[\\/]/.test(String(text || ''));

// 某条 Promise 没人兑现时，事件循环空了 Node 就安静退出 0——"看起来过了"是最坏的结果。
// 这条兜底把那种情况变成明确的失败。
const watchdog = setTimeout(() => {
  for (const line of failures) console.log(`✗ ${line}`);
  console.log('✗ 自检卡住了：有一条 Promise 没人兑现（替身少发了事件，或者服务少接了一条回调）');
  process.exit(1);
}, 20000);
// 故意不 unref：卡住的时候事件循环是空的，unref 的定时器根本不会响

async function main() {
  try {
    fs.mkdirSync(path.join(tmp, '[风灵]《测试游戏》修改器'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '《顶层假修改器》.exe'), 'not a real exe');
    fs.writeFileSync(path.join(tmp, 'unins000.exe'), 'uninstaller, must be skipped');
    fs.writeFileSync(path.join(tmp, 'readme.txt'), 'must be ignored');
    fs.writeFileSync(path.join(tmp, '[风灵]《测试游戏》修改器', 'TestGame v1.0 Trainer.exe'), 'not a real exe');
    fs.writeFileSync(path.join(tmp, '[风灵]《测试游戏》修改器', 'readme.txt'), 'must be ignored');
    // 一个目录里两个 exe：显示名要把文件名拼上才分得开
    fs.mkdirSync(path.join(tmp, '双版本'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '双版本', 'v1.exe'), 'x');
    fs.writeFileSync(path.join(tmp, '双版本', 'v2.exe'), 'x');

    const trainers = new Trainers({ getConfig: () => ({ trainers: { folder: tmp } }) });

    const first = trainers.scan(true);
    const names = first.items.map((item) => item.name);
    console.log(`扫到 ${first.items.length} 条：`);
    for (const item of first.items) console.log(`  ${String(item.id).padStart(2)} | ${item.name}  <=  ${path.relative(tmp, item.path)}`);

    expect(names.includes('[风灵]《测试游戏》修改器'), '子目录里的 exe 应该用目录名当显示名');
    expect(names.includes('《顶层假修改器》'), '顶层 exe 应该用去掉 .exe 的文件名');
    expect(names.some((n) => n.startsWith('双版本 · ')), '同目录多个 exe 没拼上文件名区分');
    expect(!names.some((n) => /unins/i.test(n)), '卸载器没被跳过');
    expect(!names.some((n) => /readme/i.test(n)), '非 exe 文件混进列表了');
    expect(first.items.every((item, index) => index === 0 || item.id === first.items[index - 1].id + 1), 'id 不是连续的');

    // 缓存命中：第二次 scan 不该重扫（scannedAt 不变）
    const at = trainers.status().scannedAt;
    const second = trainers.scan(false);
    expect(second.items.length === first.items.length, '缓存命中却给了不同长度');
    expect(trainers.status().scannedAt === at, '60 秒内不该重扫');

    // 只认缓存里的 id：路径进不来，过期要提示重扫
    expect((await trainers.launch(9999)).error?.includes('重扫'), '未知 id 没被挡在缓存这一层');
    expect((await trainers.launch('H:/随便一个.exe')).error?.includes('重扫'), '渲染层递路径进来居然被接受了？');

    // 真 spawn 打假 exe：失败要变成一条能显示的文案，而不是把路径原样甩回渲染层
    const bad = await trainers.launch(0);
    expect(bad.ok === false && Boolean(bad.error), `假 exe 的启动失败没被接住：${JSON.stringify(bad)}`);
    expect(!hasPath(bad.error), `启动失败的文案里带了盘符路径：${JSON.stringify(bad.error)}`);
    const again = await trainers.launch(0);
    expect(again.error?.includes('刚刚已经点过'), `3 秒防抖没生效：${JSON.stringify(again)}`);

    // ---- 剧本化的替身：一个框都不弹，只验接线 ----

    // 1) 普通权限点开了：只 spawn 一次，工作目录给的是 exe 旁边（很多 trainer 靠这个找自己的 dll）
    const plainSpawn = fakeSpawn([{}]);
    const plain = await trainersWith(plainSpawn).launch(0);
    expect(plain.ok === true && plain.elevated === false && !plain.autoElevated, `普通启动没报成功：${JSON.stringify(plain)}`);
    expect(plainSpawn.calls.length === 1, `普通启动多发了调用：${JSON.stringify(plainSpawn.calls.map((c) => c.exe))}`);
    expect(plainSpawn.calls[0].options.cwd && plainSpawn.calls[0].options.detached === true, `普通启动没给工作目录或没 detach：${JSON.stringify(plainSpawn.calls[0].options)}`);

    // 2) 异步 'error' = EACCES（exe 清单写了 requireAdministrator 就是这个）：接住，并且恰好补发一次 RunAs
    const upSpawn = fakeSpawn([{ error: 'EACCES' }, { close: 0 }]);
    const up = await trainersWith(upSpawn).launch(0);
    expect(upSpawn.calls.length === 2, `EACCES 之后补发的 spawn 次数不对（共 ${upSpawn.calls.length} 次）：${JSON.stringify(up)}`);
    const elevatedCall = upSpawn.calls[1];
    expect(elevatedCall?.exe === 'powershell.exe' && elevatedCall.args.join(' ').includes('-Verb RunAs'), `补发的那条不是 RunAs：${JSON.stringify(elevatedCall?.args)}`);
    expect(up.ok === true && up.autoElevated === true && up.elevated === true, `补发 UAC 成功却没说清：${JSON.stringify(up)}`);

    // 3) UAC 被点「否」：非零退出 + stderr 写「操作已被用户取消」，要说成取消，不能报成功
    const cancelSpawn = fakeSpawn([{ close: 1, stderr: 'Start-Process : 由于出现错误，无法运行此命令。操作已被用户取消。\r\n' }]);
    const cancelled = await trainersWith(cancelSpawn).launch(0, { elevated: true });
    expect(cancelled.ok === false && /UAC/.test(cancelled.error || ''), `取消 UAC 没说成取消：${JSON.stringify(cancelled)}`);
    expect(!hasPath(cancelled.error), `取消 UAC 的文案里带了盘符路径：${JSON.stringify(cancelled.error)}`);

    // 4) 补发 UAC 也失败（不是取消）：给出 PowerShell 那行的原因，同样不带路径
    const denySpawn = fakeSpawn([{ error: 'EACCES' }, { close: 1, stderr: 'Start-Process : This command cannot be run due to the error: C:\\ 盘不让执行。\r\n' }]);
    const denied = await trainersWith(denySpawn).launch(0);
    expect(denied.ok === false && !hasPath(denied.error), `提权失败的文案里带了盘符路径：${JSON.stringify(denied)}`);

    // 5) ENOENT（异步那条来路）翻成人话并且提示重扫，但不该去补发 UAC
    const goneSpawn = fakeSpawn([{ error: 'ENOENT' }]);
    const gone = await trainersWith(goneSpawn).launch(0);
    expect(gone.ok === false && /重扫/.test(gone.error || ''), `文件没了却没提示重扫：${JSON.stringify(gone)}`);
    expect(goneSpawn.calls.length === 1, `ENOENT 不该补发 UAC：${JSON.stringify(goneSpawn.calls.map((c) => c.exe))}`);

    // 没配目录 / 目录不存在：要给成人话，不能抛
    const none = new Trainers({ getConfig: () => ({ trainers: { folder: '' } }) }).scan(true);
    expect(none.error?.includes('还没配置'), `没配目录时没说清：${JSON.stringify(none.error)}`);
    const missing = new Trainers({ getConfig: () => ({ trainers: { folder: path.join(tmp, '这里没有这个目录') } }) }).scan(true);
    expect(missing.error?.includes('不存在'), `目录不存在时没说清：${JSON.stringify(missing.error)}`);
    const relative = new Trainers({ getConfig: () => ({ trainers: { folder: '相对路径\\不行' } }) }).scan(true);
    expect(relative.error?.includes('绝对路径'), `相对路径没被挡：${JSON.stringify(relative.error)}`);

    console.log(`未配置 => 「${none.error}」`);
    console.log(`不存在 => 「${missing.error}」`);
    console.log(`相对路径 => 「${relative.error}」`);
    console.log(`启动假 exe => 「${bad.error}」，再点 => 「${again.error}」`);
    console.log(`普通权限点开 => 「${plain.ok ? `已启动（1 次 spawn，cwd 给了 exe 旁边的 ${path.basename(plainSpawn.calls[0].options.cwd)}）` : JSON.stringify(plain)}」`);
    console.log(`EACCES => 补发 RunAs（共 ${upSpawn.calls.length} 次 spawn）=> 「${up.autoElevated ? '已请求管理员权限启动（它要求管理员，普通权限点不开）' : JSON.stringify(up)}」`);
    console.log(`UAC 被点否 => 「${cancelled.error}」`);
    console.log(`提权也失败 => 「${denied.error}」`);
    console.log(`文件没了 => 「${gone.error}」`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(() => {
  clearTimeout(watchdog);
  if (failures.length) {
    for (const line of failures) console.log(`✗ ${line}`);
    process.exitCode = 1;
  } else {
    console.log('✓ 修改器服务自检全绿：命名规则、跳过卸载器、缓存只认 id、防抖、三种配置错误都对上了；spawn 的两条失败来路都接住了（异步 EACCES 只补发一次 RunAs、UAC 被点否说成取消、文案里不带盘符路径）');
  }
}, (err) => {
  clearTimeout(watchdog);
  console.log(`✗ 自检被异常打断（这正说明某条 'error' 没人接）：${err?.stack || err}`);
  process.exit(1);
});
