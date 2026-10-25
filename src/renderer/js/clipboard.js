TB.clipboard = {
  init(root) {
    root.innerHTML = '';
    this.head = TB.util.el('div', { class: 'clip-head' }, [
      TB.util.el('span', { class: 'panel-title', text: '剪贴板历史' }),
      TB.util.el('button', { class: 'link-btn', text: '清空', onclick: () => TB.api.clipboard.clear() })
    ]);
    this.list = TB.util.el('div', { class: 'clip-list' });
    root.append(this.head, this.list);
  },

  timeText(at) {
    return new Date(at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  },

  update(state) {
    const items = state.clipboard || [];
    this.head.querySelector('.link-btn').textContent = items.length ? `清空 ${items.length}` : '清空';
    this.list.innerHTML = '';
    if (!items.length) {
      this.list.appendChild(TB.util.el('div', { class: 'muted', text: '复制过的内容会出现在这里（仅存在内存，退出即清空）' }));
      return;
    }
    for (const item of items) {
      const children = [TB.util.el('span', { class: 'clip-time', text: this.timeText(item.at) })];
      if (item.thumb) children.push(TB.util.el('img', { class: 'clip-thumb', src: item.thumb, alt: '图片预览' }));
      children.push(TB.util.el('span', { class: 'clip-text', text: item.preview }));
      this.list.appendChild(
        TB.util.el('button', {
          class: 'clip-item',
          title: '点击重新复制',
          onclick: async () => {
            await TB.api.clipboard.copy(item.id);
            TB.app.toast('已复制到剪贴板', 'ok');
          }
        }, children)
      );
    }
  }
};
