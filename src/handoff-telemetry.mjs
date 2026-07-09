import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const HANDOFF_EVENTS = Object.freeze({
  fired: 'handoff_fired',
  latency: 'handoff_latency_seconds',
  fallbackTickCatch: 'handoff_fallback_tick_catch',
  rateCapHit: 'handoff_rate_cap_hit',
  budgetRefusal: 'handoff_budget_refusal',
});

const EVENT_SET = new Set(Object.values(HANDOFF_EVENTS));
export const HANDOFF_EVENT_DIR_MODE = 0o775;
export const HANDOFF_EVENT_LOG_MODE = 0o664;
const STEP_ORDER = ['review-to-remediation', 'remediation-to-rereview', 'final-to-hammer'];
const STEP_LABELS = Object.freeze({
  'review-to-remediation': 'review->remediation',
  'remediation-to-rereview': 'remediation->re-review',
  'final-to-hammer': 'final->hammer',
});
const STEP_BASELINES = Object.freeze({
  'review-to-remediation': 120,
  'remediation-to-rereview': 300,
  'final-to-hammer': 300,
});
const OWNER_EVENT_SCRIPT = `
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
const eventArgs = process.argv[1] === '[eval]' ? process.argv.slice(2) : process.argv.slice(1);
const [rootDir, rowRaw] = eventArgs;
const row = JSON.parse(rowRaw);
const filePath = join(rootDir, 'data', 'handoff-events', \`\${String(row.at).slice(0, 10)}.jsonl\`);
const dir = dirname(filePath);
mkdirSync(dir, { recursive: true, mode: 0o775 });
try { chmodSync(dir, 0o775); } catch {}
appendFileSync(filePath, \`\${JSON.stringify(row)}\\n\`, { encoding: 'utf8', mode: 0o664 });
try { chmodSync(filePath, 0o664); } catch {}
process.stdout.write(filePath);
`;

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizePrNumber(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeStep(step) {
  const text = normalizeText(step);
  if (!text) return null;
  if (text === 'review_to_remediation') return 'review-to-remediation';
  if (text === 'remediation_to_rereview') return 'remediation-to-rereview';
  if (text === 'final_to_hammer') return 'final-to-hammer';
  return text;
}

function normalizeTimestamp(value = new Date().toISOString()) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`invalid handoff telemetry timestamp: ${value}`);
  return new Date(parsed).toISOString();
}

function normalizeLatencySeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1000) / 1000 : null;
}

export function handoffEventLogDir(rootDir) {
  return join(rootDir, 'data', 'handoff-events');
}

export function handoffEventLogPath(rootDir, timestamp = new Date().toISOString()) {
  return join(handoffEventLogDir(rootDir), `${normalizeTimestamp(timestamp).slice(0, 10)}.jsonl`);
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function resolveCanonicalEventOwnerUid(rootDir) {
  const dir = handoffEventLogDir(rootDir);
  try {
    return statSync(dir).uid;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  try {
    return statSync(join(rootDir, 'data')).uid;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return statSync(rootDir).uid;
}

function resolveUsernameForUid(uid, { spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl('id', ['-un', String(uid)], { encoding: 'utf8' });
  if (result?.status !== 0) {
    const detail = String(result?.stderr || result?.error?.message || '').trim();
    throw new Error(`failed to resolve canonical handoff telemetry owner uid ${uid}${detail ? `: ${detail}` : ''}`);
  }
  const username = String(result.stdout || '').trim();
  if (!username) throw new Error(`failed to resolve canonical handoff telemetry owner uid ${uid}: empty username`);
  return username;
}

function appendHandoffEventNative(filePath, row) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: HANDOFF_EVENT_DIR_MODE });
  try {
    chmodSync(dir, HANDOFF_EVENT_DIR_MODE);
  } catch {
    // Telemetry is best-effort; callers catch write failures on wake paths.
  }
  appendFileSync(filePath, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: HANDOFF_EVENT_LOG_MODE });
  try {
    chmodSync(filePath, HANDOFF_EVENT_LOG_MODE);
  } catch {
    // Existing shared logs may be owned by another daemon user.
  }
}

function appendHandoffEventAsOwner(rootDir, row, ownerUid, { spawnSyncImpl = spawnSync } = {}) {
  const ownerUser = resolveUsernameForUid(ownerUid, { spawnSyncImpl });
  const result = spawnSyncImpl(
    'sudo',
    [
      '-A',
      '-H',
      '-u',
      ownerUser,
      process.execPath,
      '--input-type=module',
      '-e',
      OWNER_EVENT_SCRIPT,
      rootDir,
      JSON.stringify(row),
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  if (result?.status !== 0) {
    const detail = String(result?.stderr || result?.error?.message || '').trim();
    throw new Error(`handoff telemetry owner append failed for ${ownerUser}${detail ? `: ${detail}` : ''}`);
  }
  return { ownerUser, filePath: String(result.stdout || '').trim() || handoffEventLogPath(rootDir, row.at) };
}

export function buildHandoffEvent({
  event,
  at = new Date().toISOString(),
  step = null,
  repo = null,
  prNumber = null,
  pr_number = null,
  headSha = null,
  head_sha = null,
  latencySeconds = null,
  latency_seconds = null,
  source = null,
  target = null,
  reason = null,
  extra = null,
} = {}) {
  if (!EVENT_SET.has(event)) throw new TypeError(`unsupported handoff telemetry event: ${event}`);
  const row = {
    schema_version: 1,
    event,
    at: normalizeTimestamp(at),
    step: normalizeStep(step),
    repo: normalizeText(repo),
    pr_number: normalizePrNumber(prNumber ?? pr_number),
    head_sha: normalizeText(headSha ?? head_sha),
  };
  const latency = normalizeLatencySeconds(latencySeconds ?? latency_seconds);
  if (latency !== null) row.latency_seconds = latency;
  if (source) row.source = normalizeText(source);
  if (target) row.target = normalizeText(target);
  if (reason) row.reason = normalizeText(reason);
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    Object.assign(row, extra);
  }
  return row;
}

export function recordHandoffEvent(
  { rootDir, ...event },
  { spawnSyncImpl = spawnSync, currentUidImpl = currentUid } = {},
) {
  if (!rootDir) return null;
  const row = buildHandoffEvent(event);
  const filePath = handoffEventLogPath(rootDir, row.at);
  const ownerUid = resolveCanonicalEventOwnerUid(rootDir);
  const uid = currentUidImpl();
  if (uid !== null && uid !== ownerUid) {
    const delegated = appendHandoffEventAsOwner(rootDir, row, ownerUid, { spawnSyncImpl });
    return { filePath: delegated.filePath, row, delegated: true, ownerUser: delegated.ownerUser };
  }
  appendHandoffEventNative(filePath, row);
  return { filePath, row };
}

export function recordHandoffWakeEvents({ rootDir, payload = {}, target = null, wokeAt = new Date().toISOString() } = {}) {
  const requestedAt = payload?.requested_at || payload?.requestedAt || null;
  const wokeAtIso = normalizeTimestamp(wokeAt);
  const latencySeconds = requestedAt
    ? Math.max(0, (Date.parse(wokeAtIso) - Date.parse(requestedAt)) / 1000)
    : null;
  const common = {
    rootDir,
    at: wokeAtIso,
    step: payload?.reason || null,
    repo: payload?.repo || null,
    prNumber: payload?.pr_number ?? payload?.prNumber ?? null,
    headSha: payload?.head_sha ?? payload?.headSha ?? payload?.revisionRef ?? null,
    target,
  };
  const fired = recordHandoffEvent({ ...common, event: HANDOFF_EVENTS.fired });
  const latency = latencySeconds === null ? null : recordHandoffEvent({
    ...common,
    event: HANDOFF_EVENTS.latency,
    latencySeconds,
  });
  return { fired, latency };
}

export function parseHandoffWindow(windowText = '24h') {
  const text = String(windowText || '24h').trim();
  const match = /^(\d+)([hd])$/.exec(text);
  if (!match) throw new Error('--window must look like 24h or 7d');
  const amount = Number(match[1]);
  const multiplier = match[2] === 'h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return amount * multiplier;
}

export function parseRepoPr(value) {
  const match = /^([^#]+)#(\d+)$/.exec(String(value || '').trim());
  if (!match) throw new Error('trace target must look like owner/repo#123 or repo#123');
  return { repo: match[1], prNumber: Number(match[2]) };
}

export function readHandoffEvents({
  rootDir,
  since = new Date(Date.now() - parseHandoffWindow('24h')).toISOString(),
  repo = null,
  prNumber = null,
} = {}) {
  const dir = handoffEventLogDir(rootDir);
  if (!existsSync(dir)) return [];
  const sinceMs = Date.parse(since);
  const sinceDate = Number.isFinite(sinceMs) ? normalizeTimestamp(since).slice(0, 10) : null;
  const rows = [];
  for (const name of readdirSync(dir).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
    if (sinceDate && name.slice(0, 10) < sinceDate) continue;
    const filePath = join(dir, name);
    for (const line of readFileSync(filePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        const atMs = Date.parse(row.at);
        if (!Number.isFinite(atMs) || atMs < sinceMs) continue;
        if (repo && row.repo !== repo) continue;
        if (prNumber && row.pr_number !== prNumber) continue;
        rows.push(row);
      } catch {
        // Ignore malformed legacy/manual rows; event shape validation happens
        // at write time for rows emitted by this package.
      }
    }
  }
  return rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

function percentile(values, pct) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return sorted[index];
}

function formatSeconds(value) {
  if (value === null || value === undefined) return 'n/a';
  return `${Number(value).toFixed(1)}s`;
}

function summarizeEnabled({ loadConfigImpl = null } = {}) {
  if (typeof loadConfigImpl !== 'function') return 'unknown';
  try {
    const cfg = loadConfigImpl().getHandoffConfig();
    if (cfg.enabled !== true) return 'OFF';
    const enabled = [];
    if (cfg.reviewToRemediation) enabled.push('review->remediation');
    if (cfg.remediationToRereview) enabled.push('remediation->re-review');
    enabled.push(`final->hammer ${cfg.finalToHammer ? 'ON' : 'OFF'}`);
    return enabled.join(', ');
  } catch {
    return 'unknown';
  }
}

export function collectHandoffStatus({
  rootDir,
  repo = null,
  window = '24h',
  now = () => new Date(),
  loadConfigImpl = null,
} = {}) {
  const since = new Date(now().getTime() - parseHandoffWindow(window)).toISOString();
  const events = readHandoffEvents({ rootDir, since, repo });
  const latencies = events
    .filter((event) => event.event === HANDOFF_EVENTS.latency && Number.isFinite(Number(event.latency_seconds)))
    .map((event) => Number(event.latency_seconds));
  return {
    rootDir,
    repo,
    window,
    enabledSummary: summarizeEnabled({ loadConfigImpl }),
    handoffsFired: events.filter((event) => event.event === HANDOFF_EVENTS.fired).length,
    medianLatencySeconds: percentile(latencies, 50),
    p95LatencySeconds: percentile(latencies, 95),
    fallbackTickCatches: events.filter((event) => event.event === HANDOFF_EVENTS.fallbackTickCatch).length,
    budgetRefusalsPreserved: events.filter((event) => event.event === HANDOFF_EVENTS.budgetRefusal).length,
    rateCapsHit: events.filter((event) => event.event === HANDOFF_EVENTS.rateCapHit).length,
    events,
  };
}

export function renderHandoffStatus(status) {
  return [
    `  HANDOFF MODE  (enabled: ${status.enabledSummary})`,
    '  ------------------------------------------------------------------------',
    `  handoffs fired ............. ${status.handoffsFired}`,
    `  median step latency ........ ${formatSeconds(status.medianLatencySeconds)}      (tick baseline: 120-300s)`,
    `  p95 step latency ........... ${formatSeconds(status.p95LatencySeconds)}`,
    `  fallback-tick catches ...... ${status.fallbackTickCatches}         (wake missed -> timer caught it; safe)`,
    `  budget refusals (preserved). ${status.budgetRefusalsPreserved}         (handoff routed through claimNextFollowUpJob)`,
    `  handoff rate-caps hit ...... ${status.rateCapsHit}`,
    '  ------------------------------------------------------------------------',
    `  kill-switch: ${status.enabledSummary === 'OFF' ? 'off' : 'armed'} (roles.adversarial.handoff.enabled=${status.enabledSummary === 'OFF' ? 'false' : 'true'})`,
    '',
  ].join('\n');
}

function traceOrdinal(step) {
  const index = STEP_ORDER.indexOf(step);
  return index >= 0 ? String.fromCharCode(0x2460 + index) : '?';
}

function timeOfDayUtc(at) {
  return normalizeTimestamp(at).slice(11, 19);
}

export function collectHandoffTrace({ rootDir, target, since = '1970-01-01T00:00:00.000Z' } = {}) {
  const { repo, prNumber } = typeof target === 'string' ? parseRepoPr(target) : target;
  return { repo, prNumber, events: readHandoffEvents({ rootDir, since, repo, prNumber }) };
}

export function renderHandoffTrace(trace) {
  const lines = [];
  const latencyByStepAt = new Map();
  for (const event of trace.events) {
    if (event.event !== HANDOFF_EVENTS.latency) continue;
    latencyByStepAt.set(`${event.step}\0${event.at}`, event.latency_seconds);
  }
  for (const event of trace.events) {
    if (event.event === HANDOFF_EVENTS.latency) continue;
    const step = normalizeStep(event.step);
    if (event.event === HANDOFF_EVENTS.fired) {
      const latency = event.latency_seconds ?? latencyByStepAt.get(`${event.step}\0${event.at}`);
      const baseline = STEP_BASELINES[step] || 300;
      const target = event.target || (step === 'review-to-remediation' ? 'follow-up daemon' : 'watcher');
      lines.push(
        `  ${timeOfDayUtc(event.at)}  |- handoff${traceOrdinal(step)} -> ${target} woke ` +
        `(+${formatSeconds(latency)}, not +${baseline}s)`
      );
    } else if (event.event === HANDOFF_EVENTS.fallbackTickCatch) {
      lines.push(`  ${timeOfDayUtc(event.at)}  fallback tick caught missed ${STEP_LABELS[step] || step || 'handoff'}`);
    } else if (event.event === HANDOFF_EVENTS.rateCapHit) {
      lines.push(`  ${timeOfDayUtc(event.at)}  handoff rate cap hit ${STEP_LABELS[step] || step || ''}`.trimEnd());
    }
  }
  if (lines.length === 0) {
    lines.push(`  no handoff events found for ${trace.repo}#${trace.prNumber}`);
  }
  return `${lines.join('\n')}\n`;
}
