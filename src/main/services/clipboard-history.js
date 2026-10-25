const { clipboard, nativeImage } = require('electron');

const MAX_PREVIEW = 400;

/**
 * History lives in memory only: pasted passwords and tokens never reach disk.
 */
class ClipboardHistory {
  constructor({ maxItems = 30, pollMs = 800, enabled = true } = {}) {
    this.maxItems = maxItems;
    this.pollMs = pollMs;
    this.enabled = enabled;
    this.items = [];
    this.timer = null;
    this.listeners = new Set();
    this.lastSignature = null;
  }

  start() {
    if (!this.enabled || this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  keyFor(text) {
    return `${text.length}:${text.slice(0, 64)}:${text.slice(-32)}`;
  }

  tick() {
    if (!this.enabled) return;
    const text = (clipboard.readText() || '').trim();
    if (text) {
      const signature = this.keyFor(text);
      if (signature === this.lastSignature) return;
      this.lastSignature = signature;
      this.push({ kind: 'text', text, preview: text.slice(0, MAX_PREVIEW) });
      return;
    }
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
      const png = image.toPNG();
      const signature = `img:${png.length}`;
      if (signature === this.lastSignature) return;
      this.lastSignature = signature;
      const thumb = image.resize({ width: 96 });
      this.push({
        kind: 'image',
        text: `[图片 ${Math.round(png.length / 1024)} KB]`,
        preview: `[图片 ${Math.round(png.length / 1024)} KB]`,
        dataUrl: `data:image/png;base64,${thumb.toPNG().toString('base64')}`,
        fullDataUrl: png.length > 2 * 1024 * 1024 ? null : `data:image/png;base64,${png.toString('base64')}`
      });
    }
  }

  push(entry) {
    const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), ...entry };
    this.items = [item, ...this.items.filter((prev) => prev.text !== item.text)].slice(0, this.maxItems);
    this.emit();
  }

  publicItems() {
    return this.items.map(({ dataUrl, fullDataUrl, ...rest }) => ({
      ...rest,
      thumb: dataUrl,
      hasFullImage: Boolean(fullDataUrl)
    }));
  }

  emit() {
    const payload = this.publicItems();
    for (const listener of this.listeners) listener(payload);
  }

  list() {
    return this.publicItems();
  }

  copy(id) {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return false;
    if (item.kind === 'image' && (item.fullDataUrl || item.dataUrl)) {
      clipboard.writeImage(nativeImage.createFromDataURL(item.fullDataUrl || item.dataUrl));
    } else {
      clipboard.writeText(item.text);
    }
    this.lastSignature = null;
    this.tick();
    return true;
  }

  clear() {
    this.items = [];
    this.lastSignature = null;
    this.emit();
  }
}

module.exports = { ClipboardHistory };
