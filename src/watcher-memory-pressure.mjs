import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ELEVATED_AVAILABLE_MB = 2048;
const CRITICAL_AVAILABLE_MB = 1024;
const ELEVATED_SWAP_USED_PCT = 85.0;
const CRITICAL_SWAP_USED_PCT = 95.0;
const PROJECTED_HEADROOM_FLOOR_MB = 1024;

const PAGE_SIZE_RE = /page size of (\d+) bytes/i;
const VM_STAT_LINE_RE = /^([^:]+):\s+([0-9.]+)\.?$/;
const SWAP_FIELD_RE = /\b(total|used|free)\s*=\s*([0-9.]+)([KMG])/gi;

const REVIEWER_PEAK_MEMORY_MB = Object.freeze({
  codex: 1024,
  'claude-code': 512,
  'clio-agent': 512,
  claude: 512,
  gemini: 512,
});

function utcNowIso() {
  return new Date().toISOString();
}

function mbFromUnit(value, unit) {
  const amount = Number.parseFloat(value);
  const normalized = String(unit || '').toUpperCase();
  if (normalized === 'K') return amount / 1024;
  if (normalized === 'G') return amount * 1024;
  return amount;
}

function parseVmStat(vmStat) {
  const pageSizeMatch = PAGE_SIZE_RE.exec(String(vmStat || ''));
  if (!pageSizeMatch) {
    throw new Error('vm_stat missing page size');
  }
  const pageSize = Number.parseInt(pageSizeMatch[1], 10);
  const counters = new Map();
  for (const rawLine of String(vmStat || '').split(/\r?\n/)) {
    const match = VM_STAT_LINE_RE.exec(rawLine.trim());
    if (!match) continue;
    counters.set(match[1].trim().toLowerCase(), Number.parseInt(match[2].replace(/\./g, ''), 10));
  }
  const freePages = counters.get('pages free');
  if (!Number.isFinite(freePages)) {
    throw new Error('vm_stat missing Pages free');
  }
  const inactivePages = counters.get('pages inactive') || 0;
  const speculativePages = counters.get('pages speculative') || 0;
  const availablePages = freePages + inactivePages + speculativePages;
  const compressorPages = counters.get('pages occupied by compressor') || 0;
  return {
    freePages,
    freeMb: Math.floor((freePages * pageSize) / (1024 * 1024)),
    availablePages,
    availableMb: Math.floor((availablePages * pageSize) / (1024 * 1024)),
    compressorPages,
  };
}

function parseSwapusage(swapusage) {
  const fields = new Map();
  for (const match of String(swapusage || '').matchAll(SWAP_FIELD_RE)) {
    fields.set(match[1].toLowerCase(), mbFromUnit(match[2], match[3]));
  }
  const totalMb = fields.get('total') || 0;
  const usedMb = fields.get('used') || 0;
  return {
    swapUsedMb: Math.trunc(usedMb),
    swapUsedPct: totalMb > 0 ? (usedMb / totalMb) * 100 : 0,
  };
}

function pressureLevelFor({ availableMb, swapUsedPct }) {
  if (availableMb < CRITICAL_AVAILABLE_MB || swapUsedPct > CRITICAL_SWAP_USED_PCT) {
    return 'critical';
  }
  if (availableMb < ELEVATED_AVAILABLE_MB || swapUsedPct > ELEVATED_SWAP_USED_PCT) {
    return 'elevated';
  }
  return 'nominal';
}

function parseMemoryPressureSample({ vmStat, swapusage, sampledAt = utcNowIso() } = {}) {
  const vm = parseVmStat(vmStat);
  const swap = parseSwapusage(swapusage);
  const pressureLevel = pressureLevelFor({
    availableMb: vm.availableMb,
    swapUsedPct: swap.swapUsedPct,
  });
  return {
    freePages: vm.freePages,
    freeMb: vm.freeMb,
    availablePages: vm.availablePages,
    availableMb: vm.availableMb,
    compressorPages: vm.compressorPages,
    swapUsedMb: swap.swapUsedMb,
    swapUsedPct: swap.swapUsedPct,
    pressureLevel,
    sampledAt,
  };
}

async function readMemoryPressureSample({
  execFileImpl = execFileAsync,
  platform = process.platform,
  sampledAt = utcNowIso(),
} = {}) {
  if (platform !== 'darwin') {
    throw new Error('Memory pressure sampling is Darwin-only');
  }
  const [vmStat, swapusage] = await Promise.all([
    execFileImpl('vm_stat', [], { timeout: 5_000 }),
    execFileImpl('sysctl', ['vm.swapusage'], { timeout: 5_000 }),
  ]);
  return parseMemoryPressureSample({
    vmStat: vmStat?.stdout || '',
    swapusage: swapusage?.stdout || '',
    sampledAt,
  });
}

function peakReviewerMemoryMbFor(reviewerModel) {
  const normalized = String(reviewerModel || '').toLowerCase();
  for (const [needle, mb] of Object.entries(REVIEWER_PEAK_MEMORY_MB)) {
    if (normalized.includes(needle)) return mb;
  }
  return 256;
}

function decideReviewerMemoryAdmission({
  sample,
  reviewerModel,
  reservedMb = 0,
  estimatedReviewerRssMb = peakReviewerMemoryMbFor(reviewerModel),
  projectedHeadroomFloorMb = PROJECTED_HEADROOM_FLOOR_MB,
} = {}) {
  if (!sample) {
    return {
      admit: true,
      reason: null,
      sample: null,
      projectedHeadroomMb: null,
      reservedMb: Math.max(0, Number(reservedMb) || 0),
    };
  }
  const availableMb = Number.isFinite(Number(sample.availableMb))
    ? Math.trunc(Number(sample.availableMb))
    : Math.trunc(Number(sample.freeMb) || 0);
  const pressureLevel = String(sample.pressureLevel || sample.pressure_level || 'unknown');
  const swapUsedPct = Number(sample.swapUsedPct ?? sample.swap_used_pct ?? 0);
  if (pressureLevel === 'critical') {
    return {
      admit: false,
      reason: 'memory_pressure_critical',
      sample,
      projectedHeadroomMb: null,
      availableMb,
      swapUsedPct,
      estimatedReviewerRssMb,
      reservedMb: Math.max(0, Number(reservedMb) || 0),
    };
  }
  const projectedHeadroomMb = availableMb - Math.max(0, Number(reservedMb) || 0) - estimatedReviewerRssMb;
  if (projectedHeadroomMb < projectedHeadroomFloorMb) {
    return {
      admit: false,
      reason: 'memory_pressure_projected_headroom_low',
      sample,
      projectedHeadroomMb,
      availableMb,
      swapUsedPct,
      estimatedReviewerRssMb,
      reservedMb: Math.max(0, Number(reservedMb) || 0),
    };
  }
  return {
    admit: true,
    reason: null,
    sample,
    projectedHeadroomMb,
    availableMb,
    swapUsedPct,
    estimatedReviewerRssMb,
    reservedMb: Math.max(0, Number(reservedMb) || 0),
  };
}

async function checkReviewerMemoryAdmission(options = {}) {
  const {
  reviewerModel,
  reservedMb = 0,
  execFileImpl = execFileAsync,
  platform = process.platform,
  logger = console,
  sample = null,
  } = options;
  const hasInjectedSample = Object.prototype.hasOwnProperty.call(options, 'sample');
  try {
    const pressureSample = hasInjectedSample
      ? sample
      : await readMemoryPressureSample({ execFileImpl, platform });
    return decideReviewerMemoryAdmission({
      sample: pressureSample,
      reviewerModel,
      reservedMb,
    });
  } catch (err) {
    logger?.warn?.(
      `[watcher] memory pressure gate unavailable; admitting by legacy policy: ${err?.message || err}`
    );
    return {
      admit: true,
      reason: 'memory_pressure_unavailable',
      sample: null,
      projectedHeadroomMb: null,
      unavailable: true,
      error: err,
    };
  }
}

export {
  CRITICAL_AVAILABLE_MB,
  CRITICAL_SWAP_USED_PCT,
  ELEVATED_AVAILABLE_MB,
  ELEVATED_SWAP_USED_PCT,
  PROJECTED_HEADROOM_FLOOR_MB,
  checkReviewerMemoryAdmission,
  decideReviewerMemoryAdmission,
  parseMemoryPressureSample,
  peakReviewerMemoryMbFor,
  pressureLevelFor,
  readMemoryPressureSample,
};
