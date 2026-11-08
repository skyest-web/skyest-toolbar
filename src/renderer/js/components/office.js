// 办公文档（工作面板第 3 列那一整块 officezone，约 572×402）：一个文件夹里的 Word / Excel / PPT / PDF。
//
// 数据来自 office:scan：主进程按 config.office.folder 扫盘、按修改时间倒排，这里只渲染。
// 打开不在这一层：左键走 office.open(id)，Ctrl+左键走 office.reveal(id)。id 是主进程这次缓存里的那条
// （小写绝对路径），文档的完整路径只出现在悬浮说明里，任何它递回主进程的路径都进不了 openPath。
//
// 手势为什么是「左键直接打开」而不是项目格那套「左键选中 / 双击启动」：
// 这一格旁边没有第二格要喂，选中没有第二个用途；而点开一份文档正是他扫这个文件夹的目的。
// 代价是一次单击就拉起 Word/Excel，所以浏览器在双击时送的第二发 click 必须自己咽掉
// （见 row() 里那句 lastClick）——不然主进程那 3 秒防抖会把「刚刚已经点开过同一个」这句
// 当失败弹回来，双击一次反而每次都被警告一句。
//
// 四类单子（文档 / 表格 / 演示 / PDF）的筛选是纯本地的：切筛选不重扫，也不发 IPC。

TB.office = {
  KINDS: [
    { id: 'all', label: '全部' },
    { id: 'word', label: '文档' },
    { id: 'sheet', label: '表格' },
    { id: 'slides', label: '演示' },
    { id: 'pdf', label: 'PDF' }
  ],

  data: null,
  filter: 'all',
  busy: false,
  lastClick: { id: null, at: 0 },

  init(root) {
    root.innerHTML = '';

    this.count = TB.util.el('span', { class: 'of-count', text: '读取中…' });
    this.rescan = TB.util.el('button', {
      class: 'link-btn',
      text: '重扫',
      title: '重新扫一遍办公文档文件夹（刚存了新文件、或改了设置里的文件夹之后点这个）',
      onclick: () => this.load(true)
    });
    this.chips = this.KINDS.map((kind) => TB.util.el('button', {
      class: 'seg-btn',
      text: kind.label,
      title: `只看${kind.label}那一类（筛选是本地的事，不会重新扫盘）`,
      onclick: () => this.setFilter(kind.id)
    }));
    this.head = TB.util.el('div', { class: 'of-head' }, [
      TB.util.el('span', { class: 'panel-title', text: '办公' }),
      this.count,
      TB.util.el('div', { class: 'of-tabs' }, this.chips),
      this.rescan
    ]);

    this.list = TB.util.el('div', { class: 'of-list' });
    root.append(this.head, this.list);
    this.load(false);
  },

  async load(force) {
    if (this.busy || !this.count) return;
    this.busy = true;
    this.count.textContent = force ? '重扫中…' : '读取中…';
    try {
      this.data = await TB.api.office.scan(force);
    } catch (err) {
      this.data = { folder: '', items: [], error: `主进程没响应：${err.message}` };
    }
    this.busy = false;
    this.render();
  },

  // 这一格没有别的格会反过来问它话，所以 update 只管一件事：切面板把 DOM 重建了，数据要补回来。
  // 缓存过期与「改了文件夹」都由主进程那句 folder 比对决定，这里不自己掐表。
  update() {
    if (!this.data && this.count) this.load(false);
  },

  setFilter(id) {
    if (this.filter === id) return;
    this.filter = id;
    this.renderChips();
    this.renderList();
  },

  renderChips() {
    this.chips?.forEach((chip, index) => chip.classList.toggle('on', this.KINDS[index].id === this.filter));
  },

  render() {
    if (!this.count) return;
    const items = this.data?.items || [];
    const error = this.data?.error;
    // 有 error 时列表里只有那句提示、一行文档都没有，牌子就不能还按 items 报「6 份」。
    // 但 error 里混着两种：`empty` 说明「扫成了、里面就是没有」，那句写「0 份」是对的；
    // 剩下五种是压根没扫成，写「0 份」是把故障说成空，所以先写「未就绪」。
    this.count.textContent = error && !this.data?.empty ? '未就绪' : `${items.length} 份`;
    this.renderChips();
    this.renderList();
  },

  visible() {
    const items = this.data?.items || [];
    // 报错时不许还留着上一批行：文件夹改成空目录以后，列表里那些旧文档点开只会「文件不存在」
    if (this.filter === 'all') return items;
    return items.filter((item) => item.kind === this.filter);
  },

  renderList() {
    if (!this.list) return;
    this.list.innerHTML = '';

    if (this.data?.error) {
      this.list.append(TB.util.el('div', { class: 'of-note', text: this.data.error }));
      return;
    }

    const rows = this.visible();
    if (!rows.length) {
      const empty = this.filter === 'all'
        ? `「${this.data?.folder || '办公文件夹'}」里没有办公文档`
        : `${(this.data?.items || []).length} 份文档里没有${this.KINDS.find((kind) => kind.id === this.filter)?.label || ''}这一类`;
      this.list.append(TB.util.el('div', { class: 'of-note', text: empty }));
      return;
    }
    for (const item of rows) this.list.append(this.row(item));
  },

  row(item) {
    return TB.util.el('div', {
      class: 'of-item',
      'data-id': item.id,
      'data-kind': item.kind,
      title: [
        item.path,
        `${item.kindLabel} · ${item.ext.toUpperCase()} · ${TB.util.bytes(item.size)}`,
        `改动时间：${TB.util.date(item.mtime)}`,
        '左键用系统默认程序打开 · Ctrl+左键在资源管理器里选中它'
      ].join('\n'),
      onclick: (event) => {
        if (event.ctrlKey || event.metaKey) {
          this.reveal(item);
          return;
        }
        if (this.lastClick.id === item.id && Date.now() - this.lastClick.at < 500) return;
        this.lastClick = { id: item.id, at: Date.now() };
        this.open(item);
      }
    }, [
      TB.util.el('span', { class: `of-kind kind-${item.kind}`, text: item.kindLabel }),
      TB.util.el('span', { class: 'of-name', text: item.title }),
      TB.util.el('span', { class: 'of-dir', text: item.dir }),
      TB.util.el('span', { class: 'of-ago', text: TB.util.ago(item.mtime) })
    ]);
  },

  async open(item) {
    const result = await TB.api.office.open(item.id);
    if (result?.ok) TB.app.toast(`已交给系统打开「${item.title}」`, 'ok');
    else TB.app.toast(`打开失败：${result?.error || '未知错误'}`, 'warn');
  },

  async reveal(item) {
    const result = await TB.api.office.reveal(item.id);
    if (!result?.ok) TB.app.toast(`打开文件夹失败：${result?.error || '未知错误'}`, 'warn');
  }
};

TB.register({
  id: 'office',
  name: '办公文档',
  cls: 'area office-area',
  build: () => TB.util.el('div', { id: 'office' }),
  init: (node) => TB.office.init(node),
  update: () => TB.office.update()
});
