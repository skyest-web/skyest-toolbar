// 项目列表（工作面板左边那一整块）：一行一个仓库根目录（config.repos.roots，和 git 格共用那一份）下的顶层文件夹。
//
// 数据来自 projects:list：主进程扫目录、按项目里的标记文件判 IDE、再按 JetBrains 的装法找到启动器；
// 这里只渲染。启动不在这一层：双击走 projects.launch(id)，Ctrl+左键走 projects.reveal(id)，
// id 是主进程这次缓存里的序号——渲染层拿不到、也不需要拿到 IDE 的 exe 路径。
//
// 三种手势各管一件事，别再往回退：
//   左键   = 选中这一行 → 中间那格 git 换到这个项目（TB.app.selectProject，选中态存在 app.state 而不是这里）
//   双击   = 交给 IDE 打开项目
//   Ctrl+左键 = 打开这个文件夹
// 所以左键不再直接开 IDE：一次点击就起一个 IDE 进程，点错了还得自己关，而「看这个仓库」才是更高频的动作。
//
// 一行三个信息：项目名 / 判出来的 IDE / 上次动过。IDE 那块就是「双击会发生什么」的预告，
// 判不出类型时它显示的是默认那个，悬浮说明里写了按哪条判的。

TB.projects = {
  // 上一次的数据存在 JS 上而不是 DOM 里：切面板会整体重建这一格
  data: null,
  busy: false,

  init(root) {
    root.innerHTML = '';

    this.count = TB.util.el('span', { class: 'pj-count', text: '读取中…' });
    this.rescan = TB.util.el('button', {
      class: 'link-btn',
      text: '重扫',
      title: '重新扫一遍项目根目录，并重新认一次本机装了哪些 IDE（新建项目或刚装完 IDE 之后点这个）',
      onclick: () => this.load(true)
    });
    this.head = TB.util.el('div', { class: 'pj-head' }, [
      TB.util.el('span', { class: 'panel-title', text: '项目' }),
      this.count,
      this.rescan
    ]);

    // 这一格不放过滤框：顶层项目只有几个，输入框那 26px 会从列表里扣掉，逼人滚动才能看完。
    // 将来项目多到一屏装不下，再按游戏列表那格的写法加回来。
    this.list = TB.util.el('div', { class: 'pj-list' });
    root.append(this.head, this.list);
    this.load(false);
  },

  async load(force) {
    if (this.busy || !this.count) return;
    this.busy = true;
    this.count.textContent = force ? '重扫中…' : '读取中…';
    try {
      this.data = await TB.api.projects.list(force);
    } catch (err) {
      this.data = { roots: [], items: [], ides: [], warnings: [], error: `主进程没响应：${err.message}` };
    }
    this.busy = false;
    // 重扫之后这批行换了（项目被删、或者根目录改了）：选中项不在列表里就清掉，
    // 否则中间那格还在演一个已经不在这个面板上的项目，而左边根本看不出来。
    const sel = TB.app.state.project;
    if (sel && !(this.data?.items || []).some((item) => item.id === sel.id && item.path === sel.path)) TB.app.selectProject(null);
    this.render();
  },

  // 这一格没有「重扫之外」的手动刷新：设置里改了 repos.roots 由主进程现读配置，
  // 缓存自己作废（见 services/projects.js 的 stale 那条），保存后切回这一格就是新根的结果。
  // 所以 update 管两件事——组件刚被重建、数据要补回来；以及中间那格反过来问「现在选的是哪个」。
  update() {
    if (!this.data && this.count) {
      this.load(false);
      return;
    }
    // 选中态变了只翻 class，不重建列表：重建会把滚动位置洗掉，而他刚点下去的那一下正是要看高亮的
    this.markSelection();
  },

  markSelection() {
    if (!this.list) return;
    const id = TB.app.state.project?.id ?? null;
    for (const node of this.list.querySelectorAll('.pj-item')) node.classList.toggle('sel', Number(node.dataset.id) === id);
  },

  render() {
    if (!this.count) return;
    this.count.textContent = this.data?.error ? '未就绪' : `${(this.data?.items || []).length} 个`;
    this.renderList();
    // 重建完要把高亮补回去：选中态还在 app.state 里，行却是新的一批 DOM。
    // 少了这一句，重扫（或切回这一页）之后中间那格还演着同一个项目，左边却看不出选的是哪一行。
    this.markSelection();
  },

  renderList() {
    if (!this.list) return;
    this.list.innerHTML = '';

    if (this.data?.error) {
      this.list.append(TB.util.el('div', { class: 'muted', text: this.data.error }));
      return;
    }

    // 多个根里有一路读不到：别掀整张表，但要说清哪几个根没进来
    for (const warning of this.data?.warnings || []) {
      this.list.append(TB.util.el('div', { class: 'pj-warn', text: `有一个根目录没读到：${warning}` }));
    }

    const items = this.data?.items || [];
    if (!items.length) {
      const roots = (this.data?.roots || []).join('、') || '仓库根目录';
      this.list.append(TB.util.el('div', { class: 'muted', text: `「${roots}」下没有项目文件夹` }));
      return;
    }

    for (const item of items) this.list.append(this.row(item));
    this.markSelection();
  },

  when(item) {
    // touched 两种来源都有落空的时候（目录 stat 失败、又没有 git 记录），那格不硬编「今天」
    return item.touched ? TB.util.ago(item.touched) : '没记录';
  },

  row(item) {
    const ready = item.ideReady !== false;
    const chip = TB.util.el('span', {
      // 没装的那个 IDE 也照样写名字：只留个 ✗ 看不出点下去会怎样
      class: `pj-ide${ready ? '' : ' missing'}`,
      text: item.ideLabel || item.ide
    });

    return TB.util.el('div', {
      class: 'pj-item',
      'data-id': String(item.id),
      title: [
        item.path,
        `按这条判的 IDE：${item.why}`,
        `上次动过：${item.touched ? TB.util.date(item.touched) : '没记录'}（${item.touchedBy === 'git' ? 'git 里最后一次提交/切分支' : '目录自身的修改时间'}）`,
        item.empty ? '这是个空文件夹' : null,
        item.git ? null : '这个文件夹不是 git 仓库（往上那一层才是）——左键点它，右边那一格说它的情况',
        ready ? `左键选中它 · 双击用 ${item.ideLabel} 打开 · Ctrl+左键打开这个文件夹` : `本机没找到 ${item.ideLabel}，双击会提示找不到启动器`
      ]
        .filter(Boolean)
        .join('\n'),
      // 左键只管选中：双击前浏览器一定会先送两次 click，靠 app 里那句「同一个项目不重渲染」兜住，
      // 所以这里不需要防抖，也不会出现「选中动画闪两下才开 IDE」。
      onclick: (event) => {
        if (event.ctrlKey || event.metaKey) {
          this.reveal(item);
          return;
        }
        TB.app.selectProject(item);
      },
      ondblclick: (event) => {
        if (event.ctrlKey || event.metaKey) return;
        this.launch(item);
      }
    }, [TB.util.el('span', { class: 'pj-name', text: item.name }), chip, TB.util.el('span', { class: 'pj-ago', text: this.when(item) })]);
  },

  async launch(item) {
    const result = await TB.api.projects.launch(item.id);
    if (result?.ok) TB.app.toast(`已交给 ${result.ideLabel || item.ideLabel} 打开「${item.name}」`, 'ok');
    else TB.app.toast(`打开失败：${result?.error || '未知错误'}`, 'warn');
  },

  async reveal(item) {
    const result = await TB.api.projects.reveal(item.id);
    if (!result?.ok) TB.app.toast(`打开文件夹失败：${result?.error || '未知错误'}`, 'warn');
  }
};

TB.register({
  id: 'projects',
  name: '项目列表',
  cls: 'area projects-area',
  build: () => TB.util.el('div', { id: 'projects' }),
  init: (node) => TB.projects.init(node),
  update: () => TB.projects.update()
});
