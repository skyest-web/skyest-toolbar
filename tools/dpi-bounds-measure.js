// 量一个事实：BrowserWindow 构造函数的宽高、setBounds 的宽高、getBounds 回来的宽高，
// 在这台机器的这块屏上到底是不是同一套单位。另一台机器「每重启大一圈」、这台「每启动小一圈」
// 都源自同一个问题，所以换机器前先跑它，别再靠猜做归一化。
// 跑法（Git Bash）：./node_modules/.bin/electron.cmd ./tools/dpi-bounds-measure.js
const { app, BrowserWindow, screen } = require('electron');

const PROBE = { width: 600, height: 400 };

function report(label, win, extra) {
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b);
  console.log(
    `${label}: bounds=${JSON.stringify(b)} 屏 ${d.id} scale=${d.scaleFactor} workarea=${JSON.stringify(d.workareaSize)}` +
      (extra ? ` ${extra}` : '')
  );
  return b;
}

app.whenReady().then(() => {
  console.log('所有屏:', JSON.stringify(screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, scale: d.scaleFactor }))));
  console.log('请求的宽高:', JSON.stringify(PROBE));

  // 1) 只给位置不给宽高：让 Electron 自己按屏缩放定初值
  const a = new BrowserWindow({ show: false, width: PROBE.width, height: PROBE.height });
  report('构造函数给宽高', a);

  // 2) 用 setBounds 再要求同一个宽高，看读回来的是不是同一个数
  a.setBounds({ width: PROBE.width, height: PROBE.height });
  const afterSet = report('setBounds 同一个宽高', a);
  console.log(`setBounds 保真度: 宽 ${afterSet.width / PROBE.width}x 高 ${afterSet.height / PROBE.height}x`);

  // 3) 放到每个屏的 workarea 里量一遍，混排 DPI 下差别只可能出在这里
  for (const d of screen.getAllDisplays()) {
    const x = d.bounds.x + 80;
    const y = d.bounds.y + 80;
    a.setBounds({ x, y, width: PROBE.width, height: PROBE.height });
    report(`摆到屏 ${d.id} 后 setBounds`, a, `期望位置 x=${x} y=${y}`);
  }

  a.destroy();
  app.quit();
});
