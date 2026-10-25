const { app, screen } = require('electron');

app.whenReady().then(() => {
  const displays = screen.getAllDisplays();
  const lines = displays.map((disp, index) =>
    [
      `#${index}`,
      `${disp.bounds.width}x${disp.bounds.height}`,
      `origin=(${disp.bounds.x},${disp.bounds.y})`,
      `workArea=${disp.workArea.width}x${disp.workArea.height}@(${disp.workArea.x},${disp.workArea.y})`,
      `scale=${disp.scaleFactor}x`,
      `primary=${disp.id === screen.getPrimaryDisplay().id}`,
      `depth=${disp.colorDepth}`
    ].join(' ')
  );
  console.log(lines.join('\n'));
  app.exit(0);
});
