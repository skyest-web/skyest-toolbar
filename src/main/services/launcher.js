const { shell } = require('electron');
const { spawn } = require('node:child_process');

async function launch(item) {
  const type = (item.type || 'path').toLowerCase();
  const target = String(item.target || '').trim();
  if (!target) return { ok: false, error: '目标为空' };

  try {
    if (type === 'url') {
      if (!/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^(\/\/|www\.)/i.test(target)) {
        return { ok: false, error: '链接需要协议前缀，例如 https://… 或 ms-settings:…' };
      }
      await shell.openExternal(target.startsWith('www.') ? `https://${target}` : target);
      return { ok: true };
    }
    if (type === 'cmd') {
      const [exe, ...args] = target.split(/\s+/);
      const child = spawn(exe, args, { detached: true, stdio: 'ignore', shell: true, windowsHide: true });
      child.unref();
      return { ok: true };
    }
    const result = await shell.openPath(target);
    return result ? { ok: false, error: result } : { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function reveal(target) {
  if (target && /^[a-z]:[\\/]/i.test(target)) shell.showItemInFolder(target);
}

module.exports = { launch, reveal };
