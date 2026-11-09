import { loadAwareTimeoutMs } from '../../src/load-aware-timeout.mjs';

export function loadModel(multiplier) {
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 6) throw Error('load must be x1..x6');
  return {
    multiplier,
    timeout: nominal => loadAwareTimeoutMs(nominal, { loadAvg1m: 1 + (multiplier - 1) * 2 / 5,
      cpuCount: 1, cpuBusyPercent: 100, maxMultiplier: 6, enabled: true, maxMs: nominal * 6 }),
  };
}

// Stable FIFO ties, seeded latency jitter; no wall time, timers or host load.
export class Clock {
  now = 0;
  queue = [];
  sequence = 0;
  constructor(seed = 1) { this.seed = seed >>> 0; }
  random() {
    this.seed = (Math.imul(1664525, this.seed) + 1013904223) >>> 0;
    return this.seed / 2 ** 32;
  }
  at(at, label, run) {
    if (at < this.now) throw Error('event in the past');
    this.queue.push({ at, label, run, order: this.sequence++ });
  }
  async run(after) {
    while (this.queue.length) {
      this.queue.sort((a, b) => a.at - b.at || a.order - b.order);
      const event = this.queue.shift();
      this.now = event.at;
      await event.run();
      await after(event.label);
    }
  }
  iso() { return new Date(Date.UTC(2030, 0, 1) + this.now).toISOString(); }
}
