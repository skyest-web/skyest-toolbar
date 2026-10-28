TB.ai = {
  init(root) {
    root.innerHTML = '';
    this.status = TB.util.el('span', { class: 'ai-status', text: '未配置密钥' });
    // 文案跟着 dsh 状态走：独立窗口的原生标题栏显示不了端口，首次拉起又要几十秒，得有个「启动中」
    this.dshBtn = TB.util.el('button', {
      class: 'link-btn',
      title: '打开 DeepSeek Harness 窗口（独立窗口，能拖到别的屏幕；或直接双击宠物）',
      onclick: () => TB.dsh.open()
    });
    this.head = TB.util.el('div', { class: 'ai-head' }, [
      TB.util.el('span', { class: 'panel-title', text: TB.app.state.config?.ai?.name || 'AI 伙伴' }),
      this.status,
      TB.util.el('button', { class: 'link-btn', text: '清空', title: '清空对话历史', onclick: () => this.clear() }),
      // 双击宠物是 Harness 窗口，打字入口得有个常驻的位置，不然只能靠「开不了麦」兜底
      TB.util.el('button', { class: 'link-btn', text: '打字', title: '打开打字输入', onclick: () => this.openCompose(true) }),
      this.dshBtn,
      TB.util.el('button', { class: 'link-btn', text: '设置', title: '打开 AI 与语音设置', onclick: () => TB.settings.open('ai') })
    ]);

    // 气泡是浮在 body 上的，不留在格子里：矮屏时它本来就会顶出 .area 被 overflow:hidden 裁掉，
    // 而「它在说什么」恰恰是最不能看不见的那块（定位见 placeBubble，跟搜索下拉同一个套路）。
    // 组件重建时节点不跟着重建——isConnected 为真就继续用同一个。
    if (!this.bubbleEl?.isConnected) {
      this.bubbleText = TB.util.el('div', { class: 'ai-bubble-text' });
      this.bubbleEl = TB.util.el('div', { class: 'ai-bubble' }, [this.bubbleText]);
      document.body.appendChild(this.bubbleEl);
    }
    // 它调本机工具的痕迹（「查了本机文件索引「xxx」→ 12 条」）：只在流式期间在，说完就收
    this.toolEl = TB.util.el('div', { class: 'ai-tool' });
    this.petHost = TB.util.el('div', { class: 'ai-pet' });
    this.ask = TB.util.el('div', { class: 'ai-ask' });
    this.stage = TB.util.el('div', { class: 'ai-stage' }, [this.toolEl, this.petHost, this.ask]);

    this.summary = TB.util.el('div', { class: 'ai-history-head', role: 'button', tabindex: '0', text: '完整对话' });
    this.list = TB.util.el('div', { class: 'ai-list' });
    this.jump = TB.util.el('button', { class: 'ai-jump', text: '↓ 回到底部', onclick: () => this.scrollToEnd(true) });
    this.history = TB.util.el('div', { class: 'ai-history' }, [this.summary, this.list]);
    // 以前这里是 <details>/<summary>，列表塞在浏览器的匿名插槽盒子里：那个盒子不是 flex 项、
    // 高度又按内容算，于是 .ai-list 一路撑到几千像素，既没有滚动条也压穿格子（矮屏底部整截被裁）。
    // 换成 div + .open 之后「列表 flex:1 / min-height:0 / 自己滚」这套才真的生效。
    this.historyOpen = false;
    this.toggleHistory = () => this.setHistory(!this.historyOpen);
    this.summary.addEventListener('click', this.toggleHistory);
    this.summary.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.toggleHistory();
      }
    });

    this.input = TB.util.el('textarea', {
      class: 'ai-input',
      placeholder: '打字后 Enter 发送（Shift+Enter 换行），或点麦克风按钮说话',
      spellcheck: 'false',
      maxlength: '8000'
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.submit();
      } else if (event.key === 'Escape') {
        this.closeCompose(true);
      }
    });
    this.list.addEventListener('scroll', () => this.trackStick(), { passive: true });

    this.send = TB.util.el('button', { class: 'primary', text: '发送', onclick: () => this.submit() });
    this.stop = TB.util.el('button', { class: 'ghost-btn', text: '停止', onclick: () => TB.api.ai.abort() });
    // 原来这条是常驻的 .ai-foot；现在改成浮层，只在打字或录音时盖在面板底部
    this.compose = TB.util.el('div', { class: 'ai-compose' }, [this.input, this.send, this.stop]);

    root.append(this.head, this.stage, this.history, this.jump, this.compose);
    // 点浮层以外任何地方就收起（监听挂在 root 上：组件重建时随旧节点一起消失，不会累积）
    root.addEventListener('pointerdown', (event) => {
      if (!this.compose.classList.contains('open')) return;
      if (this.compose.contains(event.target)) return;
      this.closeCompose();
    });
    // 打字浮层是绝对定位的浮层，靠面板自己的 padding-bottom 给它腾出底部那条带；
    // root 每次重建都是新节点（没有 compose-open），而 compose 也新建了、类跟着丢了，两边天然一致
    this.composeRoot = root;

    // persona 决定渲染后端：video=蓝毛小女仆（webm 精灵），pet=猫团子 SVG，plain=不出宠物
    this.pet = this.persona() === 'pet' ? TB.pet : TB.petVideo;
    this.petHandle = this.pet.mount(this.petHost, { mood: 'calm', motion: this.motion() });
    this.petShown = { mood: null, talk: null };
    this.bindPet();
    // 换屏、展开完整对话、开合打字浮层都会挪动宠物的矩形，气泡得跟着重贴。
    // TB.ai 是单例，window 上的监听只绑一次；「完整对话」的开合走 setHistory()，那里自己会重贴
    if (!TB.ai._placeBound) {
      TB.ai._placeBound = true;
      window.addEventListener('resize', () => TB.ai.placeBubble());
      // 矮屏上 grid 会溢出、页面能滚（focus 输入框就会滚 53px）：宠物滚走了气泡得跟着，
      // 否则 fixed 的气泡留在原地盖住宠物。capture 才收得到内部容器（.ai-list）的滚动
      window.addEventListener('scroll', () => TB.ai.placeBubble(), { capture: true, passive: true });
    }
    // 重建即重新开始：清掉上一轮的收起状态和倒计时。bubbleKey 置 null 让首次渲染只记账不显示，
    // 免得应用刚起来时把历史里那条旧回复又念一遍似地闪三秒
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = null;
    this.bubbleKey = null;
    this.bubbleHidden = false;
    TB.dsh.subscribe(() => this.syncDsh());
    this.syncDsh();
    this.stick = true;
    this.bubbleCount = -1;
    TB.api.ai.keyStatus().then((key) => {
      TB.app.state.ai = { ...TB.app.state.ai, key };
      this.update(TB.app.state);
    });
    TB.voice?.init(this);
  },

  // 单击=浮出输入条（打字还是点麦克风说话，由他自己选），双击=DeepSeek Harness 窗口（独立窗口，能拖到别的屏），右键=打断当前回复/朗读。
  // 单击延后 260ms 给双击让位（浏览器连发 click/click/dblclick，两次 click 的定时器都会被 dblclick 清掉）
  bindPet() {
    this.petHost.addEventListener('click', () => {
      clearTimeout(this.tapTimer);
      this.tapTimer = setTimeout(() => {
        this.pet.react?.(this.petHandle);
        // 只在已经在录音时接管这一击——那是「说完了」的快捷；其余情况一律只把条子浮出来，不开麦
        if (TB.voice?.recording) TB.voice.stopRecord();
        else this.openCompose(true);
      }, 260);
    });
    this.petHost.addEventListener('dblclick', () => {
      clearTimeout(this.tapTimer);
      TB.dsh.open();
    });
    this.petHost.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      TB.voice?.stopSpeaking();
      if (TB.app.state.ai?.streaming) TB.api.ai.abort();
    });
  },

  syncDsh() {
    if (this.dshBtn) this.dshBtn.textContent = TB.dsh.label();
  },

  // 贴在宠物头顶居中（工具提示行露出来就让到它上面），横向夹在窗口内。
  // 顶边不够放时压缩气泡高度而不是压到宠物脸上：宁可气泡内部滚动，也别把宠物和面板按钮糊住。
  placeBubble() {
    const el = this.bubbleEl;
    if (!el?.isConnected || !el.classList.contains('show')) return;
    const anchor = (this.toolEl.classList.contains('show') ? this.toolEl : this.petHost).getBoundingClientRect();
    const areaWidth = this.petHost.closest('.area')?.getBoundingClientRect().width || 320;
    const width = Math.max(180, Math.min(420, areaWidth - 20));
    el.style.width = `${Math.round(width)}px`;
    el.style.maxHeight = `${Math.round(Math.min(window.innerHeight * 0.45, Math.max(56, anchor.top - 16)))}px`;
    const height = el.getBoundingClientRect().height;
    const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - 8));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(Math.max(8, anchor.top - height - 8))}px`;
    // 高度被压过时保住最新那句：气泡是「它在说什么」，不是聊天记录本录
    this.bubbleText.scrollTop = this.bubbleText.scrollHeight;
  },

  // 展开/收起「完整对话」：开合都会挪动宠物和列表的矩形，所以顺手重贴气泡
  setHistory(open) {
    this.historyOpen = Boolean(open);
    this.history.classList.toggle('open', this.historyOpen);
    this.placeBubble();
  },

  openCompose(focus) {
    this.compose.classList.add('open');
    // 浮层是绝对定位的，不腾地方就会压住宠物的脚（实测矮屏上盖掉 25px）。
    // 高度不能写死：录音按钮在不在、字体缩放都会改它，所以开的时候量一次再让面板腾出底部那条带。
    if (this.composeRoot) {
      this.composeRoot.style.setProperty('--compose-h', `${this.compose.offsetHeight}px`);
      this.composeRoot.classList.add('compose-open');
    }
    if (focus) this.input.focus();
    // 先 focus 再贴：矮屏上 grid 会溢出，浏览器把输入框滚进视野是 focus 干的，
    // 先贴后滚的话气泡（fixed）留在原地，正好盖到宠物头上
    this.placeBubble();
  },

  closeCompose(force) {
    // 录音中收起就看不见实时字幕；有草稿时不收起，那是「说完即发送」关掉后等着手改的字
    if (TB.voice?.recording) return;
    if (!force && this.input.value.trim()) return;
    this.compose.classList.remove('open');
    this.composeRoot?.classList.remove('compose-open');
    if (this.compose.contains(document.activeElement)) this.input.blur();
    this.placeBubble();
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
    this.closeCompose(true);
    this.stick = true;
    TB.app.state.ai = { ...TB.app.state.ai, error: null, stream: { text: '', reasoning: '', tools: [] } };
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
        TB.app.state.ai = { ...TB.app.state.ai, error: null, stream: { text: '', reasoning: '', tools: [] } };
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

    // 装了语音就以真实发声为准（真口型）；没装模型时退回「流式即在说话」的老行为
    const talking = TB.voice?.speaking || (!TB.voice?.ttsReady() && Boolean(ai.streaming && stream?.text));
    let mood;
    if (ai.error) mood = 'error';
    else if (ai.streaming && !talking) mood = 'curious';
    else mood = TB.emotion.moodOf(lastAssistant?.emotion);
    this.setPet(mood, talking);

    // persona:'plain' 是看腻了的退路：收起舞台、展开完整历史，不用回滚代码
    const plain = this.persona() === 'plain';
    this.stage.classList.toggle('hidden', plain);
    if (plain && !this.plainOpened) this.setHistory(true);
    this.plainOpened = plain;

    // 流式期间标签可能只到了半截，先别把它画进泡里
    const parsed = stream ? TB.emotion.splitLeading(stream.text) : null;
    const bubbleText = stream ? (parsed.pending ? '' : parsed.content) : lastAssistant?.content || '';
    this.bubbleText.textContent = bubbleText;

    // 气泡是「它刚说了什么」，不是常驻字幕：这一轮说完三秒就收起（没装语音时以回复结束为准）。
    // 一轮 = 一个 key（消息条数 + 末条长度），收起状态只记在当前这轮，下一回复 key 变了自然又显示
    const roundKey = `${messages.length}|${lastAssistant?.content?.length || 0}`;
    if (this.bubbleKey !== roundKey) {
      const boot = this.bubbleKey === null;
      this.bubbleKey = roundKey;
      // 首次渲染（开应用、换布局）时历史里那条是旧回复，不该闪一下；但那一轮正在流式就照常显示
      this.bubbleHidden = boot && !stream;
      clearTimeout(this.bubbleTimer);
      this.bubbleTimer = null;
    }
    const hasReply = Boolean(bubbleText) || Boolean(stream);
    // 流式一开始就把「已收起」撤掉：用户那句话可能到整轮结束才进 messages，只认 key 的话
    // 新一轮在流式期间还带着上一轮的收起状态，气泡整轮都不出来
    if (stream && this.bubbleHidden) {
      this.bubbleHidden = false;
      clearTimeout(this.bubbleTimer);
      this.bubbleTimer = null;
    }
    // 三秒从「真的说完了」起算：流式在跑、或朗读在说话都不算说完。朗读一开始就把表撤掉，
    // 结束那次渲染（voice.setSpeaking → refresh）重新起表——否则「说完三秒」会变成「回复出来三秒」，
    // 话还没念完字就没了。
    const idle = !stream && !TB.voice?.speaking;
    if (idle && hasReply && !this.bubbleHidden && !this.bubbleTimer) {
      this.bubbleTimer = setTimeout(() => {
        this.bubbleTimer = null;
        if (TB.voice?.speaking || TB.app.state.ai?.streaming) return;
        this.bubbleHidden = true;
        this.update(TB.app.state);
      }, 3000);
    } else if (this.bubbleTimer && (!idle || this.bubbleHidden)) {
      clearTimeout(this.bubbleTimer);
      this.bubbleTimer = null;
    }

    // plain 形象把舞台收了；气泡现在挂在 body 上，不再跟着 .ai-stage 的 hidden 一起消失，得自己判
    const showBubble = !plain && hasReply && !this.bubbleHidden;
    this.bubbleEl.classList.toggle('show', showBubble);
    this.bubbleEl.classList.toggle('typing', Boolean(stream && !bubbleText));
    if (showBubble) this.placeBubble();
    this.ask.textContent = lastUser ? `你：${lastUser.content}` : '';
    this.ask.classList.toggle('show', Boolean(lastUser));

    // 工具痕迹跟着 stream 走：流一结束就空掉，不留在这条对话的历史里
    const tools = stream?.tools || [];
    this.toolEl.textContent = tools
      .map((item) => `${item.label} → ${item.count ? `${item.count} 条` : '没查到'}`)
      .join('　');
    this.toolEl.classList.toggle('show', Boolean(stream) && tools.length > 0);

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
            ? TB.util.el('span', { text: '还没有对话。单击宠物浮出输入条（打字或点麦克风说话），点「打字」同效，双击宠物开 Harness 窗口。' })
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
