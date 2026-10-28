// 零依赖回归脚本（`npm run test:ai`）：用本地 mock SSE 服务验证 AiChat 的解析、中断、错误分类，
// 全程不碰真实密钥，也不发任何外网请求。
const http = require('node:http');
const { AiChat } = require('../src/main/services/ai.js');

function makeStore() {
  const state = { tasks: [], notes: '', player: null, aiChat: [] };
  return {
    state,
    get: (key) => state[key],
    set: (key, value) => {
      state[key] = value;
    }
  };
}

function harness({ key = 'sk-test', config = {}, store = makeStore(), tools = null } = {}) {
  const events = [];
  const ai = new AiChat({
    store,
    getKey: () => key,
    getConfig: () => ({
      model: 'deepseek-chat',
      systemPrompt: 'SYS',
      temperature: 0.6,
      maxTokens: 100,
      contextMessages: 12,
      timeoutMs: 60000,
      firstByteTimeoutMs: 15000,
      persistHistory: true,
      ...config
    }),
    emit: (channel, payload) => events.push({ channel, payload }),
    getTools: tools ? () => tools : null,
    endpoint: `http://127.0.0.1:${server.address().port}/chat`
  });
  return { ai, events, store };
}

// 每一次 /chat 请求的原始 body 都留一份，工具轮次的断言全靠回看它
const requestLog = [];

function sse(res, objects) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const frames = objects.map((obj) => `data: ${JSON.stringify(obj)}\n\n`);
  frames.push('data: [DONE]\n\n');
  let cursor = 0;
  const tick = setInterval(() => {
    if (cursor >= frames.length) return clearInterval(tick);
    res.write(frames[cursor++]);
  }, 3);
  res.on('close', () => clearInterval(tick));
}

// tool_calls 的 arguments 在真实流里就是被切成很多片送来的，这里照它的样子拆开发，
// 拼不回去就是非法 JSON —— 那是这条链路上最容易错的地方。
function toolCallFrame(frag) {
  return { choices: [{ delta: { tool_calls: [frag] } }] };
}

function toolCallFrames(id, name, argChunks) {
  return [
    { choices: [{ delta: { role: 'assistant', content: '让我' } }] },
    toolCallFrame({ index: 0, id, function: { name, arguments: argChunks[0] } }),
    ...argChunks.slice(1).map((chunk) => toolCallFrame({ index: 0, function: { arguments: chunk } })),
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
  ];
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const payload = JSON.parse(body);
    requestLog.push(payload);
    const last = payload.messages[payload.messages.length - 1];
    const prompt = last.content;
    // 认最后一条 user，而不是"历史里出现过"：工具轮次不落盘，但用户下一句真的还会再提这个词
    const asked = (marker) => payload.messages.filter((m) => m.role === 'user').at(-1)?.content === marker;

    // 工具轮：第一轮点 search_files，收到 role:'tool' 的结果才把观察到的东西回吐给测试
    if (asked('TOOLCALL')) {
      if (last.role !== 'tool') {
        sse(res, toolCallFrames('call_a1', 'search_files', ['{"qu', 'ery": "everyth', 'ing.exe"}']));
        return;
      }
      const prev = payload.messages[payload.messages.length - 2];
      sse(res, [
        {
          choices: [
            {
              delta: {
                content: JSON.stringify({
                  gotTools: Array.isArray(payload.tools) && payload.tools.map((t) => t.function.name),
                  toolChoice: payload.tool_choice,
                  toolRole: last.role,
                  toolName: last.name,
                  toolCallId: last.tool_call_id,
                  prevHadCalls: Array.isArray(prev?.tool_calls) ? prev.tool_calls.map((c) => [c.id, c.function.name]) : null,
                  prevContent: prev?.content,
                  resultHead: String(last.content).slice(0, 8)
                })
              }
            }
          ]
        }
      ]);
      return;
    }

    // 无赖轮：永远在要工具（服务端行为异常时的样子），验轮次上限这道硬闸
    if (asked('TOOLLOOP')) {
      sse(res, toolCallFrames(`call_${requestLog.length}`, 'search_files', ['{"query": "x"}']));
      return;
    }

    if (prompt === 'TRIGGER_401') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Authentication Fails, Your api key: **** invalid' } }));
      return;
    }
    if (prompt === 'TRIGGER_429') {
      res.writeHead(429);
      res.end('too many requests');
      return;
    }
    if (prompt === 'TRIGGER_SLOW') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      return; // 之后不再输出，等 firstByte 之外的 overall 超时
    }

    // ECHO:xxx —— 按 xxx 原文回，每 2 个字符一个 SSE 事件，专门用来把情绪标签切成两半
    if (prompt.startsWith('ECHO:')) {
      const text = prompt.slice(5);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frames = [];
      for (let i = 0; i < text.length; i += 2) {
        frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 2) } }] })}\n\n`);
      }
      frames.push('data: [DONE]\n\n');
      let cursor = 0;
      const drip = setInterval(() => {
        if (cursor >= frames.length) return clearInterval(drip);
        res.write(frames[cursor++]);
      }, 5);
      res.on('close', () => clearInterval(drip));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // 故意把一行 SSE 切成两个 chunk，验证半行缓冲
    const pieces = [
      'data: {"choices":[{"delta":{"role":"assistant","content":"你"}}]}\n\n',
      'data: {"choi',
      'ces":[{"delta":{"content":"好，世界"}}]}\n\n',
      ': comment line that must be ignored\n\n',
      'data: {"choices":[{"delta":{"content":"！"}}],"usage":null}\n\n',
      'data: {"choices":[],"usage":{"total_tokens":42}}\n\n',
      'data: [DONE]\n\n'
    ];
    let index = 0;
    const tick = setInterval(() => {
      if (index >= pieces.length) return clearInterval(tick);
      res.write(pieces[index++]);
    }, 40);
    res.on('close', () => clearInterval(tick));
  });
});

// 假的「查本机文件」工具：形状和 src/main/services/ai-tools.js 里那个真的一致
// （name / label / schema / run），而且故意在结果里放一条绝对路径，好验它不落盘。
function fakeTool(onRun) {
  return {
    name: 'search_files',
    label: (query) => `查了本机文件索引「${query}」`,
    schema: {
      type: 'function',
      function: {
        name: 'search_files',
        description: '按文件名关键字查本机索引',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }
      }
    },
    async run(args) {
      onRun?.(args);
      return { text: '1. everything.exe｜2.2MB\n   D:\\SecretPlace\\everything.exe', count: 3 };
    }
  };
}

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // A. 正常流式 + 半行缓冲 + usage
  {
    const { ai, events, store } = harness();
    await ai.send('你好');
    const deltas = events.filter((e) => e.channel === 'ai:delta').map((e) => e.payload.text).join('');
    check('A1 流式拼接完整', deltas === '你好，世界！', JSON.stringify(deltas));
    const last = ai.messages.at(-1);
    check('A2 历史含 user+assistant', ai.messages.length === 2 && ai.messages[0].role === 'user' && last.role === 'assistant', JSON.stringify(ai.messages.map((m) => m.role)));
    check('A3 usage 捕获', last.usage?.total_tokens === 42, JSON.stringify(last.usage));
    check('A4 落盘 state.json 结构', Array.isArray(store.state.aiChat) && store.state.aiChat.length === 2, `len=${store.state.aiChat.length}`);
    check('A5 done 事件发出', events.some((e) => e.channel === 'ai:done'));
    check('A6 注释行不产生气泡', last.content === '你好，世界！', last.content);
  }

  // B. system prompt + 上下文裁剪
  {
    const { ai } = harness({ config: { contextMessages: 3 } });
    await ai.send('一');
    await ai.send('二');
    await ai.send('三');
    check('B1 多轮累积', ai.messages.length === 6, `len=${ai.messages.length}`);
    const ctx = ai.contextFor('四');
    check('B2 首条是 system', ctx[0].role === 'system' && ctx[0].content.startsWith('SYS'), JSON.stringify(ctx[0]));
    check('B3 上下文裁到 3 条', ctx.length === 4, JSON.stringify(ctx.map((m) => m.content)));
    check('B4 默认追加情绪约定', ctx[0].content.includes('[开心]'), ctx[0].content.slice(-40));
  }

  // J. 情绪标签协议（docs/ai-pet-panel.md §9）
  {
    const { ai, events } = harness();
    await ai.send('ECHO:[开心]你好');
    const last = ai.messages.at(-1);
    check('J1 开头标签被剥离并存成 emotion', last.content === '你好' && last.emotion === '开心', JSON.stringify(last));
  }
  {
    const { ai } = harness();
    await ai.send('ECHO:今天天气不错。');
    const last = ai.messages.at(-1);
    check('J2 无标签回落平静', last.content === '今天天气不错。' && last.emotion === '平静', JSON.stringify(last));
  }
  {
    const { ai } = harness();
    await ai.send('ECHO:你好[开心]世界');
    const last = ai.messages.at(-1);
    check('J3 标签不在开头就不剥离', last.content === '你好[开心]世界' && last.emotion === '平静', JSON.stringify(last));
  }
  {
    const { ai } = harness();
    await ai.send('ECHO:[开心][困]你好');
    const last = ai.messages.at(-1);
    check('J4 两个标签只剥第一个', last.content === '[困]你好' && last.emotion === '开心', JSON.stringify(last));
  }
  {
    const { ai } = harness();
    await ai.send('ECHO:[兴奋]你好');
    const last = ai.messages.at(-1);
    check('J5 未知情绪回落平静且标签不进正文', last.content === '你好' && last.emotion === '平静', JSON.stringify(last));
  }
  {
    const { ai, events } = harness();
    await ai.send('ECHO:[难过]这一条的标签会被切成两半送达');
    const last = ai.messages.at(-1);
    check('J6 标签被 chunk 切断也能正确落库', last.content === '这一条的标签会被切成两半送达' && last.emotion === '难过', JSON.stringify(last));
    check('J6b 中途不报错', !events.some((e) => e.channel === 'ai:error'), JSON.stringify(events.filter((e) => e.channel === 'ai:error')));
  }
  {
    const { ai } = harness();
    await ai.send('ECHO:[好奇]嗯？');
    await ai.send('ECHO:再问一句');
    const ctx = ai.contextFor('第三句');
    // 只看 assistant：ECHO: 这类测试输入本身带方括号，用户说什么不是协议要管的
    const dirty = ctx.filter((m) => m.role === 'assistant' && /[[【][^[\]【】]{1,6}[\]】]/.test(m.content || ''));
    check('J7 回传给模型的历史里没有标签', dirty.length === 0, JSON.stringify(dirty.map((m) => m.content)));
  }
  {
    const { ai } = harness({ config: { emotion: false } });
    await ai.send('ECHO:[开心]你好');
    const ctx = ai.contextFor('四');
    check('J8 关掉 emotion 时不追加约定', !ctx[0].content.includes('[开心]'), ctx[0].content);
    check('J8b 关掉 emotion 时不剥离', ai.messages.at(-1).content === '[开心]你好' && !ai.messages.at(-1).emotion, JSON.stringify(ai.messages.at(-1)));
  }
  {
    const { ai } = harness();
    await ai.send('ECHO:[1] 这是参考文献编号');
    check('J9 数字开头的方括号不被当成标签', ai.messages.at(-1).content === '[1] 这是参考文献编号', JSON.stringify(ai.messages.at(-1)));
  }
  {
    const named = harness({ config: { name: '  鲸鲸  ' } }).ai.contextFor('在吗').find((m) => m.role === 'system').content;
    check('K1 名字拼进系统提示且去掉首尾空格', named.startsWith('你叫「鲸鲸」，是常驻在桌面工具栏里的小女仆。SYS'), named);
    const anon = harness().ai.contextFor('在吗').find((m) => m.role === 'system').content;
    check('K1b 没起名字时不加身份句', anon.startsWith('SYS') && !anon.includes('你叫'), anon);
    const long = harness({ config: { name: '名'.repeat(40) } }).ai.contextFor('在吗').find((m) => m.role === 'system').content;
    check('K1c 名字被截到 20 字', long.includes('「' + '名'.repeat(20) + '」') && !long.includes('名'.repeat(21)), long);
  }

// C. 错误分类
  {
    const { ai, events } = harness();
    await ai.send('TRIGGER_401');
    const err = events.find((e) => e.channel === 'ai:error');
    check('C1 401 → auth', err?.payload.kind === 'auth', JSON.stringify(err?.payload));
    check('C2 401 不留半成品 assistant', ai.messages.every((m) => m.role !== 'assistant'), JSON.stringify(ai.messages.map((m) => m.role)));
  }
  {
    const { ai, events } = harness();
    await ai.send('TRIGGER_429');
    check('C3 429 → rate', events.find((e) => e.channel === 'ai:error')?.payload.kind === 'rate');
  }

  // D. 无 key：不发请求
  {
    const { ai, events } = harness({ key: null });
    await ai.send('你好');
    const err = events.find((e) => e.channel === 'ai:error');
    check('D1 无 key → nokey', err?.payload.kind === 'nokey', JSON.stringify(err?.payload));
    check('D2 无 key 不写入历史', ai.messages.length === 0, JSON.stringify(ai.messages));
  }

  // E. 模型白名单
  {
    const { ai, events } = harness({ config: { model: 'gpt-4' } });
    await ai.send('你好');
    check('E1 非白名单模型被拒', events.find((e) => e.channel === 'ai:error')?.payload.kind === 'badconfig');
  }

  // F. 中断保留已生成内容
  {
    const { ai, events } = harness();
    const pending = ai.send('你好');
    await wait(90);
    ai.abort();
    await pending;
    const err = events.find((e) => e.channel === 'ai:error');
    check('F1 中断 → cancelled', err?.payload.kind === 'cancelled', JSON.stringify(err?.payload));
    check('F2 已生成的部分被保留', ai.messages.at(-1)?.role === 'assistant' && ai.messages.at(-1).partial === true, JSON.stringify(ai.messages.at(-1)));
  }

  // G. 超时
  {
    const { ai, events } = harness({ config: { timeoutMs: 5000, firstByteTimeoutMs: 5000 } });
    const started = Date.now();
    await ai.send('TRIGGER_SLOW');
    const err = events.find((e) => e.channel === 'ai:error');
    check('G1 有首字后靠总超时兜底', err?.payload.kind === 'timeout' && Date.now() - started >= 4800, `${err?.payload.kind} ${Date.now() - started}ms`);
  }

  // H. 关闭持久化
  {
    const store = makeStore();
    const { ai } = harness({ store });
    await ai.send('你好');
    check('H1 开启时落盘', store.state.aiChat.length === 2);
    const cfg = { persistHistory: false };
    ai.getConfig = () => ({ model: 'deepseek-chat', systemPrompt: 'SYS', temperature: 0.6, maxTokens: 100, contextMessages: 12, timeoutMs: 60000, firstByteTimeoutMs: 15000, persistHistory: false });
    ai.syncPersistence();
    check('H2 关闭后内存与磁盘一起清空', ai.messages.length === 0 && store.state.aiChat.length === 0, `${ai.messages.length}/${store.state.aiChat.length}`);
  }

  // I. 输入上限与空输入
  {
    const { ai } = harness();
    await ai.send('   ');
    check('I1 空输入直接跳过', ai.messages.length === 0);
    await ai.send('x'.repeat(20000));
    const longUser = ai.messages.filter((m) => m.role === 'user').at(-1);
    check('I2 超长输入被截断', longUser.content.length === 8000, `len=${longUser.content.length}`);
  }

  // L. 工具调用（function calling）：宠物能查本机文件索引，但工具轮次不落盘
  {
    const calls = [];
    const tool = fakeTool((args) => calls.push(args));
    const { ai, events, store } = harness({ tools: [tool] });
    const before = requestLog.length;
    await ai.send('TOOLCALL');
    const rounds = requestLog.slice(before);
    const finalText = ai.messages.at(-1)?.content || '';
    let obs = null;
    try {
      obs = JSON.parse(finalText.slice(finalText.indexOf('\n') + 1));
    } catch {
      obs = null;
    }
    check('L1 两轮拼成一条回答，中间有分隔', Boolean(obs) && finalText.startsWith('让我\n'), JSON.stringify(finalText));
    check('L2 第一轮请求带了 tools 定义', rounds[0]?.tools?.[0]?.function?.name === 'search_files', JSON.stringify(rounds[0]?.tools?.map((t) => t.function.name)));
    check('L3 tool_choice=auto', rounds[0]?.tool_choice === 'auto', String(rounds[0]?.tool_choice));
    check('L4 分片的 arguments 拼回合法 JSON 才交给工具', calls.length === 1 && calls[0].query === 'everything.exe', JSON.stringify(calls));
    check('L5 assistant 的 tool_calls 原样回传', JSON.stringify(obs?.prevHadCalls) === JSON.stringify([['call_a1', 'search_files']]), JSON.stringify(obs?.prevHadCalls));
    check('L6 工具结果以 role:tool 回传', obs?.toolRole === 'tool' && obs?.toolCallId === 'call_a1' && obs?.resultHead === '1. every', JSON.stringify(obs));
    check('L7 前一轮的口播留在上下文里', obs?.prevContent === '让我', JSON.stringify(obs?.prevContent));
    check('L8 历史里只有 user + 最终 assistant', ai.messages.length === 2 && ai.messages[1].role === 'assistant', JSON.stringify(ai.messages.map((m) => m.role)));
    check('L9 工具轮次与文件路径不落盘', !JSON.stringify(store.state.aiChat).includes('SecretPlace') && store.state.aiChat.length === 2, JSON.stringify(store.state.aiChat.map((m) => m.role)));
    const toolEvent = events.find((e) => e.channel === 'ai:tool');
    check('L10 给渲染层发了 ai:tool（带文案与条数）', toolEvent?.payload?.count === 3 && toolEvent?.payload?.label === '查了本机文件索引「everything.exe」', JSON.stringify(toolEvent?.payload));
  }
  {
    const before = requestLog.length;
    const { ai } = harness();
    await ai.send('你好');
    check('L11 不接工具时请求体和以前一样（无 tools 字段）', requestLog.slice(before).every((p) => p.tools === undefined && p.tool_choice === undefined));
  }
  {
    const before = requestLog.length;
    const { ai } = harness({ config: { model: 'deepseek-reasoner' }, tools: [fakeTool()] });
    await ai.send('你好');
    check('L12 reasoner 不支持 function calling，开着也不给 tools', requestLog.slice(before).at(-1)?.tools === undefined, JSON.stringify(requestLog.slice(before).at(-1)?.tools));
  }
  {
    let runs = 0;
    const looping = { ...fakeTool(), run: async () => (runs += 1, { text: '还在查', count: 0 }) };
    const before = requestLog.length;
    const { ai } = harness({ tools: [looping] });
    await ai.send('TOOLLOOP');
    const rounds = requestLog.slice(before);
    check('L13 模型一直要工具也在三轮请求内收住', rounds.length === 3 && runs === 2, `${rounds.length} 轮请求 / 执行 ${runs} 次`);
    check('L13b 最后一轮不再带 tools（逼它用文字收尾）', rounds.at(-1)?.tools === undefined, JSON.stringify(rounds.at(-1)?.tools));
    check('L13c 到点就停，不是死循环', ai.messages.at(-1)?.role === 'assistant');
  }
  {
    const { ai } = harness({ tools: [fakeTool()] });
    await ai.send('TOOLCALL');
    const before = requestLog.length;
    await ai.send('再来一句');
    const messages = requestLog.slice(before).at(-1)?.messages || [];
    check('L14 下一轮对话的上下文里没有上次的工具轮次', messages.every((m) => m.role !== 'tool'), JSON.stringify(messages.map((m) => m.role)));
  }
  // 用户那句话只能出现一遍：send() 先取上下文再写历史，反过来的话请求里会带上两遍
  {
    const { ai } = harness();
    await ai.send('第一句');
    const first = requestLog.at(-1)?.messages || [];
    check('L15 请求里用户那句话只出现一遍', first.filter((m) => m.role === 'user').length === 1 && first.at(-1)?.content === '第一句', JSON.stringify(first.map((m) => m.role)));
    await ai.send('第二句');
    const second = requestLog.at(-1)?.messages || [];
    check('L15b 多轮上下文顺序对且不重复', JSON.stringify(second.map((m) => m.role)) === '["system","user","assistant","user"]', JSON.stringify(second.map((m) => m.role)));
  }

  server.close();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})();
