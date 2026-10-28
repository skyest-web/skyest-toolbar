# Everything 全盘文件搜索

顶栏中间是一条**常驻搜索栏**（Ctrl+F 聚焦），输入文件名片段就在它下面垂出结果下拉，回车用系统默认程序打开，↑↓ 选择、Esc 收起、点外面收起。索引和查询都由 **voidtools Everything** 干，我们只是它的 IPC 客户端。

只支持 Windows（Everything 没有别的平台）；其他平台上徽标显示「仅 Windows」，查询直接返回不支持，不报错。

## 1. 分工

| 层 | 文件 | 干什么 |
|---|---|---|
| 渲染层 | [src/renderer/js/search.js](../src/renderer/js/search.js) | 认领顶栏输入框、下拉定位、防抖、↑↓/Enter、徽标状态。只持有 `(listId, 序号)` 和展示用的结果数组 |
| 桥 | [src/preload/preload.js](../src/preload/preload.js) | `TB.api.search` 六个方法：`status/probe/query/open/startHost/onState` |
| 主进程 | [src/main/services/everything.js](../src/main/services/everything.js) | 拉起工作进程、排队转发查询、超时兜底、自动带起 Everything、缓存结果供「打开」 |
| 工作进程 | [src/main/services/everything-worker.js](../src/main/services/everything-worker.js) | `utilityProcess` 子进程，在里面调阻塞的 `Everything_QueryW` |
| SDK 封装 | [src/main/services/everything-sdk.js](../src/main/services/everything-sdk.js) | koffi 声明 + 把结果收成对象，不依赖 Electron，自检脚本也用它 |

**为什么非得开个子进程**：`Everything_QueryW(TRUE)` 是同步阻塞调用，SDK v2 的异步模式要求调用方自己泵 Windows 消息，Node 里没有消息循环。放进主进程就是拿整个应用的 UI 线程去赌一次查询；放进渲染层更不行（没有 Node）。所以只有工作进程这一条路，主进程侧用超时（`search.timeoutMs`）兜住。

**为什么要排队而不是丢弃**：搜索栏一聚焦就先发一条状态探测，用户手快接着回车。早期版本同一时刻只允许一条查询、第二条直接返回 busy，结果"打开后第一条查询必挂"。现在 `call()` 走一条 FIFO 队列（`this.gate`），探测和查询排队跑，渲染层再用 `seq` 判断结果是不是已经被更新的输入取代。

**输入框在顶栏、下拉在 body**：顶栏是个组件，改布局或存配置会重建它的 DOM，所以 `TB.search` 不能把输入框当自己的节点持有——`topbar.js` 每次 `init()` 都会调 `attachBar(input, badge)` 重新认领，事件绑在新节点上、关键词从 `this.query` 还原，下拉面板（`#search-panel`，在 `index.html` 里、不参与重建）再用 `place()` 按输入框的矩形贴到它下面。

## 2. vendor/ 里放了什么

```
vendor/everything/
├── app/everything.exe        # 便携版客户端（跟着 git 走）
├── app/Everything.lng        # 界面语言
├── app/Everything.ini        # 客户端配置：运行时生成，已 gitignore
├── app/Everything.db         # 索引：本机几百 MB，已 gitignore
└── sdk/
    ├── dll/Everything64.dll  # 只留 x64（32/ARM/ARM64 的 dll 和 lib 都删了）
    ├── include/Everything.h  # 官方头文件，查签名用
    └── example/ ipc/ lib/ src/ vs/
```

Everything 是便携模式：**ini 和 db 都落在 exe 旁边**，不写注册表、不碰 `%APPDATA%`。所以 `Everything.db` 长到 75MB 也只在项目目录里，换机器 clone 完是干净的。

打包（`npm run package`）不压 asar，`vendor/` 原样拷进产物目录，`koffi.load()` 拿到的还是真实文件路径。

## 3. 权限与索引范围

默认**普通权限**就够：`auto_include_fixed_volumes=1` 让 Everything 自己扫所有固定 NTFS 卷，实测这台机器 105 万个文件、查询 10–40ms。代价是受保护目录（别的用户配置目录之类）进不了索引。

要全盘含受保护目录，装 Everything 的服务再重启客户端（**机器级变更，需要管理员，由你自己敲**）：

```powershell
# PowerShell（管理员），项目目录
.\vendor\everything\app\everything.exe -install-service
.\vendor\everything\app\everything.exe -exit   # 让客户端带着服务重起
```

卸载：把上面第二条换成 `-uninstall-service`。

**首跑那个坑**：便携版第一次启动生成的 ini 里 `index=0`——进程在、能连上、索引永远是空的，什么关键字都查不到东西。所以拉起前会调 `ensureHostConfig()`（在 `everything-sdk.js`，自检脚本共用）：只在 **ini 不存在时**补一份 `index=1 + auto_include_fixed_volumes=1 + ipc=1` 的 starter；你已经手工配过的 ini 一个字都不动。

## 4. 边界

- **不出网**。Everything 只读本机索引，我们只走本机 IPC（注册窗口消息 + 广播），CSP 那边不需要开任何新口子。
- **「打开」不接渲染层给的路径**。`search:open` 只接 `(listId, 序号)`，路径从主进程缓存的最近 8 页结果里取（`LIST_LIMIT`）。这条 IPC 不是"你给我路径我帮你 openPath"的口子。
- **状态里不带结果**：`search:state` 推的是连接信息（版本、在不在跑、索引好没好），没有文件路径。
- 结果路径会显示在面板上，这是功能本身要的；但它不进日志、不进 `state.json`。

## 5. 配置段

`toolbar.config.json` 的 `search`（新增顶层段，改配置要**同时**动 `config.js` 的 `DEFAULTS` 和 `save()` 的白名单）：

```jsonc
"search": {
  "enabled": true,       // 关掉后顶栏不显示搜索栏，Ctrl+F 一起失效：读它的是 topbar.js 的 build()
  "maxResults": 20,      // 一次取回多少条；下拉里可滚动看完，总数超出时底部提示还有多少
  "minChars": 2,         // 少于这个字数不发查询：单字符在全盘索引上又慢又没意义
  "timeoutMs": 1500,     // 阻塞调用堵住工作进程时，超过这么久算这次没成功
  "autoStart": true,     // 查询撞见 Everything 没在跑，就用 vendor 里的 exe 拉起来再重试一次
  "sort": "NAME_ASCENDING" // 也可 PATH_ASCENDING / SIZE_DESCENDING / DATE_MODIFIED_DESCENDING
}
```

设置面板「文件搜索（Everything）」卡片里都能改，还有一条「重连并拉起 Everything」按钮用来在 Everything 掉了之后手动救回来。

## 6. 自检与真机验证

```bash
# Git Bash，项目目录
npm run everything:check              # 无界面：DLL 加载、IPC 连通、查询耗时、结果形状、size/时间数值
npm run everything:check -- --start   # Everything 没在跑时，用便携版拉起来再测（会补 starter ini）

# 真机（CDP）：先带调试端口起应用，再跑探针
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
npm run search:appprobe -- --shot     # 等价于 node tools/search-appprobe.js 9223 --shot
```

`search-appprobe.js` 覆盖：搜索栏在不在顶栏（旧的「搜索」按钮必须已经没了）、`attachBar` 有没有认领到当前这个输入框节点、聚焦展开与定位（下拉贴在输入框下方、不出窗口）、徽标状态、字数下限、真查询有结果、结果形状（绝对路径 / 文件夹标志 / size / 修改时间）、↑↓ 选择、过期列表与越界序号被拒、连打两次只留最后一次、Ctrl+F 聚焦、Esc 收起并交还焦点、点外面收起而点搜索栏不收起、设置卡片字段齐。

最后一步是 `enabled` 开关的往返：探针把 `search.enabled` 写成 false（走 `TB.api.config.save` → `applyConfigResult` → `buildShell`，跟用户在设置里点保存是同一条路），断言顶栏整条搜索栏和徽标都不再渲染、`TB.search` 交出了那个已销毁的输入框、Ctrl+F 与 `focus()` 都成空操作，然后在 `finally` 里把原值写回去并确认搜索栏、徽标、`attachBar` 都回来了。**这段别删**：`enabled` 曾经只被设置面板写、没人读，开关点了没反应；现在它由 `topbar.js` 的 `build()` 消费，是唯一能让这条链路"配置即界面"的地方。跑探针的机器上如果本来就是关的，这一步会打印跳过。

**size 和修改时间这两项别当装饰删**：它们走 koffi 的 `int64*` / `uint64*` 出参，是这条链路上最容易静默归零的地方（见下节）。

## 7. 已知的坑

- **koffi 的 out 参数不能传 JS 数组**。`api.size(i, [0])` 不报错，但值永远读不回来，表现就是所有文件都是 0 字节、修改时间全空。必须 `koffi.alloc('int64', 1)` 拿真指针，再 `koffi.decode(ptr, 'int64')`。见 `everything-sdk.js` 的 `readOut()`。
- **类字段别和方法同名**。`EverythingSearch` 里 `this.status = {...}` 把自己原型的 `status()` 方法盖掉了，第一次探测就在事件回调里抛 `this.status is not a function`——而且是主进程未捕获异常，弹一个 "A JavaScript error occurred in the main process" 的模态框，把整个应用带走（CDP 的 HTTP 端口跟着不响应，看着像没起来）。状态字段现在叫 `this.state`。
- **主进程崩了但进程还在**：`MainWindowTitle` 是 `Error`、`Responding=True`、`/json/list` 挂住不起。这时候别看 `run.log`（异常只在模态框里），栈只出现在那个对话框里，用 UI Automation 把它读出来：
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/main-error-dialog.ps1`
- **Everything 的 ini 会吃反斜杠**：写 `folders="D:\GitProject"` 会被它改写成 `folders="D:GitProject"`。走 NTFS 卷全量索引这条路不用碰这个键，要精确控制文件夹索引时再验证转义写法。
- 收尾时**不主动关 Everything 客户端**：它是常驻索引服务，跟着工具栏一起起落没意义，退出只 `dispose()` 工作进程。
