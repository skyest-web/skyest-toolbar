const { screen } = require('electron');

function describe(disp, index) {
  const primary = screen.getPrimaryDisplay();
  return {
    index,
    id: disp.id,
    label: `#${index} ${disp.bounds.width}x${disp.bounds.height} @ (${disp.bounds.x},${disp.bounds.y})`,
    bounds: disp.bounds,
    workArea: disp.workArea,
    scaleFactor: disp.scaleFactor,
    isPrimary: disp.id === primary.id
  };
}

function list() {
  return screen.getAllDisplays().map((disp, index) => describe(disp, index));
}

function resolve(config) {
  const displays = screen.getAllDisplays();
  const hint = config.display || {};

  if (hint.mode === 'bounds' && hint.bounds) {
    return { bounds: { ...hint.bounds }, source: 'manual bounds', display: null };
  }
  if (hint.mode === 'index') {
    const picked = displays[hint.index] || displays[0];
    return { bounds: { ...picked.bounds }, source: `display #${hint.index}`, display: describe(picked, hint.index) };
  }

  const match = hint.match || {};
  const tolerance = match.tolerance ?? 80;
  const wanted = { width: match.width ?? 0, height: match.height ?? 0 };
  const primaryId = screen.getPrimaryDisplay().id;
  const scored = displays
    .map((disp, index) => ({
      index,
      primary: disp.id === primaryId ? 1 : 0,
      delta: Math.abs(disp.bounds.width - wanted.width) + Math.abs(disp.bounds.height - wanted.height),
      within:
        Math.abs(disp.bounds.width - (match.width ?? disp.bounds.width)) <= tolerance &&
        Math.abs(disp.bounds.height - (match.height ?? disp.bounds.height)) <= tolerance
    }))
    .filter((entry) => entry.within)
    .sort((a, b) => a.primary - b.primary || a.delta - b.delta || a.index - b.index);

  const chosen = scored.length ? displays[scored[0].index] : displays[Math.min(1, displays.length - 1)];
  const index = displays.indexOf(chosen);
  return {
    bounds: { ...chosen.bounds },
    source: scored.length ? `auto match #${index}` : 'fallback: 第二块屏',
    display: describe(chosen, index)
  };
}

module.exports = { resolve, list };
