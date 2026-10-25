const fs = require('node:fs');
const path = require('node:path');
const { app, screen, desktopCapturer } = require('electron');

// 用独立 userData 跑诊断，避免和工具栏本体的单实例锁冲突
app.setName('screen-toolbar-diag');
app.setPath('userData', path.join(app.getPath('temp'), 'screen-toolbar-diag'));

app.whenReady().then(async () => {
  const primary = screen.getPrimaryDisplay();
  console.log('--- Electron 显示器 ---');
  screen.getAllDisplays().forEach((disp, index) => {
    console.log(
      `#${index} id=${disp.id} bounds=${disp.bounds.width}x${disp.bounds.height}@(${disp.bounds.x},${disp.bounds.y})`,
      `workArea=${disp.workArea.width}x${disp.workArea.height}@(${disp.workArea.x},${disp.workArea.y})`,
      `scale=${disp.scaleFactor}x rotation=${disp.rotation} depth=${disp.colorDepth} label=${disp.label || ''}`,
      disp.id === primary.id ? 'PRIMARY' : ''
    );
  });

  console.log('--- desktopCapturer 真实位图 ---');
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 4000, height: 4000 }
  });
  for (const source of sources) {
    const size = source.thumbnail.getSize();
    console.log(`display_id=${source.display_id} ${source.name} thumbnail=${size.width}x${size.height}`);
    const file = path.join(app.getPath('temp'), `diag-screen-${source.display_id}.png`);
    fs.writeFileSync(file, source.thumbnail.toPNG());
    console.log(`  saved ${file}`);
  }
  app.exit(0);
});
