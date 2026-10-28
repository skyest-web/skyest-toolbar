// Everything 工作进程：由 everything.js 用 utilityProcess.fork 拉起。
// 放这儿而不是主进程，是因为 Everything_QueryW(TRUE) 是阻塞调用——主进程一旦被 it 卡住，
// 宠物、语音、所有 IPC 都跟着停。工作进程卡住只影响搜索这一路，主进程那边有超时和丢弃。
const { EverythingSdk, SORT } = require('./everything-sdk');

const sdk = new EverythingSdk({ appRoot: process.env.TB_APP_ROOT });
const post = (message) => process.parentPort.postMessage(message);

function handle(message) {
  if (!message || typeof message !== 'object') return;
  const { op, id } = message;
  if (op === 'search') {
    const reply = sdk.search(message.query, { max: message.max, sort: message.sort || SORT.NAME_ASCENDING });
    post({ id, op, ...reply });
    return;
  }
  if (op === 'probe') {
    post({ id, op, ...sdk.probe(), sdkVersion: sdk.versionText() });
    return;
  }
  if (op === 'dispose') {
    sdk.dispose();
    post({ id, op, ok: true });
  }
}

process.parentPort.on('message', (event) => handle(event.data));
