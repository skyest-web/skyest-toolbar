/* 蓝毛小女仆：移植 dsh-pet（MIT，见 assets/pet/LICENSE.dsh-pet.txt）的精灵播放器。
   只搬它的双 <video> 交叉淡入淡出，桌面几何/拖拽物理/随机整活链一概不要。 */
(function (global) {
  const BASE = 'assets/pet/';
  const IDLE = '待机呼吸休闲';
  const TALK = '工作状态-忙碌点按';
  // 情绪 → 一次性动作，播完自动回待机循环；没列出来的（平静）直接挂待机
  const MOOD_CLIP = {
    happy: '点击回应-开心跃动',
    curious: '东张西望',
    sleepy: '哈欠连天',
    angry: '点击回应-傲娇生气',
    sad: '工作状态-垂头叹气冒汗',
    error: '被吓一跳'
  };

  // 点一下的本地反应池：不请求 API、不烧 token，播完照样回待机
  const REACT = ['点击回应-元气挥手', '点击回应-害羞惊讶', '点击回应-挠痒咯咯笑', '点击回应-开心跃动', '点击回应-傲娇生气'];

  const STYLE = `
.pet-video-host { position: relative; overflow: hidden; }
.pet-video-host video.pet-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .18s ease; pointer-events: none; }
.pet-video-host video.pet-video.is-front { opacity: 1; }
`;
  let injected = false;

  function url(name) {
    return BASE + encodeURIComponent(name) + '.webm';
  }

  function makeVideo() {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.className = 'pet-video';
    v.disablePictureInPicture = true;
    return v;
  }

  function targetClip(h) {
    if (h.talk) return { name: TALK, loop: true };
    const once = MOOD_CLIP[h.mood];
    return once ? { name: once, loop: false } : { name: IDLE, loop: true };
  }

  // 交叉淡入淡出：新片段先装进后台那条，等 loadeddata 再换前台，避免黑帧
  function play(h, name, loop) {
    if (h.current === name && h.loop === loop && h.front.classList.contains('is-front')) return;
    h.current = name;
    h.loop = loop;
    h.seq += 1;
    const seq = h.seq;
    const next = h.vids.find((v) => v !== h.front) || h.vids[0];
    const prev = h.front;
    next.loop = loop;
    next.onended = () => {
      if (seq !== h.seq) return;
      // 表情片段播完一律回待机；换表情由 apply() 重新触发，不能在这里按 mood 反查
      // （反查会拿到刚播完的那段，被 current 去重挡掉，宠物就定格在最后一帧）
      play(h, h.talk ? TALK : IDLE, true);
    };
    next.src = url(name);
    const reveal = () => {
      if (seq !== h.seq) return;
      next.classList.add('is-front');
      prev.classList.remove('is-front');
      prev.pause();
      h.front = next;
      resume(h);
    };
    if (next.readyState >= 2) reveal();
    else next.addEventListener('loadeddata', reveal, { once: true });
  }

  function resume(h) {
    if (h.paused) return;
    const v = h.front;
    if (v && v.src) v.play().catch(() => {});
  }

  function mount(host, options = {}) {
    if (!injected) {
      const style = document.createElement('style');
      style.textContent = STYLE;
      document.head.appendChild(style);
      injected = true;
    }
    host.classList.add('pet-video-host');
    host.innerHTML = '';
    const vids = [makeVideo(), makeVideo()];
    host.append(...vids);
    const h = { host, vids, front: vids[0], current: null, loop: null, seq: 0, mood: 'calm', talk: false, paused: false };
    host.dataset.mood = 'calm';
    apply(h, options);
    return h;
  }

  function apply(h, options = {}) {
    h.mood = options.mood || 'calm';
    h.talk = Boolean(options.talk);
    h.paused = (options.motion || 'full') === 'off';
    h.host.dataset.mood = h.mood;
    h.host.dataset.motion = h.paused ? 'off' : 'on';
    const clip = targetClip(h);
    play(h, clip.name, clip.loop);
    // motion:'off' 是唯一真省 CPU 的档位——定格当前帧，不再解码
    if (h.paused) h.vids.forEach((v) => v.pause());
    else resume(h);
    return h;
  }

  function react(h) {
    const pool = REACT.filter((n) => n !== h.current);
    play(h, pool[Math.floor(Math.random() * pool.length)] || REACT[0], false);
    return h;
  }

  global.TB = global.TB || {};
  global.TB.petVideo = { mount, apply, react, MOOD_CLIP, IDLE, TALK };
})(typeof window !== 'undefined' ? window : globalThis);
