// Everything SDK 的最薄一层：只负责"加载 DLL + 发一条查询 + 把结果收成对象"。
// 故意不依赖 Electron，也不管进程归属——因为 Everything_QueryW(TRUE) 是阻塞的
// （SDK v2 的异步模式要自己泵 Windows 消息，Node 里没有消息循环可做），
// 所以调用方必须是能阻塞的地方：自检脚本直接调，应用里交给 utilityProcess 工作进程调。
// 只有 Windows 有 Everything；非 win32 上一切入口都走"未安装"分支。
const path = require('path');
const fs = require('fs');

const IS_WIN = process.platform === 'win32';
const ERROR_IPC = 2; // Everything 搜索端没在跑
const ERROR_MEMORY = 1;
const FILETIME_TO_EPOCH = 116444736000000000n; // 1601-01-01 → 1970-01-01，单位 100ns

const REQUEST = {
  FILE_NAME: 0x00000001,
  PATH: 0x00000002,
  SIZE: 0x00000010,
  DATE_MODIFIED: 0x00000040,
  ATTRIBUTES: 0x00000100
};

const SORT = {
  NAME_ASCENDING: 1,
  PATH_ASCENDING: 3,
  SIZE_DESCENDING: 6,
  DATE_MODIFIED_DESCENDING: 12
};

function dllPath(appRoot) {
  if (!IS_WIN) return null;
  const p = path.join(appRoot, 'vendor', 'everything', 'sdk', 'dll', 'Everything64.dll');
  return fs.existsSync(p) ? p : null;
}

function exePath(appRoot) {
  if (!IS_WIN) return null;
  const p = path.join(appRoot, 'vendor', 'everything', 'app', 'everything.exe');
  return fs.existsSync(p) ? p : null;
}

// 便携模式：Everything 把 ini 和 db 都放在 exe 旁边，而首跑留下的 ini 里 index=0——
// 进程在、能连上、索引永远是空的。换机器 clone 完 vendor/ 里根本没有 ini，
// 所以拉起前先补一份只含"要不要索引"的开关；卷 guid/路径清单这些跟机器绑定的键交给 Everything 自己扫。
// 已经有人手工配过就别碰。
const STARTER_INI = '[Everything]\r\nindex=1\r\nauto_include_fixed_volumes=1\r\nauto_include_removable_volumes=0\r\nipc=1\r\n';

function ensureHostConfig(exe) {
  if (!exe) return false;
  const ini = path.join(path.dirname(exe), 'Everything.ini');
  if (fs.existsSync(ini)) return false;
  fs.writeFileSync(ini, STARTER_INI, 'utf8');
  return true;
}

// str16 = LPCWSTR；int64* / uint64* 让 koffi 把标量按引用带回来，省掉自己拼 LARGE_INTEGER/FILETIME。
function bind(lib) {
  return {
    setSearch: lib.func('void Everything_SetSearchW(str16)'),
    setMax: lib.func('void Everything_SetMax(uint32)'),
    setOffset: lib.func('void Everything_SetOffset(uint32)'),
    setSort: lib.func('void Everything_SetSort(uint32)'),
    setRequestFlags: lib.func('void Everything_SetRequestFlags(uint32)'),
    query: lib.func('bool Everything_QueryW(bool)'),
    getLastError: lib.func('uint32 Everything_GetLastError()'),
    numResults: lib.func('uint32 Everything_GetNumResults()'),
    totResults: lib.func('uint32 Everything_GetTotResults()'),
    fileName: lib.func('str16 Everything_GetResultFileNameW(uint32)'),
    filePath: lib.func('str16 Everything_GetResultPathW(uint32)'),
    isFolder: lib.func('bool Everything_IsFolderResult(uint32)'),
    isVolume: lib.func('bool Everything_IsVolumeResult(uint32)'),
    size: lib.func('bool Everything_GetResultSize(uint32, int64* out)'),
    dateModified: lib.func('bool Everything_GetResultDateModified(uint32, uint64* out)'),    dbLoaded: lib.func('bool Everything_IsDBLoaded()'),
    isAdmin: lib.func('bool Everything_IsAdmin()'),
    major: lib.func('uint32 Everything_GetMajorVersion()'),
    minor: lib.func('uint32 Everything_GetMinorVersion()'),
    revision: lib.func('uint32 Everything_GetRevision()'),
    build: lib.func('uint32 Everything_GetBuildNumber()'),
    cleanUp: lib.func('void Everything_CleanUp()')
  };
}

function errorCodeText(code) {
  const map = {
    [ERROR_MEMORY]: 'Everything 侧内存不足',
    [ERROR_IPC]: 'Everything 没在运行（或没开 IPC）',
    3: '注册窗口类失败',
    4: '创建监听窗口失败',
    5: '创建线程失败',
    6: '索引越界',
    7: '调用顺序不对（先 SetSearch 再 Query）',
    8: '没先声明请求的数据项',
    9: '参数非法'
  };
  return map[code] ? `${map[code]}（错误码 ${code}）` : `Everything 返回错误码 ${code}`;
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

class EverythingSdk {
  constructor({ appRoot } = {}) {
    this.root = appRoot || path.resolve(__dirname, '..', '..', '..');
    this.api = null;
    this.koffi = null;
    this.loadError = null;
  }

  // 一次加载、长期复用：DLL 里的查询状态是进程内全局单例，重复 load 没有意义。
  ensureLoaded() {
    if (this.api) return true;
    if (this.loadError) return false;
    const dll = dllPath(this.root);
    if (!dll) {
      this.loadError = IS_WIN ? '没找到 vendor/everything/sdk/dll/Everything64.dll' : 'Everything 只有 Windows 版';
      return false;
    }
    try {
      const koffi = require('koffi');
      this.koffi = koffi;
      this.api = bind(koffi.load(dll));
      this.dll = dll;
      return true;
    } catch (error) {
      this.loadError = `加载 Everything64.dll 失败：${error.message}`;
      return false;
    }
  }

  versionText() {
    if (!this.api) return null;
    const { major, minor, revision, build } = this.api;
    return [major, minor, revision, build].map((f) => safe(f)).join('.');
  }

  // 同步阻塞查询。Everything 索引没建完时可能卡住，所以超时由调用方（工作进程）负责。
  search(query, { max = 50, sort = SORT.NAME_ASCENDING } = {}) {
    if (!this.ensureLoaded()) return { ok: false, message: this.loadError, items: [] };
    const api = this.api;
    try {
      api.setSearch(String(query));
      api.setMax(Math.max(1, Math.min(500, max | 0)));
      api.setOffset(0);
      api.setSort(sort);
      api.setRequestFlags(REQUEST.FILE_NAME | REQUEST.PATH | REQUEST.SIZE | REQUEST.DATE_MODIFIED | REQUEST.ATTRIBUTES);
      const done = api.query(true);
      const err = api.getLastError();
      if (!done) {
        return { ok: false, ipcDown: err === ERROR_IPC, message: errorCodeText(err), items: [] };
      }
      const count = api.numResults();
      const items = [];
      for (let i = 0; i < count; i++) items.push(this.readResult(api, i));
      return {
        ok: true,
        items,
        total: api.totResults(),
        returned: count,
        dbLoaded: safe(() => api.dbLoaded()),
        admin: safe(() => api.isAdmin())
      };
    } catch (error) {
      return { ok: false, message: `查询失败：${error.message}`, items: [] };
    }
  }

  readResult(api, i) {
    const name = api.fileName(i) || '';
    const dir = api.filePath(i) || '';
    // Everything 给的就是 Windows 路径，用 win32 拼，别被当前平台的路径规则带偏
    const full = dir ? path.win32.join(dir, name) : name;
    const size = this.readInt64(api, i);
    return { name, path: full, folder: Boolean(api.isFolder(i)), volume: Boolean(api.isVolume(i)), size, modified: this.readFiletime(api, i) };
  }

  // int64* / uint64* 这类出参必须用 koffi.alloc 出来的真指针去接。
  // 传 JS 数组当 out 参数不会报错，但值永远读不回来——size 全 0、修改时间全空就是这么来的。
  readOut(fn, type, i) {
    const out = this.koffi.alloc(type, 1);
    try {
      if (!fn(i, out)) return null;
      return this.koffi.decode(out, type);
    } catch {
      return null;
    }
  }

  readInt64(api, i) {
    const raw = this.readOut(api.size, 'int64', i);
    if (raw == null) return 0;
    try {
      const v = BigInt(raw);
      return v > 0n && Number.isFinite(Number(v)) ? Number(v) : 0;
    } catch {
      return 0;
    }
  }

  readFiletime(api, i) {
    const raw = this.readOut(api.dateModified, 'uint64', i);
    if (raw == null) return null;
    try {
      const ticks = BigInt(raw);
      const ms = Number((ticks - FILETIME_TO_EPOCH) / 10000n);
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    } catch {
      return null;
    }
  }

  // 给状态用：能不能连上 Everything、索引好了没有。
  probe() {
    if (!this.ensureLoaded()) return { installed: false, running: false, message: this.loadError };
    const api = this.api;
    try {
      api.setSearch('C:\\');
      api.setMax(1);
      api.setSort(SORT.NAME_ASCENDING);
      api.setRequestFlags(REQUEST.FILE_NAME | REQUEST.PATH);
      const done = api.query(true);
      const err = api.getLastError();
      return {
        installed: true,
        running: Boolean(done),
        ipcDown: !done && err === ERROR_IPC,
        dbLoaded: done ? safe(() => api.dbLoaded()) : false,
        admin: done ? safe(() => api.isAdmin()) : false,
        sdkVersion: done ? this.versionText() : null,
        message: done ? null : errorCodeText(err)
      };
    } catch (error) {
      return { installed: true, running: false, message: error.message };
    }
  }

  dispose() {
    if (!this.api) return;
    try {
      this.api.cleanUp();
    } catch {
      // 收尾失败不值得挡住退出
    }
    this.api = null;
  }
}

module.exports = { EverythingSdk, dllPath, exePath, ensureHostConfig, SORT, REQUEST, ERROR_IPC, errorCodeText, IS_WIN };
