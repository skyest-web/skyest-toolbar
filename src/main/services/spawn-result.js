// spawn 的失败有两条来路，两条都得接：
//   1) CreateProcess 当场返回错误（比如喂进去一个文本文件改名成的 .exe）→ spawn() 同步抛；
//   2) 子进程句柄已经建好、错误随后才报：ENOENT（文件挪走了）和**最要紧的 EACCES**——
//      目标 exe 的清单写了 requireAdministrator，普通权限被 Windows 拒（libuv 把
//      ERROR_ELEVATION_REQUIRED / ERROR_ACCESS_DENIED 都映射成 EACCES）→ 只有 'error' 事件。
// 只写 try/catch 就是漏了第 2 条：ChildProcess 上没人听 'error'，异常冒到主进程顶层，
// Electron 弹出「A JavaScript error occurred in the main process」那个模态框。实测症状：
// 游戏面板点《赛博朋克2077》修改器的标签，弹框写 `spawn ... EACCES`。
//
// 统一成一条 Promise，调用方只管 await，不要再自己碰 'error'。

const { spawn: realSpawn } = require('node:child_process');

// spawnFn 是注入点：自检脚本换上一个只记账的替身，才敢断言「EACCES 之后恰好补发一次 RunAs」
// 而不在自检机上真的弹 UAC。
function spawnResult(spawnFn, exe, args = [], options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = (spawnFn || realSpawn)(exe, args, { detached: true, stdio: 'ignore', windowsHide: true, ...options });
    } catch (err) {
      resolve({ ok: false, error: err });
      return;
    }
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      resolve(error ? { ok: false, error } : { ok: true, child });
    };
    // 这个监听器**不摘**：'spawn' 之后子进程照样可能报错（运行期被安全软件干掉），
    // 那时没人听同样是顶层异常。摘掉换不来任何好处。
    child.on('error', finish);
    child.once('spawn', () => {
      child.unref();
      finish(null);
    });
  });
}

// 错误码 → 人话。返回值要跨 IPC 进渲染层的提示条，所以不放盘符路径——
// 行数据里一个 exe 路径都不给，这条规矩跟着守（Node 原话是 `spawn H:\x.exe EACCES`，直接抛回去就漏了）。
function explainSpawnError(err) {
  const code = String(err?.code || '').toUpperCase();
  if (code === 'EACCES' || code === 'EPERM') return '系统拒绝访问（它要的管理员权限没给到，或者被安全软件拦下）';
  if (code === 'ENOENT') return '文件已经不在了（可能被移动或删除），点「重扫」再试';
  // ERROR_BAD_EXE_FORMAT(193) 在 libuv 里没有对应码，落到 UNKNOWN：文本文件改名成 .exe 就是这个
  if (code === 'EFTYPE' || code === 'ENOEXEC' || code === 'UNKNOWN') return '这个文件启不来（多半不是能直接运行的 exe，或者被安全软件拦下了）';
  if (code === 'EINVAL') return '启动参数无效';
  return redactPaths(err?.message || '未知错误') || '未知错误';
}

// 把可能带路径的一行原始报错洗掉路径，只留能给人看的那截
function redactPaths(text) {
  return String(text || '')
    .replace(/[A-Za-z]:[\\/][^\r\n"']*/g, '（路径）')
    .replace(/\\\\[^"'`\r\n]+/g, '（路径）')
    .trim();
}

module.exports = { spawnResult, explainSpawnError, redactPaths };
