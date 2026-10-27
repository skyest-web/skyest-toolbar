TB.ai = {
  init(root) {
    root.innerHTML = '';
    this.status = TB.util.el('span', { class: 'ai-status', text: '未配置密钥' });
    this.head = TB.util.el('div', { class: 'ai-head' }, [
      TB.util.el('span', { class: 'panel-title', text: TB.app.state.config?.ai?.name || 'AI 伙伴' }),
      this.status,
      TB.util.el('button', { class: 'link-btn', text: '清空', title: '清空对话历史', onclick: () => this.clear() })
    ]);

    this.bubbleText = TB.util.el('div', { class: 'ai-bubble-text' });
    this.bubbleEl = TB.util.el('div', { class: 'ai-bubble' }, [this.bubbleText]);
    this.petHost = TB.util.el('div', { class: 'ai-pet' });
    this.ask = TB.util.el('div', { class: 'ai-ask' });
    this.stage = TB.util.el('div', { class: 'ai-stage' }, [this.bubbleEl, this.petHost, this.ask]);

    this.summary = TB.util.el('summary', { text: '完整对话' });
    this.list = TB.util.el('div', { class: 'ai-list' });
    this.jump = TB.util.el('button', { class: 'ai-jump', text: '↓ 回到底部', onclick: () => this.scrollToEnd(true) });
    this.history = TB.util.el('details', { class: 'ai-history' }, [this.summary, this.list]);

    this.input = TB.util.el('textarea', {
      class: 'ai-input',
      placeholder: '跟它说点什么…（Enter 发送，Shift+Enter 换行）',
      spellcheck: 'false',
      maxlength: '8000'
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.submit();
      }
    });
    this.list.addEventListener('scroll', () => this.trackStick(), { passive: true });

    this.send = TB.util.el('button', { class: 'primary', text: '发送', onclick: () => this.submit() });
    this.stop = TB.util.el('button', { class: 'ghost-btn', text: '停止', onclick: () => TB.api.ai.abort() });

    root.append(this.head, this.stage, this.history, this.jump, TB.util.el('div', { class: 'ai-foot' }, [this.input, this.send, this.stop]));

    // persona 决定渲染后端：video=蓝毛小女仆（webm 精灵），pet=猫团子 SVG，plain=不出宠物
    this.pet = this.persona() === 'pet' ? TB.pet : TB.petVideo;
    this.petHandle = this.pet.mount(this.petHost, { mood: 'calm', motion: this.motion() });
    this.petShown = { mood: null, talk: null };
    this.bindPet();
    this.stick = true;
    this.bubbleCount = -1;
    TB.api.ai.keyStatus().then((key) => {
      TB.app.state.ai = { ...TB.app.state.ai, key };
      this.update(TB.app.state);
    });
  },

  // 单击延后 260ms 给双击让位；流式回复中不响应，避免和「停止」抢注意力
  bindPet() {
    this.petHost.addEventListener('click', () => {
      if (TB.app.state.ai?.streaming) return;
      clearTimeout(this.tapTimer);
      this.tapTimer = setTimeout(() => this.pet.react?.(this.petHandle), 260);
    });
    this.petHost.addEventListener('dblclick', () => {
      clearTimeout(this.tapTimer);
      TB.settings.open('ai');
    });
  },

  persona() {
    return TB.app.state.config?.ai?.persona || 'video';
  },

  motion() {
    // plain 模式宠物不可见，继续解码纯属浪费
    if (this.persona() === 'plain') return 'off';
    return TB.app.state.config?.ai?.motion || 'full';
  },

  // update() 每个流式增量都会跑，所以只在状态真的变了才写 data-*，避免反复触发样式重算
  setPet(mood, talk) {
    if (this.petShown.mood === mood && this.petShown.talk === talk) return;
    this.petShown = { mood, talk };
    this.pet.apply(this.petHandle, { mood, talk, motion: this.motion() });
  },

  atBottom() {
    const node = this.list;
    return node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  },

  trackStick() {
    this.stick = this.atBottom();
    this.jump.classList.toggle('show', !this.stick && this.hasGrowth());
  },

  hasGrowth() {
    const ai = TB.app.state.ai || {};
    return Boolean(ai.streaming) || Boolean(ai.error);
  },

  scrollToEnd(force) {
    if (!this.stick && !force) return;
    this.list.scrollTop = this.list.scrollHeight;
    this.stick = true;
    this.jump.classList.remove('show');
  },

  clear() {
    TB.api.ai.clear();
    TB.app.toast('已清空对话历史', 'ok');
  },

  async submit() {
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = '';
    this.stick = true;
    TB.app.state.ai = { ...TB.app.state.ai, error: null, stream: { text: '', reasoning: '' } };
    await TB.api.ai.send(text);
    this.update(TB.app.state);
  },

  bubble(message, kind) {
    const children = [];
    if (message.reasoning) {
      children.push(
        TB.util.el('details', { class: 'ai-think' }, [
          TB.util.el('summary', { text: '思考过程' }),
          TB.util.el('div', { class: 'ai-think-body', text: message.reasoning })
        ])
      );
    }
    children.push(TB.util.el('div', { class: 'ai-text', text: message.content }));
    const meta = [];
    if (message.ms) meta.push(`${(message.ms / 1000).toFixed(1)}s`);
    if (message.usage?.total_tokens) meta.push(`${message.usage.total_tokens} tokens`);
    if (message.partial) meta.unshift('已中断');
    if (meta.length) children.push(TB.util.el('div', { class: 'ai-meta', text: meta.join(' · ') }));
    return TB.util.el('div', { class: `ai-msg ${kind}` }, children);
  },

  errorBubble(error) {
    const retry = TB.util.el('button', {
      class: 'link-btn',
      text: '重试上一条',
      onclick: () => {
        TB.app.state.ai = { ...TB.app.state.ai, error: null, stream: { text: '', reasoning: '' } };
        TB.api.ai.retry();
      }
    });
    return TB.util.el('div', { class: 'ai-msg error' }, [TB.util.el('div', { class: 'ai-text', text: error.message }), retry]);
  },

  update(state) {
    if (!this.list) return;
    // 宠物异常不能连带打断后面组件的刷新（dock 空白事故的同类结构）
    try {
      this.render(state);
    } catch (error) {
      console.error('[ai] 渲染失败', error);
      this.setPet('calm', false);
    }
  },

  render(state) {
    const ai = state.ai || {};
    const messages = ai.messages || [];
    const stream = ai.stream;
    const lastAssistant = [...messages].reverse().find((item) => item.role === 'assistant');
    const lastUser = [...messages].reverse().find((item) => item.role === 'user');

    this.status.textContent = ai.key?.set ? (state.config?.ai?.model || 'deepseek-chat') : '未配置密钥';
    this.status.classList.toggle('warn', !ai.key?.set);
    this.send.disabled = Boolean(ai.streaming);
    this.stop.classList.toggle('hidden', !ai.streaming);

    const talking = Boolean(ai.streaming && stream?.text);
    let mood;
    if (ai.error) mood = 'error';
    else if (ai.streaming && !talking) mood = 'curious';
    else mood = TB.emotion.moodOf(lastAssistant?.emotion);
    this.setPet(mood, talking);

    // persona:'plain' 是看腻了的退路：收起舞台、展开完整历史，不用回滚代码
    const plain = this.persona() === 'plain';
    this.stage.classList.toggle('hidden', plain);
    if (plain && !this.plainOpened) this.history.open = true;
    this.plainOpened = plain;

    // 流式期间标签可能只到了半截，先别把它画进泡里
    const parsed = stream ? TB.emotion.splitLeading(stream.text) : null;
    const bubbleText = stream ? (parsed.pending ? '' : parsed.content) : lastAssistant?.content || '';
    this.bubbleText.textContent = bubbleText;
    this.bubbleEl.classList.toggle('show', Boolean(bubbleText) || Boolean(stream));
    this.bubbleEl.classList.toggle('typing', Boolean(stream && !bubbleText));
    this.ask.textContent = lastUser ? `你：${lastUser.content}` : '';
    this.ask.classList.toggle('show', Boolean(lastUser));

    this.summary.textContent = `完整对话 (${messages.length})`;

    if (this.bubbleCount !== messages.length) {
      const wasStick = this.stick;
      this.list.innerHTML = '';
      for (const message of messages) this.list.appendChild(this.bubble(message, message.role));
      this.bubbleCount = messages.length;
      this.stick = wasStick;
    }

    let live = this.list.querySelector('.ai-msg.live');
    if (stream) {
      if (!live) {
        live = this.bubble({ content: '' }, 'assistant live');
        this.list.appendChild(live);
      }
      live.querySelector('.ai-text').textContent = parsed.content;
      if (stream.reasoning) {
        let think = live.querySelector('.ai-think-body');
        if (!think) {
          live.insertBefore(
            TB.util.el('details', { class: 'ai-think', open: true }, [TB.util.el('summary', { text: '思考过程' }), (think = TB.util.el('div', { class: 'ai-think-body' }))]),
            live.firstChild
          );
        }
        think.textContent = stream.reasoning;
      }
    } else if (live) {
      live.remove();
    }

    if (!messages.length && !stream && !this.list.querySelector('.ai-empty')) {
      this.list.appendChild(
        TB.util.el('div', { class: 'ai-empty muted' }, [
          ai.key?.set
            ? TB.util.el('span', { text: '还没有对话。输入问题，回车发送。' })
            : TB.util.el('button', { class: 'link-btn', text: '先在设置里填 DeepSeek 密钥 →', onclick: () => TB.settings.open() })
        ])
      );
    }

    if (ai.error) {
      if (!this.list.querySelector('.ai-msg.error')) this.list.appendChild(this.errorBubble(ai.error));
    }

    if (this.stick) this.scrollToEnd();
    this.trackStick();
  }
};

TB.register({
  id: 'ai',
  name: 'AI 伙伴',
  cls: 'area ai',
  build: () => TB.util.el('div', { id: 'ai' }),
  init: (node) => TB.ai.init(node),
  update: (state) => TB.ai.update(state)
});
