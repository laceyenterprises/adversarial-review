import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_FRESH_MS = 5 * 60 * 1000;
const PAUSE_CLASSIFIER = 'codex_oauth_refresh_failed';

function resolveHqRoot(env = process.env) {
  return resolve(env.HQ_ROOT || join(homedir(), 'agent-os-hq'));
}

function parseObservedAt(payload) {
  const observedAt = payload?.observedAt || payload?.observed_at;
  const parsed = Date.parse(observedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function readCodexHealthStatus({
  env = process.env,
  statusPath = join(resolveHqRoot(env), 'codex-health', 'status.json'),
  nowMs = Date.now(),
  freshMs = DEFAULT_FRESH_MS,
} = {}) {
  let raw;
  let stat;
  try {
    raw = readFileSync(statusPath, 'utf8');
    stat = statSync(statusPath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { usable: false, reason: 'missing-status', statusPath };
    }
    return { usable: false, reason: 'unreadable-status', statusPath, error: err.message };
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    return { usable: false, reason: 'invalid-status-json', statusPath, error: err.message };
  }

  const observedMs = parseObservedAt(payload) ?? stat.mtimeMs;
  const ageMs = nowMs - observedMs;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > freshMs) {
    return { usable: false, reason: 'stale-status', statusPath, payload, ageMs };
  }

  return { usable: true, statusPath, payload, ageMs };
}

function codexSpawningPauseDecision(options = {}) {
  const status = readCodexHealthStatus(options);
  if (!status.usable) {
    return { pause: false, ...status };
  }
  const classifier = String(status.payload?.classifier || '');
  const state = String(status.payload?.status || '');
  if (state === 'degraded' && classifier === PAUSE_CLASSIFIER) {
    return {
      pause: true,
      classifier,
      lastHealthyAt: status.payload?.lastHealthyAt || null,
      ...status,
    };
  }
  return { pause: false, ...status };
}

function logCodexHealthPause(log, decision, context = {}) {
  log.log?.(
    [
      'event=codex_health_paused',
      `classifier=${decision.classifier}`,
      `lastHealthyAt=${decision.lastHealthyAt || ''}`,
      context.repo ? `repo=${context.repo}` : null,
      context.prNumber ? `pr=${context.prNumber}` : null,
      context.site ? `site=${context.site}` : null,
    ].filter(Boolean).join(', ')
  );
}

export {
  PAUSE_CLASSIFIER,
  codexSpawningPauseDecision,
  logCodexHealthPause,
  readCodexHealthStatus,
};
