window.TB = window.TB || {};

TB.util = {
  el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  },

  bytes(value, digits = 1) {
    if (value === null || value === undefined || Number.isNaN(value)) return '--';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let num = Math.abs(value);
    let index = 0;
    while (num >= 1024 && index < units.length - 1) {
      num /= 1024;
      index += 1;
    }
    return `${num.toFixed(index === 0 ? 0 : digits)} ${units[index]}`;
  },

  rate(bytesPerSecond) {
    if (bytesPerSecond === null || bytesPerSecond === undefined) return '--';
    return `${TB.util.bytes(bytesPerSecond, 2)}/s`;
  },

  percent(value, digits = 0) {
    if (value === null || value === undefined || Number.isNaN(value)) return '--';
    return `${value.toFixed(digits)}%`;
  },

  duration(seconds) {
    if (!Number.isFinite(seconds)) return '--';
    const units = [
      ['d', 86400],
      ['h', 3600],
      ['m', 60]
    ];
    const parts = [];
    let left = Math.floor(seconds);
    for (const [label, size] of units) {
      const value = Math.floor(left / size);
      if (value > 0) {
        parts.push(`${value}${label}`);
        left -= value * size;
      }
      if (parts.length === 3) break;
    }
    return parts.length ? parts.join(' ') : `${left}s`;
  },

  clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  },

  sparkline(canvas, values, color) {
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio;
      canvas.height = height * ratio;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const points = values.filter((value) => Number.isFinite(value));
    if (points.length < 2) return;

    const max = Math.max(1, ...points);
    const step = width / (points.length - 1);
    const path = new Path2D();
    points.forEach((value, index) => {
      const x = index * step;
      const y = height - (value / max) * (height - 3) - 1.5;
      index === 0 ? path.moveTo(x, y) : path.lineTo(x, y);
    });

    const fill = new Path2D(path);
    fill.lineTo(width, height);
    fill.lineTo(0, height);
    fill.closePath();
    ctx.fillStyle = `${color}22`;
    ctx.fill(fill);

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  },

  escape(text) {
    return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
};
