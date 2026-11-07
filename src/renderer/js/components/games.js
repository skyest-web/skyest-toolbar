// 游戏列表（游戏面板中间那一大格）：两列并排，每格一款 Steam 游戏——左边图标，右上游戏名，右下它对应的修改器。
//
// 数据来自 library:list：主进程把 Steam 库 + 修改器目录 + 别名表 + 本地图标缓存拼成一份行数据，
// 这里只渲染。启动不在这一层：点游戏名走 steam.launch(id)，点标签走 trainers.launch(id)，
// 两边的 id 都是各自服务那批缓存的序号，渲染层拿不到也不需要拿到任何可执行路径。
//
// 图标是 Steam 自己缓存的本地图（appcache/librarycache 下那张 32×32），路径由主进程给，
// 这里按桌宠图标同样的方式拼成 file:///；CSP 里已经放了 file:，不外网抓图。

function fileUrl(winPath) {
  return winPath ? `file:///${String(winPath).replace(/\\/g, '/')}` : '';
}

TB.games = {
  // 筛选词存在 JS 上而不是 input 里：切面板会整体重建 DOM
  filter: '',
  data: null,
  busy: false,

  init(root) {
    root.innerHTML = '';

    this.count = TB.util.el('span', { class: 'gz-count', text: '加载中…' });
    this.rescan = TB.util.el('button', {
      class: 'link-btn',
      text: '重扫',
      title: '重新读一遍 Steam 清单和修改器目录（新装游戏或新下载修改器之后点这个）',
      onclick: () => this.load(true)
    });
    this.head = TB.util.el('div', { class: 'gz-head' }, [
      TB.util.el('span', { class: 'panel-title', text: '游戏列表' }),
      this.count,
      this.rescan
    ]);

    this.filterInput = TB.util.el('input', {
      class: 'input gz-filter',
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
          if (first) this.launch(first);
        }
      }
    });

    this.list = TB.util.el('div', { class: 'gz-list' });
    root.append(this.head, this.filterInput, this.list);
    this.load(false);
  },

  async load(force) {
    if (this.busy || !this.count) return;
    this.busy = true;
    this.count.textContent = force ? '重扫中…' : '读取中…';
    try {
      this.data = await TB.api.library.list(force);
    } catch (err) {
      this.data = { rows: [], stats: {}, error: `主进程没响应：${err.message}` };
    }
    this.busy = false;
    this.render();
  },

  // 配置里换了任一个文件夹就自动重扫，省得保存完还要想起来点「重扫」
  update(state) {
    const steamFolder = state?.config?.steam?.folder || '';
    const trainersFolder = state?.config?.trainers?.folder || '';
    if (!this.data) return;
    if (steamFolder !== this.data.steamFolder || trainersFolder !== this.data.trainersFolder) this.load(true);
  },

  visible() {
    const rows = this.data?.rows || [];
    const needle = this.filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => row.name.toLowerCase().includes(needle));
  },

  render() {
    if (!this.count) return;
    const stats = this.data?.stats || {};
    this.count.textContent = this.data?.error
      ? '未就绪'
      : `共 ${stats.games || 0} 款 · ${stats.withTrainer || 0} 款有修改器 · 图标 ${stats.icons || 0}`;
    this.renderList();
  },

  renderList() {
    if (!this.list) return;
    this.list.innerHTML = '';

    if (this.data?.error) {
      this.list.append(TB.util.el('div', { class: 'muted', text: this.data.error }));
      return;
    }

    const rows = this.visible();
    if (!rows.length) {
      const hint = (this.data?.rows || []).length ? '没有匹配的游戏' : '这个库里没有已安装的游戏';
      this.list.append(TB.util.el('div', { class: 'muted', text: `${hint}（当前库：${this.data?.steamFolder || '--'}）` }));
      return;
    }

    for (const row of rows) this.list.append(this.row(row));
  },

  row(item) {
    const played = TB.util.ago(item.played);
    const icon = item.icon
      ? TB.util.el('img', {
          class: 'gz-icon',
          src: fileUrl(item.icon),
          alt: '',
          // 图没了就退回一个同尺寸的透明位：整行的名字和标签才是主角，图标坏掉不该留个破图标，也不该行高跟着跳
          onerror: (event) => event.target.classList.add('broken')
        })
      : TB.util.el('span', { class: 'gz-icon broken' });

    return TB.util.el('div', {
      class: 'gz-item',
      title: `${item.name}\n${TB.util.bytes(item.size)} · 上次游玩 ${played} · appid ${item.appid}\n左键通过 Steam 启动 · Ctrl+左键打开安装目录`,
      onclick: (event) => {
        if (event.target.closest('.gz-chip')) return;
        if (event.ctrlKey || event.metaKey) {
          this.reveal(item);
          return;
        }
        this.launch(item);
      }
    }, [
      icon,
      TB.util.el('div', { class: 'gz-body' }, [
        TB.util.el('div', { class: 'gz-title' }, [
          TB.util.el('span', { class: 'gz-name', text: item.name }),
          TB.util.el('span', { class: 'gz-ago', text: played })
        ]),
        // 对不上 Steam 的修改器不显示；没有对应修改器的游戏就只留名字这一行
        TB.util.el('div', { class: 'gz-chips' }, item.trainers.map((chip) => this.chip(item, chip)))
      ])
    ]);
  },

  chip(item, chip) {
    return TB.util.el('button', {
      class: 'gz-chip',
      text: chip.short,
      title: `${chip.name}\n属于「${item.name}」\n左键启动 · 右键以管理员启动`,
      onclick: (event) => {
        event.stopPropagation();
        this.launchTrainer(chip);
      },
      oncontextmenu: (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.launchTrainer(chip, true);
      }
    });
  },

  async launch(item) {
    const result = await TB.api.steam.launch(item.id);
    if (result?.ok) TB.app.toast(`已交给 Steam 启动「${item.name}」`, 'ok');
    else TB.app.toast(`启动失败：${result?.error || '未知错误'}`, 'warn');
  },

  async reveal(item) {
    const result = await TB.api.steam.reveal(item.id);
    if (!result?.ok) TB.app.toast(`定位失败：${result?.error || '列表已过期'}`, 'warn');
  },

  async launchTrainer(chip, elevated) {
    const result = await TB.api.trainers.launch(chip.id, Boolean(elevated));
    if (!result?.ok) TB.app.toast(`启动失败：${result?.error || '未知错误'}`, 'warn');
    // 普通权限点不开、自动改走 UAC 的那批要说明白，不然他会以为点错了手势
    else if (result.autoElevated) TB.app.toast(`已请求管理员权限启动「${chip.name}」（它要求管理员，普通权限点不开）`, 'ok');
    else TB.app.toast(elevated ? `已请求管理员权限启动「${chip.name}」` : `已启动「${chip.name}」`, 'ok');
  }
};

TB.register({
  id: 'games',
  name: '游戏列表（Steam + 修改器）',
  cls: 'area games',
  build: () => TB.util.el('div', { id: 'games' }),
  init: (node) => TB.games.init(node),
  update: (state) => TB.games.update(state)
});
