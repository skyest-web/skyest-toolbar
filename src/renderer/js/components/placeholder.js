TB.register({
  id: 'placeholder',
  name: '空白占位',
  cls: 'area placeholder',
  build: () => TB.util.el('div', { class: 'ph-inner' }),
  init: (node) => {
    const at = node.parentElement?.dataset?.slot || '';
    node.append(
      TB.util.el('div', { class: 'ph-title', text: at ? `占位 · ${at}` : '占位' }),
      TB.util.el('div', { class: 'ph-hint', text: '空白位置：在「组件与位置」(Ctrl+L) 里给它挑一个组件' })
    );
  }
});
