const { shell } = require('electron');
const { spawn } = require('node:child_process');
const { spawnResult, explainSpawnError } = require('./spawn-result');

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
      // 快捷方式里的 exe 打不开是常事（改过名、被安全软件拦），失败必须落在这条 Promise 上，
      // 不能冒到主进程顶层
      const res = await spawnResult(spawn, exe, args, { shell: true });
      return res.ok ? { ok: true } : { ok: false, error: explainSpawnError(res.error) };
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
