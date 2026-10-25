const fs = require('node:fs');
const path = require('node:path');

const EMPTY = { tasks: [], notes: '', player: null };

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'state.json');
    this.state = { ...EMPTY };
    this.timer = null;
    this.load();
  }

  load() {
    try {
      this.state = { ...EMPTY, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      this.state = { ...EMPTY };
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf8');
  }

  scheduleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.flush();
      } catch (err) {
        console.warn('[store] write failed', err.message);
      }
    }, 400);
  }

  get(key) {
    return this.state[key];
  }

  set(key, value) {
    this.state[key] = value;
    this.scheduleFlush();
  }
}

module.exports = { Store };
