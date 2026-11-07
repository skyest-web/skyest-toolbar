// 修改器（trainer）列表：把配置目录里的 exe 列成可点的格子，点一下就启动。
// 数据只在需要时向主进程要一次（主进程扫目录并缓存 id→路径），这里不持有路径之外的东西。

TB.trainers = {
  // 筛选词存在 JS 上而不是 input 里：切面板会整体重建 DOM（见 QODER.md「组件不能只在 DOM 里存在状态」）
  filter: '',
  data: null,
  busy: false,

  init(root) {
    root.innerHTML = '';

    this.count = TB.util.el('span', { class: 'tr-count', text: '加载中…' });
    this.rescan = TB.util.el('button', {
      class: 'link-btn',
      text: '重扫',
      title: '重新扫一遍目录（新装了修改器、或改了文件夹之后点这个）',
      onclick: () => this.load(true)
    });
    this.head = TB.util.el('div', { class: 'tr-head' }, [
      TB.util.el('span', { class: 'panel-title', text: '修改器' }),
      this.count,
      this.rescan
    ]);

    this.filterInput = TB.util.el('input', {
      class: 'input tr-filter',
      type: 'text',
      value: this.filter,
      placeholder: '过滤游戏名，Enter 直接启动第一条',
      oninput: (event) => {
        this.filter = event.target.value;
        this.renderList();
      },
      onkeydown: (event) => {
        if (event.key === 'Enter') {
          const first = this.visible()[0];
          if (first) this.launch(first, false);
        }
      }
    });

    this.list = TB.util.el('div', { class: 'tr-list' });
    root.append(this.head, this.filterInput, this.list);
    this.load(false);
  },

  async load(force) {
    if (this.busy || !this.count) return;
    this.busy = true;
    this.count.textContent = force ? '扫描中…' : '读取中…';
    try {
      this.data = await TB.api.trainers.list(force);
    } catch (err) {
      this.data = { items: [], error: `主进程没响应：${err.message}` };
    }
    this.busy = false;
    this.render();
  },

  // 配置里换了文件夹就自动重扫，省得他保存完还要想起来点「重扫」
  update(state) {
    const folder = state?.config?.trainers?.folder || '';
    if (this.data && folder !== this.data.folder) this.load(true);
  },

  visible() {
    const items = this.data?.items || [];
    const needle = this.filter.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => item.name.toLowerCase().includes(needle));
  },

  render() {
    if (!this.count) return;
    const total = (this.data?.items || []).length;
    this.count.textContent = this.data?.error ? '未就绪' : `共 ${total} 个`;
    this.renderList();
  },

  renderList() {
    if (!this.list) return;
    this.list.innerHTML = '';

    if (this.data?.error) {
      this.list.append(TB.util.el('div', { class: 'muted', text: this.data.error }));
      return;
    }

    const items = this.visible();
    if (!items.length) {
      const hint = (this.data?.items || []).length ? '没有匹配的修改器' : '这个目录里没找到 .exe';
      this.list.append(TB.util.el('div', { class: 'muted', text: `${hint}（当前目录：${this.data?.folder || '--'}）` }));
      return;
    }

    for (const item of items) {
      this.list.append(
        TB.util.el(
          'button',
          {
            class: 'tr-item',
            title: `${item.path}\n左键启动 · 右键以管理员启动 · Ctrl+左键在资源管理器里定位`,
            onclick: (event) => {
              if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                this.reveal(item);
                return;
              }
              this.launch(item, false);
            },
            oncontextmenu: (event) => {
              event.preventDefault();
              this.launch(item, true);
            }
          },
          [TB.util.el('span', { class: 'tr-name', text: item.name })]
        )
      );
    }
  },

  async launch(item, elevated) {
    const result = await TB.api.trainers.launch(item.id, Boolean(elevated));
    if (!result?.ok) TB.app.toast(`启动失败：${result?.error || '未知错误'}`, 'warn');
    else if (result.autoElevated) TB.app.toast(`已请求管理员权限启动「${item.name}」（它要求管理员，普通权限点不开）`, 'ok');
    else TB.app.toast(elevated ? `已请求管理员权限启动「${item.name}」` : `已启动「${item.name}」`, 'ok');
  },

  async reveal(item) {
    const result = await TB.api.trainers.reveal(item.id);
    if (!result?.ok) TB.app.toast(`定位失败：${result?.error || '列表已过期'}`, 'warn');
  }
};

TB.register({
  id: 'trainers',
  name: '修改器列表',
  cls: 'area trainers',
  build: () => TB.util.el('div', { id: 'trainers' }),
  init: (node) => TB.trainers.init(node),
  update: (state) => TB.trainers.update(state)
});
