TB.settings = {
  init(root) {
    this.root = root;
    root.addEventListener('click', (event) => {
      if (event.target === root) this.close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && root.classList.contains('open')) this.close();
    });
  },

  field(labelText, control, hint) {
    return TB.util.el('label', { class: 'field' }, [
      TB.util.el('span', { class: 'field-label', text: labelText }),
      TB.util.el('div', { class: 'field-control' }, [control, hint ? (hint instanceof Node ? hint : TB.util.el('span', { class: 'field-hint', text: hint })) : null])
    ]);
  },

  number(value, min, max, step = 1) {
    return TB.util.el('input', { class: 'input num', type: 'number', value, min, max, step });
  },

  checkbox(checked) {
    const box = TB.util.el('input', { type: 'checkbox' });
    box.checked = !!checked;
    return box;
  },

  select(entries, value) {
    return TB.util.el(
      'select',
      { class: 'input' },
      entries.map(([optionValue, text]) => TB.util.el('option', { value: optionValue, text, selected: optionValue === value }))
    );
  },

  card(title, ...fields) {
    return TB.util.el('section', { class: 'card' }, [TB.util.el('h3', { text: title }), ...fields]);
  },

  open(focusCard) {
    const state = TB.app.state;
    const config = structuredClone(state.config);
    const layout = state.grid;
    const displays = state.displays || [];

    // ----- 屏幕 -----
    const modeSelect = TB.util.el('select', { class: 'input' }, [
      TB.util.el('option', { value: 'auto', text: '自动匹配（推荐）', selected: config.display.mode === 'auto' }),
      TB.util.el('option', { value: 'index', text: '按屏幕序号', selected: config.display.mode === 'index' }),
      TB.util.el('option', { value: 'bounds', text: '手动坐标', selected: config.display.mode === 'bounds' })
    ]);
    const indexSelect = TB.util.el('select', { class: 'input' });
    const activeIndex = state.placement?.display?.index ?? config.display.index;
    for (const disp of displays) {
      indexSelect.appendChild(
        TB.util.el('option', {
          value: disp.index,
          text: `${disp.label}${disp.isPrimary ? '（主屏）' : ''} · 缩放 ${disp.scaleFactor}x`,
          selected: disp.index === activeIndex
        })
      );
    }
    const bounds = config.display.bounds || state.placement?.bounds || { x: 0, y: 0, width: 1920, height: 540 };
    const boundsInputs = {
      x: this.number(bounds.x, -10000, 10000),
      y: this.number(bounds.y, -10000, 10000),
      width: this.number(bounds.width, 320, 10000),
      height: this.number(bounds.height, 240, 10000)
    };
    const matchInputs = {
      width: this.number(config.display.match.width, 320, 10000),
      height: this.number(config.display.match.height, 240, 10000),
      tolerance: this.number(config.display.match.tolerance, 0, 500)
    };
    const alwaysOnTop = this.checkbox(config.window.alwaysOnTop);
    const current = state.placement
      ? `${state.placement.source} → ${state.placement.bounds.width}x${state.placement.bounds.height} @(${state.placement.bounds.x},${state.placement.bounds.y})`
      : '--';

    // ----- 轮询与剪贴板 -----
    const fastMs = this.number(config.metrics.pollMs, 500, 60000, 100);
    const slowMs = this.number(config.metrics.slowPollMs, 1000, 120000, 500);
    const historySize = this.number(config.metrics.historySize, 20, 600, 10);
    const clipEnabled = this.checkbox(config.clipboard.enabled);
    const clipMax = this.number(config.clipboard.maxItems, 5, 200, 5);

    // ----- 音乐 -----
    const musicFolder = TB.util.el('input', { class: 'input', type: 'text', value: config.music.folder, placeholder: '例如 D:\\Music' });
    const browse = TB.util.el('button', {
      class: 'ghost-btn',
      text: '浏览…',
      onclick: async () => {
        const picked = await TB.api.music.pickFolder();
        if (picked) musicFolder.value = picked;
      }
    });
    const musicRecursive = this.checkbox(config.music.recursive);
    const musicVolume = this.number(Math.round(config.music.volume * 100), 0, 100, 5);

    // ----- AI（密钥即时加密写入 userData/ai-key.bin，不跟随「保存并应用」） -----
    const keyState = state.ai?.key || { set: false, hint: null };
    const keyInput = TB.util.el('input', { class: 'input', type: 'password', placeholder: keyState.set ? `已保存 ${keyState.hint}` : 'sk-…', spellcheck: 'false', autocomplete: 'off' });
    const keyHint = TB.util.el('span', { class: 'field-hint', text: keyState.set ? `已加密保存（${keyState.hint}），Windows 用户级 DPAPI，换机需重填` : '只加密存在 userData，不写进 toolbar.config.json' });
    const saveKey = TB.util.el('button', {
      class: 'ghost-btn',
      text: '保存密钥',
      onclick: async () => {
        const result = await TB.api.ai.setKey(keyInput.value);
        if (!result.ok) return TB.app.toast(result.error, 'error');
        keyInput.value = '';
        keyInput.placeholder = result.hint;
        keyHint.textContent = `已加密保存（${result.hint}）`;
        TB.app.state.ai = { ...TB.app.state.ai, key: { set: result.set, hint: result.hint } };
        TB.app.refresh('ai');
        TB.app.toast('密钥已加密保存', 'ok');
      }
    });
    const clearKey = TB.util.el('button', {
      class: 'ghost-btn',
      text: '清除密钥',
      onclick: async () => {
        await TB.api.ai.clearKey();
        keyInput.placeholder = 'sk-…';
        keyHint.textContent = '已清除';
        TB.app.state.ai = { ...TB.app.state.ai, key: { set: false, hint: null } };
        TB.app.refresh('ai');
      }
    });
    const aiModel = TB.util.el('select', { class: 'input' }, [
      TB.util.el('option', { value: 'deepseek-chat', text: 'deepseek-chat（V3，快）', selected: config.ai.model === 'deepseek-chat' }),
      TB.util.el('option', { value: 'deepseek-reasoner', text: 'deepseek-reasoner（R1，带思考过程）', selected: config.ai.model === 'deepseek-reasoner' })
    ]);
    const aiSystem = TB.util.el('textarea', { class: 'input ai-system', rows: '3', spellcheck: 'false' });
    aiSystem.value = config.ai.systemPrompt;
    const aiTemp = this.number(config.ai.temperature, 0, 2, 0.1);
    const aiMaxTokens = this.number(config.ai.maxTokens, 1, 8192, 64);
    const aiContext = this.number(config.ai.contextMessages, 2, 40, 2);
    const aiPersist = this.checkbox(config.ai.persistHistory);
    const aiName = TB.util.el('input', { class: 'input', type: 'text', maxlength: '20', placeholder: '留空则不叫名字' });
    aiName.value = config.ai.name || '';
    const aiPersona = this.select(
      [
        ['video', '蓝毛小女仆（webm 动画）'],
        ['pet', '猫团子（SVG，最省资源）'],
        ['plain', '纯文字（不出宠物）']
      ],
      config.ai.persona
    );
    const aiEmotion = this.checkbox(config.ai.emotion);
    const aiMotion = this.select(
      [
        ['full', '完整'],
        ['calm', '安静'],
        ['off', '关闭（定格）']
      ],
      config.ai.motion
    );

    const aiCard = this.card(
      'AI 对话',
      this.field('DeepSeek 密钥', TB.util.el('div', { class: 'inline' }, [keyInput, saveKey, clearKey]), keyHint),
      this.field('模型', aiModel, 'reasoner 会多一段可折叠的思考过程'),
      this.field('系统提示', aiSystem, '每次请求都带，最长 2000 字'),
      this.field('temperature', aiTemp),
      this.field('单次回复上限 (tokens)', aiMaxTokens),
      this.field('上下文条数', aiContext, '带最近几条对话'),
      this.field('历史存盘', aiPersist, '关掉则对话只留内存，退出即清空'),
      this.field('名字', aiName, '会写进系统提示，它就知道别人怎么叫它；面板标题也用这个'),
      this.field('宠物形象', aiPersona, '换形象即时生效，不用重启'),
      this.field('情绪标签', aiEmotion, '让它每句话开头带 [开心]/[困] 这类标签，宠物据此换表情；关掉省一点 token'),
      this.field('宠物动画', aiMotion, '只有「关闭」真省 CPU：视频版常驻约 23% 单核，关闭后 3%')
    );
    aiCard.dataset.card = 'ai';

    // ----- 组件与位置（layout.json 的 slots） -----
    const visibleCount = layout.slots.filter((slot) => slot.enabled && slot.module).length;
    const gridSummary = `${layout.grid.columns.length} 列 × ${layout.grid.rows.length} 行`;

    const screenCard = this.card(
      '屏幕目标',
      this.field('定位方式', modeSelect, '自动模式挑选与目标分辨率最接近的非主屏'),
      this.field(
        '目标分辨率',
        TB.util.el('div', { class: 'inline' }, [
          matchInputs.width,
          TB.util.el('span', { text: '×' }),
          matchInputs.height,
          TB.util.el('span', { text: '容差' }),
          matchInputs.tolerance
        ]),
        current
      ),
      this.field('屏幕序号', indexSelect, '仅在“按屏幕序号”时生效'),
      this.field(
        '手动坐标',
        TB.util.el('div', { class: 'inline' }, [
          TB.util.el('span', { class: 'mini-label', text: 'X' }),
          boundsInputs.x,
          TB.util.el('span', { class: 'mini-label', text: 'Y' }),
          boundsInputs.y,
          TB.util.el('span', { class: 'mini-label', text: '宽' }),
          boundsInputs.width,
          TB.util.el('span', { class: 'mini-label', text: '高' }),
          boundsInputs.height
        ]),
        '仅在“手动坐标”时生效'
      ),
      this.field('窗口置顶', alwaysOnTop, '只有被其他窗口遮挡时才需要')
    );

    const refreshCard = this.card(
      '刷新与剪贴板',
      this.field('快轮询 (ms)', fastMs, 'CPU、内存'),
      this.field('慢轮询 (ms)', slowMs, 'GPU、网络、磁盘、进程（走 nvidia-smi 与 PowerShell）'),
      this.field('曲线点数', historySize),
      this.field('记录剪贴板', clipEnabled, '内容只留内存，不落盘'),
      this.field('保留条数', clipMax)
    );

    const musicCard = this.card(
      '音乐',
      this.field('文件夹', TB.util.el('div', { class: 'inline' }, [musicFolder, browse]), '扫描 mp3 / flac / m4a / wav 等'),
      this.field('含子目录', musicRecursive, '最深 4 层'),
      this.field('默认音量 %', musicVolume, '播放器上的音量优先'),
      this.field('歌词', TB.util.el('span', { class: 'field-hint', text: '与音频同名、同目录的 .lrc 自动同步' }))
    );

    const moduleCard = TB.util.el('section', { class: 'card' }, [
      TB.util.el('h3', { text: '组件与位置' }),
      TB.util.el('p', { class: 'muted', text: `位置固定（当前 ${gridSummary}），换组件或关掉不显示都在面板里做；改动直接写入 layout.json` }),
      TB.util.el('button', {
        class: 'ghost-btn',
        text: '打开组件与位置',
        onclick: () => {
          this.close();
          TB.layoutEditor.open();
        }
      }),
      TB.util.el('p', { class: 'muted', text: `已注册 ${TB.components.size} 个组件 / 显示中 ${visibleCount} 个位置` })
    ]);

    const dockCard = TB.util.el('section', { class: 'card' }, [
      TB.util.el('h3', { text: '快捷方式' }),
      TB.util.el('p', { class: 'muted', text: '入口和分类都用表单增删改，保存时立刻写入 toolbar.config.json；dock 上的 ＋ 打开同一个面板' }),
      TB.util.el('button', { class: 'ghost-btn', text: '打开快捷方式管理', onclick: () => TB.dockEditor.open() }),
      TB.util.el('p', { class: 'muted', text: `当前 ${config.dock.length} 个入口 / ${config.dockCategories.length} 个分类` })
    ]);

    const modal = TB.util.el('div', { class: 'settings-modal' }, [
      TB.util.el('div', { class: 'settings-head' }, [
        TB.util.el('h2', { text: '工具栏设置' }),
        TB.util.el('span', { class: 'muted', text: '保存到项目根目录 toolbar.config.json；组件位置在「组件与位置」面板里改 layout.json' })
      ]),
      TB.util.el('div', { class: 'settings-grid' }, [
        screenCard,
        refreshCard,
        TB.util.el('div', { class: 'card-col' }, [musicCard, aiCard, moduleCard]),
        dockCard
      ]),
      TB.util.el('div', { class: 'settings-footer' }, [
        TB.util.el('button', {
          class: 'primary',
          text: '保存并应用',
          onclick: async () => {
            config.display = {
              mode: modeSelect.value,
              index: Number(indexSelect.value),
              match: {
                width: Number(matchInputs.width.value),
                height: Number(matchInputs.height.value),
                tolerance: Number(matchInputs.tolerance.value)
              },
              bounds: Object.fromEntries(Object.entries(boundsInputs).map(([key, input]) => [key, Number(input.value)]))
            };
            config.window.alwaysOnTop = alwaysOnTop.checked;
            config.metrics = { pollMs: Number(fastMs.value), slowPollMs: Number(slowMs.value), historySize: Number(historySize.value) };
            config.clipboard = { enabled: clipEnabled.checked, maxItems: Number(clipMax.value), pollMs: config.clipboard.pollMs };
            config.music = {
              folder: musicFolder.value.trim(),
              recursive: musicRecursive.checked,
              volume: TB.util.clamp(Number(musicVolume.value) / 100, 0, 1),
              repeat: config.music.repeat
            };
            config.ai = {
              ...config.ai,
              model: aiModel.value,
              systemPrompt: aiSystem.value.slice(0, 2000),
              temperature: TB.util.clamp(Number(aiTemp.value), 0, 2),
              maxTokens: Math.round(TB.util.clamp(Number(aiMaxTokens.value), 1, 8192)),
              contextMessages: Math.round(TB.util.clamp(Number(aiContext.value), 2, 40)),
              persistHistory: aiPersist.checked,
              name: aiName.value.trim().slice(0, 20),
              persona: aiPersona.value,
              emotion: aiEmotion.checked,
              motion: aiMotion.value
            };
            // dock 与 layout 分别由「快捷方式管理」「组件与位置」面板即时写入，
            // 这里不带着旧副本，避免覆盖那边的改动
            delete config.dock;
            delete config.dockCategories;

            const result = await TB.api.config.save(config);
            TB.app.applyConfigResult(result);
            TB.app.toast(`已写入 ${result.file}`, 'ok');
            this.close();
          }
        }),
        TB.util.el('button', { text: '打开配置文件', onclick: () => TB.api.config.openFile() }),
        TB.util.el('button', { text: '打开布局文件', onclick: () => TB.api.layout.openFile() }),
        TB.util.el('button', { text: '重载文件', onclick: async () => TB.app.applyConfigResult(await TB.api.config.reload()) }),
        TB.util.el('button', { text: '重启工具栏', onclick: () => TB.api.app.relaunch() }),
        TB.util.el('button', { class: 'danger', text: '退出', onclick: () => TB.api.app.quit() }),
        TB.util.el('button', { text: '关闭 (Esc)', onclick: () => this.close() })
      ])
    ]);

    this.root.innerHTML = '';
    this.root.appendChild(modal);
    this.root.classList.add('open');
    if (focusCard) this.root.querySelector(`[data-card="${focusCard}"]`)?.scrollIntoView({ block: 'start' });
  },

  close() {
    this.root.classList.remove('open');
    this.root.innerHTML = '';
  }
};
