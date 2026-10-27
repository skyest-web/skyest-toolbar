const { PROTOCOL, splitLeading } = require('../../renderer/js/emotion.js');

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const ALLOWED_MODELS = new Set(['deepseek-chat', 'deepseek-reasoner']);

const MAX_INPUT = 8000;
const MAX_HISTORY = 200;
const MAX_ERROR_TEXT = 200;

function clamp(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

function classify(status) {
  if (status === 401 || status === 403) return ['auth', '密钥无效或没有权限，去设置里重新填'];
  if (status === 402) return ['quota', 'DeepSeek 账户余额不足'];
  if (status === 429) return ['rate', '触发限流（并发或请求频率），稍等再试'];
  if (status === 400) return ['badrequest', '请求被拒绝（上下文过长或参数不合法）'];
  if (status >= 500) return ['server', `DeepSeek 服务异常（HTTP ${status}）`];
  return ['server', `请求失败（HTTP ${status}）`];
}

function errorText(body) {
  try {
    const parsed = JSON.parse(body);
    return String(parsed?.error?.message || parsed?.message || body).slice(0, MAX_ERROR_TEXT);
  } catch {
    return String(body).slice(0, MAX_ERROR_TEXT);
  }
}

// SSE 的一行只可能是 `data: {json}` 或 `data: [DONE]`；注释行与空行忽略。
function sseEvent(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload) return null;
  if (payload === '[DONE]') return { done: true };
  try {
    return { json: JSON.parse(payload) };
  } catch {
    return null;
  }
}

class AiChat {
  constructor({ store, getKey, getConfig, emit, endpoint = ENDPOINT }) {
    this.store = store;
    this.getKey = getKey;
    this.getConfig = getConfig;
    this.emit = emit;
    this.endpoint = endpoint;
    this.messages = [];
    this.current = null;
    this.load();
  }

  load() {
    const stored = this.store.get('aiChat');
    this.messages = Array.isArray(stored) ? stored.slice(-MAX_HISTORY) : [];
  }

  commit() {
    if (this.messages.length > MAX_HISTORY) this.messages = this.messages.slice(-MAX_HISTORY);
    this.store.set('aiChat', this.getConfig().persistHistory ? this.messages : []);
    this.pushState();
  }

  pushState() {
    this.emit('ai:state', { messages: this.messages, streaming: this.current?.requestId || null });
  }

  fail(requestId, kind, message) {
    if (this.current?.requestId === requestId) this.current = null;
    this.emit('ai:error', { requestId, kind, message });
  }

  contextFor(userText) {
    const cfg = this.getConfig();
    const keep = clamp(cfg.contextMessages, 2, 40);
    const history = this.messages.concat([{ role: 'user', content: userText }]);
    let system = String(cfg.systemPrompt || '').slice(0, 2000);
    // 名字和身份单独拼，免得用户在「系统提示」里改文案时把它们改掉或改没
    const name = String(cfg.name || '').trim().slice(0, 20);
    if (name) system = `你叫「${name}」，是常驻在桌面工具栏里的小女仆。` + system;
    if (cfg.emotion !== false) system += PROTOCOL;
    const messages = [{ role: 'system', content: system }];
    for (const item of history.slice(-keep)) {
      if (item.role !== 'user' && item.role !== 'assistant') continue;
      if (!item.content) continue;
      messages.push({ role: item.role, content: item.content });
    }
    return messages;
  }

  abort() {
    if (!this.current) return false;
    this.current.reason = 'user';
    this.current.controller.abort();
    return true;
  }

  clear() {
    this.abort();
    this.messages = [];
    this.commit();
  }

  // 关掉持久化时把内存与磁盘一起清空，避免"以为没存"的历史留在 state.json。
  syncPersistence() {
    if (!this.getConfig().persistHistory) {
      this.messages = [];
      this.store.set('aiChat', []);
    }
    this.pushState();
  }

  retry() {
    const lastUserIndex = this.messages.map((item) => item.role).lastIndexOf('user');
    if (lastUserIndex < 0) return { requestId: null, skipped: 'empty' };
    const text = this.messages[lastUserIndex].content;
    this.messages = this.messages.slice(0, lastUserIndex);
    this.store.set('aiChat', this.getConfig().persistHistory ? this.messages : []);
    return this.send(text);
  }

  async send(rawText) {
    this.abort();

    const cfg = this.getConfig();
    const clipped = (typeof rawText === 'string' ? rawText : '').trim().slice(0, MAX_INPUT);
    if (!clipped) return { requestId: null, skipped: 'empty' };

    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    if (!this.getKey()) {
      this.fail(requestId, 'nokey', '还没有保存 DeepSeek 密钥');
      return { requestId };
    }
    if (!ALLOWED_MODELS.has(cfg.model)) {
      this.fail(requestId, 'badconfig', `模型 "${cfg.model}" 不支持，只允许 deepseek-chat / deepseek-reasoner`);
      return { requestId };
    }

    const userMessage = { role: 'user', content: clipped, at: Date.now() };
    this.messages.push(userMessage);
    this.commit();

    const controller = new AbortController();
    const state = { requestId, controller, reason: null, text: '', reasoning: '', startedAt: Date.now() };
    this.current = state;
    this.pushState();

    const overall = setTimeout(() => {
      if (this.current !== state) return;
      state.reason = 'timeout';
      controller.abort();
    }, clamp(cfg.timeoutMs, 5000, 300000));

    let firstByte = setTimeout(() => {
      if (this.current !== state) return;
      state.reason = 'firstbyte';
      controller.abort();
    }, clamp(cfg.firstByteTimeoutMs, 3000, 120000));

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.getKey()}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream'
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: this.contextFor(clipped),
          stream: true,
          temperature: clamp(cfg.temperature, 0, 2),
          max_tokens: clamp(cfg.maxTokens, 1, 8192),
          stream_options: { include_usage: true }
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const [kind, label] = classify(response.status);
        return this.fail(requestId, kind, body ? `${label}：${errorText(body)}` : label);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let usage = null;
      let finished = false;

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        clearTimeout(firstByte);
        buffer += decoder.decode(value, { stream: true });

        // 一个 chunk 可能把一行 SSE 切成两半，半行留在 buffer 里等下一个 chunk。
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');

          const event = sseEvent(line);
          if (!event) continue;
          if (event.done) {
            finished = true;
            break;
          }

          const delta = event.json?.choices?.[0]?.delta;
          const piece = typeof delta?.content === 'string' ? delta.content : '';
          const thought = typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : '';
          if (event.json?.usage) usage = event.json.usage;
          if (!piece && !thought) continue;

          state.text += piece;
          state.reasoning += thought;
          this.emit('ai:delta', { requestId, text: piece, reasoning: thought });
        }
        if (finished) break;
      }

      clearTimeout(overall);
      clearTimeout(firstByte);
      if (this.current !== state) return { requestId };
      this.current = null;
      this.finish(state, usage);
      return { requestId };
    } catch (err) {
      clearTimeout(overall);
      clearTimeout(firstByte);
      if (this.current !== state) return { requestId };
      const kind = state.reason === 'user' ? 'cancelled' : state.reason === 'timeout' ? 'timeout' : state.reason === 'firstbyte' ? 'firstbyte' : 'network';
      const message =
        kind === 'cancelled' ? '已取消'
        : kind === 'timeout' ? `超过 ${Math.round(clamp(cfg.timeoutMs, 5000, 300000) / 1000)} 秒没有完成，已中断`
        : kind === 'firstbyte' ? '等了 15 秒没有收到第一个字，可能是网络或密钥问题'
        : `请求没发出去：${err.message}`;
      if (state.text) this.finish(state, null, true);
      this.fail(requestId, kind, message);
      return { requestId };
    }
  }

  finish(state, usage, partial = false) {
    // 标签必须在落库前剥掉：contextFor() 会把历史原样回传，残留标签会让模型模仿并越攒越多
    const raw = state.text.trim();
    const parsed = this.getConfig().emotion === false ? { emotion: null, content: raw } : splitLeading(raw);
    const content = parsed.content.trim();
    if (content) {
      const message = { role: 'assistant', content, at: Date.now(), ms: Date.now() - state.startedAt };
      if (parsed.emotion) message.emotion = parsed.emotion;
      if (state.reasoning.trim()) message.reasoning = state.reasoning.trim();
      if (usage) message.usage = usage;
      if (partial) message.partial = true;
      this.messages.push(message);
    }
    this.commit();
    this.emit('ai:done', { requestId: state.requestId, partial });
  }
}

module.exports = { AiChat, ENDPOINT, ALLOWED_MODELS };
