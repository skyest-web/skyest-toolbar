window.TB = window.TB || {};

// 组件注册表。components/ 目录下的每个 .js 在加载时调用一次 TB.register，
// 之后就能在「组件与位置」面板里被放到任意位置、或关掉不显示。
//
// 一个组件只需要四样东西：
//   id    —— layout.json 的 slots.module 用它来引用
//   name  —— 面板里显示的名字
//   cls   —— 外层 <section> 的 class（决定配色与内边距，样式在 styles.css）
//   build —— 返回组件自己的 DOM 节点；init(node) 里挂事件、update(state) 里刷新数据
TB.components = new Map();

TB.register = (def) => {
  if (!def?.id || typeof def.build !== 'function') {
    console.warn('[components] 组件缺少 id 或 build，已忽略', def?.id || def);
    return;
  }
  TB.components.set(def.id, def);
};
