TB.register({
  id: 'topbar',
  name: '顶栏（设置与退出）',
  cls: 'topbar',
  build: () =>
    TB.util.el('div', { class: 'topbar-inner' }, [
      TB.util.el('div', { class: 'brand' }, [TB.util.el('span', { class: 'dot' }), TB.util.el('span', { text: '桌面工具栏' })]),
      TB.util.el('div', { class: 'topbar-right' }, [
        TB.util.el('span', { class: 'muted', id: 'placement-label' }),
        TB.util.el('button', { class: 'ghost-btn', id: 'btn-layout', text: '组件', title: '组件与位置 (Ctrl+L)' }),
        TB.util.el('button', { class: 'ghost-btn', id: 'btn-settings', text: '设置', title: '设置 (Ctrl+,)' }),
        TB.util.el('button', { class: 'ghost-btn danger-text', id: 'btn-quit', text: '退出', title: '退出工具栏' })
      ])
    ]),
  init() {
    document.getElementById('btn-layout')?.addEventListener('click', () => TB.layoutEditor.open());
    document.getElementById('btn-settings')?.addEventListener('click', () => TB.settings.open());
    document.getElementById('btn-quit')?.addEventListener('click', () => TB.api.app.quit());
  }
});
