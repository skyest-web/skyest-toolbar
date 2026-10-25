const os = require('node:os');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const IS_WIN = process.platform === 'win32';
const NOT_SUPPORTED = /^(n\/a|not supported|\[not|unknown)$/i;

let lastCpu = null;
let lastNet = null;

function toNumber(value) {
  const num = Number.parseFloat(String(value).trim());
  return Number.isFinite(num) ? num : null;
}

function readCpuLoad() {
  const cpus = os.cpus();
  const total = cpus.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0);
  const idle = cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);
  const sample = { total, idle };
  if (!lastCpu) {
    lastCpu = sample;
    return { percent: null, cores: cpus.map(() => null) };
  }
  const dt = sample.total - lastCpu.total;
  const di = sample.idle - lastCpu.idle;
  const percent = dt > 0 ? (1 - di / dt) * 100 : 0;
  lastCpu = sample;
  return { percent: Math.max(0, Math.min(100, percent)), cores: cpus.map(() => null) };
}

function readMemory() {
  const total = os.totalmem();
  const free = os.freemem();
  return { total, used: total - free, percent: total > 0 ? ((total - free) / total) * 100 : 0 };
}

function readDisk() {
  const drives = IS_WIN ? ['C:\\', 'D:\\'] : ['/'];
  const out = [];
  for (const mount of drives) {
    try {
      const stats = fs.statfsSync(mount);
      const total = stats.blocks * stats.bsize;
      const available = stats.bavail * stats.bsize;
      if (total > 0) out.push({ mount, total, available, used: total - available, percent: ((total - available) / total) * 100 });
    } catch {
      /* drive not present */
    }
  }
  return out;
}

function readGpu() {
  return new Promise((resolve) => {
    if (!IS_WIN) return resolve([]);
    const args = [
      '--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,fan.speed,clocks.sm',
      '--format=csv,noheader,nounits'
    ];
    execFile('nvidia-smi', args, { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const gpus = stdout
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => {
          const [name, temp, util, memUsed, memTotal, power, fan, clock] = line.split(',');
          const clean = (value) => (value && !NOT_SUPPORTED.test(value.trim()) ? toNumber(value) : null);
          return {
            name: (name || '').trim(),
            temperature: clean(temp),
            utilization: clean(util),
            memoryUsedMiB: clean(memUsed),
            memoryTotalMiB: clean(memTotal),
            powerDrawW: clean(power),
            fanPercent: clean(fan),
            clockMHz: clean(clock)
          };
        });
      resolve(gpus);
    });
  });
}

const SLOW_SCRIPT = [
  '$ErrorActionPreference="SilentlyContinue"',
  '$a = Get-NetAdapterStatistics',
  '$rx = ($a | Measure-Object -Property ReceivedBytes -Sum).Sum',
  '$tx = ($a | Measure-Object -Property SentBytes -Sum).Sum',
  '$p = Get-Process | Sort-Object WS -Descending | Select-Object -First 5 Name,WS,CPU | ConvertTo-Json -Compress',
  'if ($p -notlike "[[]*") { $p = "[$p]" }',
  '"{0}|{1}|{2}" -f [int64]$rx, [int64]$tx, $p'
].join('; ');

function readSlowMetrics() {
  return new Promise((resolve) => {
    if (!IS_WIN) return resolve({ net: null, processes: [] });
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', SLOW_SCRIPT],
      { windowsHide: true, timeout: 6000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve({ net: null, processes: [] });
        const line = stdout.trim().split(/\r?\n/).find((row) => row.includes('|'));
        if (!line) return resolve({ net: null, processes: [] });
        const [rx, tx, procsJson] = line.split('|');
        let processes = [];
        try {
          processes = JSON.parse(procsJson).map((proc) => ({
            name: proc.Name,
            memoryBytes: Math.round(Number(proc.WS) || 0),
            cpuSeconds: Number(proc.CPU) || 0
          }));
        } catch {
          processes = [];
        }
        resolve({ netTotals: { rx: Number(rx) || 0, tx: Number(tx) || 0 }, processes });
      }
    );
  });
}

function netRates(totals, now) {
  if (!totals) return null;
  const prev = lastNet;
  lastNet = { ...totals, at: now };
  if (!prev) return { rxPerSec: null, txPerSec: null, rxBytes: totals.rx, txBytes: totals.tx };
  const seconds = Math.max(0.2, (now - prev.at) / 1000);
  return {
    rxPerSec: Math.max(0, (totals.rx - prev.rx) / seconds),
    txPerSec: Math.max(0, (totals.tx - prev.tx) / seconds),
    rxBytes: totals.rx,
    txBytes: totals.tx
  };
}

async function snapshot() {
  const now = Date.now();
  const slow = await readSlowMetrics();
  return {
    at: now,
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    uptimeSeconds: os.uptime(),
    load: readCpuLoad(),
    memory: readMemory(),
    disks: readDisk(),
    gpus: await readGpu(),
    network: netRates(slow.netTotals, now),
    processes: slow.processes,
    cpuCount: os.cpus().length
  };
}

function fastSnapshot() {
  return {
    at: Date.now(),
    load: readCpuLoad(),
    memory: readMemory(),
    cpuCount: os.cpus().length
  };
}

module.exports = { snapshot, fastSnapshot };
