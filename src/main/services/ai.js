const { PROTOCOL, splitLeading } = require('../../renderer/js/emotion.js');

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const ALLOWED_MODELS = new Set(['deepseek-chat', 'deepseek-reasoner']);

const MAX_INPUT = 8000;
const MAX_HISTORY = 200;
const MAX_ERROR_TEXT = 200;
// 模型连着点工具的上限：到顶就停，把已经生成的文字当作回答收尾，不给它无限要下去
const MAX_TOOL_ROUNDS = 2;

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

// HTTP 层的失败：分类好带上给用户看的文案，由 send() 的 catch 统一收口
class AiRequestError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'AiRequestError';
    this.kind = kind;
  }
}

class AiChat {
  constructor({ store, getKey, getConfig, emit, endpoint = ENDPOINT, getTools = null }) {
    this.store = store;
    this.getKey = getKey;
    this.getConfig = getConfig;
    this.emit = emit;
    this.endpoint = endpoint;
    this.getTools = getTools;
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
    // 多轮工具循环里 controller 每轮换一个，轮与轮之间点「停止」也得算数（见 streamOnce 开头的检查）
    this.current.aborted = true;
    this.current.controller?.abort();
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

  // 工具清单每轮现取：设置里那个开关要能即时生效，不用重启应用。
  availableTools() {
    if (typeof this.getTools !== 'function') return [];
    // reasoner 不支持 function calling，给它 tools 会被 400 掉
    if (this.getConfig().model !== 'deepseek-chat') return [];
    return this.getTools().filter((tool) => tool?.name && tool?.schema && typeof tool.run === 'function');
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

    const state = { requestId, controller: null, reason: null, aborted: false, text: '', reasoning: '', startedAt: Date.now() };
    this.current = state;
    this.pushState();

    const overall = setTimeout(() => {
      if (this.current !== state) return;
      state.reason = 'timeout';
      state.controller?.abort();
    }, clamp(cfg.timeoutMs, 5000, 300000));

    const tools = this.availableTools();
    // contextFor() 自己会把这句话补成最后一条 user，所以必须在写入历史之前取上下文，
    // 反过来说同一句话会在请求里出现两遍。
    // 工具轮次（带 tool_calls 的 assistant 和 role:'tool' 的结果）只活在这次 send 的局部里，
    // 不进下面的 this.messages —— 也就不进 state.json。搜索结果里那些绝对路径就是这么挡在落盘之外的。
    let messages = this.contextFor(clipped);

    this.messages.push({ role: 'user', content: clipped, at: Date.now() });
    this.commit();

    let usage = null;

    try {
      for (let round = 0; ; round++) {
        // 连着两轮还在要工具，第三轮就不给了：逼它用文字收尾，比硬报错体面
        const outcome = await this.streamOnce(state, messages, round < MAX_TOOL_ROUNDS ? tools : []);
        if (this.current !== state) return { requestId };
        usage = outcome.usage || usage;
        // 轮次上限是硬闸：服务端行为异常、没给工具还在吐 tool_calls 时，也得停在这儿
        if (!outcome.toolCalls.length || round >= MAX_TOOL_ROUNDS) break;
        messages = messages.concat(await this.runTools(state, outcome.toolCalls, tools));
        // 上一轮的口播（「我查一下」）和下一轮的答案之间得有分隔，不然流式文本会粘成一句
        if (state.text) state.text = `${state.text}\n`;
      }
      clearTimeout(overall);
      this.current = null;
      this.finish(state, usage);
      return { requestId };
    } catch (err) {
      clearTimeout(overall);
      if (this.current !== state) return { requestId };
      const requestError = err instanceof AiRequestError;
      const kind = requestError
        ? err.kind
        : state.reason === 'user' ? 'cancelled'
        : state.reason === 'timeout' ? 'timeout'
        : state.reason === 'firstbyte' ? 'firstbyte'
        : 'network';
      const message = requestError
        ? err.message
        : kind === 'cancelled' ? '已取消'
        : kind === 'timeout' ? `超过 ${Math.round(clamp(cfg.timeoutMs, 5000, 300000) / 1000)} 秒没有完成，已中断`
        : kind === 'firstbyte' ? '等了 15 秒没有收到第一个字，可能是网络或密钥问题'
        : `请求没发出去：${err.message}`;
      if (state.text) this.finish(state, usage, true);
      this.fail(requestId, kind, message);
      return { requestId };
    }
  }

  // 一次流式请求：边收边吐给渲染层，同时把 delta.tool_calls 的分片攒起来
  // （arguments 是很多个 chunk 拼出来的，少拼一片就是非法 JSON）。
  async streamOnce(state, messages, tools) {
    if (state.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });

    const cfg = this.getConfig();
    const controller = new AbortController();
    state.controller = controller;
    const firstByte = setTimeout(() => {
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
          messages,
          stream: true,
          temperature: clamp(cfg.temperature, 0, 2),
          max_tokens: clamp(cfg.maxTokens, 1, 8192),
          stream_options: { include_usage: true },
          // 没有工具时这个字段干脆不出现，和接工具之前的请求体逐字节一致
          ...(tools.length ? { tools: tools.map((tool) => tool.schema), tool_choice: 'auto' } : {})
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const [kind, label] = classify(response.status);
        throw new AiRequestError(kind, body ? `${label}：${errorText(body)}` : label);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let usage = null;
      let finished = false;
      const calls = new Map();

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
          const fragments = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
          if (event.json?.usage) usage = event.json.usage;
          for (const fragment of fragments) {
            const at = Number.isInteger(fragment?.index) ? fragment.index : 0;
            const slot = calls.get(at) || { id: '', name: '', arguments: '' };
            if (fragment.id) slot.id = fragment.id;
            if (typeof fragment.function?.name === 'string') slot.name += fragment.function.name;
            if (typeof fragment.function?.arguments === 'string') slot.arguments += fragment.function.arguments;
            calls.set(at, slot);
          }
          if (!piece && !thought) continue;

          state.text += piece;
          state.reasoning += thought;
          this.emit('ai:delta', { requestId: state.requestId, text: piece, reasoning: thought });
        }
        if (finished) break;
      }

      const toolCalls = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, call]) => ({ id: call.id || `call_${state.requestId}_${index}`, name: call.name, arguments: call.arguments }))
        .filter((call) => call.name);
      return { toolCalls, usage };
    } finally {
      clearTimeout(firstByte);
    }
  }

  // 执行模型点名的工具。不认识的名字、不合法的参数、工具自己炸了——都当成结果文字回给模型，
  // 它会换个说法或道歉；在这里抛出去只会把整轮对话变成一条错误气泡。
  async runTools(state, toolCalls, tools) {
    const turns = [
      {
        role: 'assistant',
        content: state.text.trim() || null,
        tool_calls: toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }))
      }
    ];
    for (const call of toolCalls) {
      const tool = tools.find((item) => item.name === call.name);
      let args = null;
      let text = null;
      let count = 0;
      if (!tool) text = `没有这个工具：${call.name}`;
      else {
        try {
          args = JSON.parse(call.arguments || '{}');
        } catch {
          text = '参数不是合法 JSON，这次没执行。';
        }
        if (text === null) {
          try {
            const result = await tool.run(args);
            text = result?.text || '这个工具没返回内容。';
            count = Number(result?.count) || 0;
          } catch (error) {
            text = `工具执行失败：${error.message}`;
          }
        }
      }
      this.emit('ai:tool', {
        requestId: state.requestId,
        name: call.name,
        label: tool && args ? String(tool.label(args.query ?? '')).slice(0, 120) : call.name,
        count
      });
      turns.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: text });
    }
    return turns;
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
