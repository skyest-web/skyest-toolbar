// 邮箱（生活面板左侧那一整块，原来 clock+player 的位置）：最近 N 封的信封头部——
// 发件人、主题、时间，未读的在行首点一个点。
//
// 数据走 mail:list：主进程用 IMAP 只读拉头部，这一层只渲染，不改服务器上的任何状态
// （不标已读、不移动、不删除——点了也不算已读，这是他能看到「还没处理过」的前提）。
// 要回信就走行底的「网页邮箱」，那个地址在主进程从配置取，渲染层连字符串都递不进去。
//
// 状态存 JS 上而不是 DOM 里：切面板会整体重建 DOM（见 QODER.md「组件不能只在 DOM 里存在状态」）。
// 定时器的句柄也存 JS 上，init 第一件事就是清掉上一个——不然切几次面板就叠几个轮询。

TB.mail = {
  data: null,
  status: null,
  busy: false,
  onlyUnread: false,
  root: null,
  bound: false,

  init(root) {
    this.root = root;
    root.innerHTML = '';

    this.count = TB.util.el('span', { class: 'ml-count', text: '读取中…' });
    this.refreshBtn = TB.util.el('button', {
      class: 'link-btn',
      text: '刷新',
      title: '重新连一次 IMAP 拉最近的邮件头部（60 秒内的结果本来就走缓存）',
      onclick: () => this.load(true)
    });
    this.unreadBtn = TB.util.el('button', {
      class: 'link-btn',
      text: '只看未读',
      title: '只在列表里显示未读的那几封',
      onclick: () => {
        this.onlyUnread = !this.onlyUnread;
        this.render();
      }
    });
    this.head = TB.util.el('div', { class: 'ml-head' }, [
      TB.util.el('span', { class: 'panel-title', text: '邮箱' }),
      this.count,
      this.unreadBtn,
      this.refreshBtn
    ]);

    this.list = TB.util.el('div', { class: 'ml-list' });

    this.accountLine = TB.util.el('span', { class: 'ml-who', text: '' });
    this.webBtn = TB.util.el('button', {
      class: 'link-btn',
      text: '网页邮箱',
      title: '用系统浏览器打开网页邮箱回信（地址在设置 → 邮箱 → 网页地址）',
      onclick: async () => {
        const result = await TB.api.mail.openWebmail();
        if (!result?.ok) TB.app.toast(`打开失败：${result?.error || '浏览器没响应'}`, 'error');
      }
    });
    this.foot = TB.util.el('div', { class: 'ml-foot' }, [this.accountLine, this.webBtn]);

    root.append(this.head, this.list, this.foot);

    // 先拿一次状态：账号没填 / 授权码没存这两种情况，列表里要直接说清楚该去哪儿填
    TB.api.mail
      .status()
      .then((status) => {
        this.status = status;
      })
      .catch(() => {});
    // 订阅只绑一次：TB.mail 是单例，切面板会重新 init，绑两遍就是一次推送取两遍数据。
    // 轮询本身搬进了主进程（停在别的面板也要能发现新邮件），这一格只负责「主进程推来了就重画」。
    if (!this.bound) {
      this.bound = true;
      TB.api.mail.onUpdated(() => this.load(false));
    }
    this.load(false);
  },

  async load(force) {
    // 面板切走了 root 会脱离文档：那时候别再发 IPC，主进程的看护轮询会替我们拉
    if (this.busy || !this.root?.isConnected || !this.count) return;
    this.busy = true;
    this.count.textContent = force ? '连接中…' : '读取中…';
    try {
      this.data = await TB.api.mail.list(force);
    } catch (err) {
      this.data = { ok: false, rows: this.data?.rows || [], stats: this.data?.stats || {}, error: `主进程没响应：${err.message}` };
    }
    this.busy = false;
    this.render();
  },

  // 设置里换了账号 / 服务器 / 封数，或把组件关了：重取一次状态并强制拉一遍（轮询由主进程看护）
  update(state) {
    const cfg = state?.config?.mail || {};
    const seen = this.seenCfg || {};
    const keys = ['account', 'host', 'port', 'mailbox', 'maxMessages', 'pollMs', 'enabled'];
    const changed = keys.some((key) => cfg[key] !== seen[key]);
    this.seenCfg = Object.fromEntries(keys.map((key) => [key, cfg[key]]));
    if (!changed || !this.count) return;
    TB.api.mail
      .status()
      .then((status) => {
        this.status = status;
        this.render();
      })
      .catch(() => {});
    this.load(true);
  },

  visible() {
    const rows = this.data?.rows || [];
    return this.onlyUnread ? rows.filter((row) => row.unseen) : rows;
  },

  // 这一格只有 330px 宽，时间写得越短越好：今天几点、昨天、几月几日、跨年才带年份
  when(ms) {
    if (!ms) return '';
    const at = new Date(ms);
    const now = new Date();
    const sameDay = at.toDateString() === now.toDateString();
    const pad = (n) => String(n).padStart(2, '0');
    if (sameDay) return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    const yesterday = new Date(now.getTime() - 86400000);
    if (at.toDateString() === yesterday.toDateString()) return '昨天';
    if (at.getFullYear() === now.getFullYear()) return `${at.getMonth() + 1}月${at.getDate()}日`;
    return `${at.getFullYear()}/${pad(at.getMonth() + 1)}/${pad(at.getDate())}`;
  },

  render() {
    if (!this.count) return;
    const stats = this.data?.stats || {};
    const unseen = Number(stats.unseen) || 0;
    this.count.textContent = this.data?.error
      ? '未就绪'
      : unseen
        ? `未读 ${unseen} · 共 ${stats.total || 0}`
        : `全读完 · 共 ${stats.total || 0}`;
    this.unreadBtn.classList.toggle('on', this.onlyUnread);
    this.accountLine.textContent = this.status?.account || '没填账号';
    this.accountLine.title = this.status
      ? `${this.status.account || '（未填）'} @ ${this.status.host}:${this.status.port} · ${this.status.mailbox} · 每次 ${this.status.maxMessages} 封\n未读数取整箱，列表只拉最近那一截`
      : '';
    this.renderList();
  },

  renderList() {
    if (!this.list) return;
    this.list.innerHTML = '';

    if (this.data?.error) {
      this.list.append(TB.util.el('div', { class: 'ml-note', text: this.data.error }));
      if (this.data.stale && this.data.rows?.length) {
        this.list.append(TB.util.el('div', { class: 'ml-note muted', text: `下面是 ${this.whenLast()} 拉到的旧结果，先凑合看` }));
      }
    }

    const rows = this.visible();
    if (!rows.length) {
      if (!this.data?.error) {
        const hint = this.data?.rows?.length ? '没有未读的邮件' : '收件箱是空的';
        this.list.append(TB.util.el('div', { class: 'ml-note muted', text: hint }));
      }
      return;
    }
    for (const row of rows) this.list.append(this.item(row));
  },

  whenLast() {
    const at = this.data?.fetchedAt || this.status?.fetchedAt || 0;
    return at ? this.when(at) : '上次';
  },

  item(row) {
    return TB.util.el('div', {
      class: `ml-item${row.unseen ? ' unread' : ''}`,
      title: `${row.subject}\n来自 ${row.name} <${row.address}> · ${new Date(row.date).toLocaleString('zh-CN')}\n${row.unseen ? '未读' : '已读'} · 序号 ${row.id}`,
      // 只读组件：点这里不改服务器状态，也不假装能就地回信
      onclick: () => TB.app.toast(`${row.unseen ? '未读' : '已读'} · ${row.name}：${row.subject}`, 'info')
    }, [
      TB.util.el('span', { class: 'ml-dot' }),
      TB.util.el('div', { class: 'ml-body' }, [
        TB.util.el('div', { class: 'ml-line' }, [
          TB.util.el('span', { class: 'ml-from', text: row.name || row.address || '未知发件人' }),
          TB.util.el('span', { class: 'ml-when', text: this.when(row.date) })
        ]),
        TB.util.el('div', { class: 'ml-subject', text: row.subject })
      ])
    ]);
  }
};

TB.register({
  id: 'mail',
  name: '邮箱（163 只读收件）',
  cls: 'area mail',
  build: () => TB.util.el('div', { id: 'mail' }),
  init: (node) => TB.mail.init(node),
  update: (state) => TB.mail.update(state)
});
