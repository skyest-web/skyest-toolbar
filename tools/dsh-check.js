// D0 自检：不开界面，只验「拉得起 dsh、拿得到带 token 的地址、退得干净」。
// 用法（Git Bash，项目目录）：node ./tools/dsh-check.js
// 注意：它会占住 dsh.port 上那个端口，跑完自己收；全程不打印 token，只打印长度。
const path = require('node:path');
const configStore = require('../src/main/config');
const { DshHost, installInfo, probe } = require('../src/main/services/dsh');

const APP_ROOT = path.resolve(__dirname, '..');
const config = configStore.load(APP_ROOT);

const install = installInfo(APP_ROOT);
console.log('装的是：', install ? `dsh ${install.version}（${install.bin}）` : '（没装：npm install --save-dev @deepseek-ai/dsh）');
if (!install) process.exit(1);

const host = new DshHost({
  appRoot: APP_ROOT,
  getConfig: () => config,
  getKey: () => process.env.DEEPSEEK_API_KEY || null,
  emit: (channel, status) => console.log('[事件]', channel, JSON.stringify(status))
});

console.log('工作区：', host.workspaceDir());
console.log('初始状态：', JSON.stringify(host.status()));

const started = Date.now();
host
  .start()
  .then(async (url) => {
    const token = new URL(url).searchParams.get('token') || '';
    console.log(`就绪：用时 ${((Date.now() - started) / 1000).toFixed(1)}s，token ${token.length} 位`);
    console.log('健康检查：', await host.healthy());
    console.log('状态（不该出现 token）：', JSON.stringify(host.status()));
    host.stop();
    const origin = new URL(url).origin;
    // 给 taskkill 一点时间，再看端口是不是真让出来了（带不带 token 不重要，有响应就说明还活着）
    setTimeout(async () => {
      const stillAlive = await probe(origin);
      console.log('停止后健康检查：', stillAlive, stillAlive ? '—— 没收干净' : '—— 收干净了');
      process.exit(stillAlive ? 1 : 0);
    }, 2500);
  })
  .catch((error) => {
    console.error('失败：', error.message || error);
    host.stop();
    process.exit(1);
  });
