// 情绪标签协议：模型在回复最前面输出 [开心] 之类的前缀，主进程落库前剥掉，渲染层流式期间临时遮蔽。
// 两处必须走同一套规则，否则带标签的历史会被回传给模型、模型开始模仿。
// 需求见 docs/ai-pet-panel.md §3–§4。
//
// 这个文件放在 renderer 目录下用 <script> 加载（CSP 是 script-src 'self'，跨目录引脚本不稳），
// 同时被 src/main/services/ai.js 直接 require —— 所以写成 UMD，两头都能拿。

(function (global) {
  const EMOTIONS = ['开心', '平静', '好奇', '困', '生气', '难过'];
  const DEFAULT_EMOTION = '平静';
  const MOOD_BY_EMOTION = {
    开心: 'happy',
    平静: 'calm',
    好奇: 'curious',
    困: 'sleepy',
    生气: 'angry',
    难过: 'sad'
  };

  // 只认开头的一个方括号词。排除数字，避免把 `[1] 参考文献` 这类正文当成标签吃掉。
  const EMOTION_RE = /^\s*[[【]([^[\]【】\d]{1,6})[\]】]\s*/;
  // 流式被切断时可能只到 `[开` —— 这时先别把半截标签画出来。
  const EMOTION_OPEN_RE = /^\s*[[【][^[\]【]]{0,6}$/;

  function splitLeading(text) {
    const raw = String(text || '');
    const matched = raw.match(EMOTION_RE);
    if (!matched) return { emotion: DEFAULT_EMOTION, content: raw, tagged: false, pending: EMOTION_OPEN_RE.test(raw) };
    const label = matched[1].trim();
    return {
      emotion: EMOTIONS.includes(label) ? label : DEFAULT_EMOTION,
      content: raw.slice(matched[0].length),
      tagged: true,
      pending: false
    };
  }

  function moodOf(emotion) {
    return MOOD_BY_EMOTION[emotion] || 'calm';
  }

  const PROTOCOL =
    '\n每次回复的最前面加一个方括号情绪标签，只能从 [开心] [平静] [好奇] [困] [生气] [难过] 里选一个，标签后直接接正文。例：[开心] 你回来啦。';

  const emotion = { EMOTIONS, DEFAULT_EMOTION, MOOD_BY_EMOTION, EMOTION_RE, EMOTION_OPEN_RE, PROTOCOL, splitLeading, moodOf };

  global.TB = global.TB || {};
  global.TB.emotion = emotion;
  if (typeof module !== 'undefined' && module.exports) module.exports = emotion;
})(typeof window !== 'undefined' ? window : globalThis);
