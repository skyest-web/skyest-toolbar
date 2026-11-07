// Steam 库列表：把库里的已安装游戏列成一格一格的按钮，点一下通过 Steam 启动。
//
// 渲染层只拿 id 和名字——appid、安装目录都留在主进程这次扫出来的缓存里（和修改器那条纪律一样）。
// 提示语写的是「已交给 Steam」而不是「已启动」：我们只能保证把 appid 交给了客户端，
// 至于 Steam 有没有真的把游戏拉起来（启动选项、需要更新、离线模式），这里看不到。

function sizeLabel(bytes) {
  if (!bytes) return '--';
  const gb = bytes / 1024 / 1024 / 1024;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

TB.steam = {
  // 筛选词存在 JS 上而不是 input 里：切面板会整体重建 DOM
  filter: '',
  data: null,
  busy: false,

  init(root) {
    root.innerHTML = '';

    this.count = TB.util.el('span', { class: 'st-count', text: '加载中…' });
    this.rescan = TB.util.el('button', {
      class: 'link-btn',
      text: '重扫',
      title: '重新读一遍 steamapps 的清单（新装或卸载了游戏之后点这个）',
      onclick: () => this.load(true)
    });
    this.head = TB.util.el('div', { class: 'st-head' }, [
      TB.util.el('span', { class: 'panel-title', text: 'Steam 游戏' }),
      this.count,
      this.rescan
    ]);

    this.filterInput = TB.util.el('input', {
      class: 'input st-filter',
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

    this.list = TB.util.el('div', { class: 'st-list' });
    root.append(this.head, this.filterInput, this.list);
    this.load(false);
  },

  async load(force) {
    if (this.busy || !this.count) return;
    this.busy = true;
    this.count.textContent = force ? '重扫中…' : '读取中…';
    try {
      this.data = await TB.api.steam.list(force);
    } catch (err) {
      this.data = { items: [], error: `主进程没响应：${err.message}` };
    }
    this.busy = false;
    this.render();
  },

  // 配置里换了库文件夹就自动重扫，省得保存完还要想起来点「重扫」
  update(state) {
    const folder = state?.config?.steam?.folder || '';
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
    this.count.textContent = this.data?.error ? '未就绪' : `共 ${total} 款`;
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
      const hint = (this.data?.items || []).length ? '没有匹配的游戏' : '这个库里没有已安装的游戏';
      this.list.append(TB.util.el('div', { class: 'muted', text: `${hint}（当前库：${this.data?.folder || '--'}）` }));
      return;
    }

    for (const item of items) {
      const played = TB.util.ago(item.played);
      this.list.append(
        TB.util.el(
          'button',
          {
            class: 'st-item',
            title: `${item.name}\n${sizeLabel(item.size)} · 上次游玩 ${played} · appid ${item.appid}\n左键通过 Steam 启动 · Ctrl+左键打开安装目录`,
            onclick: (event) => {
              if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                this.reveal(item);
                return;
              }
              this.launch(item);
            }
          },
          [
            TB.util.el('span', { class: 'st-name', text: item.name }),
            TB.util.el('span', { class: 'st-ago', text: played })
          ]
        )
      );
    }
  },

  async launch(item) {
    const result = await TB.api.steam.launch(item.id);
    if (result?.ok) TB.app.toast(`已交给 Steam 启动「${item.name}」`, 'ok');
    else TB.app.toast(`启动失败：${result?.error || '未知错误'}`, 'warn');
  },

  async reveal(item) {
    const result = await TB.api.steam.reveal(item.id);
    if (!result?.ok) TB.app.toast(`定位失败：${result?.error || '列表已过期'}`, 'warn');
  }
};

TB.register({
  id: 'steam',
  name: 'Steam 游戏列表',
  cls: 'area steam',
  build: () => TB.util.el('div', { id: 'steam' }),
  init: (node) => TB.steam.init(node),
  update: (state) => TB.steam.update(state)
});
