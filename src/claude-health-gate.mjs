import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_HQ_ROOT = '/Users/airlock/agent-os-hq';
const DEFAULT_FRESH_MS = 5 * 60 * 1000;

function resolveClaudeHealthStatusPath(env = process.env) {
  return env.CLAUDE_HEALTH_STATUS_PATH || join(env.HQ_ROOT || DEFAULT_HQ_ROOT, 'claude-health', 'status.json');
}

function readClaudeHealthGate({
  env = process.env,
  now = () => new Date(),
  maxFreshMs = DEFAULT_FRESH_MS,
  statusPath = resolveClaudeHealthStatusPath(env),
  readFileImpl = readFileSync,
  statImpl = statSync,
} = {}) {
  let payload;
  let stat;
  try {
    payload = JSON.parse(readFileImpl(statusPath, 'utf8'));
    stat = statImpl(statusPath);
  } catch {
    return { paused: false, statusPath, reason: 'missing-or-unreadable' };
  }

  const current = now();
  const nowMs = current instanceof Date ? current.getTime() : new Date(current).getTime();
  const observedMs = Number.isFinite(Date.parse(payload?.observedAt || ''))
    ? Date.parse(payload.observedAt)
    : Number(stat?.mtimeMs || 0);
  const ageMs = Math.max(0, nowMs - observedMs);
  const fresh = ageMs < maxFreshMs;
  const paused = (
    fresh &&
    payload?.status === 'degraded' &&
    payload?.classifier === 'claude_oauth_expired'
  );
  return {
    paused,
    statusPath,
    fresh,
    ageMs,
    classifier: payload?.classifier || null,
    lastHealthyAt: payload?.lastHealthyAt || null,
    observedAt: payload?.observedAt || null,
  };
}

function formatClaudeHealthPausedLog(gate) {
  return [
    'event=claude_health_paused',
    `classifier=${gate.classifier || 'unknown'}`,
    `lastHealthyAt=${gate.lastHealthyAt || 'unknown'}`,
  ].join(', ');
}

class ClaudeHealthPausedError extends Error {
  constructor(gate) {
    super(formatClaudeHealthPausedLog(gate));
    this.name = 'ClaudeHealthPausedError';
    this.isClaudeHealthPaused = true;
    this.classifier = gate.classifier || null;
    this.lastHealthyAt = gate.lastHealthyAt || null;
    this.gate = gate;
  }
}

function assertClaudeHealthAllowsSpawn(options = {}) {
  const gate = readClaudeHealthGate(options);
  if (gate.paused) {
    throw new ClaudeHealthPausedError(gate);
  }
  return gate;
}

export {
  ClaudeHealthPausedError,
  assertClaudeHealthAllowsSpawn,
  formatClaudeHealthPausedLog,
  readClaudeHealthGate,
  resolveClaudeHealthStatusPath,
};
