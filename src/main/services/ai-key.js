const fs = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');

const KEY_FILE = 'ai-key.bin';

function mask(plain) {
  const tail = plain.slice(-4);
  return `sk-…${tail}`;
}

// 密钥只走加密文件，绝不进 toolbar.config.json / state.json / 日志。
// safeStorage 在 Windows 上是 DPAPI：密文只有同一台机器的同一个 Windows 用户能解开。
class AiKey {
  constructor(dir) {
    this.file = path.join(dir, KEY_FILE);
    this.plain = null;
    this.load();
  }

  available() {
    return safeStorage.isEncryptionAvailable();
  }

  load() {
    let packed;
    try {
      packed = fs.readFileSync(this.file);
    } catch {
      return;
    }
    if (!this.available()) {
      console.warn('[ai] safeStorage 当前不可用，已保存的密钥暂时读不出来');
      return;
    }
    try {
      this.plain = safeStorage.decryptString(packed);
    } catch (err) {
      console.warn(`[ai] 密钥解密失败（${err.message}），需要重新填写`);
      this.plain = null;
    }
  }

  status() {
    return { set: Boolean(this.plain), hint: this.plain ? mask(this.plain) : null, encrypted: this.available() };
  }

  get() {
    return this.plain;
  }

  set(key) {
    if (!this.available()) return { ok: false, error: '本机 safeStorage 不可用，拒绝明文保存密钥' };
    const plain = typeof key === 'string' ? key.trim() : '';
    if (!/^sk-[A-Za-z0-9]{16,64}$/.test(plain)) {
      return { ok: false, error: '格式不对：应为 sk- 开头、总长 19–67 位的字母数字' };
    }
    const packed = safeStorage.encryptString(plain);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, packed);
    } catch (err) {
      return { ok: false, error: `写入失败：${err.message}` };
    }
    this.plain = plain;
    return { ok: true, ...this.status() };
  }

  clear() {
    this.plain = null;
    try {
      fs.unlinkSync(this.file);
    } catch {}
    return { ok: true, ...this.status() };
  }
}

module.exports = { AiKey };
