// 猫团子：AI 面板宠物的素材与状态机。
// 形象定稿见 docs/ai-pet-panel.md §5 —— 团子身形 + 一对静态三角耳（可压成飞机耳），不做尾巴和四肢。
// 素材与它的 keyframes 放在一起：换宠物 = 换掉这个文件，组件代码不动。

(function (global) {
  const SVG = `
<svg class="pet" viewBox="0 0 120 124" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g class="pet-anim">
    <g class="pet-shadow"><ellipse cx="60" cy="115" rx="30" ry="4"/></g>

    <g class="pet-bubble">
      <path d="M84 8 h44 a8 8 0 0 1 8 8 v22 a8 8 0 0 1 -8 8 h-26 l-8 8 v-8 h-10 a8 8 0 0 1 -8 -8 v-22 a8 8 0 0 1 8 -8 z"/>
    </g>

    <g class="pet-body-wrap">
      <g class="pet-ears">
        <path class="pet-ear pet-ear-l" d="M34 36 L27 11 L52 24 Z"/>
        <path class="pet-ear pet-ear-r" d="M86 36 L93 11 L68 24 Z"/>
        <path class="pet-ear-in in-l" d="M36 33 L32 18 L47 26 Z"/>
        <path class="pet-ear-in in-r" d="M84 33 L88 18 L73 26 Z"/>
      </g>

      <path class="pet-body" d="M60 24 C84 24 99 43 99 65 C99 89 82 104 60 104 C38 104 21 89 21 65 C21 43 36 24 60 24 Z"/>
      <path class="pet-belly" d="M60 62 C74 62 84 74 84 87 C84 98 73 104 60 104 C47 104 36 98 36 87 C36 74 46 62 60 62 Z"/>

      <g class="pet-blush">
        <ellipse cx="35" cy="72" rx="6" ry="3.4"/>
        <ellipse cx="85" cy="72" rx="6" ry="3.4"/>
      </g>

      <g class="pet-brows">
        <path class="pet-brow brow-l" d="M37 51 L52 48"/>
        <path class="pet-brow brow-r" d="M83 51 L68 48"/>
      </g>

      <g class="pet-eyes">
        <g class="eye-open">
          <circle cx="46" cy="64" r="6.4"/>
          <circle cx="74" cy="64" r="6.4"/>
          <circle class="eye-shine" cx="48.2" cy="61.6" r="2"/>
          <circle class="eye-shine" cx="76.2" cy="61.6" r="2"/>
        </g>
        <g class="eye-happy">
          <path d="M37 66 Q46 58.5 55 66"/>
          <path d="M65 66 Q74 58.5 83 66"/>
        </g>
        <g class="eye-sad">
          <circle cx="46" cy="66" r="5.4"/>
          <circle cx="74" cy="66" r="5.4"/>
          <path class="lid" d="M39 61 Q46 57 53 62"/>
          <path class="lid" d="M81 61 Q74 57 67 62"/>
        </g>
      </g>

      <g class="pet-mouth">
        <path class="mouth mouth-calm" d="M54 79 Q60 83 66 79"/>
        <path class="mouth mouth-smile" d="M51 77 Q60 88 69 77"/>
        <path class="mouth mouth-frown" d="M52 85 Q60 77 68 85"/>
        <path class="mouth mouth-wavy" d="M50 81 Q55 77 60 81 Q65 85 70 81"/>
        <ellipse class="mouth-open" cx="60" cy="82" rx="5.4" ry="6.4"/>
      </g>

      <g class="pet-sweat">
        <path d="M92 44 C96 50 97 54 93 56 C89 54 90 48 92 44 Z"/>
      </g>
      <g class="pet-zzz">
        <text x="96" y="30">z</text>
        <text x="104" y="20" class="z2">z</text>
      </g>
      <g class="pet-mark">
        <text x="98" y="26">?</text>
      </g>
      <g class="pet-cloud">
        <path d="M40 16 q-9 0 -9 7 q-7 1 -7 7 q0 6 8 6 h34 q7 0 7 -7 q0 -6 -7 -7 q-1 -6 -9 -6 q-4 -3 -8 0 z"/>
        <path class="bolt" d="M58 44 l-6 10 h5 l-3 9 l9 -12 h-5 l3 -7 z"/>
      </g>
    </g>
  </g>
</svg>`;

  const CSS = `
.pet { display: block; width: 100%; height: 100%; overflow: visible; }
.pet-body { fill: var(--pet-body, #7cc6ff); }
.pet-belly { fill: var(--pet-belly, #d7ecff); opacity: .85; }
.pet-ear { fill: var(--pet-body, #7cc6ff); }
.pet-ear-in { fill: var(--pet-inner, #ffb3c7); }
.pet-shadow ellipse { fill: #000; opacity: .22; }
.pet-bubble path { fill: var(--pet-bubble, #fff); stroke: var(--pet-line, #12233a); stroke-width: 2; }
.pet-bubble { opacity: 0; }
.pet .pet-brows, .pet .pet-blush, .pet .pet-sweat, .pet .pet-zzz, .pet .pet-mark, .pet .pet-cloud,
.pet .eye-happy, .pet .eye-sad, .pet .mouth-smile, .pet .mouth-frown, .pet .mouth-wavy, .pet .mouth-open { display: none; }
.pet .pet-brows path, .pet .pet-eyes path, .pet .pet-mouth path {
  fill: none; stroke: var(--pet-ink, #12233a); stroke-width: 3; stroke-linecap: round;
}
.pet .pet-eyes .eye-open circle { fill: var(--pet-ink, #12233a); }
.pet .pet-eyes .eye-open circle.eye-shine { fill: #fff; }
.pet .pet-sweat path { fill: #8fd3ff; }
.pet .pet-zzz text, .pet .pet-mark text { fill: var(--pet-ink, #12233a); font: bold 15px system-ui, sans-serif; }
.pet .pet-zzz .z2 { font-size: 11px; opacity: .7; }
.pet .pet-cloud path { fill: #5a6a80; stroke: none; }
.pet .pet-cloud .bolt { fill: #ffd75e; }
.pet .pet-blush ellipse { fill: var(--pet-blush, #ff9db1); opacity: .8; }

/* ---- 耳朵：竖 / 飞机耳 ---- */
.pet-ear-l, .pet-ear-r, .in-l, .in-r { transform-box: view-box; transition: transform .22s ease; }
.pet-ear-l, .in-l { transform-origin: 36px 32px; }
.pet-ear-r, .in-r { transform-origin: 84px 32px; }
.pet[data-ears="flat"] .pet-ear-l, .pet[data-ears="flat"] .in-l { transform: rotate(-52deg) scaleY(.8); }
.pet[data-ears="flat"] .pet-ear-r, .pet[data-ears="flat"] .in-r { transform: rotate(52deg) scaleY(.8); }

/* ---- 表情 ---- */
.pet[data-mood="happy"] .eye-open, .pet[data-mood="sleepy"] .eye-open,
.pet[data-mood="sad"] .eye-open { display: none; }
.pet[data-mood="happy"] .eye-happy { display: block; }
.pet[data-mood="sad"] .eye-sad { display: block; }
.pet[data-mood="sleepy"] .eye-open { display: block; transform-box: view-box; transform-origin: 60px 64px; transform: scaleY(.28); }
.pet[data-mood="calm"] .mouth-calm { display: block; }
.pet[data-mood="curious"] .mouth-calm { display: block; }
.pet[data-mood="sleepy"] .mouth-calm { display: block; }
.pet[data-mood="happy"] .mouth-smile { display: block; }
.pet[data-mood="sad"] .mouth-frown { display: block; }
.pet[data-mood="angry"] .mouth-wavy { display: block; }
.pet[data-mood="curious"] .pet-mark { display: block; }
.pet[data-mood="sleepy"] .pet-zzz { display: block; }
.pet[data-mood="error"] .pet-cloud { display: block; }
.pet[data-mood="error"] .mouth-frown { display: block; }
.pet[data-mood="error"] .eye-open { display: none; }
.pet[data-mood="error"] .eye-sad { display: block; }
.pet[data-mood="angry"] .pet-brows, .pet[data-mood="sad"] .pet-brows,
.pet[data-mood="curious"] .pet-brows { display: block; }
.pet[data-mood="angry"] .brow-l { transform: translate(0, 3px) rotate(14deg); }
.pet[data-mood="angry"] .brow-r { transform: translate(0, 3px) rotate(-14deg); }
.pet[data-mood="sad"] .brow-l { transform: translate(0, -2px) rotate(-14deg); }
.pet[data-mood="sad"] .brow-r { transform: translate(0, -2px) rotate(14deg); }
.pet[data-mood="curious"] .brow-l { transform: translate(0, -3px); }
.pet[data-mood="curious"] .brow-r { transform: translate(0, -5px); }
.pet-brow { transform-box: view-box; transform-origin: 60px 50px; }
.pet[data-mood="happy"] .pet-blush { display: block; }
.pet[data-mood="angry"] .pet-sweat, .pet[data-mood="sad"] .pet-sweat { display: block; }
.pet[data-mood="curious"] .pet-body-wrap { transform-box: view-box; transform-origin: 60px 90px; transform: rotate(-6deg); }

/* ---- 说话：嘴部开合，由 ai:delta 驱动 ---- */
.pet[data-talk="on"] .mouth-open { display: block; }
.pet[data-talk="on"] .mouth-calm, .pet[data-talk="on"] .mouth-smile { display: none; }
.pet .mouth-open { transform-box: view-box; transform-origin: 60px 82px; }

/* ---- 三个状态动画：呼吸 / 眨眼 / 说话 ---- */
/* 待机（呼吸+浮动）放在宿主的 transform 上：SVG 内部元素的动画每帧都要重新栅格化，
   实测常驻时渲染进程多吃 ~14% CPU；改成宿主 div 的 transform 后由合成器接管。
   眨眼同理不用 infinite 动画，改由 JS 定时打一下 data-blink，其余时间一帧都不动。 */
@keyframes pet-idle { 0%, 100% { transform: translateY(0) scale(1, 1); } 50% { transform: translateY(-2px) scale(.99, 1.028); } }
@keyframes pet-blink { 0%, 100% { transform: scaleY(1); } 45%, 55% { transform: scaleY(.08); } }
@keyframes pet-talk { 0%, 100% { transform: scaleY(.3); } 50% { transform: scaleY(1); } }
.pet-host { transform-origin: 50% 100%; will-change: transform; }
.pet-body-wrap { transform-box: view-box; transform-origin: 60px 104px; }
.pet-eyes .eye-open { transform-box: view-box; transform-origin: 60px 64px; }
.pet-host[data-motion="full"] { animation: pet-idle 3.6s ease-in-out infinite; }
.pet-host[data-motion="calm"] { animation: pet-idle 7.2s ease-in-out infinite; }
.pet[data-blink="on"] .eye-open { animation: pet-blink .18s ease-in-out; }
.pet[data-talk="on"] .mouth-open { animation: pet-talk .26s ease-in-out infinite; }
.pet[data-motion="off"] *, .pet-host[data-motion="off"] { animation: none !important; }
`;

  const MOODS = ['calm', 'happy', 'curious', 'sleepy', 'angry', 'sad', 'error'];
  const FLAT_EARS = { angry: true, sad: true, error: true };

  let injected = false;

  let blinkTarget = null;

  // 只保留一只会眨眼的宠物：重建 shell 后旧节点脱离文档，它的定时链在下一次触发时自行断掉
  function scheduleBlink(svg, period) {
    setTimeout(() => {
      if (blinkTarget !== svg) return;
      svg.setAttribute('data-blink', 'on');
      setTimeout(() => {
        if (blinkTarget === svg) svg.removeAttribute('data-blink');
        scheduleBlink(svg, period);
      }, 200);
    }, period * (0.55 + Math.random() * 0.9));
  }

  function startBlink(svg, motion) {
    if (motion === 'off') {
      if (blinkTarget === svg) blinkTarget = null;
      return;
    }
    if (blinkTarget === svg) return;
    blinkTarget = svg;
    scheduleBlink(svg, motion === 'calm' ? 9000 : 5200);
  }

  function mount(host, options = {}) {
    if (!injected && typeof document !== 'undefined') {
      const style = document.createElement('style');
      style.textContent = CSS;
      document.head.appendChild(style);
      injected = true;
    }
    host.classList.add('pet-host');
    host.innerHTML = SVG;
    const svg = host.firstElementChild;
    apply(svg, options);
    return svg;
  }

  function apply(svg, options = {}) {
    const mood = MOODS.includes(options.mood) ? options.mood : 'calm';
    const motion = options.motion || 'full';
    svg.setAttribute('data-mood', mood);
    svg.setAttribute('data-ears', options.ears || (FLAT_EARS[mood] ? 'flat' : 'up'));
    svg.setAttribute('data-talk', options.talk ? 'on' : 'off');
    svg.setAttribute('data-motion', motion);
    // 待机动画挂在宿主 div 上，所以 motion 开关要同步过去
    if (svg.parentElement) svg.parentElement.setAttribute('data-motion', motion);
    startBlink(svg, motion);
    return svg;
  }

  // 点一下的反应：临时挤掉当前表情，一段时间后按原样恢复
  function react(svg) {
    const mood = svg.getAttribute('data-mood') || 'calm';
    const motion = svg.getAttribute('data-motion') || 'full';
    apply(svg, { mood: 'happy', motion });
    clearTimeout(svg.reactTimer);
    svg.reactTimer = setTimeout(() => apply(svg, { mood, motion }), 1400);
    return svg;
  }

  const pet = { SVG, CSS, MOODS, mount, apply, react };
  global.TB = global.TB || {};
  global.TB.pet = pet;
  if (typeof module !== 'undefined' && module.exports) module.exports = pet;
})(typeof window !== 'undefined' ? window : globalThis);
