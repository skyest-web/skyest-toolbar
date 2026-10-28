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
    const aiAgentTools = this.checkbox(config.ai.agentTools?.enabled);
    const aiMotion = this.select(
      [
        ['full', '完整'],
        ['calm', '安静'],
        ['off', '关闭（定格）']
      ],
      config.ai.motion
    );

    // ----- 语音 -----
    const voiceEnabled = this.checkbox(config.voice.enabled);
    const voiceEngine = this.select(
      [
        ['auto', '自动（离线优先，失败走在线）'],
        ['kokoro', '只用离线 Kokoro'],
        ['edge', '只用在线 edge-tts']
      ],
      config.voice.ttsEngine
    );
    const voiceName = this.select(
      [
        ['zh-CN-XiaoyiNeural', '晓伊（女·少女音，最甜）'],
        ['zh-CN-XiaoxiaoNeural', '晓晓（女·温暖大姐姐）'],
        ['zh-CN-YunxiaNeural', '云夏（男童·软糯）'],
        ['zh-CN-YunxiNeural', '云希（男·普通话）'],
        ['zh-CN-YunjianNeural', '云健（男·普通话）'],
        ['zh-CN-YunyangNeural', '云扬（男·新闻播报）']
      ],
      config.voice.ttsVoice
    );
    // edge 的 pitch 只认 Hz；范围给到 ±，太往上就变成电子音了
    const voicePitch = this.select(
      [
        ['-4Hz', '更低沉'],
        ['+0Hz', '原调'],
        ['+3Hz', '略亮（默认）'],
        ['+6Hz', '甜美'],
        ['+9Hz', '很嗲']
      ],
      config.voice.ttsPitch || '+3Hz'
    );
    const sidCount = Number(TB.voice?.status?.tts?.numSpeakers) || 103;
    const voiceSid = this.number(config.voice.ttsSid ?? 0, 0, sidCount - 1, 1);
    const voiceSpeed = this.number(config.voice.ttsSpeed, 0.6, 1.6, 0.05);
    const voiceAutoSpeak = this.checkbox(config.voice.autoSpeak);
    const voiceAutoSend = this.checkbox(config.voice.autoSend);
    const voiceStatusHint = TB.util.el('span', {
      class: 'field-hint',
      text: TB.voice?.status?.running
        ? `进程在跑；离线识别${TB.voice.status.models.asr ? '已装' : '缺模型'}，离线朗读${TB.voice.status.models.tts ? '已装' : '缺模型'}`
        : '语音进程未启动（模型未安装时先在项目目录跑 npm run voice:install）'
    });
    const voicePreview = TB.util.el('button', {
      class: 'ghost-btn',
      text: '试听',
      // 用面板上当前（还没保存）的值合成，改一项就能立刻听，不用先存再试
      onclick: () => TB.voice?.preview?.({
        engine: voiceEngine.value === 'auto' ? undefined : voiceEngine.value,
        voice: voiceName.value,
        pitch: voicePitch.value,
        sid: Number(voiceSid.value),
        speed: Number(voiceSpeed.value)
      })
    });

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
      this.field(
        '查本机文件',
        aiAgentTools,
        '开着时它能按文件名查本机索引（Everything）来回答「X 在哪」。只读，打不开文件；工具拿到的原始结果不落盘，但命中的文件名和路径会作为输入发到 DeepSeek。需要「文件搜索」是开的，且模型是 deepseek-chat（reasoner 不支持工具）'
      ),
      this.field('宠物动画', aiMotion, '只有「关闭」真省 CPU：视频版常驻约 23% 单核，关闭后 3%')
    );
    aiCard.dataset.card = 'ai';

    const voiceCard = this.card(
      '语音',
      this.field('启用语音', voiceEnabled, '关掉后宠物只听打字，不发音也不识别'),
      this.field('模型状态', voiceStatusHint, '离线模型放在项目 models/，装法：npm run voice:install'),
      this.field('朗读引擎', voiceEngine, '在线 edge-tts 是人录的音色、最像人，联网才能用；离线 Kokoro 全 CPU、不出网，但偏平。自动=在线优先、断网退回离线'),
      this.field('在线音色', voiceName, '走在线时生效；默认「晓伊」就是偏甜妹的那个'),
      this.field('音高', voicePitch, '在线音色的明暗，往上更甜更嗲，往下更沉；只对在线音色生效'),
      this.field('离线音色 (sid)', voiceSid, `断网兜底时用的离线说话人编号，0–${(Number(TB.voice?.status?.tts?.numSpeakers) || 103) - 1}；离线没有音高可调`),
      this.field('语速', voiceSpeed, '1.0 为原速；在线按百分率、离线按倍速各自换算'),
      this.field('自动朗读回复', voiceAutoSpeak, '回复完成后逐句播放，宠物口型跟着声音走'),
      this.field('说完即发送', voiceAutoSend, '关掉后识别结果只填进输入框，你改完再按回车'),
      this.field('试听', voicePreview)
    );
    voiceCard.dataset.card = 'voice';

    // ----- 文件搜索（Everything） -----
    const searchEnabled = this.checkbox(config.search.enabled);
    const searchMax = this.number(config.search.maxResults, 1, 100, 5);
    const searchMin = this.number(config.search.minChars, 1, 8, 1);
    const searchTimeout = this.number(config.search.timeoutMs, 300, 10000, 100);
    const searchAutoStart = this.checkbox(config.search.autoStart);
    const searchSort = this.select(
      [
        ['NAME_ASCENDING', '名称 A→Z'],
        ['PATH_ASCENDING', '路径 A→Z'],
        ['SIZE_DESCENDING', '大的在前'],
        ['DATE_MODIFIED_DESCENDING', '最近改动的在前']
      ],
      config.search.sort
    );
    const searchState = TB.search?.status || null;
    const searchStatusHint = TB.util.el('span', {
      class: 'field-hint',
      text: !searchState
        ? '状态未知：点一下顶栏搜索栏就能拿到'
        : !searchState.supported
          ? 'Everything 只有 Windows 版，这台机器上用不了'
          : !searchState.installed
            ? `没找到 vendor/everything 里的 SDK${searchState.lastError ? `（${searchState.lastError}）` : ''}`
            : searchState.running && searchState.dbLoaded
              ? `已连上 SDK ${searchState.sdkVersion || ''}${searchState.admin ? '（管理员索引）' : '（普通权限索引）'}`
              : searchState.running
                ? '已连上，但索引还没建完'
                : `Everything 没在运行${searchState.lastError ? `（${searchState.lastError}）` : ''}`
    });
    const searchRetry = TB.util.el('button', {
      class: 'ghost-btn',
      text: '重连并拉起 Everything',
      onclick: async () => {
        const result = await TB.api.search.startHost();
        TB.search?.applyStatus?.(result.status);
        searchStatusHint.textContent = result.ok
          ? '已连上，具体看顶栏搜索栏右侧的徽标'
          : `拉起失败：${result.message || 'Everything 没回应'}`;
      }
    });

    const searchCard = this.card(
      '文件搜索（Everything）',
      this.field('启用', searchEnabled, '关掉后顶栏不显示搜索栏，Ctrl+F 也一起失效'),
      this.field('连接状态', searchStatusHint, '查询全走本机 Everything 的 IPC，不出网'),
      this.field('最多返回', searchMax, '一次取回多少条；下拉里可以滚动看完，总数超出时底部提示还有多少'),
      this.field('最少字数', searchMin, '少于这个字数不发查询：单字符在全盘索引上又慢又没意义'),
      this.field('单次超时 (ms)', searchTimeout, '阻塞调用堵住工作进程时，超过这么久算这次没成功'),
      this.field('没运行就拉起', searchAutoStart, '首次查询撞见 Everything 没在跑，就用项目里的便携版把它带起来再重试一次'),
      this.field('排序', searchSort),
      this.field('重连', searchRetry)
    );
    searchCard.dataset.card = 'search';

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
        TB.util.el('div', { class: 'card-col' }, [musicCard, aiCard, voiceCard, searchCard, moduleCard]),
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
              agentTools: { ...config.ai.agentTools, enabled: aiAgentTools.checked },
              motion: aiMotion.value
            };
            config.voice = {
              ...config.voice,
              enabled: voiceEnabled.checked,
              ttsEngine: voiceEngine.value,
              ttsVoice: voiceName.value,
              ttsPitch: voicePitch.value,
              ttsSpeed: TB.util.clamp(Number(voiceSpeed.value), 0.6, 1.6),
              ttsSid: Math.round(TB.util.clamp(Number(voiceSid.value), 0, (Number(TB.voice?.status?.tts?.numSpeakers) || 103) - 1)),
              autoSpeak: voiceAutoSpeak.checked,
              autoSend: voiceAutoSend.checked
            };
            config.search = {
              ...config.search,
              enabled: searchEnabled.checked,
              maxResults: Math.round(TB.util.clamp(Number(searchMax.value), 1, 100)),
              minChars: Math.round(TB.util.clamp(Number(searchMin.value), 1, 8)),
              timeoutMs: Math.round(TB.util.clamp(Number(searchTimeout.value), 300, 10000)),
              autoStart: searchAutoStart.checked,
              sort: searchSort.value
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
