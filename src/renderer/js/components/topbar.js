TB.register({
  id: 'topbar',
  name: '顶栏（搜索与设置）',
  cls: 'topbar',
  build: () => {
    // search.enabled=false 时整条搜索栏不出现（Ctrl+F 也随之无效）：设置里那个开关得真的管用
    const searchEnabled = TB.app?.state?.config?.search?.enabled !== false;
    const bar = TB.util.el('div', { class: 'search-bar' }, [
      TB.util.el('span', { class: 'search-icon', text: '⌕' }),
      TB.util.el('input', {
        class: 'search-input',
        id: 'search-input',
        type: 'text',
        spellcheck: 'false',
        placeholder: '搜索文件（Everything 全盘）· Ctrl+F',
        title: '输入文件名片段即搜，回车打开高亮项，↑↓ 选择，Esc 收起'
      }),
      TB.util.el('span', { class: 'search-badge', id: 'search-badge', text: '未连接' })
    ]);
    const pages = TB.app?.pages?.() || [];
    const tabs =
      pages.length > 1
        ? TB.util.el(
            'div',
            { class: 'page-tabs', role: 'tablist', title: '切换面板；每个面板的位置在「组件与位置」(Ctrl+L) 里单独配' },
            pages.map((page) =>
              TB.util.el('button', {
                class: `page-tab${page.id === TB.app.state.page ? ' active' : ''}`,
                text: page.name,
                'data-page': page.id,
                onclick: () => TB.app.setPage(page.id)
              })
            )
          )
        : null;
    return TB.util.el('div', { class: 'topbar-inner' }, [
      TB.util.el('div', { class: 'brand' }, [TB.util.el('span', { class: 'dot' }), TB.util.el('span', { text: '桌面工具栏' })]),
      ...(tabs ? [tabs] : []),
      ...(searchEnabled ? [bar] : []),
      TB.util.el('div', { class: 'topbar-right' }, [
        TB.util.el('span', { class: 'muted', id: 'placement-label' }),
        TB.util.el('button', { class: 'ghost-btn', id: 'btn-layout', text: '组件', title: '组件与位置 (Ctrl+L)' }),
        TB.util.el('button', { class: 'ghost-btn', id: 'btn-settings', text: '设置', title: '设置 (Ctrl+,)' }),
        TB.util.el('button', { class: 'ghost-btn danger-text', id: 'btn-quit', text: '退出', title: '退出工具栏' })
      ])
    ]);
  },
  init() {
    TB.search.attachBar(document.getElementById('search-input'), document.getElementById('search-badge'));
    document.getElementById('btn-layout')?.addEventListener('click', () => TB.layoutEditor.open());
    document.getElementById('btn-settings')?.addEventListener('click', () => TB.settings.open());
    document.getElementById('btn-quit')?.addEventListener('click', () => TB.api.app.quit());
  }
});
