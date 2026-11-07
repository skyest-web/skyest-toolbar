// git 状态（工作面板中间那一整块 gitzone）：项目格的第二个视图，看哪个仓库由左边选中决定。
//
// 数据来自 git:status(force, id)：行是主进程拿项目格那批行里 **选中的那一条** 现读 porcelain v2 拼出来的，这里只渲染。
// 一格只看一个仓库，所以「六行列表 + 点开哪一条」那一层没了，换成三种状态里挑一条显示：
//   没选中      → 一句「点左边项目看它的仓库」，连 IPC 都不发（他要的默认态：不选就不起 git 进程）
//   选中仓库    → 分支那一行 + 改动清单 + 四个动作 + 提交说明框，常驻展开
//   选中非仓库  → 项目信息卡（该用哪个 IDE、按哪条判的、多久没动、绝对路径、来自哪个根）+ 仓库根目录清单
//
// 四条纪律和主进程那份注释一一对应，改渲染层时别绕过它们：
//   1) 只递 id 和序号：点文件是 (行 id, 第几条)，绝对路径、仓库目录、git.exe 都在这条线以外；
//   2) 写操作全走两步：按钮点下去只发 prepare(id, op[, 说明])，确认条上那一下才发 confirm(nonce)。
//      所以这一层不存在「直接推」的代码路径，也不可能在确认前把参数改掉；
//   3) 未跟踪的文件单独计数、单独说：commit -a 不带上它们，把它们混进「N 处改动」就是骗人；
//   4) 非仓库那张卡上的路径 **不来自 git 的返回**：它抄的是项目格那行（选中态存在 TB.app.state.project）。
//      git 那条 payload 里除了 root 依然一个盘符路径都没有——这条纪律不能因为「顺手显示一下路径」就破掉。
//
// 文件清单是这一格唯一的可伸缩部分（动作行永远在格子内，见 styles.css 里那三条 flex 老规矩）；
// 确认条更狠——挂出来时整格只渲染它，见 renderList。

TB.git = {
  data: null,
  busy: false,
  ask: null,
  askTimer: null,
  // 提交说明存在组件上而不是 DOM 里：切面板会整体重建这一格，DOM 没了但这句话不该跟着没
  message: '',

  init(root) {
    root.innerHTML = '';

    this.count = TB.util.el('span', { class: 'gt-count', text: '未选项目' });
    this.reload = TB.util.el('button', {
      class: 'link-btn',
      text: '刷新',
      title: '重新读一遍当前这个项目的仓库（在 IDE 或命令行里提交、拉取之后点这个；没选中项目时它一条命令都不发）',
      onclick: () => this.load(true)
    });
    this.head = TB.util.el('div', { class: 'gt-head' }, [
      TB.util.el('span', { class: 'panel-title', text: 'git' }),
      this.count,
      this.reload
    ]);

    this.list = TB.util.el('div', { class: 'gt-list' });
    root.append(this.head, this.list);
    this.load(false);
  },

  // 选中态只有一个来源：项目格点出来那一条行。这一格不另存一份「我认为是哪个」，
  // 否则重扫之后两格会各说各的。
  selected() {
    return TB.app.state.project || null;
  },

  async load(force) {
    if (this.busy || !this.count) return;
    const sel = this.selected();
    // 默认态那条要求落在这里：没选中就一条 IPC 都不发，主进程那边连 git 进程都不会起
    if (!sel) {
      this.data = null;
      this.render();
      return;
    }
    this.busy = true;
    this.count.textContent = force ? '刷新中…' : '读取中…';
    try {
      this.data = await TB.api.git.status(force, sel.id);
    } catch (err) {
      this.data = { rows: [], need: '', focus: null, error: `主进程没响应：${err.message}` };
    }
    this.busy = false;
    // 'stale' = 主进程那批行里已经没有这个 id 了（刚重扫、或者改了仓库根目录）。
    // 演旧数据是骗人，一直停在这句话上也没用：清掉选中、让项目格重取一份新行，他再点一下就接上了。
    if (this.data?.need === 'stale') {
      this.data = null;
      TB.app.selectProject(null);
      TB.projects.load(true);
      return;
    }
    this.render();
  },

  // 这一格没有自己的定时器（除了确认条那 5 秒）：20 秒缓存只在选中项变了和点刷新时才作废。
  // 常驻轮询会把 git 进程按分钟计地点在磁盘上；现在一次只问一个仓库，更没理由自己动。
  update() {
    const sel = this.selected();
    // 换项目 = 那条待确认的操作没地方可看了：连同主进程那条 nonce 一起取消，不留「看不见但还能跑」
    if (this.ask && (!sel || this.ask.id !== sel.id)) this.cancelAsk();
    if (!sel) {
      this.data = null;
      this.render();
      return;
    }
    // need 非空说明手上这条是「什么都没看着」的回复，不能拿它当缓存复用
    if (!this.data || this.data.focus?.id !== sel.id || this.data.need) this.load(false);
    else this.render();
  },

  render() {
    if (!this.count) return;
    this.count.textContent = this.summary();
    this.renderList();
  },

  // 标题行那一句话：只说当前这个仓库最要紧的一条，不把六个仓库的数字搬回来。
  summary() {
    if (!this.selected()) return '未选项目';
    const row = (this.data?.rows || [])[0];
    if (!row) return '读取中…';
    if (row.error) return '读不到';
    if (!row.repo) return '非仓库';
    const bits = [];
    if (row.conflicted) bits.push(`${row.conflicted} 冲突`);
    if (row.counts.tracked) bits.push(`${row.counts.tracked} 改动`);
    if (row.untracked) bits.push(`${row.untracked} 未跟踪`);
    if (row.ahead) bits.push(`↑${row.ahead}`);
    if (row.behind) bits.push(`↓${row.behind}`);
    return bits.join(' · ') || '干净';
  },

  renderList() {
    if (!this.list) return;
    this.list.innerHTML = '';
    // 这里不许 stopAsk：prepareOp 设完 this.ask 紧接着就调 renderList，清了等于确认条永远出不来。
    // 确认条的清理只有两处——换选中项、超时或取消（见 update / startAsk）。

    // 挂着确认条的那 5 秒整格只渲染这一条：这五秒钟里只有一件事需要看清——这一步会动什么，以及那两个按钮。
    if (this.ask) {
      this.list.append(this.confirmBar());
      return;
    }

    if (!this.selected()) {
      this.list.append(TB.util.el('div', { class: 'gt-prompt', text: '点左边一个项目，这里就看它的仓库' }));
      return;
    }

    const row = (this.data?.rows || [])[0];
    if (!row) {
      this.list.append(TB.util.el('div', { class: 'muted', text: this.data?.error || '读取中…' }));
      return;
    }
    // 非仓库没有「什么还没交出去」可看，这一格改成说这个项目的情况 + 根目录配了哪几处
    if (!row.repo) {
      this.list.append(this.infoCard());
      return;
    }
    this.list.append(this.repoBlock(row));
  },

  // ---------- 状态一：选中的是一个 git 仓库 ----------
  repoBlock(row) {
    const box = TB.util.el('div', { class: 'gt-repo', title: this.tooltip(row) });
    box.append(this.repoHead(row));
    // 整格级别的那句（本机没 git）和这一行级别的那句（这个仓库读不到）不是一回事，分开摆
    if (this.data?.error) box.append(TB.util.el('div', { class: 'gt-note', text: this.data.error }));
    if (row.error) box.append(TB.util.el('div', { class: 'gt-note bad', text: row.error }));
    // 读不到就不要再摆清单和四个按钮：那是一张空表配四个必然失败的按钮
    if (row.error) return box;
    box.append(this.fileList(row), this.actions(row));
    return box;
  },

  repoHead(row) {
    const head = TB.util.el('div', { class: 'gt-who' }, [
      TB.util.el('span', { class: 'gt-name', text: row.name, title: row.root || '' }),
      this.state(row)
    ]);
    const bits = [];
    if (row.upstream) bits.push(`上游 ${row.upstream}`);
    else if (!row.detached) bits.push('没有上游分支');
    if (row.sha) bits.push(`HEAD ${row.sha}`);
    if (row.counts.staged) bits.push(`已暂存 ${row.counts.staged}`);
    if (row.counts.unstaged) bits.push(`没暂存 ${row.counts.unstaged}`);
    if (bits.length) head.append(TB.util.el('span', { class: 'gt-meta', text: bits.join(' · ') }));
    return head;
  },

  // 状态位：游离 > 冲突 > 尚无提交 > 领先/落后 > 改动数 > 干净。一块位置只说最要紧那一条，其余在悬浮说明里。
  state(row) {
    if (row.error) return TB.util.el('span', { class: 'gt-chip bad', text: '读不到' });
    if (row.detached) return TB.util.el('span', { class: 'gt-chip bad', text: '游离 HEAD' });
    if (row.conflicted) return TB.util.el('span', { class: 'gt-chip bad', text: `${row.conflicted} 冲突` });
    if (row.unborn) return TB.util.el('span', { class: 'gt-chip plain', text: '尚无提交' });

    const bits = [row.branch || '—'];
    if (row.ahead) bits.push(`↑${row.ahead}`);
    if (row.behind) bits.push(`↓${row.behind}`);
    const changed = row.counts.tracked;
    if (changed) bits.push(`~${changed}`);
    if (row.untracked) bits.push(`+${row.untracked}`);
    const cls = changed || row.ahead || row.behind ? 'gt-chip dirty' : 'gt-chip clean';
    return TB.util.el('span', { class: cls, text: bits.join(' ') });
  },

  tooltip(row) {
    const lines = [`${row.name} · ${row.branch || '游离 HEAD'}`];
    if (row.upstream) lines.push(`上游 ${row.upstream}（领先 ${row.ahead ?? '?'} / 落后 ${row.behind ?? '?'}）`);
    else if (!row.detached) lines.push('这条分支没有上游分支（推送和拉取都用不上，第一次要在 IDE 或命令行里做）');
    if (!row.error) {
      lines.push(`已跟踪的改动 ${row.counts.tracked} 个（提交会带走这些）· 未跟踪 ${row.untracked} 个（提交不带）`);
      if (row.sha) lines.push(`HEAD ${row.sha}`);
    }
    lines.push(row.detached ? '现在是游离 HEAD，这一格不做切分支' : '点一条改动文件，用左边那个 IDE 打开');
    return lines.join('\n');
  },

  fileList(row) {
    const box = TB.util.el('div', { class: 'gt-files' });
    if (!row.files.length) {
      box.append(TB.util.el('div', { class: 'muted', text: '工作区干净，没有没交出去的东西' }));
      return box;
    }

    // 序号就是这一行 files 数组的下标：点开文件时把它原样递回去，主进程按同一份缓存取路径
    row.files.forEach((file, index) => {
      box.append(TB.util.el('button', {
        class: `gt-file ${file.kind}`,
        title: `${this.mark(file)} ${file.path}${file.from ? ` ← ${file.from}` : ''}\n用项目格判出来的那个 IDE 打开`,
        onclick: () => this.openFile(row.id, index),
        text: `${this.mark(file)} ${file.path}${file.dir ? '（整个目录）' : ''}`
      }));
    });
    if (row.truncated) {
      box.append(TB.util.el('div', { class: 'gt-more', text: '改动太多，这里只显示前面一部分' }));
    }
    return box;
  },

  // git 的两个字符状态位（索引位 + 工作树位）压成一个符号：
  // 原样写「M.」「.M」会被当成乱码，但「已暂存 / 没暂存」这个区别必须留——它决定提交带不带得走。
  mark(file) {
    if (file.kind === 'conflicted') return '✗';
    if (file.kind === 'untracked') return '?';
    if (file.code[0] !== '.' && file.code[1] === '.') return '✓';
    if (file.code[0] === '.' && file.code[1] !== '.') return '·';
    return '±';
  },

  actions(row) {
    const bar = TB.util.el('div', { class: 'gt-ops' });
    // 读不到和非仓库都到不了这里：前者在 repoBlock 就返回了，后者走 infoCard 那一态。

    for (const op of ['fetch', 'pull', 'commit', 'push']) {
      bar.append(TB.util.el('button', {
        class: `gt-op ${op}`,
        text: { fetch: '抓取', pull: '拉取', commit: '提交', push: '推送' }[op],
        title: this.opTitle(op, row),
        onclick: () => this.prepareOp(row, op)
      }));
    }

    // 说明框一直摆在动作行下面，只有这一格挂着确认条时让位。原来改成「点提交才长出输入框」要两次点击，
    // 而且中间那次点击之后屏幕上的东西变了，第二次点的是哪儿反而不清楚。
    // 确认条不在这里挂：它挂出来时整格只渲染它（见 renderList 那段）。
    bar.append(this.messageBox());
    return bar;
  },

  opTitle(op, row) {
    if (op === 'fetch') return 'git fetch：只更新远端那些引用，不动你的文件和分支';
    if (op === 'pull') return 'git pull --ff-only：只走快进，对不齐就报错给你看，不会自动产生一次合并';
    if (op === 'commit') return `git commit -a：带走 ${row.counts.tracked} 个已跟踪文件的改动。未跟踪的 ${row.untracked} 个不会被带上（这一格不做 add）`;
    return row.upstream
      ? `git push：把 ${row.branch} 已有的 ${row.ahead || 0} 条提交推到 ${row.upstream}。这一步别人看得见`
      : '这条分支没有上游分支，git push 不知道该推到哪儿（第一次推送请在 IDE 或命令行里做）';
  },

  messageBox() {
    const input = TB.util.el('textarea', {
      class: 'gt-msg',
      rows: '1',
      // 说明框只有一行高（见 styles.css .gt-msg）：placeholder 长了会被裁，那半句话等于没写
      placeholder: '写一句提交说明（不 add）',
      oninput: (event) => {
        this.message = event.target.value;
      }
    });
    input.value = this.message;
    return TB.util.el('div', { class: 'gt-msgbox' }, [input]);
  },

  // ---------- 状态二：选中的项目不是 git 仓库 ----------
  // 卡上每一条都抄自项目格那行（TB.app.state.project）：这些信息本来就是它判出来的，
  // 这一格不另判一套，也不为这张卡多发一条 IPC。
  infoCard() {
    const item = this.selected();
    const ready = item.ideReady !== false;
    const touched = item.touched
      ? `${TB.util.date(item.touched)} · ${item.touchedBy === 'git' ? 'git 里最后一次提交/切分支' : '目录自身的修改时间'}`
      : '没有改动记录';
    const lines = [
      ['该用的 IDE', `${item.ideLabel || item.ide}${ready ? '' : '（本机没找到启动器）'}`],
      ['按哪条判的', item.why],
      ['上次动过', touched],
      ['这个文件夹', item.path],
      ['来自根目录', item.root]
    ];
    const box = TB.util.el('div', { class: 'gt-card' }, [
      TB.util.el('div', { class: 'gt-card-head' }, [
        TB.util.el('span', { class: 'gt-name', text: item.name }),
        TB.util.el('span', { class: 'gt-chip plain', text: '非仓库' })
      ]),
      TB.util.el('div', {
        class: 'gt-card-why',
        text: '这个文件夹里没有 .git，它不在版本控制里，所以没有「什么还没交出去」可看。（往上那一层是仓库时，git 会把这里的改动算到上面那个仓库头上——这一格故意不去问它。）'
      }),
      TB.util.el(
        'div',
        { class: 'gt-card-lines' },
        lines.map(([label, value]) =>
          TB.util.el('div', { class: 'gt-card-line' }, [
            TB.util.el('span', { class: 'gt-card-label', text: label }),
            TB.util.el('span', { class: 'gt-card-value', title: value, text: value })
          ])
        )
      ),
      ...(item.empty ? [TB.util.el('div', { class: 'gt-note', text: '这是个空文件夹（顶层一个条目都没有）' })] : [])
    ]);
    box.append(this.rootsList());
    return box;
  },

  // 他要的「配置信息」里那另一半：仓库根目录这一栏现在配了哪几处。
  // 数一下有几处、这个项目从哪处来，比让他打开配置文件快。
  rootsList() {
    const roots = TB.projects?.data?.roots || [];
    const wrap = TB.util.el('div', { class: 'gt-roots' }, [
      TB.util.el('div', { class: 'gt-roots-title', text: roots.length ? `仓库根目录 · 配置里那 ${roots.length} 处` : '仓库根目录 · 一处都没配' })
    ]);
    if (!roots.length) {
      wrap.append(TB.util.el('div', { class: 'gt-roots-empty', text: '设置 → 仓库根目录里加一处，左边这一格才会列出项目' }));
      return wrap;
    }
    for (const root of roots) wrap.append(TB.util.el('div', { class: 'gt-root', title: root, text: root }));
    return wrap;
  },

  // prepare 不发任何 git 写命令，只换一个一次性 nonce 和几句「这一步会动到什么」回来
  async prepareOp(row, op) {
    if (this.ask) this.cancelAsk();
    if (op === 'commit' && !this.message.trim()) {
      TB.app.toast('先写一句提交说明 —— 这一步我不替你编', 'warn');
      this.renderList();
      return;
    }

    let res;
    try {
      res = await TB.api.git.prepare(row.id, op, op === 'commit' ? { message: this.message.trim() } : {});
    } catch (err) {
      TB.app.toast(`准备失败：${err.message}`, 'warn');
      return;
    }
    if (!res?.ok) {
      TB.app.toast(res?.error || '这一步做不了', 'warn');
      return;
    }
    this.ask = { id: row.id, op: res.op, label: res.label, name: res.name, lines: res.lines || [], nonce: res.nonce, left: Math.round((res.expiresMs || 5000) / 1000) };
    this.startAsk();
    this.renderList();
  },

  confirmBar() {
    const ask = this.ask;
    const lines = TB.util.el('div', { class: 'gt-ask-lines' }, ask.lines.map((line) => TB.util.el('div', { class: 'gt-ask-line', text: line })));
    const yes = TB.util.el('button', {
      class: 'gt-yes',
      text: `确认 ${ask.left}s`,
      onclick: () => this.confirmAsk()
    });
    const no = TB.util.el('button', { class: 'gt-no', text: '取消', onclick: () => this.cancelAsk() });
    return TB.util.el('div', { class: `gt-ask ${ask.op}` }, [
      TB.util.el('div', { class: 'gt-ask-who', text: `${ask.label}「${ask.name}」` }),
      lines,
      TB.util.el('div', { class: 'gt-ask-btns' }, [yes, no])
    ]);
  },

  startAsk() {
    clearInterval(this.askTimer);
    // 这条定时器是本组件唯一的一条，且只在确认条挂着的时候活着；到 0 秒自己作废（和主进程那 5 秒同一件事）
    this.askTimer = setInterval(() => {
      const ask = this.ask;
      if (!ask) {
        clearInterval(this.askTimer);
        this.askTimer = null;
        return;
      }
      ask.left -= 1;
      const btn = this.list?.querySelector('.gt-yes');
      if (ask.left <= 0) {
        this.stopAsk();
        this.cancelAskRemote(ask.nonce);
        TB.app.toast('确认超时（5 秒），这一步没做', 'warn');
        this.renderList();
        return;
      }
      if (btn) btn.textContent = `确认 ${ask.left}s`;
    }, 1000);
  },

  stopAsk() {
    clearInterval(this.askTimer);
    this.askTimer = null;
    this.ask = null;
  },

  async cancelAskRemote(nonce) {
    try {
      await TB.api.git.cancel(nonce);
    } catch (err) {
      // 取消不成也没关系：那条 nonce 5 秒后在主进程自己过期
    }
  },

  cancelAsk() {
    const ask = this.ask;
    this.stopAsk();
    // 取消以后必须马上重渲染：确认条那 5 秒是把列表整段换掉的，不渲染回来就停在一条已经没有对象的确认条上
    // （真机探针量出来的：点了「取消」`.gt-ask` 还在，`.gt-list` 里那些行也回不来）。
    if (ask) {
      this.cancelAskRemote(ask.nonce);
      this.renderList();
    }
  },

  // 这一步是全格唯一真起 git 写进程的按钮：只递 nonce，id / 参数 / 说明全留在主进程 prepare 那次
  async confirmAsk() {
    const ask = this.ask;
    if (!ask) return;
    this.stopAsk();
    let res;
    try {
      res = await TB.api.git.confirm(ask.nonce);
    } catch (err) {
      TB.app.toast(`这一步没跑起来：${err.message}`, 'warn');
      return;
    }
    if (res?.ok) {
      const done = { fetch: '抓取完了', pull: '拉取完了', commit: '提交完了', push: '推出去了' }[res.op] || '做完了';
      TB.app.toast(`${done}「${res.name}」${res.output ? ` · ${res.output}` : ''}`, 'ok');
    } else {
      TB.app.toast(`没做成：${res?.error || '未知错误'}`, 'warn');
    }
    // 跑完一步这仓库的数字就变了，缓存不许再用：直接重读，不停在旧数字上演
    this.data = null;
    await this.load(false);
  },

  async openFile(id, index) {
    let res;
    try {
      res = await TB.api.git.openFile(id, index);
    } catch (err) {
      TB.app.toast(`打开失败：${err.message}`, 'warn');
      return;
    }
    if (res?.ok) TB.app.toast(`已交给 ${res.ideLabel} 打开「${res.file}」`, 'ok');
    else TB.app.toast(`打开失败：${res?.error || '未知错误'}`, 'warn');
  }
};

TB.register({
  id: 'git',
  name: 'git 状态',
  cls: 'area git-area',
  build: () => TB.util.el('div', { id: 'git' }),
  init: (node) => TB.git.init(node),
  update: () => TB.git.update()
});
