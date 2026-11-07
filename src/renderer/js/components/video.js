// 生活面板 slot2：视频。两档来源用头上一对分段按钮切——「本地」播文件夹里的文件，「B站」只列单子。
//
// 【本地】左边一块 <video>（原生控制条：播放/进度/音量/画中画/全屏都是 Chromium 给的），
// 右边一列是扫出来的清单，点一行播一条。取数据走 video:scan——主进程只扫 config.video.folder
// 那一个目录，渲染层递进去的路径只影响弹窗默认打开哪儿，不是读文件的入口。播放走和音乐同一条
// track://：file:// 直连媒体元素会被 Chromium 的跨源策略挡住，而那份分段响应是手写的——缺
// Content-Length 时 Chromium 把 duration 报成 Infinity，进度条整个废掉（见 QODER.md）。
//
// 【B站】画面那一格整个收起来，换成三个页签（稍后再看 / 观看历史 / 我的收藏）。这一档不放流：
// B 站的视频是 DASH 分片 + 签名地址 + 必须回 Referer，<video src> 吃不下；点一行是把
// https://www.bilibili.com/video/<bvid> 交给系统浏览器（这台机器是 Edge），和 Steam 那条
// steam:// 同一个套路。出网全在主进程 services/bili.js，这里只拿行数据；SESSDATA 碰不到，
// 账号名也只存在内存里，绝不写进 state.json。
//
// 状态存 JS 上、<video> 元素也只建一次：切面板会整体重建 DOM，元素跟着重建就等于每条都从头播。
// 「哪一档、哪个页签、上次看到第几秒」走 video:save 进 state.json（userData），
// 和播放器一样不碰 toolbar.config.json。

TB.video = {
  clips: [],
  index: -1,
  folder: null,
  el: null,
  error: null,
  busy: false,
  pendingResume: 0,
  lastSaved: 0,
  lastQueued: 0,
  // 'local' | 'bili'——切档只是换这一格画什么，<video> 元素本身一直留着
  source: 'local',
  restored: false,
  SECTIONS: [
    { id: 'toview', name: '稍后再看' },
    { id: 'history', name: '观看历史' },
    { id: 'fav', name: '我的收藏' }
  ],
  // B 站那一档的内存态。rows 是主进程这次发回来的行，folder 是「我的收藏」里点进去的那个夹子。
  bili: { section: 'toview', folder: null, rows: [], error: null, busy: false, total: 0, loaded: false, account: null },


  init(root) {
    this.root = root;
    root.innerHTML = '';

    this.count = TB.util.el('span', { class: 'vd-count', text: '' });
    this.srcLocalBtn = TB.util.el('button', {
      class: 'seg-btn',
      text: '本地',
      title: '播文件夹里的视频（mp4 / m4v / mov / webm / mkv）',
      onclick: () => this.setSource('local')
    });
    this.srcBiliBtn = TB.util.el('button', {
      class: 'seg-btn',
      text: 'B站',
      title: '列稍后再看 / 观看历史 / 我的收藏；点一行交给浏览器打开，不在这里播',
      onclick: () => this.setSource('bili')
    });
    this.pickBtn = TB.util.el('button', {
      class: 'link-btn',
      text: '选文件夹',
      title: '挑一个本地视频文件夹，只扫里面的 mp4 / m4v / mov / webm / mkv',
      onclick: () => this.pickFolder()
    });
    this.revealBtn = TB.util.el('button', {
      class: 'link-btn',
      text: '定位',
      title: '在资源管理器里选中当前这个文件',
      onclick: () => this.reveal()
    });
    this.refreshBtn = TB.util.el('button', {
      class: 'link-btn',
      text: '刷新',
      title: '重新问一次 B 站（本地清单不看这个）',
      onclick: () => this.loadBili(true)
    });
    this.head = TB.util.el('div', { class: 'vd-head' }, [
      TB.util.el('span', { class: 'panel-title', text: '视频' }),
      this.srcLocalBtn,
      this.srcBiliBtn,
      this.count,
      TB.util.el('span', { class: 'vd-grow' }),
      this.revealBtn,
      this.pickBtn,
      this.refreshBtn
    ]);

    // B 站那一档的三个页签。本地模式下整条藏起来，别占高度。
    this.tabs = TB.util.el('div', { class: 'bl-tabs' });
    this.line = TB.util.el('div', { class: 'vd-line muted' });
    this.list = TB.util.el('div', { class: 'vd-list' });
    this.stage = TB.util.el('div', { class: 'vd-stage' });
    this.body = TB.util.el('div', { class: 'vd-body' }, [this.stage, TB.util.el('div', { class: 'vd-side' }, [this.tabs, this.line, this.list])]);

    root.append(this.head, this.body);
    // <video> 在 stage 建好之后才挂进去：元素本身只 new 一次，换面板只是把它挪进新的那一格
    this.ensureEl();
    // 切面板会重跑这一趟，但 this.source 活在 JS 上，不会退回「本地」——所以先按它把界面摆对再画
    this.syncControls();
    this.repaint();
  },

  // ---------- 两档来源 ----------

  // 头部按钮的显隐、页签、.is-bili 那一个类：一处收口，切档和重画都走这里
  syncControls() {
    const bili = this.source === 'bili';
    this.root.classList.toggle('is-bili', bili);
    this.srcLocalBtn.classList.toggle('on', !bili);
    this.srcBiliBtn.classList.toggle('on', bili);
    this.pickBtn.hidden = bili;
    this.revealBtn.hidden = bili;
    this.refreshBtn.hidden = !bili;
    this.tabs.hidden = !bili;
    this.renderTabs();
  },

  async setSource(next) {
    if (next === this.source) return;
    this.source = next;
    // 切到 B 站就把本地那条停下：这一档不播东西，让音频在背后继续放最容易被当成 bug
    if (next === 'bili') this.el?.pause();
    this.syncControls();
    this.repaint();
    // 立刻落盘：去抖那 600 秒窗口里退出应用，下次开机就会回到本地那一档
    TB.api.video.save(this.snapshot());
    if (next === 'bili' && !this.bili.loaded) await this.loadBili();
  },

  // <video> 只建一次：init 会清空整个格子，重复 createElement 会把正在播的那条打断
  ensureEl() {
    if (!this.el) {
      this.el = document.createElement('video');
      this.el.className = 'vd-player';
      this.el.controls = true;
      this.el.preload = 'metadata';
      this.el.playsInline = true;
    }
    if (this.el.parentNode !== this.stage) this.stage.appendChild(this.el);
    if (!this.bound) this.bind();
  },

  bind() {
    this.bound = true;
    const el = this.el;
    el.addEventListener('loadedmetadata', () => this.applyResume());
    el.addEventListener('timeupdate', () => {
      this.renderLine();
      // 每 250ms 一次的 timeupdate 不该直接写盘：播放中最多 5 秒排一次。
      // 这道闸门必须按「上次排程」算，不能按 lastSaved（那要等 600ms 的去抖真落地才更新）——
      // 照着它写，250ms 一次的排程会把去抖一直往后推，播放期间一次盘都写不上（真机探针抓到过）。
      if (Date.now() - this.lastQueued > 5000) this.persist();
    });
    for (const type of ['pause', 'ended', 'seeked', 'volumechange']) {
      el.addEventListener(type, () => this.persist());
    }
    el.addEventListener('error', () => this.onError());
  },

  onError() {
    const clip = this.clips[this.index];
    this.error = clip ? `播不了：${clip.file}（容器或编码 Electron 解不了，换 mp4 / webm 试试）` : '播放器出错';
    this.renderHead();
    this.renderLine();
    TB.app.toast(this.error, 'error');
  },

  // ---------- 清单 ----------
  update(state) {
    // 开机那一趟：把 state.json 里记的「哪一档、哪个页签」捡回来。只认第一次，
    // 之后他自己点的那一档不能被下一次 config.save 抹回磁盘上的旧值。
    if (!this.restored) {
      this.restored = true;
      const saved = state?.video;
      const source = saved?.source === 'bili' ? 'bili' : 'local';
      const section = this.SECTIONS.some((item) => item.id === saved?.section) ? saved.section : this.bili.section;
      const changed = source !== this.source || section !== this.bili.section;
      this.source = source;
      this.bili.section = section;
      if (changed) {
        this.syncControls();
        this.repaint();
      }
      if (source === 'bili') this.loadBili();
    }

    const cfg = state?.config?.video || {};
    const folder = cfg.folder || '';
    if (folder === this.folder) return;
    this.folder = folder;
    this.index = -1;
    this.rescan();
  },

  async rescan() {
    if (!this.folder) {
      this.clips = [];
      this.error = null;
      this.repaint();
      return;
    }
    this.busy = true;
    this.renderHead();
    const result = await TB.api.video.scan(this.folder);
    this.busy = false;
    this.clips = result.clips || [];
    this.error = result.error || null;
    if (!this.clips.length && this.error) TB.app.toast(this.error, 'warn');
    this.restore();
    this.repaint();
  },

  // 原生对话框选目录 → 主进程已经写回 toolbar.config.json，这里再走一次 config.save 让渲染层跟着换配置
  async pickFolder() {
    const picked = await TB.api.video.pickFolder();
    if (!picked) return;
    const result = await TB.api.config.save({ video: { folder: picked } });
    if (!result?.config) {
      TB.app.toast(`保存配置失败：${result?.error || '未知错误'}`, 'error');
      return;
    }
    TB.app.applyConfigResult(result);
    // 换新文件夹通常已经由 applyConfigResult → renderAll → update() 触发过重扫，
    // 这里只兜「那一趟没走到本组件」（比如这一格当时没在画面上）的情况，否则一次选目录扫两遍
    if (picked !== this.folder) this.rescan();
    TB.app.toast(`已加载视频文件夹 ${picked}`);
  },

  reveal() {
    const clip = this.clips[this.index];
    if (!clip) {
      TB.app.toast('先点一行开始播，才能定位到那个文件', 'warn');
      return;
    }
    TB.api.dock.reveal(clip.path);
  },

  // ---------- B 站：取数据 ----------
  // 只问主进程要行数据，一行都不出网（CSP 的 connect-src 本来也不允许这里发请求）。
  async loadBili(force) {
    const b = this.bili;
    b.busy = true;
    this.renderHead();
    this.renderList();
    const res = await TB.api.bili.list(b.section, { force: Boolean(force), folderId: b.folder?.folderId ?? null });
    b.busy = false;
    b.section = res.section || b.section;
    // 主进程会把不认识的 folderId 归零，这里跟着它落的真值走，别自己记一套
    const fid = Number(res.folderId) || 0;
    b.folder = fid ? { folderId: fid, title: fid === b.folder?.folderId ? b.folder.title : `收藏夹 ${fid}` } : null;
    b.rows = res.rows || [];
    b.error = res.error || null;
    b.total = Number(res.total) || b.rows.length;
    b.loaded = true;
    this.renderTabs();
    this.repaint();
    if (b.error) TB.app.toast(b.error, 'warn');
    this.fetchAccount();
  },

  // 账号名只进内存：写进 state.json 就等于把「谁在看」落到磁盘上，这一格用不着
  fetchAccount() {
    if (this.bili.account !== null) return;
    TB.api.bili
      .status()
      .then((st) => {
        this.bili.account = st?.logged ? st.uname || String(st.mid || '') : '';
        this.renderLine();
      })
      .catch(() => {});
  },

  sectionName(id) {
    return this.SECTIONS.find((item) => item.id === id)?.name || id;
  },

  setSection(id) {
    // 已经在这一档的顶层才忽略重复点击；正在夹子里时，点当前页签等于退回夹子列表
    if (id === this.bili.section && !this.bili.folder) return;
    this.bili.section = id;
    this.bili.folder = null;
    this.renderTabs();
    TB.api.video.save(this.snapshot());
    this.loadBili();
  },

  backToFolders() {
    this.bili.folder = null;
    this.renderTabs();
    this.loadBili();
  },

  async clickBili(row) {
    if (row.kind === 'folder') {
      // 「我的收藏」这一层列的是夹子，点进去才列视频——一层导航，不是第二个入口
      this.bili.folder = row;
      this.bili.rows = [];
      this.renderTabs();
      this.loadBili();
      return;
    }
    // 只把主进程这次发出去的那一行 id 递回去，地址由它自己拼
    const res = await TB.api.bili.open(row.id);
    if (res?.ok) TB.app.toast(res.toast);
    else TB.app.toast(res?.error || '没交给浏览器', 'error');
  },

  // ---------- 播放 ----------
  play(index) {
    const clip = this.clips[index];
    if (!clip) return;
    this.index = index;
    this.error = null;
    this.pendingResume = 0;
    this.el.src = clip.url;
    this.el.play().catch(() => {});
    this.renderList();
    this.renderLine();
    this.persist();
    this.list.querySelector('.vd-item.active')?.scrollIntoView({ block: 'nearest' });
  },

  // 换文件夹后按 id 找回上次那条：只把画面定位到那一秒，不自动开播
  // （开机就自己放视频，比音乐更容易吵到人）
  restore() {
    const saved = TB.app.state.video;
    const index = this.clips.findIndex((clip) => clip.id === saved?.clipId);
    if (index < 0) return;
    this.index = index;
    this.el.src = this.clips[index].url;
    // 元数据到手之前设 currentTime 会被 Chromium 忽略，所以先记着，loadedmetadata 里再用一次
    this.pendingResume = Number.isFinite(saved?.position) ? saved.position : 0;
  },

  applyResume() {
    if (!this.pendingResume) return;
    const seconds = this.el.duration > this.pendingResume + 1 ? this.pendingResume : 0;
    this.pendingResume = 0;
    if (seconds > 0) {
      this.el.currentTime = seconds;
      this.el.pause();
      TB.app.toast(`上次看到 ${this.clock(seconds)}，已回到那一处`);
    }
    this.renderLine();
  },

  clock(seconds) {
    if (!Number.isFinite(seconds)) return '--:--';
    const total = Math.floor(seconds);
    const pad = (n) => String(n).padStart(2, '0');
    return total >= 3600 ? `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}` : `${Math.floor(total / 60)}:${pad(total % 60)}`;
  },

  // ---------- 重绘 ----------
  repaint() {
    this.renderHead();
    this.renderList();
    this.renderLine();
  },

  renderHead() {
    if (!this.count) return;
    if (this.source === 'bili') return this.renderBiliHead();
    if (this.busy) {
      this.count.textContent = '扫描中…';
      return;
    }
    if (!this.folder) this.count.textContent = '没设置文件夹';
    else if (this.error) this.count.textContent = '没扫到';
    else this.count.textContent = `${this.clips.length} 个文件`;
    this.count.title = this.folder || '点右上「选文件夹」挑一个本地目录';
    this.revealBtn.classList.toggle('on', this.index >= 0);
  },

  renderList() {
    if (!this.list) return;
    this.list.innerHTML = '';
    if (this.source === 'bili') return this.renderBiliList();
    if (!this.clips.length) {
      const hint = this.error || (this.folder ? '这个文件夹里没有支持的视频' : '还没选视频文件夹');
      this.list.appendChild(TB.util.el('div', { class: 'vd-none muted', text: hint }));
      return;
    }
    this.clips.forEach((clip, index) => {
      this.list.appendChild(
        TB.util.el(
          'button',
          {
            class: `vd-item${index === this.index ? ' active' : ''}`,
            title: `${clip.path}\n${TB.util.bytes(clip.size)} · ${clip.ext.toUpperCase()}`,
            onclick: () => this.play(index)
          },
          [
            TB.util.el('span', { class: 'vd-item-name', text: clip.title }),
            TB.util.el('span', { class: 'vd-item-tag', text: clip.ext.toUpperCase() })
          ]
        )
      );
    });
  },

  renderLine() {
    if (!this.line) return;
    if (this.source === 'bili') return this.renderBiliLine();
    const clip = this.clips[this.index];
    this.line.classList.toggle('err', Boolean(this.error));
    this.line.textContent = this.error
      ? this.error
      : clip
        ? `${clip.title} · ${this.clock(this.el?.currentTime)} / ${Number.isFinite(this.el?.duration) ? this.clock(this.el.duration) : '--:--'} · ${TB.util.bytes(clip.size)}`
        : this.folder
          ? '右边点一行开始播'
          : '点右上「选文件夹」挑一个本地目录，扫出来的排在右边';
    this.line.title = clip?.path || '';
  },

  // ---------- B 站那一档怎么画 ----------
  // 行类和本地那套 .vd-item 分开（bl-*）：两档在同一格里长得不一样，
  // 探针也能按类名各自数各自的行，不用先判断当前是哪档。
  renderBiliHead() {
    const b = this.bili;
    if (b.busy) {
      this.count.textContent = '加载中…';
      return;
    }
    if (b.error) this.count.textContent = '没拿到';
    else this.count.textContent = `${b.rows.length} 条`;
    this.count.title = b.error || `B 站 · ${this.sectionName(b.section)}${b.folder ? ` / ${b.folder.title}` : ''}`;
  },

  renderTabs() {
    if (!this.tabs) return;
    this.tabs.innerHTML = '';
    for (const item of this.SECTIONS) {
      this.tabs.appendChild(
        TB.util.el('button', {
          class: `bl-tab${item.id === this.bili.section ? ' on' : ''}`,
          text: item.name,
          onclick: () => this.setSection(item.id)
        })
      );
    }
    // 进了夹子才出现的退路，固定排在页签行最右边：不用先把列表滚回顶上才能退出这一层
    if (this.bili.folder) {
      this.tabs.appendChild(
        TB.util.el('button', { class: 'bl-tab bl-back', text: '← 收藏夹列表', title: `退出「${this.bili.folder.title}」`, onclick: () => this.backToFolders() })
      );
    }
  },

  renderBiliList() {
    const b = this.bili;
    if (!b.rows.length) {
      const hint = b.error || (b.folder ? '这个收藏夹是空的' : `「${this.sectionName(b.section)}」里还没有东西`);
      const none = TB.util.el('div', { class: 'vd-none muted', text: hint });
      // 两类 cookie 问题（没填 / 过期）主进程都提了 SESSDATA，直接给一个跳到那张卡片的口子
      if (/SESSDATA/.test(hint)) {
        none.appendChild(TB.util.el('button', { class: 'link-btn', text: '去设置填 →', onclick: () => TB.settings.open('bili') }));
      }
      this.list.appendChild(none);
      return;
    }
    for (const row of b.rows) this.list.appendChild(this.biliRow(row));
  },

  biliRow(row) {
    const isFolder = row.kind === 'folder';
    const meta = [];
    if (isFolder) meta.push(`${row.count} 个`);
    else if (row.up) meta.push(row.up);
    if (!isFolder && row.duration) meta.push(this.clock(row.duration));
    if (row.seenAt) meta.push(`看到 ${this.clock(row.seenAt)}`);
    return TB.util.el(
      'button',
      {
        class: `bl-item${isFolder ? ' bl-folder' : ''}`,
        title: `${row.title}\n${isFolder ? '点开看这个收藏夹里的视频' : '交给浏览器打开这个页面'}`,
        onclick: () => this.clickBili(row)
      },
      [
        this.thumb(row.cover),
        TB.util.el('span', { class: 'bl-main' }, [
          TB.util.el('span', { class: 'bl-title', text: row.title }),
          TB.util.el('span', { class: 'bl-meta muted', text: meta.join(' · ') || (isFolder ? '空收藏夹' : '') })
        ]),
        TB.util.el('span', { class: 'bl-mark', text: isFolder ? '▸' : '↗' })
      ]
    );
  },

  // 封面是 https 的图片地址，CSP 的 img-src 本来就放了 https:，不用改那一行。
  // 挂了就把 <img> 摘掉，留一块深色：整行看着像报错而其实只是 CDN 要 Referer，最难查。
  thumb(cover) {
    const box = TB.util.el('span', { class: 'bl-cover' });
    if (!cover) return box;
    const img = TB.util.el('img', { class: 'bl-img', src: cover, loading: 'lazy', decoding: 'async', alt: '' });
    img.addEventListener('error', () => img.remove());
    box.appendChild(img);
    return box;
  },

  renderBiliLine() {
    const b = this.bili;
    this.line.classList.toggle('err', Boolean(b.error));
    this.line.textContent = b.error
      ? b.error
      : `点一行交给浏览器打开${b.account ? ` · ${b.account}` : ''}${b.total > b.rows.length ? `（这里列 ${b.rows.length} / 共 ${b.total}）` : ''}`;
    this.line.title = b.error || '';
  },

  // ---------- 记忆 ----------
  // 往 state.json 里写的那一串。source / section 必须一起带上：store.set('video', …)
  // 是整块替换，漏一个下次开机就回到默认值。
  snapshot() {
    return {
      source: this.source,
      section: this.bili.section,
      clipId: this.clips[this.index]?.id ?? null,
      position: this.el?.currentTime || 0,
      volume: this.el?.volume,
      muted: this.el?.muted
    };
  },

  persist() {
    this.lastQueued = Date.now();
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.lastSaved = Date.now();
      TB.api.video.save(this.snapshot());
    }, 600);
  }
};

TB.register({
  id: 'video',
  name: '视频（本地文件夹 / B站列表）',
  cls: 'area video-area',
  build: () => TB.util.el('div', { id: 'video' }),
  init: (node) => TB.video.init(node),
  update: (state) => TB.video.update(state)
});
