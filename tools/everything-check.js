// Everything 链路的无界面自检：DLL 能不能加载、IPC 通不通、查询多快、结果形状对不对。
// 跑法（Git Bash，项目目录）：
//   npm run everything:check            # 只测；Everything 没在跑就报 ipcDown
//   npm run everything:check -- --start  # 没在跑就用 vendor 里的便携版拉起来再测
//   npm run everything:check -- --q "任务"  # 换成自己要验的查询词
const path = require('path');
const { spawn } = require('child_process');
const { EverythingSdk, dllPath, exePath, ensureHostConfig, IS_WIN } = require('../src/main/services/everything-sdk');

const APP_ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

function waitDb(sdk, timeoutMs) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const p = sdk.probe();
      if (p.running && p.dbLoaded) return resolve(p);
      if (Date.now() > until) return resolve(p);
      setTimeout(tick, 300);
    };
    tick();
  });
}

function timed(label, fn) {
  const at = Date.now();
  const result = fn();
  return { label, ms: Date.now() - at, ...result };
}

async function main() {
  console.log('平台:', process.platform, '| 64 位:', process.arch);
  console.log('DLL:', dllPath(APP_ROOT) || '（没有）');
  console.log('Everything.exe:', exePath(APP_ROOT) || '（没有）');
  if (!IS_WIN) {
    console.log('非 Windows：Everything 这条路整体跳过，不算失败。');
    return 0;
  }

  const sdk = new EverythingSdk({ appRoot: APP_ROOT });
  if (!sdk.ensureLoaded()) {
    console.error('FAIL 加载 DLL：', sdk.loadError);
    return 1;
  }
  console.log('SDK 版本:', sdk.versionText());

  let status = sdk.probe();
  if (!status.running && status.ipcDown && flag('start')) {
    const exe = exePath(APP_ROOT);
    console.log('Everything 没在跑，拉起:', exe);
    if (ensureHostConfig(exe)) console.log('（补了一份 starter Everything.ini：index=1 + 固定卷全量索引）');
    const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
    child.unref();
    status = await waitDb(sdk, 60000);
  }
  console.log('连通状态:', JSON.stringify(status));
  if (!status.running) {
    console.error('FAIL 连不上 Everything：', status.message, '（试加 --start）');
    return 1;
  }

  const queries = [opt('q', null), 'txt', 'Everything', 'C:\\Users'].filter(Boolean);
  const rows = queries.map((q) =>
    timed(`查 "${q}"`, () => {
      const r = sdk.search(q, { max: 20 });
      return { ok: r.ok, returned: r.returned, total: r.total, message: r.message, sample: (r.items || []).slice(0, 2).map((it) => `${it.path}${it.folder ? '\\' : ''}`) };
    })
  );
  for (const row of rows) {
    console.log(`${row.ok ? 'OK  ' : 'FAIL'} ${row.label} → ${row.ms}ms 返回 ${row.returned}/${row.total}`, row.sample ? JSON.stringify(row.sample) : row.message || '');
  }

  // 结果形状抽查：路径必须是绝对路径，字段必须齐
  const shape = sdk.search('exe', { max: 5 });
  const bad = (shape.items || []).filter((it) => !it.path || !/^[a-zA-Z]:[\\/]/.test(it.path) || typeof it.folder !== 'boolean' || typeof it.size !== 'number');
  console.log(`结果形状抽查: ${shape.items.length} 条里 ${bad.length} 条不合格`, bad.length ? JSON.stringify(bad[0]) : '');
  console.log('样例第一条:', JSON.stringify(shape.items[0]));

  // 数值字段抽查：size 走的是 int64* 出参、modified 走 FILETIME——这俩最容易在 FFI 上静默变成 0/null
  const sized = sdk.search('explorer.exe', { max: 10 });
  const biggest = Math.max(0, ...(sized.items || []).map((it) => it.size));
  const dated = (sized.items || []).filter((it) => it.modified && it.modified > 0).length;
  console.log(`数值抽查: explorer.exe ${sized.items.length} 条，最大 ${biggest} 字节，${dated} 条有修改时间`);

  const slowest = Math.max(...rows.map((r) => r.ms));
  console.log(`最慢一次: ${slowest}ms`);
  sdk.dispose();

  const failed = rows.some((r) => !r.ok) || bad.length > 0 || biggest < 100000 || dated === 0;
  console.log(failed ? 'FAIL 见上面红字' : '全部通过');
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error('自检脚本崩了:', error);
  process.exit(1);
});
