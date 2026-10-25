// 生成 samples/demo 下的演示音频与歌词，用来在没有曲库时验证播放器链路。
// 用法：node tools/make-demo-audio.js
const fs = require('node:fs');
const path = require('node:path');

const RATE = 44100;
const SECONDS_PER_BEAT = 0.9;
const OUT_DIR = path.resolve(__dirname, '..', 'samples', 'demo');

function midiToHz(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

function renderTrack(notes) {
  const total = notes.reduce((sum, note) => sum + note.beats, 0);
  const seconds = total * SECONDS_PER_BEAT;
  const frames = Math.floor(RATE * seconds);
  const samples = new Float32Array(frames);
  let start = 0;
  for (const note of notes) {
    const length = Math.floor(note.beats * SECONDS_PER_BEAT * RATE);
    const freq = midiToHz(note.midi);
    for (let i = 0; i < length && start + i < frames; i += 1) {
      const t = i / RATE;
      const env = Math.min(1, i / 900) * Math.exp(-1.1 * t);
      // 基频 + 泛音，让频谱看起来有层次而不是一根线
      const wave = Math.sin(2 * Math.PI * freq * t) + 0.45 * Math.sin(4 * Math.PI * freq * t) + 0.22 * Math.sin(6 * Math.PI * freq * t);
      samples[start + i] += wave * env * 0.32;
    }
    start += length;
  }
  return samples;
}

function writeWav(file, samples) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + samples.length * 2, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(RATE, 24);
  bytes.writeUInt32LE(RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    bytes.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, bytes);
}

function writeLrc(file, lines) {
  fs.writeFileSync(file, `${lines.map(([time, text]) => `[${time}]${text}`).join('\n')}\n`, 'utf8');
}

const scale = [60, 62, 64, 65, 67, 69, 71, 72];
const twice = (notes) => notes.concat(notes.map((note) => ({ ...note })));
const tracks = [
  { file: 'Demo Artist - 晨光序曲', notes: twice(scale.map((midi, i) => ({ midi, beats: i % 4 === 3 ? 2 : 1 })).concat([{ midi: 72, beats: 4 }])) },
  { file: 'Demo Artist - 夜航西行', notes: twice([72, 69, 67, 65, 67, 69, 72, 67].map((midi) => ({ midi, beats: 1.5 }))) },
  { file: '无歌手签名曲', notes: [55, 62, 67, 70, 67, 62, 55, 60].map((midi) => ({ midi, beats: 2 })) }
];

const lyricLines = [
  ['00:00.00', '（前奏）'],
  ['00:03.20', '演示歌词第一行'],
  ['00:07.40', '演示歌词第二行'],
  ['00:11.60', '同目录同名 .lrc 会自动同步'],
  ['00:13.00', '（尾奏）']
];

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const track of tracks) {
  writeWav(path.join(OUT_DIR, `${track.file}.wav`), renderTrack(track.notes));
  writeLrc(path.join(OUT_DIR, `${track.file}.lrc`), lyricLines);
}
console.log(`已生成 ${tracks.length} 个演示文件：${OUT_DIR}`);
