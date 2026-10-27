const path = require('node:path');
const { packager } = require('@electron/packager');

const APP_ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(APP_ROOT, 'package.json'));

// 不压 asar：toolbar.config.json 与 layout.json 是要在运行时回写的，必须留在应用目录外裸放
// dist/ 也在 ignore 里，否则重复打包会把上一版产物再套一层进去
packager({
  dir: APP_ROOT,
  out: path.join(APP_ROOT, 'dist'),
  overwrite: true,
  prune: true,
  asar: false,
  name: 'screen-toolbar',
  platform: 'win32',
  arch: 'x64',
  appVersion: pkg.version,
  win32metadata: {
    ProductName: '屏幕工具栏',
    FileDescription: '副屏全屏工具栏',
    CompanyName: 'skyest'
  },
  ignore: (target) => /^\/?(docs|tools|dist|\.git)(\/|$)/.test(target)
})
  .then((dirs) => console.log('打包完成：\n' + dirs.join('\n')))
  .catch((error) => {
    console.error('打包失败：', error);
    process.exit(1);
  });
