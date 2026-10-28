// dsh 的渲染层这一半：现在只剩「入口 + 状态」。
// 面板本体已经是一个独立的系统窗口（src/main/services/dsh-window.js），能被拖到别的屏幕，
// 所以这里不再画框、不再量尺寸、不再报 bounds；带 token 的地址也依旧只留在主进程。
TB.dsh = {
  init() {
    this.state = null;
    this.busy = false;
    this.onChange = null;
    TB.api.dsh.status().then((status) => this.apply(status));
    TB.api.dsh.onState((status) => this.apply(status));
  },

  // 只有一个消费方（AI 头部的入口按钮），所以是单槽而不是监听器集合：
  // 组件每次重建都会重新登记，攒着就漏了
  subscribe(fn) {
    this.onChange = fn;
  },

  label() {
    if (this.busy) return 'Harness · 启动中…';
    const state = this.state;
    if (!state || !state.installed) return 'Harness · 未安装';
    if (state.running) return state.visible ? `Harness · :${state.port} ▣` : `Harness · :${state.port}`;
    return 'Harness';
  },

  // 已经开着就别再拉一遍：主进程的 show() 只是把窗口提到前面并抢焦点，
  // 窗口被拖到别的屏幕、一时找不到了，双击宠物就能把它要回来
  async open() {
    this.busy = true;
    this.emit();
    const result = await TB.api.dsh.show();
    this.busy = false;
    this.apply(result.status);
    if (!result.ok) TB.app.toast(`Harness 启动失败：${result.message}`, 'error');
    return result;
  },

  close() {
    TB.api.dsh.hide();
    this.apply({ ...this.state, visible: false });
  },

  apply(status) {
    if (!status) return;
    this.state = status;
    this.emit();
  },

  emit() {
    if (this.onChange) this.onChange(this.state);
  }
};
