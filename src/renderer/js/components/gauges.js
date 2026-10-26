TB.gauges = {
  cards: {
    cpu: { title: 'CPU', color: '#57b6ff', value: '--', sub: '', foot: '' },
    gpu: { title: 'GPU', color: '#7ee787', value: '--', sub: '', foot: '' },
    mem: { title: '内存', color: '#c792ea', value: '--', sub: '', foot: '' },
    net: { title: '网络', color: '#ffcb6b', value: '--', sub: '', foot: '' },
    disk: { title: '磁盘', color: '#ff8b6b', value: '--', sub: '', foot: '' }
  },

  init(root) {
    root.innerHTML = '';
    this.history = {};
    for (const [key, card] of Object.entries(this.cards)) {
      const node = TB.util.el('div', { class: 'gauge', 'data-key': key }, [
        TB.util.el('div', { class: 'gauge-head' }, [
          TB.util.el('span', { class: 'gauge-title', text: card.title }),
          TB.util.el('span', { class: 'gauge-sub', text: '' })
        ]),
        TB.util.el('div', { class: 'gauge-value', text: '--' }),
        TB.util.el('div', { class: 'gauge-bar' }, [TB.util.el('i')]),
        TB.util.el('canvas', { class: 'gauge-spark' }),
        TB.util.el('div', { class: 'gauge-foot', text: card.foot })
      ]);
      node.style.setProperty('--accent', card.color);
      root.appendChild(node);
      card.node = node;
      card.elValue = node.querySelector('.gauge-value');
      card.elSub = node.querySelector('.gauge-sub');
      card.elBar = node.querySelector('.gauge-bar i');
      card.elSpark = node.querySelector('.gauge-spark');
      card.elFoot = node.querySelector('.gauge-foot');
    }
  },

  render(key, { value, percent, sub, foot, series }) {
    const card = this.cards[key];
    if (!card.node) return;
    this.history[key] ||= [];
    const list = this.history[key];
    card.elValue.textContent = value;
    card.elSub.textContent = sub || '';
    card.elFoot.textContent = foot || '';
    card.elBar.style.width = `${TB.util.clamp(percent ?? 0, 0, 100)}%`;
    if (Number.isFinite(series)) {
      const cap = TB.app.config?.metrics?.historySize || 90;
      list.push(series);
      if (list.length > cap) list.shift();
    }
    TB.util.sparkline(card.elSpark, list, card.color);
  },

  update(state) {
    const fast = state.fast || {};
    const full = state.full || {};

    this.render('cpu', {
      value: TB.util.percent(fast.load?.percent),
      percent: fast.load?.percent,
      sub: `${fast.cpuCount || '?'} 核`,
      foot: full.processes?.length ? `占用最高 ${full.processes[0].name}` : '',
      series: fast.load?.percent
    });

    const gpu = (full.gpus || [])[0];
    this.render('gpu', {
      value: gpu ? TB.util.percent(gpu.utilization) : '无 N 卡',
      percent: gpu?.utilization,
      sub: gpu ? gpu.name.replace(/^NVIDIA\s+/i, '') : '',
      foot: gpu
        ? [
            gpu.temperature !== null ? `${gpu.temperature.toFixed(0)}℃` : '',
            gpu.memoryUsedMiB !== null ? `${gpu.memoryUsedMiB.toFixed(0)}/${gpu.memoryTotalMiB.toFixed(0)}MB` : '',
            gpu.powerDrawW !== null ? `${gpu.powerDrawW.toFixed(0)}W` : '',
            gpu.fanPercent !== null ? `风扇 ${gpu.fanPercent.toFixed(0)}%` : ''
          ]
            .filter(Boolean)
            .join(' · ')
        : '未检测到 nvidia-smi',
      series: gpu?.utilization
    });

    this.render('mem', {
      value: TB.util.percent(fast.memory?.percent),
      percent: fast.memory?.percent,
      sub: TB.util.bytes(fast.memory?.used, 0),
      foot: fast.memory ? `共 ${TB.util.bytes(fast.memory.total, 0)}` : '',
      series: fast.memory?.percent
    });

    const net = full.network;
    this.render('net', {
      value: net ? TB.util.rate(net.rxPerSec) : '--',
      percent: net ? TB.util.clamp(((net.rxPerSec || 0) / (100 * 1024 * 1024)) * 100, 0, 100) : 0,
      sub: net ? '上限 100MB/s' : '',
      foot: net ? `↑ ${TB.util.rate(net.txPerSec)}` : '等待统计',
      series: net?.rxPerSec
    });

    const disks = full.disks || [];
    const busiest = disks.reduce((best, disk) => (!best || disk.percent > best.percent ? disk : best), null);
    const driveName = (mount) => String(mount).slice(0, 2);
    this.render('disk', {
      value: busiest ? TB.util.percent(busiest.percent) : '--',
      percent: busiest?.percent,
      sub: busiest ? `剩余 ${TB.util.bytes(busiest.available, 0)}` : '',
      foot: disks.map((disk) => `${driveName(disk.mount)} 剩 ${TB.util.bytes(disk.available, 0)}`).join(' · '),
      series: busiest?.percent
    });
  }
};

TB.register({
  id: 'gauges',
  name: '系统指标卡片',
  cls: 'area gauges',
  build: () => TB.util.el('div', { id: 'gauges', class: 'gauge-row' }),
  init: (node) => TB.gauges.init(node),
  update: (state) => TB.gauges.update(state)
});
