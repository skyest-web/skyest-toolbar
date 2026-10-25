TB.clock = {
  init(root) {
    root.innerHTML = '';
    this.time = TB.util.el('div', { class: 'clock-time', text: '--:--:--' });
    this.date = TB.util.el('div', { class: 'clock-date', text: '' });
    this.chips = TB.util.el('div', { class: 'clock-chips' });
    root.append(this.time, this.date, this.chips);

    this.fields = {};
    for (const key of ['主机', '系统', '开机', '屏幕']) {
      const value = TB.util.el('span', { class: 'chip-value', text: '--' });
      this.fields[key] = value;
      this.chips.appendChild(TB.util.el('div', { class: 'chip' }, [TB.util.el('span', { class: 'chip-label', text: key }), value]));
    }

    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
  },

  tick() {
    const now = new Date();
    this.time.textContent = now.toLocaleTimeString('zh-CN', { hour12: false });
    const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
    this.date.textContent = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${weekday}`;
  },

  update(state) {
    const full = state.full || {};
    const placement = state.placement || {};
    const display = placement.display;
    this.fields['主机'].textContent = full.hostname || TB.app?.config?.hostname || '--';
    this.fields['系统'].textContent = full.platform || '--';
    this.fields['开机'].textContent = TB.util.duration(full.uptimeSeconds);
    this.fields['屏幕'].textContent = display ? `${display.bounds.width}x${display.bounds.height} @${display.scaleFactor}x` : '--';
  }
};
